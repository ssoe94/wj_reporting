"""Generate clean, illustrative previews of the five current board layouts.

The SVGs show layout and labels only. They contain no date, account, MES result,
production status, defect count, or other value that could be mistaken for live data.
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
            f'<desc id="desc">{escape(description)}. 화면 구성 예시이며 실시간 데이터가 아닙니다.</desc>',
            f'<rect width="1280" height="720" fill="{background}"/>',
        ]

    def rect(self, x, y, w, h, fill="#fff", stroke="none", radius=0, sw=1):
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')

    def line(self, x1, y1, x2, y2, color=BORDER, sw=1):
        self.parts.append(f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" stroke="{color}" stroke-width="{sw}"/>')

    def path(self, d, color=BLUE, sw=2, dash=""):
        attr = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"{attr}/>')

    def text(self, x, y, value, size=18, color=INK, weight=600, anchor="start"):
        self.parts.append(f'<text x="{x}" y="{y}" fill="{color}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}">{escape(str(value))}</text>')

    def pill(self, x, y, w, value, fill="#e9f2f8", color=BLUE):
        self.rect(x, y, w, 28, fill, radius=14)
        self.text(x + w / 2, y + 19, value, 13, color, 800, "middle")

    def panel(self, x, y, w, h, title=None, fill="#fff", radius=11):
        self.rect(x, y, w, h, fill, BORDER, radius)
        if title:
            self.text(x + 15, y + 29, title, 21, INK, 850)
            self.line(x + 15, y + 42, x + w - 15, y + 42, "#e1e8ee")

    def ghost(self, x, y, w, h=9, color="#d9e4eb"):
        self.rect(x, y, w, h, color, radius=h / 2)

    def bar(self, x, y, w, fraction, color=BLUE, h=8):
        self.rect(x, y, w, h, "#e1e9ef", radius=h / 2)
        self.rect(x, y, max(4, w * fraction), h, color, radius=h / 2)

    def save(self, name):
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / name).write_text("\n".join([*self.parts, "</svg>"]) + "\n", encoding="utf-8")


def overview():
    s = Svg("WJ 종합 운영 현황판", "현재 3×3 비디오월 구성")
    xs, ys = (6, 431, 856), (6, 245, 484)
    titles = (
        ("사출 생산", "", "조립 생산"),
        ("사출 설비 생산 현황", "종합 운영 현황", "생산 모델 · 품질 이력"),
        ("출고 실행 · JIT / CSKD", "에너지", "금형 / 유지보수"),
    )
    for row, y in enumerate(ys):
        for col, x in enumerate(xs):
            s.panel(x, y, 418, 230, titles[row][col] or None)

    for x, accent in ((6, BLUE), (856, "#378763")):
        s.text(x + 18, 82, "계획", 13, MUTED)
        s.ghost(x + 18, 96, 134, 18)
        s.text(x + 18, 147, "실적", 13, MUTED)
        s.ghost(x + 18, 161, 100, 18)
        s.rect(x + 232, 60, 165, 122, "#f5f8fb", BORDER, 8)
        s.text(x + 247, 83, "완료율", 13, MUTED)
        s.text(x + 247, 123, "—%", 28, accent, 850)
        s.bar(x + 247, 139, 133, .42, accent)
        s.text(x + 247, 169, "시간 진행률", 12, MUTED)
        s.line(x + 17, 193, x + 401, 193)
        s.text(x + 20, 215, "시간 대비  ·  종료 전망  ·  잔여 수량", 12, MUTED)

    s.text(457, 46, "WJ", 22, BLUE, 900)
    s.text(644, 46, "WJ 통합 운영 센터", 25, INK, 900, "middle")
    s.text(488, 91, "북경 현재 시각", 13, MUTED)
    s.text(682, 91, "난징 날씨", 13, MUTED)
    s.text(488, 135, "--:--", 37, INK, 850)
    s.text(682, 135, "--°C", 35, BLUE, 850)
    for i, label in enumerate(("사출 진도", "조립 진도", "가동 감지", "습도", "바람")):
        x = 448 + i * 77
        s.rect(x, 166, 72, 42, "#f7fafc", BORDER, 5)
        s.text(x + 36, 190, label, 11, BLUE, 750, "middle")
    s.ghost(451, 218, 371, 6)

    for i in range(3):
        y = 299 + i * 49
        s.rect(21, y, 386, 43, "#f8fbfd", "#d6e3e8", 7)
        s.text(34, y + 28, f"{i + 1:02}호기", 15, INK, 800)
        s.ghost(125, y + 16, 116, 10)
        s.bar(272, y + 19, 115, (.46, .64, .34)[i], "#4b9272", 7)
    s.text(21, 445, "설비별 실적 / 계획 · 60분 Shot", 12, MUTED)

    s.rect(447, 300, 387, 101, "#f7fafc", BORDER, 8)
    s.text(463, 328, "현재 우선 확인 항목", 15, INK, 750)
    s.ghost(463, 346, 274, 9)
    s.ghost(463, 369, 219, 9)
    for i, label in enumerate(("사출 진도", "조립 진도", "진도 지연", "무계획 가동")):
        x = 449 + i * 96
        s.rect(x, 418, 90, 40, "#f2f7fa", BORDER, 5)
        s.text(x + 45, 442, label, 11, MUTED, 700, "middle")

    s.rect(871, 300, 386, 32, "#edf4fa", radius=6)
    s.text(884, 321, "당일 모델과 연결된 과거 품질 이력", 13, BLUE, 750)
    s.text(885, 364, "모델 · 품번", 18, INK, 800)
    s.ghost(886, 380, 332, 10)
    s.ghost(886, 404, 277, 9)
    s.ghost(886, 428, 221, 9)

    for label, y, color in (("JIT", 552, BLUE), ("CSKD", 630, "#398760")):
        s.text(22, y, label, 17, color, 850)
        s.bar(102, y - 10, 295, .61 if label == "JIT" else .38, color)
        s.text(102, y + 22, "실적 / 목표 · 출고단 계획시간 기준", 12, MUTED)

    s.text(449, 552, "금일 누적", 13, MUTED)
    s.text(449, 598, "— kWh", 29, INK, 850)
    for i, h in enumerate((46, 74, 58, 91, 79, 107, 85, 94)):
        s.rect(606 + i * 26, 690 - h, 16, h, "#7ca5c8", radius=3)
    s.text(872, 554, "총 금형", 13, MUTED)
    s.text(872, 594, "—", 31, INK, 850)
    for i, label in enumerate(("생산 중", "수리 중", "예방점검")):
        s.text(874, 622 + i * 27, label, 13, MUTED)
        s.ghost(974, 613 + i * 27, 71, 12)
    for i, h in enumerate((26, 37, 28, 48, 33, 22, 44)):
        s.rect(1071 + i * 24, 688 - h, 13, h, "#7699bd", radius=2)
    s.save("overview-board.svg")


def injection():
    s = Svg("사출 실시간 현황판", "상단 상태 카드 3개와 17대 설비 카드 배치")
    s.rect(5, 5, 1270, 60, "#fff", BORDER, 8)
    s.rect(18, 16, 42, 39, "#eaf4fa", radius=7)
    s.text(39, 43, "▥", 25, BLUE, 700, "middle")
    s.text(73, 28, "INJECTION LIVE BOARD", 12, BLUE, 800)
    s.text(73, 52, "사출 실시간 현황판", 25, INK, 850)
    s.pill(1044, 21, 84, "KOR")
    s.pill(1140, 21, 119, "1분 자동 갱신", "#eaf4ee", "#347958")

    for i, (label, color, value) in enumerate((
        ("전체 가동 현황", "#3478a3", "— / 17"),
        ("계획 생산 진도", "#347a5a", "—%"),
        ("즉시 확인 필요", "#a74d31", "—대"),
    )):
        x = 5 + i * 255
        s.rect(x, 73, 249, 154, color, radius=7)
        s.text(x + 15, 100, f"0{i + 1}  {label}", 17, "#edf5f9", 800)
        s.text(x + 125, 151, value, 36, "#fff", 850, "middle")
        s.line(x + 16, 169, x + 233, 169, "#ffffff77")
        s.text(x + 16, 199, "계획 · 실적 · 최근 형합", 13, "#e6f0f3")

    for idx in range(17):
        slot = idx + 3
        row, col = divmod(slot, 5)
        x, y = 5 + col * 255, 73 + row * 162
        s.rect(x, y, 249, 150, "#fff", "#7992a5", 7, 2)
        s.rect(x, y, 7, 150, "#7d95a5", radius=4)
        s.text(x + 16, y + 30, f"{idx + 1}호기", 21, INK, 850)
        s.pill(x + 167, y + 9, 68, "상태", "#eef3f6", "#607585")
        s.ghost(x + 17, y + 52, 156, 10)
        for j, label in enumerate(("현재 C/T", "달성률")):
            bx = x + 16 + j * 112
            s.rect(bx, y + 74, 106, 52, "#f7fafc", BORDER, 3)
            s.text(bx + 53, y + 92, label, 11, MUTED, 700, "middle")
            s.text(bx + 53, y + 115, "—", 21, INK, 800, "middle")
        s.ghost(x + 16, y + 137, 216, 6)
    s.save("injection-board.svg")


def mould():
    s = Svg("금형 실시간 현황판", "사출기 장착 현황과 C·B·A·S 보관 구역")
    s.rect(6, 5, 1268, 68, "#fff", BORDER, 9)
    s.text(23, 29, "사출 금형 관리", 13, BLUE, 800)
    s.text(23, 57, "금형 실시간 현황판", 25, INK, 850)
    s.rect(620, 17, 292, 43, "#f7fafc", BORDER, 7)
    s.text(637, 45, "금형 코드·금형명·위치 검색", 14, "#96a6b3")
    s.pill(924, 23, 66, "KOR")
    s.pill(1124, 23, 133, "위치 새로고침")
    s.rect(6, 80, 1268, 54, "#fff", BORDER, 8)
    for i, label in enumerate(("전체", "장착", "보관", "수리", "외부", "미확인")):
        x = 17 + i * 111
        s.rect(x, 91, 104, 33, "#2e629a" if i == 0 else "#f8fafc", "#d3dfe8", 5)
        s.text(x + 52, 113, label, 14, "#fff" if i == 0 else INK, 800, "middle")
    s.panel(6, 142, 598, 572, "사출기 장착 현황")
    s.text(552, 171, "설비별", 13, MUTED, 700, "end")
    s.rect(483, 183, 105, 28, "#eff4f8", BORDER, 5)
    s.text(535, 203, "그래픽 · 테이블", 12, BLUE, 750, "middle")
    for idx in range(15):
        row, col = divmod(idx, 3)
        x, y = 17 + col * 195, 223 + row * 92
        s.rect(x, y, 184, 84, "#fff", "#cad9e5", 7)
        s.rect(x + 8, y + 29, 47, 39, "#eaf2f7", radius=5)
        s.text(x + 31, y + 54, "▰", 18, "#547991", 800, "middle")
        s.text(x + 9, y + 22, f"{idx + 1}호기", 14, INK, 800)
        s.text(x + 63, y + 49, "장착 금형", 12, MUTED)
        s.ghost(x + 63, y + 58, 94, 8)

    s.panel(613, 142, 661, 572, "보관 인벤토리")
    s.text(1227, 172, "좌표 안내 · 점검 알림", 12, MUTED, 700, "end")
    s.rect(626, 192, 635, 303, "#fff", "#5d929b", 8, 2)
    s.rect(640, 206, 34, 31, "#315f70", radius=6)
    s.text(657, 228, "C", 20, "#fff", 850, "middle")
    s.text(686, 229, "C존", 20, INK, 850)
    for row in range(8):
        for col in range(17):
            x, y = 639 + col * 22, 260 + row * 24
            tint = "#426f7e" if (row * 5 + col * 7) % 11 < 4 else "#b9c7ce" if (row + col) % 5 < 3 else "#fff"
            s.rect(x, y, 19, 20, tint, "#8298a5", 2)
    s.text(1032, 286, "—%", 34, INK, 850)
    s.text(1118, 285, "보관 점유율", 13, MUTED)
    for i, label in enumerate(("사용 좌표", "금형", "빈 좌표", "중복")):
        x, y = 1024 + (i % 2) * 113, 318 + (i // 2) * 65
        s.rect(x, y, 106, 58, "#f7fafc", BORDER, 6)
        s.text(x + 8, y + 19, label, 12, MUTED)
        s.ghost(x + 8, y + 33, 59, 12)
    for i, (label, fill) in enumerate((("B존", "#eaf5f1"), ("A존", "#eef4f8"), ("S존", "#f1f0f7"))):
        x = 626 + i * 213
        s.rect(x, 505, 205, 193, fill, BORDER, 8)
        s.text(x + 14, 536, label, 20, INK, 850)
        s.text(x + 14, 576, "—%", 28, BLUE, 850)
        for row in range(4):
            for col in range(7):
                s.rect(x + 14 + col * 25, 592 + row * 22, 21, 17, "#557c8c" if (row + col + i) % 3 else "#fff", "#a7bac7", 2)
    s.save("mould-board.svg")


def energy():
    s = Svg("사출 전력 사용 현황판", "6개 지표와 시간대별 사용량·효율 추이 구성")
    s.rect(14, 14, 1252, 111, "#fff", BORDER, 16)
    s.rect(33, 35, 62, 62, BLUE, radius=14)
    s.text(64, 79, "ϟ", 43, "#fff", 700, "middle")
    s.text(111, 48, "INJECTION ENERGY BOARD", 14, BLUE, 900)
    s.text(111, 80, "사출 전력 사용 현황판", 27, INK, 900)
    s.text(111, 105, "사출기 누적 전력계와 생산 효율", 14, MUTED)
    s.pill(1019, 52, 99, "KOR")
    s.pill(1130, 52, 116, "10분 자동 갱신", "#eaf4ee", "#347958")
    metrics = (
        ("금일 누적 사용량", "— kWh"),
        ("전일 동시간 대비", "—%"),
        ("최근 7일 평균 대비", "—%"),
        ("최대 사용 시간대", "—"),
        ("1,000 Shot당 전력", "—"),
        ("전력 계측 설비", "— / 17"),
    )
    for i, (label, value) in enumerate(metrics):
        row, col = divmod(i, 3)
        x, y = 14 + col * 422, 139 + row * 99
        s.rect(x, y, 408, 90, "#376b99" if i == 0 else "#fff", BORDER, 10)
        s.text(x + 18, y + 28, label, 15, "#e7eff6" if i == 0 else MUTED, 750)
        s.text(x + 18, y + 68, value, 28, "#fff" if i == 0 else INK, 850)

    s.panel(14, 348, 762, 359, "시간대별 전체 전력 사용량")
    s.text(29, 402, "08:00부터 다음 날 08:00까지 · kWh", 13, MUTED)
    for y in (445, 505, 565, 625, 685):
        s.line(71, y, 754, y, "#e2e9ee")
    heights = (58, 89, 118, 150, 174, 168, 183, 159, 141, 126, 104, 84)
    for i, height in enumerate(heights):
        s.rect(85 + i * 54, 683 - height, 26, height, "#4c81ad", radius=4)
    s.path("M97 600 L151 579 L205 568 L259 551 L313 530 L367 526 L421 514 L475 525 L529 546 L583 559 L637 575 L691 593", "#d18a24", 2, "6 5")
    s.text(84, 699, "08:00", 12, MUTED)
    s.text(678, 699, "익일 08:00", 12, MUTED)

    s.panel(789, 348, 477, 170, "1,000 Shot당 전력 추이")
    for y in (422, 460, 498):
        s.line(812, y, 1242, y, "#e2e9ee")
    s.path("M816 482 L855 458 L894 468 L933 435 L972 451 L1011 426 L1050 439 L1089 411 L1128 425 L1167 406 L1206 415", "#176f9f", 3)
    s.path("M816 469 L855 475 L894 456 L933 469 L972 443 L1011 455 L1050 433 L1089 443 L1128 422 L1167 432 L1206 418", "#d18a24", 2, "6 5")
    s.panel(789, 530, 477, 177, "주간조·야간조 비교")
    for i, label in enumerate(("주간조", "야간조")):
        y = 585 + i * 58
        s.text(808, y, label, 14, INK, 800)
        s.bar(881, y - 12, 344, .67 if i == 0 else .46, "#176f9f", 9)
        s.bar(881, y + 6, 344, .53 if i == 0 else .57, "#d18a24", 7)
    s.save("energy-board.svg")


def field():
    s = Svg("현장 칸반", "사출기 1~17호기 선택 및 현장 자료·가공 라인 입구")
    s.rect(14, 14, 1252, 108, "#fff", BORDER, 16)
    s.rect(32, 32, 65, 65, "#0754a8", radius=16)
    s.text(64, 75, "▣", 37, "#fff", 700, "middle")
    s.text(112, 48, "WJ DATA CENTER · 현장 터미널", 13, BLUE, 850)
    s.text(112, 80, "현장 칸반", 32, INK, 900)
    s.text(112, 104, "사출기를 선택하면 작업지도서·도면·품질Issue를 엽니다", 14, MUTED)
    s.pill(1010, 51, 119, "현황판 센터")
    s.pill(1140, 51, 105, "KOR")

    s.panel(14, 135, 1252, 421)
    s.text(32, 174, "사출기 선택", 25, INK, 900)
    s.text(32, 199, "1–17호기 · 누르면 현장 터치스크린 열기", 14, MUTED)
    for i, (label, color) in enumerate((("자료 완비", "#168251"), ("자료 누락", "#ad6a10"), ("계획 없음", "#80909c"))):
        s.pill(870 + i * 126, 160, 117, label, "#f5f8fa", color)

    for idx in range(17):
        row, col = divmod(idx, 9)
        x, y = 32 + col * 136, 223 + row * 153
        s.rect(x, y, 127, 140, "#f8fbfd", "#a8bdcc", 10, 2)
        s.rect(x + 108, y + 9, 9, 9, "#7e9aad", radius=5)
        s.text(x + 63, y + 59, f"{idx + 1:02}", 36, "#3b6684", 900, "middle")
        s.text(x + 63, y + 78, "호기", 12, MUTED, 850, "middle")
        s.ghost(x + 29, y + 96, 69, 7)
        s.ghost(x + 38, y + 113, 51, 6)

    s.panel(14, 571, 674, 135)
    s.rect(32, 590, 52, 52, "#0754a8", radius=12)
    s.text(58, 623, "▣", 24, "#fff", 800, "middle")
    s.text(99, 609, "현장 자료 통합 관리", 21, INK, 850)
    s.text(99, 637, "작업지도서 · 도면 · 품질Issue", 14, MUTED)
    s.pill(529, 606, 132, "자료 업데이트", "#eaf2fa", BLUE)
    s.panel(701, 571, 565, 135)
    s.text(719, 609, "가공 라인", 21, INK, 850)
    for i, letter in enumerate("ABCD"):
        s.pill(722 + i * 127, 625, 111, f"{letter}线", "#edf5fa", BLUE)
    s.save("field-kanban.svg")


if __name__ == "__main__":
    overview()
    injection()
    mould()
    energy()
    field()
