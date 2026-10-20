# 외부 RAW 디코더와 라이선스

파일모아의 RAW 직접 변환에는 `libraw-wasm-nothread@1.6.0-nothread.1`을 사용합니다.
사진과 원본 파일의 전송은 없으며 변환은 브라우저 Worker 안에서 실행합니다.

## 구성 요소와 배포 조건

| 구성 요소 | 고정 버전 | 적용 고지 |
| --- | --- | --- |
| LibRaw-Wasm no-thread 래퍼 | 1.6.0-nothread.1 / d03be9f0eb0efda42e807a87045b4ac18ad8ca98 | ISC |
| LibRaw | 0.22.1 / b860248a89d9082b8e0a1e202e516f46af9adb29 | CDDL 1.0으로 배포; 대체 LGPL 전문도 동봉 |
| Little CMS | 2.19.1 / 21c582a594fe5279f90c0b93437c398f93bf62b0 | MIT |
| IJG JPEG / libpng / zlib | 9f / 1.6.58 / 1.3.2 | 각 원본 라이선스 |
| Emscripten 및 런타임 | 6.0.10 기준 빌드 레시피 | MIT/NCSA 및 libc++·musl 고지 |

CDDL은 해당 구성 요소와 그 변경에 적용됩니다. 파일모아의 별도 코드 전체를 자동으로 CDDL로 변경한다는 뜻은 아닙니다. LibRaw 하위 코드의 저작권 표시는 전체 소스와 함께 보존합니다. 라이브러리 저작자가 파일모아를 보증하거나 후원한다는 의미는 없습니다.

## 이용자에게 제공하는 자료

- 사이트 하단의 [오픈소스 라이선스](https://lucky2449.github.io/selective-file-copier/licenses.html)
- 로그인·비용 없이 내려받는 [대응 소스 묶음](https://lucky2449.github.io/selective-file-copier/vendor/libraw-nothread-1.6.0-1/source-bundle.zip)
- [고지 전문](sites/filecopier-web/dist/vendor/libraw-nothread-1.6.0-1/NOTICE.txt), [출처·SHA-256](sites/filecopier-web/dist/vendor/libraw-nothread-1.6.0-1/manifest.json), [빌드 안내](sites/filecopier-web/dist/vendor/libraw-nothread-1.6.0-1/BUILDING.txt)

소스 묶음에는 LibRaw·Little CMS·JPEG·PNG·zlib 소스, 래퍼 소스, 빌드 지침과 라이선스가 들어 있습니다. upstream 빌드에서 변경한 LibRaw의 OpenMP 설정은 수정된 configure.ac로 함께 제공합니다. 래퍼 소스 묶음에서 예제 사진과 중복 사전 빌드 바이너리는 제외했습니다.

## 검증 범위와 업데이트

배포 JS/WASM의 바이트가 npm 패키지와 위 GitHub 커밋의 파일에 일치함을 확인했습니다. npm 패키지 SHA-512 및 구성 파일 SHA-256을 고정했습니다. 독립적으로 재컴파일한 바이너리와의 일치나 별도의 법률 인증을 뜻하지는 않습니다.

라이브러리를 갱신할 때에는 원본 소스·빌드 변경·라이선스·소스 ZIP·manifest를 함께 갱신하고 `npm run sync:pages`와 `npm run check`를 실행합니다. `raw-vendor.test.mjs`는 무결성과 소스 제공 링크를 검사합니다. vendor 원본 바이트는 .gitattributes에서 줄바꿈 변환을 막아 해시를 유지합니다.

공식 자료:
- https://github.com/garbarok/libraw-wasm-nothread/tree/d03be9f0eb0efda42e807a87045b4ac18ad8ca98
- https://github.com/LibRaw/LibRaw/blob/0.22.1/LICENSE.CDDL
- https://github.com/mm2/Little-CMS/tree/21c582a594fe5279f90c0b93437c398f93bf62b0
