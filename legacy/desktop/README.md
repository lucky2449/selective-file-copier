# 이전 데스크톱 버전

웹 버전 전환 전의 PyQt5 프로그램과 Windows 빌드 설정을 보존한 폴더입니다. 현재 사이트는 이 코드나 EXE 설치 파일을 사용하지 않습니다.

## 선택적 실행

저장소 루트에서 다음 명령으로 실행합니다. 별도 Python 가상환경을 권장합니다.

```powershell
cd legacy/desktop
python -m pip install -r requirements.txt
python modern_file_copier.py
```

Windows에서 `python utils/build_exe.py`로 EXE를 생성합니다. Inno Setup이 설치돼 있으면 설치 파일도 만듭니다. `build/`, `dist/`, `installer_output/`는 Git에 포함하지 않습니다.

웹 기능은 `sites/filecopier-web/dist/`에서 수정하세요.
