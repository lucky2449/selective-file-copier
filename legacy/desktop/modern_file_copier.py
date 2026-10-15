#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
모던 파일 복사 프로그램
PyQt5를 사용한 전문적인 GUI 애플리케이션
"""

import sys
import os
import shutil
import re
from pathlib import Path
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout,
                            QHBoxLayout, QLabel, QPushButton,
                            QLineEdit, QTextEdit, QComboBox,
                            QProgressBar, QFileDialog, QMessageBox,
                            QGroupBox, QFrame)
from PyQt5.QtCore import Qt, QThread, pyqtSignal
from PyQt5.QtGui import QIcon


class FileScanThread(QThread):
    """파일 스캔을 위한 백그라운드 스레드"""
    scan_progress = pyqtSignal(str)
    scan_complete = pyqtSignal(list, int)

    def __init__(self, folder_path):
        super().__init__()
        self.folder_path = folder_path

    def run(self):
        try:
            folder = Path(self.folder_path)
            if not folder.exists():
                return

            extensions = set()
            file_count = 0

            self.scan_progress.emit("파일 스캔 중...")

            for root, dirs, files in os.walk(folder):
                for file in files:
                    file_path = Path(root) / file
                    if file_path.is_file():
                        ext = file_path.suffix.lower()
                        if ext:
                            extensions.add(ext)
                        file_count += 1

            extension_list = sorted(list(extensions))
            self.scan_complete.emit(extension_list, file_count)

        except Exception as e:
            self.scan_progress.emit(f"스캔 오류: {e}")


class ModernFileCopier(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("파일 복사 프로그램")
        self.setGeometry(100, 100, 1200, 800)
        self.setMinimumSize(1000, 700)

        # 스타일 설정
        self.setup_styles()

        # 메인 위젯 설정
        self.setup_ui()

        # 중앙 배치
        self.center_window()

        # 초기 상태 설정
        self.reset_ui_state()

    def setup_styles(self):
        """모던한 스타일 설정"""
        self.setStyleSheet("""
            QMainWindow {
                background-color: #f8f9fa;
                color: #212529;
            }

            QGroupBox {
                font-weight: bold;
                font-size: 13px;
                color: #495057;
                border: 1px solid #dee2e6;
                border-radius: 6px;
                margin-top: 8px;
                padding-top: 12px;
                background-color: white;
            }

            QGroupBox::title {
                subcontrol-origin: margin;
                left: 12px;
                padding: 0 6px 0 6px;
                color: #007bff;
            }

            QPushButton {
                background-color: #007bff;
                color: white;
                border: none;
                border-radius: 5px;
                padding: 8px 16px;
                font-size: 13px;
                font-weight: bold;
                min-height: 18px;
            }

            QPushButton:hover {
                background-color: #0056b3;
            }

            QPushButton:pressed {
                background-color: #004085;
            }

            QPushButton#secondaryButton {
                background-color: #6c757d;
                color: white;
            }

            QPushButton#secondaryButton:hover {
                background-color: #545b62;
            }

            QLineEdit, QTextEdit, QComboBox {
                border: 1px solid #ced4da;
                border-radius: 4px;
                padding: 6px 10px;
                font-size: 13px;
                background-color: white;
                selection-background-color: #007bff;
            }

            QLineEdit:focus, QTextEdit:focus, QComboBox:focus {
                border-color: #007bff;
                border-width: 2px;
                outline: none;
            }

            QComboBox::drop-down {
                border: none;
                width: 30px;
            }

            QComboBox::down-arrow {
                image: none;
                border-left: 5px solid transparent;
                border-right: 5px solid transparent;
                border-top: 5px solid #6c757d;
                margin-right: 10px;
            }

            QRadioButton {
                font-size: 14px;
                color: #495057;
                spacing: 8px;
            }

            QRadioButton::indicator {
                width: 18px;
                height: 18px;
                border-radius: 9px;
                border: 2px solid #ced4da;
                background-color: white;
            }

            QRadioButton::indicator:checked {
                background-color: #007bff;
                border-color: #007bff;
            }

            QProgressBar {
                border: 2px solid #dee2e6;
                border-radius: 6px;
                text-align: center;
                background-color: #e9ecef;
                height: 25px;
            }

            QProgressBar::chunk {
                background-color: #007bff;
                border-radius: 4px;
            }

            QLabel {
                color: #495057;
                font-size: 14px;
            }

            QLabel#titleLabel {
                font-size: 20px;
                font-weight: bold;
                color: #212529;
                margin-bottom: 3px;
            }

            QLabel#subtitleLabel {
                font-size: 14px;
                color: #6c757d;
                margin-bottom: 15px;
            }

            QScrollArea {
                border: none;
                background-color: transparent;
            }
        """)

    def setup_ui(self):
        """UI 구성"""
        central_widget = QWidget()
        self.setCentralWidget(central_widget)

        # 메인 레이아웃
        main_layout = QVBoxLayout(central_widget)
        main_layout.setSpacing(15)
        main_layout.setContentsMargins(20, 20, 20, 20)

        # 제목 섹션
        self.setup_title_section(main_layout)

        # 컨텐츠 영역 (좌우 분할)
        content_layout = QHBoxLayout()
        content_layout.setSpacing(15)

        # 왼쪽 패널
        left_panel = self.setup_left_panel()
        content_layout.addWidget(left_panel, 3)

        # 오른쪽 패널
        right_panel = self.setup_right_panel()
        content_layout.addWidget(right_panel, 2)

        main_layout.addLayout(content_layout)

        # 하단 버튼 영역
        self.setup_bottom_buttons(main_layout)

        # 상태바
        self.statusBar().showMessage("준비됨")
        self.statusBar().setStyleSheet("color: #6c757d; font-size: 12px;")

    def setup_title_section(self, layout):
        """제목 섹션 설정"""
        title_frame = QFrame()
        title_layout = QVBoxLayout(title_frame)
        title_layout.setContentsMargins(0, 0, 0, 0)
        title_layout.setSpacing(5)

        title_label = QLabel("📁 파일 복사 프로그램")
        title_label.setObjectName("titleLabel")
        title_label.setAlignment(Qt.AlignCenter)

        subtitle_label = QLabel("숫자 목록을 입력하여 해당하는 파일들을 자동으로 복사합니다")
        subtitle_label.setObjectName("subtitleLabel")
        subtitle_label.setAlignment(Qt.AlignCenter)

        title_layout.addWidget(title_label)
        title_layout.addWidget(subtitle_label)

        layout.addWidget(title_frame)

    def setup_left_panel(self):
        """왼쪽 패널 설정"""
        panel = QFrame()
        layout = QVBoxLayout(panel)
        layout.setSpacing(12)

        # 경로 설정 그룹
        path_group = QGroupBox("📂 경로 설정")
        path_layout = QVBoxLayout(path_group)
        path_layout.setSpacing(10)
        path_layout.setContentsMargins(15, 20, 15, 15)

        # 원본 폴더
        source_layout = QHBoxLayout()
        source_layout.addWidget(QLabel("원본 폴더:"))
        self.source_path_edit = QLineEdit()
        self.source_path_edit.setPlaceholderText("복사할 파일들이 있는 폴더를 선택하세요")
        source_layout.addWidget(self.source_path_edit)
        self.browse_source_btn = QPushButton("찾아보기")
        self.browse_source_btn.clicked.connect(self.browse_source)
        source_layout.addWidget(self.browse_source_btn)
        path_layout.addLayout(source_layout)

        # 저장 폴더
        dest_layout = QHBoxLayout()
        dest_layout.addWidget(QLabel("저장 폴더:"))
        self.dest_path_edit = QLineEdit()
        self.dest_path_edit.setPlaceholderText("파일을 복사할 대상 폴더를 선택하세요")
        dest_layout.addWidget(self.dest_path_edit)
        self.browse_dest_btn = QPushButton("찾아보기")
        self.browse_dest_btn.clicked.connect(self.browse_dest)
        dest_layout.addWidget(self.browse_dest_btn)
        path_layout.addLayout(dest_layout)

        layout.addWidget(path_group, 0)

        # 입력 그룹
        input_content_group = QGroupBox("📝 입력 내용")
        input_content_layout = QVBoxLayout(input_content_group)
        input_content_layout.setContentsMargins(10, 15, 10, 10)
        input_content_layout.setSpacing(8)

        self.numbers_text = QTextEdit()
        self.numbers_text.setPlaceholderText(
            "입력 방법:\n"
            "• 직접 입력: 1964, 205A1964.jpg, C:\\folder\\file.jpg\n"
            "• 📁 파일 선택: 여러 파일을 선택하여 다른 확장자로 자동 매칭\n"
            "  (예: IMG_001.jpg 선택 → IMG_001.cr3 찾기)\n"
            "• 📄 텍스트 파일: 파일 목록이 담긴 텍스트 파일 로드"
        )
        self.numbers_text.setMinimumHeight(100)
        self.numbers_text.setStyleSheet("QTextEdit { line-height: 1.5; }")
        input_content_layout.addWidget(self.numbers_text, 1)

        # 버튼 레이아웃
        button_layout = QHBoxLayout()

        self.select_files_btn = QPushButton("📁 파일 선택")
        self.select_files_btn.clicked.connect(self.select_files)
        self.select_files_btn.setObjectName("secondaryButton")
        button_layout.addWidget(self.select_files_btn)

        self.load_file_btn = QPushButton("📄 텍스트 파일 로드")
        self.load_file_btn.clicked.connect(self.load_text_file)
        self.load_file_btn.setObjectName("secondaryButton")
        button_layout.addWidget(self.load_file_btn)

        input_content_layout.addLayout(button_layout)

        layout.addWidget(input_content_group, 2)

        return panel

    def setup_right_panel(self):
        """오른쪽 패널 설정"""
        panel = QFrame()
        layout = QVBoxLayout(panel)
        layout.setSpacing(12)

        # 파일 확장자 그룹
        extension_group = QGroupBox("📄 파일 확장자")
        extension_layout = QVBoxLayout(extension_group)
        extension_layout.setContentsMargins(15, 10, 15, 15)
        extension_layout.setSpacing(8)

        self.extension_combo = QComboBox()
        self.extension_combo.addItem("폴더를 먼저 선택하세요")
        extension_layout.addWidget(self.extension_combo)

        extension_info = QLabel("원본 폴더 선택 시 자동으로 파일 확장자를 스캔합니다")
        extension_info.setStyleSheet("color: #6c757d; font-size: 12px; margin-top: 10px;")
        extension_info.setWordWrap(True)
        extension_layout.addWidget(extension_info)

        layout.addWidget(extension_group, 0)

        # 진행 상황 그룹
        progress_group = QGroupBox("⚡ 진행 상황")
        progress_layout = QVBoxLayout(progress_group)
        progress_layout.setContentsMargins(15, 10, 15, 15)
        progress_layout.setSpacing(8)

        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        self.progress_bar.setToolTip("대기 중...")
        progress_layout.addWidget(self.progress_bar)

        layout.addWidget(progress_group, 0)

        # 로그 그룹
        log_group = QGroupBox("📋 실행 로그")
        log_layout = QVBoxLayout(log_group)
        log_layout.setContentsMargins(10, 5, 10, 10)
        log_layout.setSpacing(8)

        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMinimumHeight(120)
        self.log_text.setStyleSheet("background-color: #f8f9fa; border: 1px solid #dee2e6;")
        log_layout.addWidget(self.log_text, 1)

        layout.addWidget(log_group, 3)

        # 제작자 정보
        creator_group = QGroupBox("👨‍💻 제작자 정보")
        creator_layout = QVBoxLayout(creator_group)
        creator_layout.setContentsMargins(15, 5, 15, 15)
        creator_layout.setSpacing(5)

        creator_name = QLabel("Developer : @s_lucky_jam")
        creator_name.setStyleSheet("color: #007bff; font-size: 13px; font-weight: bold;")
        creator_layout.addWidget(creator_name)

        creator_id = QLabel("Idea : 소리 빛")
        creator_id.setStyleSheet("color: #28a745; font-size: 12px; font-weight: bold;")
        creator_layout.addWidget(creator_id)

        layout.addWidget(creator_group, 0)

        return panel

    def setup_bottom_buttons(self, layout):
        """하단 버튼 영역 설정"""
        button_layout = QHBoxLayout()
        button_layout.addStretch()

        self.reset_btn = QPushButton("🔄 초기화")
        self.reset_btn.setObjectName("secondaryButton")
        self.reset_btn.clicked.connect(self.reset_all)
        button_layout.addWidget(self.reset_btn)

        self.start_btn = QPushButton("🚀 파일 복사 시작")
        self.start_btn.clicked.connect(self.start_copy)
        button_layout.addWidget(self.start_btn)

        layout.addLayout(button_layout)

    def center_window(self):
        """창을 화면 중앙에 배치"""
        screen = QApplication.desktop().screenGeometry()
        size = self.geometry()
        self.move(
            (screen.width() - size.width()) // 2,
            (screen.height() - size.height()) // 2
        )

    def reset_ui_state(self):
        """UI 초기 상태 설정"""
        self.progress_bar.setValue(0)

    def browse_source(self):
        """원본 폴더 선택"""
        folder = QFileDialog.getExistingDirectory(self, "원본 폴더 선택")
        if folder:
            self.source_path_edit.setText(folder)
            self.scan_extensions(folder)

    def browse_dest(self):
        """저장 폴더 선택"""
        folder = QFileDialog.getExistingDirectory(self, "저장 폴더 선택")
        if folder:
            self.dest_path_edit.setText(folder)

    def scan_extensions(self, folder_path):
        """폴더의 파일 확장자들을 스캔"""
        self.progress_bar.setToolTip("파일 스캔 중...")
        self.progress_bar.setVisible(True)
        self.progress_bar.setRange(0, 0)

        self.scan_thread = FileScanThread(folder_path)
        self.scan_thread.scan_progress.connect(self.progress_bar.setToolTip)
        self.scan_thread.scan_complete.connect(self.on_scan_complete)
        self.scan_thread.start()

    def on_scan_complete(self, extensions, file_count):
        """스캔 완료 시 호출"""
        self.progress_bar.setVisible(False)

        self.extension_combo.clear()
        self.extension_combo.addItem("모든 파일")

        if extensions:
            for ext in extensions:
                self.extension_combo.addItem(ext)

            if len(extensions) == 1:
                self.extension_combo.setCurrentText(extensions[0])
                self.log(f"확장자 자동 선택: {extensions[0]} ({file_count}개 파일)")
            else:
                self.log(f"발견된 확장자: {', '.join(extensions)} ({file_count}개 파일)")
        else:
            self.log("폴더에 파일이 없습니다.")

        self.progress_bar.setToolTip("스캔 완료")

    def select_files(self):
        """파일 선택 다이얼로그"""
        files, _ = QFileDialog.getOpenFileNames(
            self, "복사할 파일들을 선택하세요", "",
            "모든 파일 (*);;이미지 파일 (*.jpg *.jpeg *.png *.gif *.bmp);;문서 파일 (*.txt *.doc *.pdf);;RAW 파일 (*.raw *.rwa *.cr3)"
        )
        if files:
            file_names = [Path(f).stem for f in files]
            self.numbers_text.setPlainText('\n'.join(file_names))
            self.log(f"{len(files)}개의 파일이 선택되었습니다. (확장자 제거됨)")

    def load_text_file(self):
        """텍스트 파일 로드"""
        file_path, _ = QFileDialog.getOpenFileName(
            self, "텍스트 파일 선택", "", "텍스트 파일 (*.txt);;모든 파일 (*)"
        )
        if file_path:
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.numbers_text.setPlainText(content)
                self.log(f"텍스트 파일 로드됨: {file_path}")
            except Exception as e:
                QMessageBox.critical(self, "오류", f"파일을 읽을 수 없습니다: {e}")

    def get_input_list(self):
        """입력된 텍스트에서 목록 추출 (숫자, 파일명, 경로 지원)"""
        text = self.numbers_text.toPlainText().strip()

        if not text:
            raise ValueError("내용을 입력해주세요.")

        items = []

        for line in text.split('\n'):
            line = line.strip()
            if not line:
                continue

            if os.path.sep in line or '.' in line:
                items.append(line)
            else:
                for part in re.split(r'[,\s/]+', line):
                    part = part.strip()
                    if part:
                        items.append(part)

        if not items:
            raise ValueError("유효한 입력이 없습니다.")

        return items

    def find_files(self, source_dir, input_items):
        """입력 항목에 해당하는 파일들 찾기 (숫자, 파일명, 경로 지원)"""
        source_path = Path(source_dir)
        found_files = []

        if not source_path.exists():
            raise FileNotFoundError(f"원본 폴더가 존재하지 않습니다: {source_dir}")

        extension_filter = self.extension_combo.currentText()
        if extension_filter == "모든 파일":
            extension_filter = None

        all_files = []
        for root, dirs, files in os.walk(source_path):
            for file in files:
                file_path = Path(root) / file
                if extension_filter is None or file_path.suffix.lower() == extension_filter.lower():
                    all_files.append(file_path)

        self.log(f"총 {len(all_files)}개의 파일을 검색 중... (필터: {extension_filter or '없음'})")

        for item in input_items:
            found = False

            # 1. 절대 경로
            if os.path.exists(item):
                found_files.append((item, Path(item)))
                found = True
                self.log(f"경로로 찾음: {item}")
            else:
                # 2. 정확한 파일명 (확장자 포함)
                for file_path in all_files:
                    if file_path.name == item:
                        found_files.append((item, file_path))
                        found = True
                        self.log(f"파일명으로 찾음: {item}")
                        break

                # 3. 스템 일치 (확장자 제거)
                if not found:
                    for file_path in all_files:
                        if file_path.stem == item:
                            found_files.append((item, file_path))
                            found = True
                            self.log(f"파일명 매칭: {item} -> {file_path.name}")
                            break

                # 4. 숫자 접미사 일치
                if not found:
                    for file_path in all_files:
                        file_name_without_ext = file_path.stem

                        if len(file_name_without_ext) >= 5:
                            last_5_chars = file_name_without_ext[-5:]
                            extracted_numbers = re.findall(r'\d+', last_5_chars)
                            if extracted_numbers:
                                combined_number = ''.join(extracted_numbers).lstrip('0') or '0'
                                input_number = item.lstrip('0') or '0'

                                if input_number == combined_number:
                                    found_files.append((item, file_path))
                                    found = True
                                    self.log(f"숫자로 찾음: {item} -> {file_path.name}")
                                    break

                        elif item in file_path.name:
                            found_files.append((item, file_path))
                            found = True
                            self.log(f"포함으로 찾음: {item} -> {file_path.name}")
                            break

            if not found:
                self.log(f"경고: '{item}'에 해당하는 파일을 찾을 수 없습니다.")

        return found_files

    def copy_files(self, found_files, dest_dir):
        """파일들 복사"""
        dest_path = Path(dest_dir)
        dest_path.mkdir(parents=True, exist_ok=True)

        copied_count = 0
        failed_count = 0

        for i, (number, source_file) in enumerate(found_files):
            try:
                dest_file = dest_path / source_file.name

                counter = 1
                original_dest = dest_file
                while dest_file.exists():
                    stem = original_dest.stem
                    suffix = original_dest.suffix
                    dest_file = dest_path / f"{stem}_{counter}{suffix}"
                    counter += 1

                shutil.copy2(source_file, dest_file)
                self.log(f"복사됨: {source_file.name} -> {dest_file.name}")
                copied_count += 1

                progress = int((i + 1) / len(found_files) * 100)
                self.progress_bar.setValue(progress)

            except Exception as e:
                self.log(f"복사 실패: {source_file.name} - {e}")
                failed_count += 1

        return copied_count, failed_count

    def start_copy(self):
        """파일 복사 시작"""
        try:
            if not self.source_path_edit.text():
                QMessageBox.warning(self, "경고", "원본 폴더를 선택해주세요.")
                return

            if not self.dest_path_edit.text():
                QMessageBox.warning(self, "경고", "저장 폴더를 선택해주세요.")
                return

            input_items = self.get_input_list()
            self.log(f"입력된 항목 개수: {len(input_items)}")

            self.progress_bar.setVisible(True)
            self.progress_bar.setValue(0)
            self.progress_bar.setRange(0, 100)
            self.progress_bar.setToolTip("파일 검색 중...")

            found_files = self.find_files(self.source_path_edit.text(), input_items)

            if not found_files:
                QMessageBox.warning(self, "경고", "해당하는 파일을 찾을 수 없습니다.")
                return

            self.progress_bar.setToolTip("파일 복사 중...")

            copied_count, failed_count = self.copy_files(found_files, self.dest_path_edit.text())

            self.progress_bar.setValue(100)
            self.progress_bar.setToolTip("복사 완료")

            QMessageBox.information(
                self, "완료",
                f"복사 완료!\n성공: {copied_count}개\n실패: {failed_count}개"
            )

        except Exception as e:
            self.progress_bar.setValue(0)
            self.progress_bar.setToolTip("오류 발생")
            QMessageBox.critical(self, "오류", f"오류가 발생했습니다: {e}")
            self.log(f"오류: {e}")

    def reset_all(self):
        """모든 입력 초기화"""
        self.source_path_edit.clear()
        self.dest_path_edit.clear()
        self.numbers_text.clear()
        self.log_text.clear()
        self.extension_combo.clear()
        self.extension_combo.addItem("폴더를 먼저 선택하세요")
        self.progress_bar.setValue(0)
        self.progress_bar.setVisible(False)
        self.progress_bar.setToolTip("대기 중...")

    def log(self, message):
        """로그 메시지 추가"""
        self.log_text.append(f"{message}")
        scrollbar = self.log_text.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("파일 복사 프로그램")
    app.setWindowIcon(QIcon("icon.ico"))

    window = ModernFileCopier()
    window.show()

    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
