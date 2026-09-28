import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Clock3, Sparkles } from "lucide-react";
import { withAiModelName } from "@/domains/ai/model-labels";
import type { AppLanguage } from "@/shared/i18n/language";
import styles from "./QualityBriefingContent.module.css";

const LABELS = {
  ko: {
    ai: "AI 품질 브리핑", history: "이력 기반 참고", model: "현재 생산 모델", part: "품번",
    summary: "핵심 요약", historySummary: "품질 이력 요약", phenomena: "과거 품질 현상",
    problemTypes: "과거 유형", check: "확인 포인트", evidence: "이력 근거",
    scrollLeft: "왼쪽 내용 보기", scrollRight: "오른쪽 내용 보기",
    aiSource: "AI 요약",
  },
  zh: {
    ai: "AI 品质简报", history: "历史参考", model: "当前生产型号", part: "零件号",
    summary: "核心摘要", historySummary: "品质历史摘要", phenomena: "历史品质现象",
    problemTypes: "历史类型", check: "确认要点", evidence: "历史依据",
    scrollLeft: "查看左侧内容", scrollRight: "查看右侧内容",
    aiSource: "AI 摘要",
  },
};

/** Footer source badge: "AI 요약 · {model display name}", or "AI 요약" alone when the model is unknown. */
function getQualityAiSourceLabel(language: AppLanguage, modelDisplayName: string | null | undefined) {
  return withAiModelName(LABELS[language].aiSource, modelDisplayName);
}

export interface QualityBriefingIdentity {
  machineLabel: string;
  machineTitle?: string;
  tonnageLabel?: string | null;
  modelLabel: string;
  modelTitle?: string;
  partLabel: string;
  partTitle?: string;
}

export interface QualityAiBriefingContentProps extends QualityBriefingIdentity {
  language: AppLanguage;
  headline: string;
  problemTypes: string;
  checkpoints: string[];
  evidenceLabel: string;
  latestLabel: string;
  generatedLabel: string;
  /** Display name of the model that produced the summary (from `summary.modelId` through the registry). */
  modelDisplayName?: string | null;
  totalEvidenceLabel?: string | null;
}

export interface QualityHistoryBriefingContentProps extends QualityBriefingIdentity {
  language: AppLanguage;
  historyLabel: string;
  phenomena: string;
  latestLabel: string;
  matchLabel: string;
  aiStatusLabel: string;
  aiStatusState: "pending" | "stale" | "unavailable";
}

function BriefingIdentity({ language, mode, identity }: {
  language: AppLanguage;
  mode: "ai" | "history";
  identity: QualityBriefingIdentity;
}) {
  const labels = LABELS[language];
  const Icon = mode === "ai" ? Sparkles : Clock3;
  return <header className={styles.identity}>
    <div className={styles.machine} title={identity.machineTitle ?? identity.machineLabel}>
      <strong>{identity.machineLabel}</strong>
      {identity.tonnageLabel && <small>{identity.tonnageLabel}</small>}
    </div>
    <div className={styles.product}>
      <strong aria-label={`${labels.model}: ${identity.modelTitle ?? identity.modelLabel}`} title={identity.modelTitle ?? identity.modelLabel}>{identity.modelLabel}</strong>
      <small title={`${labels.part} ${identity.partTitle ?? identity.partLabel}`}>{labels.part} {identity.partLabel}</small>
    </div>
    <span className={styles.mode}><Icon aria-hidden="true" />{labels[mode]}</span>
  </header>;
}

export function HorizontalReadingText({ text, label, language, variant }: {
  text: string;
  label: string;
  language: AppLanguage;
  variant: "headline" | "ribbon";
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ left: false, right: false });
  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    setScrollState({
      left: viewport.scrollLeft > 1,
      right: viewport.scrollLeft < maxScroll - 1,
    });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = 0;
    updateScrollState();
    window.addEventListener("resize", updateScrollState);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateScrollState);
    observer?.observe(viewport);
    if (viewport.firstElementChild) observer?.observe(viewport.firstElementChild);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateScrollState);
    };
  }, [text, updateScrollState]);

  const scroll = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * Math.max(80, viewport.clientWidth * 0.8),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  const hasOverflow = scrollState.left || scrollState.right;
  return <div className={styles.horizontalReading} data-variant={variant} data-overflow={hasOverflow}>
    <div
      ref={viewportRef}
      aria-label={`${label}: ${text}`}
      className={styles.horizontalViewport}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          scroll(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
      onScroll={updateScrollState}
      role="region"
      tabIndex={hasOverflow ? 0 : undefined}
      title={text}
    ><strong>{text}</strong></div>
    {scrollState.left && <button aria-label={`${label}: ${LABELS[language].scrollLeft}`} className={`${styles.scrollButton} ${styles.scrollLeft}`} onClick={() => scroll(-1)} type="button"><ChevronLeft aria-hidden="true" /></button>}
    {scrollState.right && <button aria-label={`${label}: ${LABELS[language].scrollRight}`} className={`${styles.scrollButton} ${styles.scrollRight}`} onClick={() => scroll(1)} type="button"><ChevronRight aria-hidden="true" /></button>}
  </div>;
}

function FlowingTypeText({ text, label }: { text: string; label: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLElement>(null);
  const [flow, setFlow] = useState({ enabled: false, durationSeconds: 12 });

  useEffect(() => {
    const viewport = viewportRef.current;
    const item = itemRef.current;
    const content = textRef.current;
    if (!viewport || !item || !content) return;
    viewport.scrollLeft = 0;
    const updateFlow = () => {
      const enabled = content.getBoundingClientRect().width > viewport.clientWidth + 1;
      const durationSeconds = Math.max(12, Math.min(40, item.getBoundingClientRect().width / 38));
      setFlow((current) => current.enabled === enabled && current.durationSeconds === durationSeconds
        ? current
        : { enabled, durationSeconds });
    };
    updateFlow();
    window.addEventListener("resize", updateFlow);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateFlow);
    observer?.observe(viewport);
    observer?.observe(item);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateFlow);
    };
  }, [text]);

  return <div
    ref={viewportRef}
    aria-label={label}
    className={styles.flowViewport}
    data-flowing={flow.enabled}
    onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      viewportRef.current?.scrollBy({ left: event.key === "ArrowLeft" ? -90 : 90 });
    }}
    role="region"
    tabIndex={flow.enabled ? 0 : undefined}
    title={text}
  >
    <span className={styles.flowTrack} style={{ animationDuration: `${flow.durationSeconds}s` }}>
      <span ref={itemRef} className={styles.flowItem}><strong ref={textRef}>{text}</strong></span>
      {flow.enabled && <span aria-hidden="true" className={`${styles.flowItem} ${styles.flowCopy}`}><strong>{text}</strong></span>}
    </span>
  </div>;
}

/** Display only: callers retain responsibility for AI validity, dates and source formatting. */
export function QualityAiBriefingContent(props: QualityAiBriefingContentProps) {
  const labels = LABELS[props.language];
  const checkpointText = props.checkpoints.filter(Boolean).join(" · ") || "—";
  const dense = props.headline.length + props.problemTypes.length + checkpointText.length > 260;
  const evidenceTitle = `${props.evidenceLabel} · ${props.latestLabel}`;
  const sourceLabel = getQualityAiSourceLabel(props.language, props.modelDisplayName);
  return <article className={styles.briefing} data-mode="ai" data-density={dense ? "compact" : "regular"} lang={props.language}>
    <BriefingIdentity language={props.language} mode="ai" identity={props} />
    <section className={styles.narrative} aria-label={labels.summary}>
      <span className={styles.sectionLabel}>{labels.summary}</span>
      <HorizontalReadingText text={props.headline} label={labels.summary} language={props.language} variant="headline" />
    </section>
    <div className={styles.details}>
      <section className={styles.evidence} aria-label={labels.evidence}>
        <div className={styles.detailHeading} title={evidenceTitle}><strong>{props.evidenceLabel}</strong><span>{props.latestLabel}</span></div>
        <div className={styles.evidenceLine}><span>{labels.problemTypes}</span><FlowingTypeText text={props.problemTypes} label={labels.problemTypes} /></div>
      </section>
      <section className={styles.checkpoint} aria-label={labels.check}>
        <div className={styles.detailHeading}><strong><CheckCircle2 aria-hidden="true" />{labels.check}</strong></div>
        <p title={checkpointText}>{checkpointText}</p>
      </section>
    </div>
    <footer className={styles.footer}>
      <span title={`${sourceLabel} · ${props.generatedLabel}`}><b>{sourceLabel}</b><span>{props.generatedLabel}</span></span>
      {props.totalEvidenceLabel && <span title={props.totalEvidenceLabel}>{props.totalEvidenceLabel}</span>}
    </footer>
  </article>;
}

export function QualityHistoryBriefingContent(props: QualityHistoryBriefingContentProps) {
  const labels = LABELS[props.language];
  return <article className={styles.briefing} data-mode="history" data-density={props.phenomena.length > 150 ? "compact" : "regular"} lang={props.language}>
    <BriefingIdentity language={props.language} mode="history" identity={props} />
    <section className={styles.narrative} aria-label={labels.historySummary}>
      <span className={styles.sectionLabel}>{labels.historySummary}</span>
      <strong title={`${props.historyLabel} · ${props.phenomena}`}>{props.historyLabel} · {props.phenomena}</strong>
    </section>
    <div className={styles.details}>
      <section className={styles.historyPhenomena} aria-label={labels.phenomena}>
        <div className={styles.detailHeading}><strong>{labels.phenomena}</strong></div>
        <p title={props.phenomena}>{props.phenomena}</p>
      </section>
      <section className={styles.historyEvidence} aria-label={labels.evidence}>
        <div className={styles.detailHeading}><strong>{labels.evidence}</strong></div>
        <p title={props.historyLabel}>{props.historyLabel}</p>
        <small title={`${props.latestLabel} · ${props.matchLabel}`}>{props.latestLabel} · {props.matchLabel}</small>
      </section>
    </div>
    <footer className={styles.footer}>
      <span className={styles.historyStatus} data-state={props.aiStatusState} role="status" title={props.aiStatusLabel}>{props.aiStatusLabel}</span>
    </footer>
  </article>;
}
