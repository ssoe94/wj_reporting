import {
  type InjectionTransitionAnalysis,
  type InjectionTransitionEvent,
  type InjectionTransitionEventType,
  type InjectionTransitionFlag,
} from "@/domains/production/injection-transition-analysis";
import { type AppLanguage } from "@/shared/i18n/language";

export type InjectionTransitionPanelCopy = {
  transitionEyebrow: string;
  transitionTitle: string;
  transitionDescription: string;
  transitionEventCount: string;
  moldChangeTime: string;
  coreChangeTime: string;
  tuningTime: string;
  productionStopTime: string;
  moldChangeEstimate: string;
  coreChangeEstimate: string;
  productionStopEstimate: string;
  tuningEstimate: string;
  requiresInjectionNote: string;
  noTransitionEvents: string;
  duration: string;
  stableStart: string;
  eventEvidence: string;
  fromTo: string;
  producedBeforeStop: string;
  targetWorkOrder: string;
  overproductionFlag: string;
  advanceProductionFlag: string;
  planDate: string;
  outputQty: string;
};

type InjectionTransitionPanelProps = {
  analysis: InjectionTransitionAnalysis;
  copy: InjectionTransitionPanelCopy;
  language: AppLanguage;
  machineKey?: string | number | null;
  compact?: boolean;
};

function formatNumber(value: number) {
  return Math.round(value).toLocaleString();
}

function formatDuration(minutes: number, language: AppLanguage) {
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  if (language === "zh") {
    if (hours > 0 && remainingMinutes > 0) return `${hours}小时 ${remainingMinutes}分`;
    if (hours > 0) return `${hours}小时`;
    return `${remainingMinutes}分`;
  }
  if (hours > 0 && remainingMinutes > 0) return `${hours}시간 ${remainingMinutes}분`;
  if (hours > 0) return `${hours}시간`;
  return `${remainingMinutes}분`;
}

function formatTime(value: string, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatTimeRange(event: InjectionTransitionEvent, language: AppLanguage) {
  return `${formatTime(event.startTime, language)} ~ ${formatTime(event.endTime, language)}`;
}

function getPartLabel(record: InjectionTransitionEvent["targetRecord"]) {
  if (!record) return "-";
  const partNo = record.part_no || record.model_name || record.part_spec || "-";
  const model = record.model_name && record.model_name !== partNo ? ` · ${record.model_name}` : "";
  return `${partNo}${model}`;
}

function getEventLabel(type: InjectionTransitionEventType, copy: InjectionTransitionPanelCopy) {
  if (type === "mold_change") return copy.moldChangeEstimate;
  if (type === "core_change") return copy.coreChangeEstimate;
  if (type === "tuning") return copy.tuningEstimate;
  return copy.productionStopEstimate;
}

function getEventEvidence(event: InjectionTransitionEvent, copy: InjectionTransitionPanelCopy, language: AppLanguage) {
  if (event.type === "mold_change" || event.type === "core_change") {
    return `${copy.producedBeforeStop} ${formatNumber(event.evidence.cumulativeQtyAtStop)} / ${formatNumber(event.evidence.completedPlanQty ?? 0)}`;
  }
  if (event.type === "tuning") {
    return event.stableStartTime
      ? `${copy.stableStart} ${formatTime(event.stableStartTime, language)}`
      : copy.requiresInjectionNote;
  }
  return `${copy.producedBeforeStop} ${formatNumber(event.evidence.producedForTargetQty ?? event.evidence.runOutputQty)} / ${formatNumber(event.evidence.targetPlanQty ?? 0)}`;
}

function getEventTarget(event: InjectionTransitionEvent, copy: InjectionTransitionPanelCopy) {
  if (event.fromRecord || event.toRecord) {
    return `${copy.fromTo} ${getPartLabel(event.fromRecord)} -> ${getPartLabel(event.toRecord)}`;
  }
  return `${copy.targetWorkOrder} ${getPartLabel(event.targetRecord)}`;
}

function getFlagLabel(flag: InjectionTransitionFlag, copy: InjectionTransitionPanelCopy) {
  if (flag.type === "overproduction_check") {
    const produced = formatNumber(flag.evidence.producedQty ?? 0);
    const planned = formatNumber(flag.evidence.plannedQty ?? 0);
    return `${copy.overproductionFlag} ${produced} / ${planned}`;
  }

  const planDate = flag.planDate ? ` · ${copy.planDate} ${flag.planDate}` : "";
  const outputQty = flag.evidence.outputQty ? ` · ${copy.outputQty} ${formatNumber(flag.evidence.outputQty)}` : "";
  return `${copy.advanceProductionFlag}${planDate}${outputQty}`;
}

export function InjectionTransitionPanel({
  analysis,
  copy,
  language,
  machineKey,
  compact = false,
}: InjectionTransitionPanelProps) {
  const selectedMachineKey = machineKey === undefined || machineKey === null ? null : String(machineKey);
  const visibleMachines = selectedMachineKey
    ? analysis.machines.filter((machine) => machine.machineKey === selectedMachineKey)
    : analysis.machines;
  const visibleTotals = visibleMachines.reduce(
    (totals, machine) => {
      totals.eventCount += machine.totals.eventCount;
      totals.flagCount += machine.totals.flagCount;
      totals.moldChangeMinutes += machine.totals.moldChangeMinutes;
      totals.coreChangeMinutes += machine.totals.coreChangeMinutes;
      totals.tuningMinutes += machine.totals.tuningMinutes;
      totals.productionStopMinutes += machine.totals.productionStopMinutes;
      totals.noteRequiredCount += machine.totals.noteRequiredCount;
      return totals;
    },
    {
      moldChangeMinutes: 0,
      coreChangeMinutes: 0,
      tuningMinutes: 0,
      productionStopMinutes: 0,
      eventCount: 0,
      flagCount: 0,
      noteRequiredCount: 0,
    },
  );

  return (
    <section className={`panel injection-transition-panel${compact ? " injection-transition-panel--compact" : ""}`}>
      <div className="injection-transition-panel__header">
        <div>
          <p className="panel-card__eyebrow">{copy.transitionEyebrow}</p>
          <h3 className="panel__title">{copy.transitionTitle}</h3>
          <p>{copy.transitionDescription}</p>
        </div>
      </div>

      <div className="injection-transition-summary">
        <div>
          <span>{copy.transitionEventCount}</span>
          <strong>{formatNumber(selectedMachineKey ? visibleTotals.eventCount : analysis.totals.eventCount)}</strong>
        </div>
        <div>
          <span>{copy.moldChangeTime}</span>
          <strong>{formatDuration(selectedMachineKey ? visibleTotals.moldChangeMinutes : analysis.totals.moldChangeMinutes, language)}</strong>
        </div>
        <div>
          <span>{copy.coreChangeTime}</span>
          <strong>{formatDuration(selectedMachineKey ? visibleTotals.coreChangeMinutes : analysis.totals.coreChangeMinutes, language)}</strong>
        </div>
        <div>
          <span>{copy.tuningTime}</span>
          <strong>{formatDuration(selectedMachineKey ? visibleTotals.tuningMinutes : analysis.totals.tuningMinutes, language)}</strong>
        </div>
        <div>
          <span>{copy.productionStopTime}</span>
          <strong>{formatDuration(selectedMachineKey ? visibleTotals.productionStopMinutes : analysis.totals.productionStopMinutes, language)}</strong>
        </div>
      </div>

      {visibleMachines.length ? (
        <div className="injection-transition-grid">
          {visibleMachines.map((machine) => (
            <article className="injection-transition-card" key={machine.machineKey}>
              <div className="injection-transition-card__head">
                <strong>{machine.machineLabel}</strong>
                <span>{copy.requiresInjectionNote} {formatNumber(machine.totals.noteRequiredCount)}</span>
              </div>
              {machine.flags.length ? (
                <div className="injection-transition-flags">
                  {machine.flags.map((flag) => (
                    <span className={`injection-transition-flag injection-transition-flag--${flag.type}`} key={flag.id}>
                      {getFlagLabel(flag, copy)}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="injection-transition-timeline" aria-hidden="true">
                {machine.events.map((event) => (
                  <span
                    className={`injection-transition-timeline__block injection-transition-timeline__block--${event.type}`}
                    key={`${event.id}-timeline`}
                    style={{ flexGrow: Math.max(6, Math.round(event.durationMinutes)) }}
                  />
                ))}
              </div>
              {machine.events.length ? (
              <div className="injection-transition-events">
                {machine.events.slice(0, compact ? 3 : 5).map((event) => (
                  <div className={`injection-transition-event injection-transition-event--${event.type}`} key={event.id}>
                    <div>
                      <span>{getEventLabel(event.type, copy)}</span>
                      <strong>{formatTimeRange(event, language)}</strong>
                    </div>
                    <dl>
                      <div>
                        <dt>{copy.duration}</dt>
                        <dd>{formatDuration(event.durationMinutes, language)}</dd>
                      </div>
                      <div>
                        <dt>{copy.eventEvidence}</dt>
                        <dd>{getEventEvidence(event, copy, language)}</dd>
                      </div>
                      <div>
                        <dt>{copy.targetWorkOrder}</dt>
                        <dd>{getEventTarget(event, copy)}</dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="injection-transition-empty">{copy.noTransitionEvents}</div>
      )}
    </section>
  );
}
