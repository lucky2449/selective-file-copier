# 파일모아 로그 서버 운영

[프로젝트 안내](../../README.md) · [웹 개발·배포](../../DEVELOPMENT.md)

## 구성과 접속 주소

```text
파일모아(GitHub Pages) → HTTPS 수집 API(Cloudflare Worker) → D1
```

| 구분 | 값 |
| --- | --- |
| Worker·D1 이름 | `filemoa-operation-logs` |
| 수집 API | `POST https://filemoa-operation-logs.lucky2449-filemoa.workers.dev/v1/operations` |
| 로그 조회 | Cloudflare Dashboard → D1 → 해당 DB → Console |
| 보관 기준 | 작업 기록 90일, 정리 실행 요약 7일 |
| 정리 예약 | 매일 한국 시간 03:20 / UTC 18:20 |

**Worker 기본 주소를 브라우저로 열면 404가 나오는 것이 정상입니다.** 관리자 웹 화면과 공개 조회·수정·삭제 API는 없습니다.

[운영 점검](#운영-점검) · [로그 조회](#로그-조회와-서명-검증) · [첫 설치](#첫-설치) · [서버 업데이트](#서버-업데이트) · [키 백업](#서명-키-관리와-백업)

## 수집 범위

웹에서 작업 기록을 허용한 경우에만 접속 또는 허용 시 접속 기록 1건, 이후 저장 작업 시작·종료 각 1건을 보냅니다. 파일마다 전송하지 않습니다. 거절 상태의 기록을 나중에 소급 전송하지 않으며, 철회 후 재허용하면 새 임시 접속 ID를 사용합니다.

| 포함 | 제외 |
| --- | --- |
| 임시 세션·작업 UUID, 순서 번호 | 실명 식별 정보 |
| 앱 버전·배포 SHA, 브라우저 종류·주 버전 | 전체 User-Agent |
| 시각·처리 시간·저장 방식·결과 | 파일 내용·파일명·폴더 경로·입력 목록 |
| 선택·성공·요청·ZIP 포함·실패·미처리 파일 수와 용량 | 원시 오류 메시지·스택 |
| 고정 오류 코드·단계·횟수 | IP·Referer·HTTP 헤더의 애플리케이션 DB 저장 |

Cloudflare 네트워크 계층에서는 접속 정보를 처리할 수 있습니다. 위 제외 범위가 플랫폼 전체의 처리를 없앤다는 뜻은 아닙니다.

일반 다운로드·ZIP은 **요청 내역**이며 사용자 폴더에 실제 저장됐다는 확인이 아닙니다. ZIP 준비 용량은 브라우저 임시본의 용량입니다.

서버는 수신 시각·기록 UUID·SHA-256·HMAC을 추가합니다. 같은 세션·작업·순서의 중복 요청은 기존 행을 덮어쓰지 않습니다.

## 운영 점검

다음 명령은 **이 README가 있는 서버 폴더**에서 실행합니다. Python 3.11 이상, 로컬 `wrangler.toml`, Wrangler 로그인 또는 `CLOUDFLARE_API_TOKEN`이 필요합니다.

```powershell
python ops_check.py
```

수집 API에 합성 접속 1건을 보내 DB 저장까지 확인하려면:

```powershell
python ops_check.py --probe
```

여러 계정이 있으면 `--account 계정ID`를 붙입니다. 결과는 화면과 저장소 루트 `.local/log-ops-health.json`에 저장합니다. **실행 시점 점검이며 상시 알림은 아닙니다.**

| 점검 항목 | 확인 내용 |
| --- | --- |
| 수집 | 최근 24시간 접속·시작·종료·실패·취소 건수 |
| 누락 의심 | 최근 7일 중 시작 후 24시간 넘게 종료가 없거나, 종료 후 10분 넘게 시작이 없는 작업 |
| 작업 오류 | 최근 24시간 고정 오류 코드·단계별 횟수 |
| 사용량 | UTC 당일 계정 전체 Workers 요청·런타임 오류, D1 읽기·쓰기·DB 용량 |
| 정리 | Cron 설정, 90일 초과 잔여 건수, 최근 정리 결과와 경과 시간 |

합성 `-test-`·`-ops-` 기록은 일반 집계에서 제외합니다. 기록 0건은 방문자가 없는 상황과 수집 장애를 구분해야 하며, 누락 의심은 실제 파일 손상·실패 판정이 아닙니다.

### 사용량 경고 기준

운영 도구는 Free 플랜 참고 한도의 80%부터 경고합니다. 실제 계정 요금제는 별도로 확인하세요.

| 항목 | 참고 한도 | 경고 기준 |
| --- | --- | --- |
| Workers 요청 | 하루 100,000건 | 80,000건 |
| D1 읽기 | 하루 5,000,000행 | 4,000,000행 |
| D1 쓰기 | 하루 100,000행 | 80,000행 |
| D1 전체 공간 | 도구 기준 5GiB | 4GiB |

사용량은 지연·표본 집계이며 청구 내역이 아닙니다. 저장 공간은 DB별 당일 최대값을 합산합니다. 빈 집계와 조회 실패는 0으로 처리하지 않습니다. Workers 런타임 오류에는 정상 처리된 HTTP 400·429·503 응답이 포함되지 않습니다. 운영 조회 자체도 DB 읽기 사용량에 포함됩니다.

### 정리 상태 해석

매일 90일을 넘긴 작업 기록을 최대 5,000건 정리합니다. `maintenance_runs`에는 시작·종료·성공/실패·삭제 건수·남은 만료 건수를 기록합니다. 정리 요약은 다음 정리 실행에서 7일 기준으로 삭제합니다.

- 최초 적용 직후에는 실행 이력이 없을 수 있습니다.
- 최근 작업이 실패·실행 중이거나 성공 이력이 36시간 넘게 갱신되지 않으면 경고합니다.
- DB 접근 자체가 실패하면 실행 이력도 남지 않을 수 있습니다.
- 장애·한도 초과·정리 누적 시 90일이 지나도 기록이 남을 수 있으므로 잔여 건수를 확인하세요.

보관 정책을 변경하면 Worker의 정리 기준과 웹의 `retentionDays`·안내를 함께 바꿉니다.

## 로그 조회와 서명 검증

Cloudflare Dashboard의 D1 Console에서 조회할 수 있습니다.

```sql
SELECT * FROM log_ops_summary;
SELECT * FROM log_ops_gaps;
SELECT * FROM log_ops_errors;
SELECT * FROM log_ops_retention;
SELECT * FROM maintenance_runs ORDER BY started_at DESC LIMIT 10;
```

특정 작업을 내보낼 때는 Git에서 제외되는 `.local/`에 저장하세요. 아래 명령도 서버 폴더 기준입니다.

```powershell
New-Item -ItemType Directory -Force ../../.local | Out-Null
$logExport = npx wrangler d1 execute filemoa-operation-logs --remote --json --command "SELECT * FROM operation_records WHERE operation_id = '작업 UUID' ORDER BY sequence"
if ($LASTEXITCODE -ne 0) { throw "로그 조회 실패" }
[IO.File]::WriteAllText((Join-Path (Get-Location) '../../.local/operation-export.json'), ($logExport -join "`n"), [Text.UTF8Encoding]::new($false))
```

`LOG_SIGNING_KEY` 환경변수를 안전하게 설정한 상태에서:

```powershell
node verify-export.mjs ../../.local/operation-export.json
```

HMAC은 보관된 내용의 변경 확인을 돕습니다. 클라이언트의 진술, 원본 무손상, 삭제된 행, DB와 키를 모두 가진 운영자의 재작성 여부를 증명하지 않습니다.

## 첫 설치

이미 운영 중인 서버에는 아래 키 생성 절차를 다시 실행하지 말고 [서버 업데이트](#서버-업데이트)를 사용하세요.

1. Cloudflare 로그인과 로컬 설정 파일을 준비합니다.

   ```powershell
   npx wrangler login
   Copy-Item wrangler.example.toml wrangler.toml
   npx wrangler d1 create filemoa-operation-logs
   ```

2. 발급된 `database_id`를 `wrangler.toml`에 입력합니다. `ALLOWED_ORIGIN`과 rate limit namespace ID도 확인합니다.
3. 테이블·운영 조회 뷰를 만듭니다.

   ```powershell
   npx wrangler d1 execute filemoa-operation-logs --remote --file schema.sql
   npx wrangler d1 execute filemoa-operation-logs --remote --file ops-views.sql
   ```

4. 충분히 긴 무작위 서명 키를 안전하게 보관하고 비밀 입력창으로 등록한 뒤 배포합니다. 최소 32자이며 예제 키를 재사용하지 않습니다.

   ```powershell
   npx wrangler secret put LOG_SIGNING_KEY
   npx wrangler deploy
   ```

5. 웹 `operation-log-config.mjs`의 `endpoint`에 수집 주소를 넣고 웹을 별도 배포합니다. 공개 URL만 입력하며 키를 넣지 않습니다.
6. `python ops_check.py --probe`로 실제 저장을 확인하고 사이트에서 작은 작업의 시작·종료 기록도 확인합니다.

## 서버 업데이트

기존 로컬 설정·서명 키를 유지한 상태에서 서버 폴더에서 실행합니다.

```powershell
npx wrangler d1 execute filemoa-operation-logs --remote --file schema.sql
npx wrangler d1 execute filemoa-operation-logs --remote --file ops-views.sql
npx wrangler deploy
python ops_check.py --probe
```

현재 SQL은 없는 테이블·인덱스·뷰를 생성하며 기존 작업 기록을 초기화하지 않습니다. 기존 뷰 정의의 변경은 `CREATE VIEW IF NOT EXISTS`만으로 반영되지 않으므로 별도 마이그레이션이 필요합니다. GitHub Pages의 push 배포는 이 Worker를 갱신하지 않습니다.

테스트는 저장소 루트에서 실행합니다.

```powershell
npm run check
python -m unittest discover -s server/operation-logs -p "test_*.py"
```

## 전송·보안 제한

- 요청은 최대 4KiB이며 고정 필드·열거값·수량 정합성을 검사합니다.
- Origin·CORS 제한은 호출자 인증이 아니며 외부 클라이언트는 값을 위조할 수 있습니다.
- 위치별 전체 300건/분·세션 60건/분 제한은 완화 장치이며 계정 전체 비용 한도를 보장하지 않습니다.
- 클라이언트 전송은 동시 최대 8건·5초 타임아웃입니다. 재시도·디스크 전송 큐가 없어 오프라인·탭 종료·차단·서버 장애 때 누락될 수 있습니다.
- 세션 ID는 새로고침·새 탭에서 바뀝니다. 개인의 신원이나 고유 인원을 확인하는 용도가 아닙니다.
- 로컬 진단 JSON에는 서버 작업 ID·전송 결과가 포함되지 않습니다.

## 서명 키 관리와 백업

서명 키·인증 토큰·실제 로그 내보내기는 채팅이나 Git에 올리지 않습니다. 로컬 설정과 `.local/`은 Git에서 제외됩니다.

현재 `.local/filemoa-log-signing-key.xml` 복구본은 Windows DPAPI로 암호화되어 같은 사용자·PC에 종속됩니다. 파일만 다른 기기로 복사해서는 복구할 수 없습니다.

추가 백업은 **아직 적용하지 않았습니다.** 비밀번호 관리자의 암호화 보관함과 독립 암호로 보호한 오프라인 복구본을 함께 사용하는 방안을 검토 중입니다. 복구본과 암호를 분리하고, 복구한 키로 기존 기록의 HMAC을 확인하는 절차가 필요합니다. 키를 교체할 때도 과거 기록 검증용 키는 보존해야 합니다.

## 참고 문서

- [Cloudflare D1 시작하기](https://developers.cloudflare.com/d1/get-started/)
- [D1 요금·한도](https://developers.cloudflare.com/d1/platform/pricing/)
- [Workers 요청 한도](https://developers.cloudflare.com/workers/platform/limits/)
- [Rate Limit 바인딩](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Microsoft DPAPI 복구 범위](https://learn.microsoft.com/en-us/powershell/module/Microsoft.PowerShell.Utility/export-clixml?view=powershell-5.1)
- [CISA 백업·복구 지침](https://www.cisa.gov/stopransomware/ransomware-guide)
