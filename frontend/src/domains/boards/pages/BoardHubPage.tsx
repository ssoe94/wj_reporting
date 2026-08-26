import { useMemo, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Boxes, Factory, FileUp, LayoutGrid, LockKeyhole, LogIn, Monitor, Radio, Zap } from "lucide-react";
import { Link } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
import { getFieldMaterials, type FieldMaterialModel } from "@/domains/field/api";
import { useLang } from "@/i18n";
import { useShanghaiBusinessDate } from "@/shared/hooks/useShanghaiBusinessDate";
import styles from "./BoardHubPage.module.css";

const COPY = {
  ko: {
    eyebrow: "WJ DISPLAY CENTER",
    title: "현황판",
    description: "운영 현황을 큰 화면에 맞춘 전용 보드로 확인합니다. 카드를 누르면 새 전체 화면 창으로 열립니다.",
    count: "운영 현황판 5개",
    publicAccess: "로그인 없이 직접 접속",
    login: "관리 화면 로그인",
    dashboard: "관리 화면으로",
    live: "LIVE",
    publicLink: "공개 링크",
    open: "현황판 열기",
    preview: "화면 미리보기",
    overviewTitle: "WJ 종합 운영 현황판",
    overviewDescription: "생산·설비·품질·출고·에너지 핵심 지표를 3×3 비디오월에서 한눈에 확인합니다.",
    overviewMeta: "3×3 비디오월 · 1분 자동 갱신",
    injectionTitle: "사출 실시간 현황판",
    injectionDescription: "17대 사출기의 계획, 생산 진도와 최근 C/T를 한 화면에서 확인합니다.",
    injectionMeta: "17대 사출기 · 1분 자동 갱신",
    mouldTitle: "금형 실시간 현황판",
    mouldDescription: "금형의 장착 설비와 Blacklake 기준 A/B/C 보관 위치를 터치로 확인합니다.",
    mouldMeta: "장착 설비 · A/B/C 보관 위치",
    energyTitle: "사출 전력 사용 현황판",
    energyDescription: "17대 사출기의 시간대별 사용량과 전일·7일 평균, 설비별 에너지 효율을 비교합니다.",
    energyMeta: "전력 사용량 · 전일/7일 비교 · 1분 갱신",
    fieldTitle: "현장 칸반",
    fieldDescription: "사출기 1~17호기를 선택하면 해당 설비의 작업지도서·도면·품질Issue 화면을 HD 전체화면으로 엽니다.",
    fieldMeta: "사출 1~17호기 · 터치스크린 전용",
    chooseMachine: "사출기 선택",
    machineUnit: "호기",
    fieldLoginRequired: "현장 또는 관리 계정 로그인이 필요합니다.",
    materialsTitle: "현장 자료 통합 관리",
    materialsDescription: "오늘 계획 모델별 자료 준비 상태를 확인하고 작업지도서와 도면을 업로드·교체합니다.",
    manageMaterials: "자료 업데이트",
    viewMaterials: "자료 현황 보기",
    loginToManage: "로그인 후 관리",
    developmentPermissionRequired: "개발 조회 권한 필요",
    materialComplete: "자료 완비",
    materialMissing: "자료 누락",
    noPlan: "계획 없음",
    statusUnknown: "상태 미확인",
    modelsUnit: "개 모델",
  },
  zh: {
    eyebrow: "WJ DISPLAY CENTER",
    title: "看板中心",
    description: "通过适配大屏的专用看板查看运营现状。点击卡片即可在新的全屏窗口中打开。",
    count: "5 个运营看板",
    publicAccess: "无需登录即可直接访问",
    login: "登录管理页面",
    dashboard: "返回管理页面",
    live: "LIVE",
    publicLink: "公开链接",
    open: "打开看板",
    preview: "画面预览",
    overviewTitle: "WJ 综合运营看板",
    overviewDescription: "通过 3×3 视频墙集中查看生产、设备、质量、出库和能源核心指标。",
    overviewMeta: "3×3 视频墙 · 每分钟刷新",
    injectionTitle: "注塑实时看板",
    injectionDescription: "在一个屏幕中查看 17 台注塑机的计划、生产进度和最近 C/T。",
    injectionMeta: "17 台注塑机 · 每分钟刷新",
    mouldTitle: "模具实时看板",
    mouldDescription: "通过触控查看模具安装设备及基于 Blacklake 的 A/B/C 存放位置。",
    mouldMeta: "安装设备 · A/B/C 存放位置",
    energyTitle: "注塑用电现状看板",
    energyDescription: "比较17台注塑机分时用电、前日与7日平均，以及设备能效。",
    energyMeta: "用电量 · 前日/7日比较 · 每分钟刷新",
    fieldTitle: "现场看板",
    fieldDescription: "选择 1~17 号注塑机后，以 HD 全屏打开该设备的作业指导书、图纸和品质Issue。",
    fieldMeta: "1~17 号注塑机 · 触摸屏专用",
    chooseMachine: "选择注塑机",
    machineUnit: "号机",
    fieldLoginRequired: "需要使用现场或管理账号登录。",
    materialsTitle: "现场资料统一管理",
    materialsDescription: "检查今日计划型号的资料准备状态，并上传或更换作业指导书与图纸。",
    manageMaterials: "更新资料",
    viewMaterials: "查看资料状态",
    loginToManage: "登录后管理",
    developmentPermissionRequired: "需要开发查看权限",
    materialComplete: "资料完整",
    materialMissing: "资料缺失",
    noPlan: "无计划",
    statusUnknown: "状态未确认",
    modelsUnit: "个型号",
  },
} as const;

const INJECTION_MACHINE_NUMBERS = Array.from({ length: 17 }, (_, index) => index + 1);

type BoardCard = {
  key: "overview" | "injection" | "mould" | "energy";
  href: string;
  image: string;
  title: string;
  description: string;
  meta: string;
  icon: typeof Factory;
};

type MachineMaterialStatus = "complete" | "missing" | "no-plan" | "unknown";

type MachineMaterialSummary = {
  status: MachineMaterialStatus;
  plannedModels: number;
  missingModels: number;
};

function summarizeMachineMaterials(models: FieldMaterialModel[] | undefined) {
  const byMachine = new Map<number, FieldMaterialModel[]>();
  for (const model of models ?? []) {
    for (const machineNumber of model.machine_numbers) {
      const rows = byMachine.get(machineNumber) ?? [];
      rows.push(model);
      byMachine.set(machineNumber, rows);
    }
  }

  return new Map(INJECTION_MACHINE_NUMBERS.map((machineNumber) => {
    const plannedModels = byMachine.get(machineNumber) ?? [];
    const missingModels = plannedModels.filter((model) => !model.readiness.complete).length;
    return [machineNumber, {
      status: plannedModels.length === 0 ? "no-plan" : missingModels === 0 ? "complete" : "missing",
      plannedModels: plannedModels.length,
      missingModels,
    } satisfies MachineMaterialSummary] as const;
  }));
}

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

function openFieldStation(event: MouseEvent<HTMLAnchorElement>, href: string, stationId: string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const popup = window.open(
    href,
    `wj-field-${stationId}`,
    "popup=yes,width=1920,height=1080,resizable=yes,scrollbars=yes",
  );
  if (popup) popup.focus();
  else window.location.assign(href);
}

export function BoardHubPage() {
  const { hasPermission, isAuthenticated, user } = useAuth();
  const { lang, setLang } = useLang();
  const copy = COPY[lang];
  const businessDate = useShanghaiBusinessDate();
  const canViewMaterials = Boolean(
    isAuthenticated
      && (user?.is_staff || hasPermission("is_admin") || hasPermission("can_view_development")),
  );
  const canEditMaterials = Boolean(
    isAuthenticated
      && (user?.is_staff || hasPermission("is_admin") || hasPermission("can_edit_development")),
  );
  const materialsQuery = useQuery({
    queryKey: ["field-materials", businessDate],
    queryFn: () => getFieldMaterials(businessDate),
    enabled: canViewMaterials,
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
  const materialStatusByMachine = useMemo(
    () => summarizeMachineMaterials(materialsQuery.data?.models),
    [materialsQuery.data?.models],
  );
  const materialsHref = canViewMaterials
    ? "/development/field-materials"
    : `/login?returnTo=${encodeURIComponent("/development/field-materials")}`;
  const boards: BoardCard[] = [
    {
      key: "overview",
      href: "/boards/overview",
      image: "/board-thumbnails/overview-board.svg",
      title: copy.overviewTitle,
      description: copy.overviewDescription,
      meta: copy.overviewMeta,
      icon: LayoutGrid,
    },
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

      <section className={styles.fieldCenter} aria-labelledby="field-kanban-title">
        <header className={styles.fieldCenterHeader}>
          <span className={styles.fieldCenterIcon}><Monitor aria-hidden="true" /></span>
          <div>
            <small>{copy.fieldMeta}</small>
            <h2 id="field-kanban-title">{copy.fieldTitle}</h2>
            <p>{copy.fieldDescription}</p>
          </div>
          <span className={styles.fieldAccess}><LockKeyhole aria-hidden="true" />{copy.fieldLoginRequired}</span>
        </header>

        <div className={styles.machineSelector}>
          <div className={styles.machineSelectorHeader}>
            <strong>{copy.chooseMachine}</strong>
            {canViewMaterials ? (
              <div className={styles.statusLegend} aria-label={copy.materialsTitle}>
                <span className={styles.legendComplete}><i />{copy.materialComplete}</span>
                <span className={styles.legendMissing}><i />{copy.materialMissing}</span>
                <span className={styles.legendNoPlan}><i />{copy.noPlan}</span>
              </div>
            ) : null}
          </div>
          <div className={styles.machineGrid}>
            {INJECTION_MACHINE_NUMBERS.map((machineNumber) => {
              const stationId = `imm${String(machineNumber).padStart(2, "0")}`;
              const stationHref = `/field/${stationId}`;
              const href = isAuthenticated
                ? stationHref
                : `/login?returnTo=${encodeURIComponent(stationHref)}`;
              const summary = canViewMaterials && materialsQuery.isSuccess
                ? materialStatusByMachine.get(machineNumber) ?? { status: "no-plan", plannedModels: 0, missingModels: 0 }
                : { status: "unknown", plannedModels: 0, missingModels: 0 } satisfies MachineMaterialSummary;
              const statusLabel = summary.status === "complete"
                ? copy.materialComplete
                : summary.status === "missing"
                  ? `${copy.materialMissing} · ${summary.missingModels}${copy.modelsUnit}`
                  : summary.status === "no-plan"
                    ? copy.noPlan
                    : copy.statusUnknown;
              const statusClass = summary.status === "complete"
                ? styles.machineComplete
                : summary.status === "missing"
                  ? styles.machineMissing
                  : summary.status === "no-plan"
                    ? styles.machineNoPlan
                    : styles.machineUnknown;
              return (
                <a
                  aria-label={`${String(machineNumber).padStart(2, "0")}${copy.machineUnit} · ${statusLabel} · ${copy.open}`}
                  className={statusClass}
                  href={href}
                  key={stationId}
                  onClick={(event) => openFieldStation(event, href, stationId)}
                  rel="noopener"
                  target="_blank"
                  title={statusLabel}
                >
                  <i aria-hidden="true" />
                  <b>{String(machineNumber).padStart(2, "0")}</b>
                  <span>{copy.machineUnit}</span>
                </a>
              );
            })}
          </div>
        </div>

        <footer className={styles.materialManager}>
          <span className={styles.materialManagerIcon}><FileUp aria-hidden="true" /></span>
          <div><strong>{copy.materialsTitle}</strong><p>{copy.materialsDescription}</p></div>
          {canViewMaterials || !isAuthenticated ? (
            <Link to={materialsHref}>
              {canViewMaterials ? (canEditMaterials ? copy.manageMaterials : copy.viewMaterials) : copy.loginToManage}
              <ArrowUpRight aria-hidden="true" />
            </Link>
          ) : (
            <span className={styles.permissionNotice}><LockKeyhole aria-hidden="true" />{copy.developmentPermissionRequired}</span>
          )}
        </footer>
      </section>

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
