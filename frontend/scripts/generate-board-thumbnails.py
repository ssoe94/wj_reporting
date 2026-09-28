"""Build static, illustrative previews of the five board layouts.

The previews intentionally omit dates and live MES values. Update their layout
when a board changes; they are never a snapshot or a data source.
"""

from html import escape
from pathlib import Path


OUT = Path(__file__).resolve().parents[1] / "public" / "board-thumbnails"
INK = "#17324b"
MUTED = "#667d90"
BLUE = "#356fa1"
BORDER = "#cbd8e2"
FONT = "Inter, Noto Sans KR, Noto Sans SC, Arial, sans-serif"


class Svg:
    def __init__(self, title, description, background="#edf3f7"):
        self.parts = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-labelledby="title desc">',
            f'<title id="title">{escape(title)}</title>',
            f'<desc id="desc">{escape(description)} 정적 화면 구성 예시이며 실시간 데이터가 아닙니다.</desc>',
            f'<rect width="1280" height="720" fill="{background}"/>',
        ]

    def rect(self, x, y, w, h, fill="#fff", stroke="none", radius=0, sw=1):
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')

    def line(self, x1, y1, x2, y2, color=BORDER, sw=1):
        self.parts.append(f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" stroke="{color}" stroke-width="{sw}"/>')

    def text(self, x, y, value, size=18, color=INK, weight=600, anchor="start"):
        self.parts.append(f'<text x="{x}" y="{y}" fill="{color}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}">{escape(str(value))}</text>')

    def pill(self, x, y, w, value, fill="#e9f2f8", color=BLUE):
        self.rect(x, y, w, 28, fill, radius=14)
        self.text(x + w / 2, y + 19, value, 13, color, 800, "middle")

    def panel(self, x, y, w, h, title=None, fill="#fff", radius=11):
        self.rect(x, y, w, h, fill, BORDER, radius)
        if title:
            self.text(x + 15, y + 28, title, 20, INK, 850)
            self.line(x + 15, y + 41, x + w - 15, y + 41, "#e1e8ee")

    def bar(self, x, y, w, fraction, color=BLUE, h=8):
        self.rect(x, y, w, h, "#e1e9ef", radius=h / 2)
        self.rect(x, y, max(4, w * fraction), h, color, radius=h / 2)

    def save(self, name):
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / name).write_text("\n".join([*self.parts, "</svg>"]) + "\n", encoding="utf-8")


def overview():
    s = Svg("WJ 종합 운영 현황판", "현재 3×3 비디오월 배치")
    x_positions = (5, 430, 855)
    y_positions = (5, 244, 483)
    titles = (
        ("사출 생산", "WJ 통합 운영 센터", "조립 생산"),
        ("사출 설비 생산 현황", "종합 운영 현황", "생산 모델 · 품질 이력"),
        ("출고 실행 · JIT / CSKD", "에너지", "금형 / 유지보수"),
    )
    for row, y in enumerate(y_positions):
        for col, x in enumerate(x_positions):
            s.panel(x, y, 420, 232, None if (row, col) == (0, 1) else titles[row][col])
    for x, label, accent in ((5, "사출", BLUE), (855, "조립", "#378763")):
        s.text(x + 24, 87, "계획", 14, MUTED)
        s.text(x + 24, 127, "22,690" if label == "사출" else "2,144", 34, INK, 850)
        s.text(x + 24, 162, "실적 10,159" if label == "사출" else "실적 955", 17, MUTED)
        s.rect(x + 238, 62, 164, 119, "#f4f7fa", BORDER, 9)
        s.text(x + 253, 88, "완료율", 14, MUTED)
        s.text(x + 253, 127, "44.8%" if label == "사출" else "44.5%", 31, accent, 850)
        s.bar(x + 253, 144, 129, .45, accent)
        s.line(x + 16, 193, x + 403, 193)
        s.text(x + 23, 218, "현재 시간 목표  ·  종료 전망  ·  잔여 수량", 13, MUTED)
    s.text(641, 43, "WJ 통합 운영 센터", 28, INK, 900, "middle")
    s.text(514, 103, "19:09", 43, "#1d3654", 850)
    s.text(702, 103, "20.6°C", 39, BLUE, 850)
    s.text(514, 132, "북경 현재 시각", 13, MUTED)
    s.text(702, 132, "난징 날씨", 13, MUTED)
    for col, value in enumerate(("사출 진도", "조립 진도", "가동 감지")):
        s.rect(449 + col * 126, 169, 120, 43, "#f7fafc", BORDER, 5)
        s.text(509 + col * 126, 195, value, 14, BLUE, 750, "middle")
    for i, (machine, pct) in enumerate((("2호기", ".53"), ("3호기", ".43"), ("4호기", ".38"))):
        y = 299 + i * 52
        s.rect(21, y, 388, 46, "#f5faf8", "#d6e3df", 7)
        s.text(36, y + 29, machine, 17, INK, 800)
        s.text(150, y + 28, "생산 중", 14, "#357a57")
        s.bar(266, y + 22, 119, float(pct), "#347e66", 7)
    for i, sentence in enumerate(("생산 진도 확인", "설비 가동 확인", "품질 이력 확인")):
        y = 299 + i * 52
        s.rect(447, y, 391, 46, "#f7fafc", BORDER, 7)
        s.pill(457, y + 9, 29, str(i + 1), "#dce9f5", BLUE)
        s.text(499, y + 29, sentence, 17, INK, 700)
    s.rect(871, 299, 388, 34, "#eef4fa", radius=6)
    s.text(887, 322, "AI 품질 브리핑 · 과거 이력", 15, BLUE, 750)
    s.text(887, 366, "생산 모델별 품질 보고 요약", 18, INK, 800)
    for i, value in enumerate(("관련 보고", "과거 유형", "확인 포인트")):
        s.text(887, 406 + i * 37, value, 15, MUTED)
        s.line(984, 404 + i * 37, 1240, 404 + i * 37, "#c8d7e5", 7)
    for x, label, pct in ((22, "JIT", .78), (22, "CSKD", .92)):
        y = 548 if label == "JIT" else 625
        s.text(x, y + 20, label, 17, BLUE, 800)
        s.bar(x + 61, y + 10, 321, pct, "#3b7c9f" if label == "JIT" else "#398760")
        s.text(x + 61, y + 41, "출고 목표 대비 실적", 13, MUTED)
    s.text(447, 547, "금일 누적", 14, MUTED)
    s.text(447, 593, "3,672.5 kWh", 31, INK, 850)
    for i, height in enumerate((49, 88, 68, 103, 118, 92, 132, 115)):
        s.rect(610 + i * 26, 691 - height, 15, height, "#7ca5c8", radius=3)
    s.text(872, 549, "총 금형", 14, MUTED)
    s.text(872, 589, "545", 35, INK, 850)
    for i, (label, value) in enumerate((("생산 중", "9"), ("수리 중", "2"), ("예방점검", "93"))):
        y = 610 + i * 28
        s.text(873, y, label, 15, MUTED)
        s.text(1010, y, value, 18, BLUE, 850)
    s.save("overview-board.svg")


def injection():
    s = Svg("사출 실시간 현황판", "상단 3개 상태 카드와 17대 설비 카드 배치")
    s.rect(5, 5, 1270, 60, "#fff", BORDER, 8)
    s.rect(19, 15, 43, 40, "#eaf4fa", radius=7)
    s.text(40, 43, "▥", 25, BLUE, 700, "middle")
    s.text(75, 28, "INJECTION LIVE BOARD", 12, BLUE, 800)
    s.text(75, 53, "사출 실시간 현황판", 25, INK, 850)
    s.pill(1070, 21, 82, "KOR", "#e7f1f8", BLUE)
    s.pill(1164, 21, 95, "자동 갱신", "#eaf4ee", "#347958")
    summaries = (("전체 가동 현황", "11 / 17", "#3478a3"), ("계획 생산 진도", "44.8%", "#347a5a"), ("즉시 확인 필요", "4대", "#a74d31"))
    for i, (label, value, color) in enumerate(summaries):
        x = 5 + i * 255
        s.panel(x, 73, 249, 154, fill=color, radius=7)
        s.text(x + 14, 98, f"0{i + 1}  {label}", 17, "#edf5f9", 800)
        s.text(x + 124, 151, value, 37, "#fff", 850, "middle")
        s.line(x + 16, 169, x + 233, 169, "#ffffff77")
        s.text(x + 16, 198, "계획 설비  ·  생산 진도", 14, "#e6f0f3")
    states = ("비가동", "정상 가동", "정상 가동", "계획 설비 정지", "비가동", "정상 가동", "비가동", "계획 설비 정지", "정상 가동", "진도 확인", "정상 가동", "정상 가동", "비가동", "정상 가동", "정상 가동", "진도 확인", "정상 가동")
    for idx in range(17):
        slot = idx + 3
        row, col = divmod(slot, 5)
        x, y = 5 + col * 255, 73 + row * 164
        if row == 0:
            x, y = 770 + (idx * 255), 73
        status = states[idx]
        color = "#2c8057" if status == "정상 가동" else "#aa513d" if status == "계획 설비 정지" else "#b18427" if status == "진도 확인" else "#7a8791"
        fill = "#f0fbf5" if status == "정상 가동" else "#fff8ed" if status == "진도 확인" else "#fafbfd"
        s.rect(x, y, 249, 154, fill, color, 7, 3)
        s.text(x + 12, y + 28, f"{idx + 1}호기", 21, INK, 850)
        s.pill(x + 142, y + 7, 94, status, color, "#fff")
        s.text(x + 12, y + 56, "생산 모델 / 품번", 12, MUTED)
        s.text(x + 12, y + 86, "현재 C/T", 12, MUTED)
        s.text(x + 141, y + 86, "달성률", 12, MUTED)
        s.text(x + 12, y + 111, "54.7s" if status == "정상 가동" else "—", 23, INK, 800)
        s.text(x + 141, y + 111, "53.1%" if status == "정상 가동" else "—", 23, INK, 800)
        s.bar(x + 12, y + 126, 224, .53 if status == "정상 가동" else .14, color, 6)
    s.save("injection-board.svg")


def mould():
    s = Svg("금형 실시간 현황판", "사출기 장착 현황과 C·B·A·S 보관 구역의 현재 화면 구성")
    s.rect(6, 5, 1268, 68, "#fff", BORDER, 9)
    s.text(23, 29, "사출 금형 관리", 13, BLUE, 800)
    s.text(23, 57, "금형 실시간 현황판", 25, INK, 850)
    s.rect(618, 17, 288, 43, "#f7fafc", BORDER, 7)
    s.text(635, 45, "금형 코드·금형명·위치 검색", 14, "#96a6b3")
    s.pill(920, 23, 66, "KOR")
    s.pill(1129, 23, 126, "위치 새로고침")
    s.rect(6, 80, 1268, 54, "#fff", BORDER, 8)
    for i, (label, value) in enumerate((("전체", "545"), ("장착", "12"), ("보관", "192"), ("수리", "0"), ("외부", "294"), ("미확인", "47"))):
        x = 17 + i * 111
        s.rect(x, 91, 104, 33, "#2e629a" if i == 0 else "#f8fafc", "#d3dfe8", 5)
        s.text(x + 52, 113, f"{label}  {value}", 14, "#fff" if i == 0 else INK, 800, "middle")
    s.panel(6, 142, 598, 572, "사출기 장착 현황")
    s.text(543, 170, "13 / 17대", 19, BLUE, 800, "end")
    for idx in range(12):
        col, row = idx % 2, idx // 2
        x, y = 18 + col * 291, 196 + row * 85
        s.rect(x, y, 279, 76, "#fff", "#cedbe6", 8)
        s.rect(x + 11, y + 19, 76, 40, "#e8f2f7", radius=6)
        s.text(x + 49, y + 45, "▰", 23, "#396981", 800, "middle")
        s.text(x + 98, y + 27, f"{idx + 1}호기 · 850T", 15, INK, 800)
        s.text(x + 98, y + 51, "장착 금형  MOLD-0***", 12, MUTED)
    s.panel(613, 142, 661, 572, "보관 인벤토리")
    s.rect(626, 192, 635, 303, "#fff", "#5d929b", 8, 3)
    s.rect(640, 206, 34, 31, "#315f70", radius=6)
    s.text(657, 228, "C", 21, "#fff", 850, "middle")
    s.text(686, 229, "C존", 21, INK, 850)
    for row in range(9):
        for col in range(17):
            x, y = 639 + col * 21, 258 + row * 22
            tint = "#2e6878" if (row * 5 + col * 7) % 11 < 4 else "#9caab3" if (row + col) % 5 < 3 else "#fff"
            s.rect(x, y, 18, 18, tint, "#718896", 2)
    s.text(1021, 286, "82%", 36, INK, 850)
    s.text(1110, 284, "보관 점유율", 14, MUTED)
    for i, (label, value) in enumerate((("사용 좌표", "133 / 162"), ("금형", "133"), ("빈 좌표", "29"), ("중복", "0"))):
        x, y = 1023 + (i % 2) * 113, 316 + (i // 2) * 65
        s.rect(x, y, 106, 59, "#f7fafc", BORDER, 6)
        s.text(x + 8, y + 19, label, 12, MUTED)
        s.text(x + 8, y + 46, value, 20, INK, 850)
    for i, (label, count, fill) in enumerate((("B존", "75%", "#eaf5f1"), ("A존", "44%", "#eef4f8"), ("S존", "54%", "#f1f0f7"))):
        x = 626 + i * 213
        s.rect(x, 504, 205, 194, fill, BORDER, 8)
        s.text(x + 14, 536, label, 20, INK, 850)
        s.text(x + 14, 577, count, 30, BLUE, 850)
        for row in range(4):
            for col in range(7):
                s.rect(x + 14 + col * 25, 594 + row * 22, 21, 17, "#557c8c" if (row + col + i) % 3 else "#fff", "#a7bac7", 2)
    s.save("mould-board.svg")


def energy():
    s = Svg("사출 전력 사용 현황판", "6개 지표와 시간대별 전력 사용량 그래프의 현재 화면 구성")
    s.rect(14, 14, 1252, 165, "#fff", BORDER, 17)
    s.rect(33, 36, 62, 62, BLUE, radius=14)
    s.text(64, 79, "ϟ", 44, "#fff", 700, "middle")
    s.text(110, 49, "INJECTION ENERGY BOARD", 14, BLUE, 900)
    s.text(110, 81, "사출 전력 사용 현황판", 27, INK, 900)
    s.text(110, 105, "사출기 누적 전력계와 생산 효율", 14, MUTED)
    for i, (label, value) in enumerate((("생산 기준일", "오늘"), ("MES 최신", "자동 수신"), ("자동 갱신", "10분"))):
        x = 33 + i * 124
        s.rect(x, 123, 116, 44, "#f7fafc", BORDER, 7)
        s.text(x + 8, 141, label, 11, MUTED)
        s.text(x + 8, 158, value, 14, INK, 800)
    metrics = (("금일 누적 사용량", "3,616.1 kWh"), ("전일 동시간 대비", "+7885.2%"), ("최근 7일 평균 대비", "+98.1%"), ("최대 사용 시간대", "16:00"), ("1,000 Shot당 전력", "556.07"), ("전력 계측 설비", "17 / 17"))
    for i, (label, value) in enumerate(metrics):
        row, col = divmod(i, 3)
        x, y = 14 + col * 422, 190 + row * 127
        fill = "#376b99" if i == 0 else "#fff"
        s.rect(x, y, 408, 116, fill, BORDER, 13)
        s.text(x + 18, y + 31, label, 16, "#e7eff6" if i == 0 else MUTED, 750)
        s.text(x + 18, y + 75, value, 31, "#fff" if i == 0 else INK, 850)
        s.text(x + 18, y + 99, "동일 경과시간 기준" if i != 0 else "진행 중", 13, "#ddebf4" if i == 0 else MUTED)
    s.panel(14, 452, 1252, 255, "시간대별 전체 전력 사용량")
    s.text(30, 514, "08:00부터 다음 날 08:00까지 · kWh", 15, MUTED)
    for y in (548, 594, 640, 686):
        s.line(88, y, 1245, y, "#e2e9ee")
    for i, height in enumerate((82, 98, 127, 162, 174, 171, 180, 185, 189, 177, 165)):
        s.rect(102 + i * 66, 687 - height, 32, height, "#4c81ad", radius=5)
    s.text(101, 701, "08:00", 13, MUTED)
    s.text(750, 701, "18:00", 13, MUTED)
    s.save("energy-board.svg")


def field():
    s = Svg("현장 칸반", "로그인 후 사출기 1~17호기를 선택하는 현장 칸반 첫 화면")
    s.rect(14, 14, 1252, 105, "#fff", BORDER, 16)
    s.rect(32, 32, 66, 66, "#0754a8", radius=16)
    s.text(65, 75, "▣", 38, "#fff", 700, "middle")
    s.text(113, 48, "WJ DATA CENTER · 현장 터미널", 13, BLUE, 850)
    s.text(113, 80, "현장 칸반", 32, INK, 900)
    s.text(113, 104, "사출기를 선택하면 작업지도서·도면·품질Issue를 엽니다", 14, MUTED)
    s.pill(1032, 52, 103, "현황판 센터")
    s.pill(1145, 52, 97, "KOR")
    s.panel(14, 132, 1252, 446)
    s.text(33, 173, "사출기 선택", 26, INK, 900)
    s.text(33, 200, "1–17호기 · 누르면 현장 터치스크린 열기", 15, MUTED)
    for i, (label, color) in enumerate((("자료 완비", "#168251"), ("자료 누락", "#ad6a10"), ("계획 없음", "#80909c"))):
        s.pill(874 + i * 126, 153, 116, label, "#f5f8fa", color)
    for idx in range(17):
        row, col = divmod(idx, 9)
        x, y = 32 + col * 137, 219 + row * 167
        tone = "#dcefe4" if idx % 4 in (0, 1) else "#fff3d9" if idx % 4 == 2 else "#edf1f4"
        color = "#14814b" if idx % 4 in (0, 1) else "#a66a10" if idx % 4 == 2 else "#788a9b"
        s.rect(x, y, 127, 150, tone, color, 11, 2)
        s.rect(x + 103, y + 11, 10, 10, color, radius=5)
        s.text(x + 63, y + 68, f"{idx + 1:02}", 41, color, 900, "middle")
        s.text(x + 63, y + 88, "호기", 13, color, 850, "middle")
        s.text(x + 63, y + 116, "오늘 계획" if idx % 4 != 3 else "계획 없음", 13, color, 800, "middle")
        s.text(x + 63, y + 136, "자료 상태", 12, color, 700, "middle")
    s.panel(14, 592, 674, 114)
    s.text(32, 628, "현장 자료 통합 관리", 22, INK, 850)
    s.text(32, 661, "작업지도서 · 도면 · 품질Issue", 16, MUTED)
    s.panel(701, 592, 565, 114)
    s.text(719, 628, "가공 라인", 22, INK, 850)
    for i, letter in enumerate("ABCD"):
        s.pill(721 + i * 128, 646, 112, f"{letter} 가공", "#edf5fa", BLUE)
    s.save("field-kanban.svg")


if __name__ == "__main__":
    overview()
    injection()
    mould()
    energy()
    field()
