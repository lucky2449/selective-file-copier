# 파일모아 작업 로그 서버

구성: GitHub Pages(기존 웹 앱) → HTTPS Cloudflare Worker → D1(SQLite).
공개 API는 POST /v1/operations만 제공합니다. 로그 조회/수정/삭제 API는 제공하지 않습니다. 운영자는 Cloudflare 계정에서 조회합니다.

## 현재 상태

서버 코드와 클라이언트 연동은 준비되어 있으며 operation-log-config.mjs의 endpoint가 빈 값이어서 실제 전송은 비활성 상태입니다. Cloudflare 계정·DB·배포 주소·서명 키를 설정해야 활성화할 수 있습니다. 키를 채팅이나 Git 저장소에 올리지 마세요.

## 수집 범위

- 접속 1건, 저장 작업 시작/종료 각 1건. 파일마다 전송하지 않습니다.
- 임시 탭 세션 UUID, 작업 UUID, 순서 번호, 클라이언트 시각, 앱 버전, 배포 Git SHA, 브라우저 종류/주 버전.
- 작업 방식, 결과, 처리 시간, 선택/성공/요청/실패/미처리 수량, 선택 용량, 복사 완료 바이트 또는 ZIP 준비 바이트.
- 고정 오류 코드/단계/횟수. 원시 오류 메시지, 스택, 파일 내용/이름/경로/입력 목록, 전체 User-Agent는 보내지 않습니다.
- 일반 다운로드/ZIP은 다운로드 요청만 기록하며 실제 사용자 폴더 저장 완료를 주장하지 않습니다. ZIP의 prepared는 브라우저 임시 파일 생성 용량이고 사용자 폴더 쓰기 용량이 아닙니다.
- 서버는 recordId/receivedAt/SHA-256/HMAC을 추가합니다. DB 행은 중복 키에 대해 덮어쓰지 않습니다.
- 애플리케이션 DB에는 IP·Referer·HTTP 헤더를 저장하지 않습니다. Cloudflare 네트워크 계층의 IP 처리나 플랫폼 로그까지 없다는 뜻은 아닙니다.

## 배포 (PowerShell, 서버 디렉터리에서)

1. Cloudflare 계정을 생성하고 Workers/D1을 사용할 수 있는 상태로 준비합니다. 처음에는 Free 플랜으로 시작할 수 있으나 사용 한도와 비용을 확인하세요.
2. 공식 Wrangler CLI로 로그인합니다.

```powershell
npx wrangler login
Copy-Item wrangler.example.toml wrangler.toml
npx wrangler d1 create filemoa-operation-logs
```

3. 반환된 database_id를 로컬 wrangler.toml에 입력합니다. wrangler.toml과 .wrangler 상태는 Git에서 제외합니다. 다른 Worker와 겹치지 않도록 rate limit namespace_id도 확인하세요.
4. 빈 DB에 테이블을 생성합니다.

```powershell
npx wrangler d1 execute filemoa-operation-logs --remote --file schema.sql
```

5. 비밀번호 관리자 등에서 충분히 긴 무작위 서명 키(최소 32자)를 생성해 비밀 저장소에 보관하고 아래 명령의 입력창에 넣습니다. 예제 키를 재사용하지 마세요.

```powershell
npx wrangler secret put LOG_SIGNING_KEY
npx wrangler deploy
```

6. 발급된 Worker 주소에 /v1/operations를 붙여 프런트엔드의 sites/filecopier-web/dist/operation-log-config.mjs endpoint에 설정합니다. 공개 주소만 넣고 비밀키는 절대 넣지 않습니다. 서버 보관 정책과 사이트의 처리 안내를 확인한 뒤 웹을 배포합니다. GitHub Actions가 실제 GITHUB_SHA를 배포본 buildId에 기록합니다.
7. 실제 사이트에서 작은 테스트 파일로 작업한 뒤 DB에 접속/시작/종료 기록이 들어오는지 확인합니다.

```powershell
npx wrangler d1 execute filemoa-operation-logs --remote --command "SELECT record_id, received_at, operation_id, sequence, mode, result FROM operation_records ORDER BY received_at DESC LIMIT 20"
```

## 보관과 검증

기본 정책은 90일이며 매일 UTC 18:20에 오래된 항목을 최대 5,000건 정리합니다. 최대 약 하루의 정리 간격이 있고, 한도 초과/장애/정리 누적 시 기간 내 삭제를 보장하지 않으므로 운영 중 Cron과 D1 한도를 감시해야 합니다. 정책 변경 시 Worker의 retention cutoff와 프런트엔드 retentionDays/안내를 함께 바꾸세요. 분쟁 자료 별도 보존이나 백업 기간은 별도 정책과 접근 통제가 필요합니다.

원본 JSON과 서버 메타데이터는 Cloudflare 계정에서 조회/내보냅니다. 예:

```powershell
npx wrangler d1 execute filemoa-operation-logs --remote --json --command "SELECT * FROM operation_records WHERE operation_id = '작업 UUID' ORDER BY sequence" > operation-export.json
```

로컬 환경변수 LOG_SIGNING_KEY를 안전하게 지정한 상태에서 다음 명령으로 내보낸 기록의 HMAC과 메타데이터 일치를 확인할 수 있습니다.

```powershell
node verify-export.mjs operation-export.json
```

검증에 필요한 과거 서명 키는 보존해야 합니다. 키 유출 시 조작 가능성이 있으므로 키와 DB 관리 계정의 접근을 제한하세요. HMAC은 서버 보관 후 변경 확인 보조 장치이며, 신뢰기관 타임스탬프나 법적 효력 보증이 아닙니다. 삭제된 행 검출, DB+키를 모두 가진 운영자에 의한 재작성, 클라이언트가 보낸 내용의 진실성은 증명하지 않습니다.

## 장애/보안 한계

- 최대 4KiB, 고정 필드·열거값·수량 정합성 검증. 공개 요청에 비밀키를 포함하지 않습니다.
- 허용 Origin과 CORS는 웹 페이지 범위를 제한하는 장치이며 호출자 인증이 아닙니다. 외부 클라이언트가 Origin이나 UUID를 위조할 수 있습니다.
- 위치별 전체 300건/분, 세션 60건/분의 완화용 제한. 분산 공격을 완전히 차단하거나 하루 비용 한도를 보장하지 않으므로 Free 플랜 한도/플랫폼 방어도 확인하세요.
- 클라이언트는 동시 전송 최대 8건, 5초 타임아웃으로 복사 작업과 분리합니다. 자동 재시도/디스크 전송 큐가 없어서 오프라인·탭 종료·차단 확장·서버 장애 시 기록이 누락될 수 있습니다.
- 페이지 새로고침/새 탭에서 임시 sessionId가 바뀌며 실명 사용자를 특정하지 않습니다. operationId/전송 기록은 현재 로컬 진단 다운로드에 추가하지 않았습니다.
- 현재 네트워크/Cloudflare 실제 배포 검증은 미완료. 로컬 SQLite·Worker 요청 처리·클라이언트 직렬화/장애 테스트로 확인했습니다.

## 공식 문서

- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
