import type { AppLanguage } from "@/shared/i18n/language";
import styles from "./OutboundPerformanceContent.module.css";

export interface OutboundLanePresentation {
  code: "JIT" | "CSKD";
  /** Preserve order count, line count and source references in the full description. */
  title: string;
  fulfilledLabel: string;
  targetLabel: string;
  unitLabel: string;
  /** Already formatted by the existing wrapper, including no-plan / unknown labels. */
  rateLabel: string;
  noPlan: boolean;
  completionRate: number | null;
  progressWidth: number;
  progressMax: number;
  secondaryItems: ReadonlyArray<{ text: string; tone?: "normal" | "attention" }>;
  priority: {
    timeLabel: string;
    materialCode: string;
    description?: string | null;
    /** Includes the original priority quantities, unit, remainder and order reference. */
    title: string;
  } | null;
  priorityEmptyLabel: string;
}

export interface OutboundPeriodPresentation {
  label: string;
  /** Preserve the period basis and full accumulated actual / target quantities. */
  title: string;
  jit: { rateLabel: string; title: string };
  cskd: { rateLabel: string; title: string };
}

export interface OutboundPerformanceContentProps {
  language: AppLanguage;
  todayLabel: string;
  actualTargetLabel: string;
  completionLabel: string;
  basisLabel: string;
  lanes: readonly [OutboundLanePresentation, OutboundLanePresentation];
  periods: readonly [OutboundPeriodPresentation, OutboundPeriodPresentation];
}

function OutboundLane({ lane, actualTargetLabel, completionLabel }: {
  lane: OutboundLanePresentation;
  actualTargetLabel: string;
  completionLabel: string;
}) {
  const quantityText = `${lane.fulfilledLabel} / ${lane.targetLabel} ${lane.unitLabel}`;
  const secondaryText = lane.secondaryItems.map((item) => item.text).join(" · ");
  const dense = lane.fulfilledLabel.length + lane.targetLabel.length > 18;
  return <article className={styles.lane} data-code={lane.code} data-density={dense ? "compact" : "regular"} title={lane.title}>
    <div className={styles.metrics}>
      <strong className={styles.code}>{lane.code}</strong>
      <div className={styles.quantity} title={`${actualTargetLabel}: ${quantityText}`} aria-label={`${actualTargetLabel}: ${quantityText}`}>
        <strong>{lane.fulfilledLabel}</strong><span>/</span><b>{lane.targetLabel}</b><small>{lane.unitLabel}</small>
      </div>
      <strong className={styles.rate} data-state={lane.noPlan ? "no-plan" : lane.completionRate === null ? "unknown" : "known"} title={`${completionLabel}: ${lane.rateLabel}`}>{lane.rateLabel}</strong>
    </div>
    <div className={styles.progress} data-state={lane.noPlan ? "no-plan" : lane.completionRate === null ? "unknown" : "known"}
      role="progressbar" aria-label={`${lane.code} ${completionLabel}`}
      aria-valuemin={0} aria-valuemax={lane.progressMax}
      aria-valuenow={lane.completionRate ?? undefined} aria-valuetext={lane.rateLabel}>
      <span style={{ width: `${lane.progressWidth}%` }} />
    </div>
    <p className={styles.secondary} title={secondaryText}>
      {lane.secondaryItems.map((item, index) => <span key={`${index}-${item.text}`} data-tone={item.tone ?? "normal"}>{item.text}</span>)}
    </p>
    {lane.priority ? <div className={styles.priority} title={lane.priority.title}>
      <span>{lane.priority.timeLabel}</span>
      <strong>{lane.priority.materialCode}</strong>
      {lane.priority.description && <small>{lane.priority.description}</small>}
    </div> : secondaryText !== lane.priorityEmptyLabel
      ? <p className={styles.priorityEmpty} title={lane.priorityEmptyLabel}>{lane.priorityEmptyLabel}</p>
      : null}
  </article>;
}

/** Pure presentation; metric definitions, source availability and rotation remain in the caller. */
export function OutboundPerformanceContent({ language, todayLabel, actualTargetLabel, completionLabel, basisLabel, lanes, periods }: OutboundPerformanceContentProps) {
  return <div className={styles.content} lang={language}>
    <div className={styles.heading} title={basisLabel}><strong>{todayLabel}</strong><span>{actualTargetLabel}</span></div>
    <div className={styles.today}>
      {lanes.map((lane) => <OutboundLane key={lane.code} lane={lane} actualTargetLabel={actualTargetLabel} completionLabel={completionLabel} />)}
    </div>
    <div className={styles.comparisons}>
      {periods.map((period, index) => <div className={styles.period} key={`${index}-${period.label}`} title={period.title}>
        <strong className={styles.periodLabel}>{period.label}</strong>
        <span className={styles.periodMetric} data-code="JIT" title={period.jit.title}><b>JIT</b><strong>{period.jit.rateLabel}</strong></span>
        <span className={styles.periodMetric} data-code="CSKD" title={period.cskd.title}><b>CSKD</b><strong>{period.cskd.rateLabel}</strong></span>
      </div>)}
    </div>
  </div>;
}
