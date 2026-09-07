import { CheckCircle2, Clock3, Sparkles } from "lucide-react";
import type { AppLanguage } from "@/shared/i18n/language";
import styles from "./QualityBriefingContent.module.css";

const LABELS = {
  ko: {
    ai: "AI 품질 브리핑", history: "이력 기반 참고", model: "현재 생산 모델", part: "품번",
    summary: "핵심 요약", historySummary: "품질 이력 요약", phenomena: "과거 품질 현상",
    problemTypes: "반복 유형", problemLocations: "유형·위치", check: "확인 포인트", evidence: "이력 근거",
  },
  zh: {
    ai: "AI 品质简报", history: "历史参考", model: "当前生产型号", part: "零件号",
    summary: "核心摘要", historySummary: "品质历史摘要", phenomena: "历史品质现象",
    problemTypes: "重复类型", problemLocations: "类型·位置", check: "确认要点", evidence: "历史依据",
  },
};

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
  problemLocationPairs: string;
  checkpoints: string[];
  evidenceLabel: string;
  latestLabel: string;
  generatedLabel: string;
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

/** Display only: callers retain responsibility for AI validity, dates and source formatting. */
export function QualityAiBriefingContent(props: QualityAiBriefingContentProps) {
  const labels = LABELS[props.language];
  const checkpointText = props.checkpoints.filter(Boolean).join(" · ") || "—";
  const dense = props.headline.length + props.problemTypes.length + props.problemLocationPairs.length + checkpointText.length > 260;
  const evidenceTitle = `${props.evidenceLabel} · ${props.latestLabel}`;
  return <article className={styles.briefing} data-mode="ai" data-density={dense ? "compact" : "regular"} lang={props.language}>
    <BriefingIdentity language={props.language} mode="ai" identity={props} />
    <section className={styles.narrative} aria-label={labels.summary}>
      <span className={styles.sectionLabel}>{labels.summary}</span>
      <strong title={props.headline}>{props.headline}</strong>
    </section>
    <div className={styles.details}>
      <section className={styles.evidence} aria-label={labels.evidence}>
        <div className={styles.detailHeading} title={evidenceTitle}><strong>{props.evidenceLabel}</strong><span>{props.latestLabel}</span></div>
        <div className={styles.evidenceLine}><span>{labels.problemTypes}</span><strong title={props.problemTypes}>{props.problemTypes}</strong></div>
        <div className={`${styles.evidenceLine} ${styles.locationLine}`}><span>{labels.problemLocations}</span><strong title={props.problemLocationPairs}>{props.problemLocationPairs}</strong></div>
      </section>
      <section className={styles.checkpoint} aria-label={labels.check}>
        <div className={styles.detailHeading}><strong><CheckCircle2 aria-hidden="true" />{labels.check}</strong></div>
        <p title={checkpointText}>{checkpointText}</p>
      </section>
    </div>
    <footer className={styles.footer}>
      <span title={`Qwen 3.8 · ${props.generatedLabel}`}><b>Qwen 3.8</b><span>{props.generatedLabel}</span></span>
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
