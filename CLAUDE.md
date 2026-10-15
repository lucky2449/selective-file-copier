# 프로젝트 안내

현재 제품은 로그인·비밀번호가 없는 브라우저 파일 복사 도구입니다.

- 웹 원본: `sites/filecopier-web/dist/`
- GitHub Pages 게시본: `docs/` — 직접 수정하지 말고 `npm run sync:pages`로 생성
- 검증: `npm run check` (문법, 게시본 동기화, 검색·ZIP·폴더 선택 회귀 테스트)
- 로컬 실행: `python -m http.server 8080 --directory docs --bind 127.0.0.1`
- 이전 PyQt 소스: `legacy/desktop/` — 현재 웹사이트에 사용하지 않음
- Sites 식별자: `sites/filecopier-web/.openai/hosting.json` — 기존 project_id 보존

파일 내용은 서버로 전송하지 않습니다. 폴더 접근은 사용자의 선택과 브라우저 권한으로만 처리합니다. 지원 브라우저는 폴더 직접 복사를 제공하고, 미지원 브라우저는 ZIP으로 저장합니다.

숫자는 파일명 끝의 연속 숫자 전체를 비교하며 선행 0은 무시합니다. 확장자 필터를 모든 검색에 적용합니다. 중복 후보는 사용자가 선택하고, 대상 이름 충돌은 자동 이름 변경하며, 동일 원본 경로는 한 번만 복사합니다.

배포 패키지, 테스트 파일, EXE, IDE 설정, 개인 권한 설정을 커밋하지 않습니다. `.local/`은 로컬 백업 전용입니다.

기본 사이트는 GitHub Pages이며 `.github/workflows/pages.yml`에서 main push 후 검증과 배포를 수행합니다. PR에서는 검증만 합니다. Actions는 웹 원본만 게시하고 legacy 및 설정 파일은 게시하지 않습니다.

폴더 직접 복사는 원본과 저장 폴더의 핸들을 isSameEntry로 선택 시·복사 직전에 비교합니다. 원본 핸들 없이 직접 복사를 허용하지 않습니다. 기본 원본 폴더 선택은 네이티브 폴더 선택으로 직접 복사 핸들을 받습니다. 저장 위치를 미리 지정하지 않아도 복사를 허용합니다. 미지정 시 복사 클릭 안에서 showDirectoryPicker({mode: "readwrite", startIn: "downloads"})로 위치 확인을 받고, 원본과 상위 폴더를 비교한 후 날짜·시간 이름의 새 폴더를 생성합니다. startIn은 위치 제안일 뿐 무권한 접근이나 고정 경로를 뜻하지 않습니다. 자동 생성한 폴더는 명시적 저장 위치로 고정하지 않으며, ZIP으로 자동 전환하지 않습니다. 파일 선택창과 ZIP 버튼은 명시적 대체 수단입니다.
