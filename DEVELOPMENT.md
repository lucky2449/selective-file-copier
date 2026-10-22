# 개발·배포 안내

[파일모아 README](README.md) · [로그 서버 운영](server/operation-logs/README.md)

## 환경과 파일 구조

전체 검증은 GitHub Actions와 동일한 **Node.js 24**를 사용하세요. 서버 운영 점검 테스트에는 **Python 3.11 이상**이 필요합니다. 웹 앱은 외부 npm 패키지를 사용하지 않아 `npm install` 없이 실행·검증할 수 있습니다.

```text
.
├── sites/filecopier-web/
│   ├── dist/                 # 웹 원본: HTML·CSS·ES modules
│   ├── tests/                # Node.js 회귀 테스트
│   └── .openai/hosting.json  # 기존 Sites 프로젝트 식별자
├── docs/                     # 웹 원본의 동기화 사본
├── server/operation-logs/    # Workers·D1 로그 서버와 운영 도구
├── scripts/                  # 동기화·검증·배포 버전 기록
├── legacy/desktop/           # 이전 PyQt 프로그램
└── .github/workflows/pages.yml
```

| 주요 소스 | 역할 |
| --- | --- |
| `app.mjs`, `index.html`, `style.css` | 화면·상태·작업 흐름 |
| `core.mjs`, `camera-number.mjs` | 입력 해석·검색·사진 번호 후보 |
| `source-picker.mjs`, `directory-access.mjs` | 원본 선택·결과 폴더 생성 |
| `copy-safety.mjs`, `copy-lock.mjs` | 대상 충돌 검사·탭 간 잠금 |
| `zip.mjs`, `zip-storage.mjs`, `zip-download.mjs` | ZIP 생성·크기 검사·임시 저장·다운로드 |
| `analytics.mjs`, `analytics-config.mjs` | GA4 통계 |
| `operation-log.mjs`, `operation-schema.mjs`, `operation-log-config.mjs` | 서버 작업 기록·검증·공개 설정 |

위 소스는 `sites/filecopier-web/dist/`에 있습니다. **`docs/`는 직접 수정하지 않고 원본에서 동기화합니다.**

## 수정·검증

저장소 루트에서 실행합니다.

```powershell
# 원본을 바로 확인하는 로컬 서버
python -m http.server 8080 --directory sites/filecopier-web/dist --bind 127.0.0.1
```

별도 터미널에서:

```powershell
npm run sync:pages
npm run check
python -m unittest discover -s server/operation-logs -p "test_*.py"
```

`npm run check`는 문법·HTML 참조·DOM ID·게시본 일치 여부와 회귀 테스트를 검사합니다. `npm test`는 Node.js 테스트만 실행합니다.

자동 테스트는 검색·확장자·경로 규칙, 원본 보존, 충돌·권한·취소·저장 실패, 탭 잠금, ZIP 구조·CRC·크기 경계, 통계·로그 검증 등을 다룹니다. 실제 브라우저 권한 대화상자와 다운로드 결과는 별도로 확인해야 합니다. 상세 ZIP 검증 범위는 [ZIP_STORAGE.md](ZIP_STORAGE.md)에 있습니다.

## GitHub Pages 배포

기본 사이트는 [GitHub Pages](https://lucky2449.github.io/selective-file-copier/)입니다.

1. 웹 원본을 수정하고 검증한 뒤 `main`에 push합니다.
2. Actions가 게시본 동기화와 Node.js·Python 테스트를 실행합니다.
3. 배포본에 Git SHA를 기록하고 웹 원본 디렉터리만 게시합니다.

PR은 검증만 실행하며 운영 배포는 하지 않습니다. 실행 결과는 [Actions](https://github.com/lucky2449/selective-file-copier/actions/workflows/pages.yml)에서 확인합니다. 저장소 Settings → Pages → Source는 **GitHub Actions**로 설정합니다.

- 로컬 기본 `buildId`는 `unversioned`이며 Actions가 배포본에만 실제 SHA를 넣습니다.
- 서버·이전 데스크톱 코드·로컬 설정은 Pages 배포 대상이 아닙니다.
- Cloudflare Worker는 별도로 배포해야 합니다. [서버 업데이트 절차](server/operation-logs/README.md#서버-업데이트)
- 기존 `chatgpt.site` 주소는 별도 배포이며 GitHub push로 갱신되지 않습니다.

## 통계 설정 (GA4)

`analytics-config.mjs`의 `measurementId`를 설정합니다. 현재 공개 측정 ID는 `G-H7FQ3VZPMB`입니다. 빈 문자열로 설정하면 GA4 태그 로드와 전송을 중지합니다. 공식 GitHub Pages에서만 활성화되며 로컬·이전 Sites 주소에서는 집계하지 않습니다.

`privacy-preferences.mjs`가 항목별 선택을 저장하며 허용 전에는 GA4 스크립트를 로드하지 않습니다. 거절·철회 시 앱 이벤트를 차단하고 Google의 `ga-disable-측정ID` 플래그를 적용합니다. 설정창은 유효한 저장 선택이 없을 때만 자동 표시합니다. GA4 관리 → 데이터 스트림 → 웹 스트림의 **향상된 측정**을 꺼서 추가 자동 이벤트 수집을 방지합니다. Google Signals와 광고 개인 최적화도 사용하지 않습니다. 배포 후 허용한 상태에서 GA4 실시간 보고서의 수신을 확인하세요.

| 이벤트 | 집계 기준 |
| --- | --- |
| `page_view` | 페이지 로드당 1회. 사용자 수는 쿠키 기반 추정 |
| `file_search` | 유효한 원본·입력으로 검색을 시작한 횟수 |
| `copy_success`, `copy_failure` | 작업당 성공·실패 요약 각 1회. 장수는 별도 매개변수 |
| `download_request` | 개별 파일 다운로드 요청 전달 횟수 |
| `zip_created` | ZIP 생성 후 다운로드 요청 성공 횟수 |

복사 1회에 1,000장을 처리하면 `copy_success` 1회와 `copied_file_count: 1000`을 보냅니다. 일부 성공·실패가 섞이면 각 이벤트를 한 번씩 전송합니다.

- **복사 인원:** `copy_success`로 필터링한 총 사용자 수. 기기·브라우저·쿠키 변경에 따라 중복 집계될 수 있습니다.
- **작업 횟수:** 해당 이벤트 수. 인원 수와 구분합니다.
- **성공·실패 장수:** 맞춤 측정항목 `copied_file_count`, `failed_file_count`의 합계. GA4 관리 → 맞춤 정의에서 단위 ‘일반’으로 등록합니다.

이벤트에는 고정 이벤트명·페이지 정보·검증된 수량만 전달합니다. 파일 내용·이름·경로·입력·원시 오류·URL 쿼리·유입 주소는 전달하지 않습니다. GA4는 별도로 쿠키 및 브라우저 접속 정보를 처리하므로 ‘개인정보를 전혀 수집하지 않는다’고 안내하지 않습니다.

## 서버 작업 기록 설정

`operation-log-config.mjs`에 공개 수집 주소와 보관 기간을 설정합니다. `endpoint`를 비우면 서버 작업 기록 전송과 해당 안내를 비활성화합니다. GA4 설정과는 별개입니다.

작업 기록은 저장된 허용 선택이 있을 때만 전송합니다. 철회 시 대기·진행 중 로그 요청을 취소하고 기존 작업의 종료 기록을 재허용 후 소급 전송하지 않습니다. 파일 복사·ZIP 작업은 중단하지 않습니다. 이 선택 UI의 구현과 국외 이전 고지·법적 근거의 충족 여부는 별개로 점검합니다.

서버는 Cloudflare Workers + D1이며 설치·조회·정리·서명 검증은 [서버 README](server/operation-logs/README.md)에 정리되어 있습니다. 보관 기간을 바꾸면 서버 정리 기준과 사이트 설정·안내도 함께 변경해야 합니다.

## Git에 포함하지 않는 항목

`.gitignore`에서 다음 항목을 제외합니다.

- `.local/`: 점검 보고서·내보낸 기록·키 복구본 등
- `server/operation-logs/wrangler.toml`, `.wrangler/`: 로컬 배포 설정·상태
- `.env*`, `.dev.vars*`: 비밀값 (`.env.example` 제외)
- 의존성·빌드 산출물·EXE·설치 파일·IDE 설정·테스트 임시 파일

GA4 측정 ID와 수집 URL은 공개 설정입니다. **서명 키·인증 토큰은 웹 코드나 Git에 넣지 않습니다.** 변경 이력은 커밋으로 관리합니다.
