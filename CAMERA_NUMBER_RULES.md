# 사진 번호 인식 규칙

파일 이름에만 적용하는 검색 규칙입니다. 제조사나 기종을 EXIF로 확인하지 않으며 원본 내용은 읽거나 수정하지 않습니다. 아래 예시는 합성 파일명으로 검증했으며 모든 기종·펌웨어·사용자 재명명 방식을 지원한다는 뜻은 아닙니다.

## 선택과 확인

- 기본 숫자 검색은 파일명 끝의 연속 숫자 전체를 비교하고 선행 0을 무시합니다.
- 기본으로 켜진 **제조사별 사진 번호 후보 포함**은 알려진 사진 이름 구조에서 추가 번호 후보를 찾습니다.
- 새 규칙으로 얻은 후보는 하나뿐이어도 `번호 확인` 상태입니다. 경로와 해석 이유를 확인한 후 드롭다운에서 선택해야 복사·다운로드·ZIP에 포함됩니다.
- 기존 숫자 일치 파일이 있어도 추가 후보를 함께 보여줍니다. 서로 다른 카드나 카메라의 동일 번호를 임의 선택하지 않습니다.
- 체크를 끄면 기존의 끝 숫자 전체 비교로 돌아갑니다. 기존 파일명/확장자 필터/전체 번호 검색은 유지됩니다.

## 대표 형식

| 형식                                         | 예시                                                                 | 입력 및 동작                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Canon 기본, Sony, Nikon, Fujifilm, Pentax 등 | IMG_0001.JPG, DSC00001.ARW, DSC_0001.NEF, DSCF0001.RAF, IMGP0001.PEF | `1`은 기존 끝 숫자 검색. 단일 후보이면 기존처럼 선택                                     |
| 숫자 포함 사용자 접두사                      | AB120001.CR3, A1298765.ARW, \_Z630001.NEF, A1230001.PEF              | 4자리 또는 Sony 형식의 5자리 번호를 추가 후보로 표시. `1` 또는 `98765` 검색 후 확인 필요 |
| Panasonic·Leica 폴더 번호 포함               | P1000001.RW2, \_1000001.JPG, L1000001.DNG                            | 전체 번호 `1000001` 유지. 짧은 번호 `1`은 추가 후보로 표시                               |
| OM SYSTEM·Olympus 월일 포함                  | P1010001.ORF, PA150001.JPG, PC310001.ORF                             | 월일 뒤의 `0001`을 추정 후보로 표시. 10~12월 A/B/C와 유효한 월일 범위 검사               |
| Ricoh 계열 긴 연번                           | R0010001.DNG                                                         | 원래 연번 `10001` 유지. 끝 4자리 `1`은 의미가 다를 수 있어 추가 후보로만 표시            |
| Sigma·Hasselblad의 연속 번호                 | FP123456.DNG, SDIM0001.X3F, B1234567.3FR                             | 전체 연속 번호 유지. 임의로 끝 4자리로 자르지 않음                                       |
| DJI 날짜·번호·접미사                         | DJI_20240101123045_0123_WIDE_Waypoint1.JPG                           | `123`을 추정 후보로 표시. 날짜나 Waypoint1의 1을 촬영 번호로 사용하지 않음               |
| GoPro 기본 사진                              | GOPR0001.JPG, GOPR0001.GPR                                           | 기존 끝 숫자 검색 유지. 영상 챕터·연사 형식 전체 지원은 아님                             |
| 알려진 카메라 이름의 편집·중복 접미사        | IMG_1234_1.JPG, IMG_1234-edit.JPG                                    | `1234`를 추정 후보로 표시. 복제 번호 `1`로 자동 선택하지 않음                            |

추가 후보 확장은 정지사진 및 지원 RAW 확장자에만 적용합니다. 동영상·XMP·TXT에는 제조사 번호를 추정하지 않습니다. JPEG/DNG는 여러 제조사의 접두사 규칙과 겹칠 수 있어 후보가 늘어날 수 있습니다. 파일명만으로 이를 확정하지 않습니다. RAW/JPEG 접두사가 서로 다른 짝 파일 자동 연결, 번호 범위 입력, 카메라 표시 번호 `100-0001`, EXIF 기반 카메라 구분은 이번 범위에 포함하지 않습니다.

## 공식 참고 자료

- [Canon EOS R3 파일명과 사용자 접두사](https://cam.start.canon/en/C010/manual/html/UG-07_Set-up_0060.html)
- [Sony 파일명 앞 3자리 설정](https://helpguide.sony.net/ilc/2010/v1/en/contents/TP0003228384.html)
- [Nikon DSC\_ 및 Adobe RGB 파일명](https://onlinemanual.nikonimglib.com/z5/en/09_menu_guide_03_03.html)
- [Fujifilm 4자리 번호와 파일명 접두사](https://app.fujifilm-dsc.com/en-int/manual/x-t5/menu_setup/save_data_set-up/)
- [Panasonic 카드 폴더·파일 번호 구조](https://eww.pavc.panasonic.co.jp/dscoi/DC-GH6/html/DC-GH6_DVQP2441_eng/0134.html)
- [Olympus E-1 매뉴얼](https://learnandsupport.getolympus.com/sites/default/files/media/files/2018/04/E-1_Reference_Manual_EN.pdf)
- [Pentax KF 매뉴얼](https://www.ricoh-imaging.co.jp/english/support/man-pdf/KF_om_en_web.pdf)
- [Ricoh GR 연번 설명](https://www.ricoh-imaging.co.jp/english/r_dc/support/manual/pdf/gr/gr_jp.pdf)
- [Leica Q3 43 매뉴얼](https://leica-camera.com/sites/default/files/pm-113588-Leica-Q343_Instructions_en.pdf)
- [Hasselblad X2D 100C 매뉴얼](https://cdn.hasselblad.com/manuals/X2D-100C-User-Manual/User_Manual/X2D_100C_User_Manual_v1_EN.pdf)
- [Sigma fp 매뉴얼](https://www.sigma-global.com/en/support/download/fp_menu_v5.0_en.pdf)
- [DJI 카메라 SDK의 파일명 규칙](https://developer.dji.com/api-reference/ios-api/Components/Camera/DJICamera.html)
- [GoPro HERO6 Black 매뉴얼](https://gopro.com/content/dam/help/hero6-black/manuals/HERO6Black_UM_ENG_REVA.pdf)
