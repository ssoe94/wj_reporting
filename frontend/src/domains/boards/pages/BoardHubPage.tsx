import type { MouseEvent } from "react";
import { ArrowUpRight, Boxes, Factory, LayoutGrid, LogIn, Radio, Zap } from "lucide-react";
import { Link } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
import { useLang } from "@/i18n";
import styles from "./BoardHubPage.module.css";

const COPY = {
  ko: {
    eyebrow: "WJ DISPLAY CENTER",
    title: "현황판",
    description: "운영 현황을 큰 화면에 맞춘 전용 보드로 확인합니다. 카드를 누르면 새 전체 화면 창으로 열립니다.",
    count: "운영 현황판 3개",
    publicAccess: "로그인 없이 직접 접속",
    login: "관리 화면 로그인",
    dashboard: "관리 화면으로",
    live: "LIVE",
    publicLink: "공개 링크",
    open: "현황판 열기",
    preview: "화면 미리보기",
    injectionTitle: "사출 실시간 현황판",
    injectionDescription: "17대 사출기의 계획, 생산 진도와 최근 C/T를 한 화면에서 확인합니다.",
    injectionMeta: "17대 사출기 · 1분 자동 갱신",
    mouldTitle: "금형 실시간 현황판",
    mouldDescription: "금형의 장착 설비와 Blacklake 기준 A/B/C 보관 위치를 터치로 확인합니다.",
    mouldMeta: "장착 설비 · A/B/C 보관 위치",
    energyTitle: "사출 전력 사용 현황판",
    energyDescription: "17대 사출기의 시간대별 사용량과 전일·7일 평균, 설비별 에너지 효율을 비교합니다.",
    energyMeta: "전력 사용량 · 전일/7일 비교 · 1분 갱신",
  },
  zh: {
    eyebrow: "WJ DISPLAY CENTER",
    title: "看板中心",
    description: "通过适配大屏的专用看板查看运营现状。点击卡片即可在新的全屏窗口中打开。",
    count: "3 个运营看板",
    publicAccess: "无需登录即可直接访问",
    login: "登录管理页面",
    dashboard: "返回管理页面",
    live: "LIVE",
    publicLink: "公开链接",
    open: "打开看板",
    preview: "画面预览",
    injectionTitle: "注塑实时看板",
    injectionDescription: "在一个屏幕中查看 17 台注塑机的计划、生产进度和最近 C/T。",
    injectionMeta: "17 台注塑机 · 每分钟刷新",
    mouldTitle: "模具实时看板",
    mouldDescription: "通过触控查看模具安装设备及基于 Blacklake 的 A/B/C 存放位置。",
    mouldMeta: "安装设备 · A/B/C 存放位置",
    energyTitle: "注塑用电现状看板",
    energyDescription: "比较17台注塑机分时用电、前日与7日平均，以及设备能效。",
    energyMeta: "用电量 · 前日/7日比较 · 每分钟刷新",
  },
} as const;

type BoardCard = {
  key: "injection" | "mould" | "energy";
  href: string;
  image: string;
  title: string;
  description: string;
  meta: string;
  icon: typeof Factory;
};

function openBoard(event: MouseEvent<HTMLAnchorElement>, board: BoardCard) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const popup = window.open(
    board.href,
    `wj-${board.key}-board`,
    "popup=yes,width=1920,height=1080,resizable=yes,scrollbars=yes",
  );
  if (popup) popup.focus();
  else window.location.assign(board.href);
}

export function BoardHubPage() {
  const { isAuthenticated } = useAuth();
  const { lang, setLang } = useLang();
  const copy = COPY[lang];
  const boards: BoardCard[] = [
    {
      key: "injection",
      href: "/boards/injection",
      image: "/board-thumbnails/injection-board.png",
      title: copy.injectionTitle,
      description: copy.injectionDescription,
      meta: copy.injectionMeta,
      icon: Factory,
    },
    {
      key: "mould",
      href: "/boards/moulds",
      image: "/board-thumbnails/mould-board.png",
      title: copy.mouldTitle,
      description: copy.mouldDescription,
      meta: copy.mouldMeta,
      icon: Boxes,
    },
    {
      key: "energy",
      href: "/boards/energy",
      image: "/board-thumbnails/energy-board.svg",
      title: copy.energyTitle,
      description: copy.energyDescription,
      meta: copy.energyMeta,
      icon: Zap,
    },
  ];

  return (
    <section className={styles.page} data-testid="board-hub-page">
      <header className={styles.hero}>
        <div className={styles.brandMark} aria-hidden="true">
          <img alt="" src="/logo-transparent.png" />
        </div>
        <div className={styles.heroCopy}>
          <p>{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <span>{copy.description}</span>
        </div>
        <div className={styles.heroActions}>
          <div className={styles.languageSwitch} aria-label={lang === "ko" ? "언어" : "语言"}>
            <button aria-pressed={lang === "ko"} className={lang === "ko" ? styles.activeLanguage : ""} onClick={() => setLang("ko")} type="button">KOR</button>
            <button aria-pressed={lang === "zh"} className={lang === "zh" ? styles.activeLanguage : ""} onClick={() => setLang("zh")} type="button">中文</button>
          </div>
          <Link className={styles.accountLink} to={isAuthenticated ? "/analysis" : "/login"}>
            <LogIn aria-hidden="true" size={18} />
            {isAuthenticated ? copy.dashboard : copy.login}
          </Link>
        </div>
      </header>

      <div className={styles.summaryBar}>
        <span><LayoutGrid aria-hidden="true" size={18} />{copy.count}</span>
        <span><Radio aria-hidden="true" size={17} />{copy.publicAccess}</span>
      </div>

      <div className={styles.boardGrid}>
        {boards.map((board) => {
          const Icon = board.icon;
          return (
            <a
              aria-label={`${board.title} · ${copy.open}`}
              className={styles.boardCard}
              href={board.href}
              key={board.key}
              onClick={(event) => openBoard(event, board)}
              rel="noopener"
              target="_blank"
            >
              <figure className={styles.thumbnail}>
                <img alt={`${board.title} ${copy.preview}`} src={board.image} />
                <figcaption><Radio aria-hidden="true" size={15} />{copy.live}</figcaption>
              </figure>
              <div className={styles.cardBody}>
                <div className={styles.cardHeading}>
                  <span className={styles.cardIcon}><Icon aria-hidden="true" size={22} /></span>
                  <div><small>{copy.publicLink}</small><h2>{board.title}</h2></div>
                  <ArrowUpRight aria-hidden="true" className={styles.openIcon} size={23} />
                </div>
                <p>{board.description}</p>
                <footer><span>{board.meta}</span><strong>{copy.open}<ArrowUpRight aria-hidden="true" size={16} /></strong></footer>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}
