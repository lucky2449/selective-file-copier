#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
실행 파일 및 설치 프로그램 생성 스크립트
1단계: PyInstaller로 단일 EXE 빌드
2단계: Inno Setup으로 설치 프로그램(.exe) 빌드
"""

import subprocess
import sys
from pathlib import Path


def build_executable(project_root):
    print("\n[1/2] EXE 빌드 (PyInstaller)")
    print("-" * 40)

    spec_file = project_root / "FileCopier.spec"
    if not spec_file.exists():
        print("❌ FileCopier.spec 파일을 찾을 수 없습니다.")
        return False

    cmd = [
        "pyinstaller",
        str(spec_file),
        "--clean",
        "--noconfirm",
        "--distpath", str(project_root / "dist"),
        "--workpath", str(project_root / "build"),
    ]

    try:
        result = subprocess.run(
            cmd, check=True, cwd=project_root, capture_output=True, text=True,
            encoding="utf-8", errors="ignore"
        )
        if result.stdout:
            print(result.stdout[-2000:])

        exe = project_root / "dist" / "FileCopier.exe"
        if exe.exists():
            size_mb = exe.stat().st_size / 1024 / 1024
            print(f"✅ {exe.name} ({size_mb:.1f} MB)")
            return True
        else:
            print(f"❌ {exe} 파일을 찾을 수 없습니다.")
            return False

    except subprocess.CalledProcessError as e:
        print(f"❌ PyInstaller 빌드 실패: {e}")
        if e.stderr:
            print(e.stderr[-1000:])
        return False
    except FileNotFoundError:
        print("❌ PyInstaller를 찾을 수 없습니다.  →  pip install pyinstaller")
        return False


def build_installer(project_root):
    print("\n[2/2] 설치 프로그램 빌드 (Inno Setup)")
    print("-" * 40)

    iss_file = project_root / "installer" / "FileCopier_Setup.iss"
    if not iss_file.exists():
        print(f"❌ {iss_file} 파일을 찾을 수 없습니다.")
        return False

    iscc_candidates = [
        Path(r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe"),
        Path(r"C:\Program Files\Inno Setup 6\ISCC.exe"),
        Path(r"C:\Program Files (x86)\Inno Setup 5\ISCC.exe"),
        Path(r"C:\Program Files\Inno Setup 5\ISCC.exe"),
    ]
    iscc = next((p for p in iscc_candidates if p.exists()), None)

    if iscc is None:
        print("⚠️  Inno Setup이 설치되어 있지 않아 설치 프로그램을 건너뜁니다.")
        print("   설치: https://jrsoftware.org/isdl.php")
        return False

    installer_dir = project_root / "installer_output"
    installer_dir.mkdir(exist_ok=True)

    # 기존 인스톨러 삭제
    installer = installer_dir / "FileCopier_download.exe"
    if installer.exists():
        installer.unlink()
        print(f"   기존 파일 삭제: {installer.name}")

    cmd = [str(iscc), str(iss_file)]

    try:
        result = subprocess.run(cmd, check=True, cwd=project_root)

        if installer.exists():
            size_mb = installer.stat().st_size / 1024 / 1024
            print(f"✅ {installer.name} ({size_mb:.1f} MB)")
            return True
        else:
            print(f"❌ installer_output 에 FileCopier_download.exe 파일이 없습니다.")
            print(f"   폴더 내용: {list(installer_dir.iterdir())}")
            return False

    except subprocess.CalledProcessError as e:
        print(f"❌ Inno Setup 빌드 실패 (exit code {e.returncode})")
        if e.stdout:
            print(e.stdout[-1000:])
        if e.stderr:
            print(e.stderr[-500:])
        return False


def main():
    project_root = Path(__file__).parent.parent

    print("=" * 50)
    print("파일 복사 프로그램 빌드")
    print("=" * 50)

    exe_ok = build_executable(project_root)
    if not exe_ok:
        print("\n빌드 실패 ❌")
        sys.exit(1)

    installer_ok = build_installer(project_root)

    print("\n" + "=" * 50)
    if exe_ok and installer_ok:
        print("빌드 완료 ✅")
        print(f"\n📌 GitHub Release 업로드 목록:")
        print(f"   • dist/FileCopier.exe")
        print(f"   • installer_output/FileCopier_download.exe")
    elif exe_ok:
        print("EXE 빌드 완료 ✅  (설치 프로그램 생략)")
        print(f"\n📌 GitHub Release 업로드 목록:")
        print(f"   • dist/FileCopier.exe")
    print("=" * 50)


if __name__ == "__main__":
    main()
