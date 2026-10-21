# RAW 미리보기 호환성

확장자 인식·검색·원본 바이트 복사와 미리보기 디코딩 지원은 다릅니다. 확장자가 목록에 있어도 모든 기종·압축 방식의 미리보기를 보장하지 않습니다. 아래는 2026년 10월 21일 로컬 검증 범위이며 배포 여부와는 별도입니다.

## 처리 순서와 제한

1. 같은 폴더·같은 이름의 JPG가 하나 있으면 우선 사용합니다.
2. RAW의 내부 JPEG를 추출합니다. 처음 32MiB를 읽고 TIFF JPEGInterchangeFormat·SubIFD, RW2 JpgFromRaw, RAF 헤더에 기록된 위치를 확인합니다. 미리보기가 앞부분 범위 밖에 있어도 위치가 유효하면 읽습니다.
3. 내부 JPEG를 얻지 못하면 마우스 올리기·포커스·터치 시에만 LibRaw 변환을 시도합니다.
4. 실패하면 `—`로 표시합니다. 미리보기 실패로 파일 검색·복사·ZIP을 차단하지 않습니다.

- 위치 기반 JPEG: 최대 8개 범위, 각 12MiB 이하. 파일 범위·태그 수·IFD 방문 수를 제한하고 순환을 차단합니다. 전체 파일을 읽어 미리보기를 탐색하지 않습니다.
- JPEG: 8비트 baseline/progressive만 허용하고 4천만 화소를 초과하면 추출하지 않습니다. lossless RAW 센서 데이터를 일반 JPEG로 오인해 표시하지 않습니다.
- 직접 변환: 파일 최대 128MiB, 센서 최대 1억1천만 화소, 한 번에 Worker 하나, 최대 30초. 이 값은 허용 상한이며 해당 크기의 모든 실제 파일에서 성공·메모리 사용량이 검증됐다는 뜻은 아닙니다. 저사양 기기에서는 실패할 수 있습니다.
- TIFF IFD0·CR3의 기존 회전 처리와 JPEG 자체 EXIF 방향 우선 적용을 유지합니다. MakerNote 내부의 제조사 전용 미리보기 포인터나 BigTIFF 전체 파서를 구현한 것은 아닙니다.
- 파일 내용과 메타데이터는 읽기만 하며 결과는 메모리의 작은 JPG입니다. 원본 파일·선택된 확장자·저장 대상은 변경하지 않습니다.

## 검증 결과

| 형식 | 실제 브라우저 샘플 | 위치 정보 구조 테스트 |
| --- | --- | --- |
| CR3 | 제공 자료 복제본에서 추출·변환 성공, 회전 반영 | 기존 CR3 회전 테스트 유지 |
| NEF | rawpy 공개 샘플 2개 추출·변환 성공 | TIFF JPEG 위치 |
| CR2 | Canon 40D sRAW 공개 샘플 추출·변환 성공 | TIFF JPEG 위치 |
| DNG | 내부 미리보기 없는 합성 센서 샘플 변환 성공 | big endian TIFF·SubIFD |
| ARW | 이번 실제 기종 샘플 미검증 | TIFF·SubIFD |
| RAF | 이번 실제 기종 샘플 미검증 | RAF 헤더 위치 |
| RW2 | 이번 실제 기종 샘플 미검증 | Panasonic JpgFromRaw |
| ORF | 이번 실제 기종 샘플 미검증 | 두 종류 TIFF 호환 매직 |
| X3F | Sigma SD9 공개 샘플 추출·변환 실패, 입력 해시 유지 | 실패 시 표시하지 않는 기존 동작 유지 |

구조 테스트는 멀리 떨어진 미리보기·순환 IFD·범위 밖 포인터·과도한 길이·잘린 JPEG·읽기 실패·읽기 횟수 제한을 검증합니다. 고화소 Worker 테스트는 작은 디코더 대체 객체로 메타데이터 상한과 자원 해제를 검증하며, 실제 61MP·102MP 카메라 파일 검증을 대신하지 않습니다. 6개 브라우저 입력의 전후 SHA-256과 디스크 샘플 SHA-256 일치를 확인했습니다.

## 근거와 샘플

- [TIFF/EXIF 태그 설명](https://exiftool.org/TagNames/EXIF.html)
- [PanasonicRaw JpgFromRaw 태그](https://exiftool.org/TagNames/PanasonicRaw.html)
- [ExifTool RAF 컨테이너 파서](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/FujiFilm.pm)
- [rawpy 공개 테스트 자료](https://github.com/letmaik/rawpy/tree/main/test)

외부 사진 샘플·개인 사진·브라우저 검증 결과는 Git 제외 폴더 `.local/raw-compat-qa/`에서만 사용하며 배포에 포함하지 않습니다. 다음 단계는 ARW·RAF·RW2·ORF의 실제 기종별 샘플과 64MiB 초과 고화소 파일, 저사양 기기에서의 메모리·취소 검증입니다.
