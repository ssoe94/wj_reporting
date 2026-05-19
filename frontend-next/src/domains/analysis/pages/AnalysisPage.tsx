import { useQuery } from "@tanstack/react-query";
import {
  getAnalyticsProductionProgress,
  type AnalyticsDailyProgress,
  type AnalyticsEquipmentProgress,
} from "@/domains/analysis/api";
import { PageHeader } from "@/shared/components/PageHeader";
import { LoadingBlock } from "@/shared/components/LoadingBlock";
import { StatCard } from "@/shared/components/StatCard";
import { type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";
import { getShanghaiDateString } from "@/shared/utils/date";

const pageCopy = {
  ko: {
    eyebrow: "Analysis",
    title: "분석 센터",
    description: "생산 mart와 예외 이벤트를 기준으로 진행률, 데이터 신선도, 우선 확인 대상을 봅니다.",
    loading: "분석 지표를 불러오는 중입니다.",
    businessDate: "기준일",
    dateHint: "08:00 ~ 익일 08:00",
    injection: "사출",
    machining: "가공",
    actualPlan: "실적 / 계획",
    progress: "진행률",
    gap: "차이",
    activeEquipment: "가동 설비",
    exceptions: "오픈 예외",
    overview: "생산 분석 Overview",
    exceptionTitle: "우선 확인 예외",
    equipmentTitle: "설비/라인 진행",
    evidenceTitle: "데이터 근거",
    noExceptions: "오픈 예외가 없습니다.",
    noEquipment: "설비/라인 진행 데이터가 없습니다.",
    usedData: "사용 데이터",
    calculationBasis: "계산 기준",
    warnings: "데이터 경고",
    freshness: "신선도",
    sourceLatest: "원천 최신",
    martGenerated: "Mart 생성",
    liveComputed: "저장 mart가 없어 현재 원천 데이터로 계산한 값입니다.",
    persisted: "저장 mart 기준",
    fetchError: "분석 API를 읽지 못했습니다. 권한 또는 백엔드 연결 상태를 확인해주세요.",
    process: "공정",
    equipment: "설비/라인",
    status: "상태",
    running: "가동",
    idle: "대기",
  },
  zh: {
    eyebrow: "Analysis",
    title: "分析中心",
    description: "基于生产 mart 和异常事件查看进度、数据新鲜度和优先确认对象。",
    loading: "正在读取分析指标。",
    businessDate: "基准日",
    dateHint: "08:00 ~ 次日 08:00",
    injection: "注塑",
    machining: "加工",
    actualPlan: "实绩 / 计划",
    progress: "进度",
    gap: "差异",
    activeEquipment: "运行设备",
    exceptions: "开放异常",
    overview: "生产分析 Overview",
    exceptionTitle: "优先确认异常",
    equipmentTitle: "设备/产线进度",
    evidenceTitle: "数据依据",
    noExceptions: "暂无开放异常。",
    noEquipment: "暂无设备/产线进度数据。",
    usedData: "使用数据",
    calculationBasis: "计算基准",
    warnings: "数据警告",
    freshness: "新鲜度",
    sourceLatest: "源数据最新",
    martGenerated: "Mart 生成",
    liveComputed: "没有保存 mart，当前显示基于源数据计算的值。",
    persisted: "保存 mart 基准",
    fetchError: "无法读取分析 API。请确认权限或后端连接状态。",
    process: "工序",
    equipment: "设备/产线",
    status: "状态",
    running: "运行",
    idle: "待机",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("ko-KR").format(Math.round(Number(value ?? 0)));
}

function formatRate(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(Number(value))}%`;
}

function processLabel(process: AnalyticsDailyProgress["process"], language: AppLanguage) {
  return process === "injection" ? pageCopy[language].injection : pageCopy[language].machining;
}

function statusTone(row: AnalyticsDailyProgress): "positive" | "negative" | "neutral" {
  if (row.status === "behind") return "negative";
  if (row.status === "ahead" || row.status === "on_track") return "positive";
  return "neutral";
}

function sortEquipmentByRisk(rows: AnalyticsEquipmentProgress[]) {
  return [...rows].sort((a, b) => a.gap_qty - b.gap_qty).slice(0, 8);
}

export function AnalysisPage() {
  const [language] = useStoredLanguage();
  const copy = pageCopy[language];
  const businessDate = getShanghaiDateString();
  const analyticsQuery = useQuery({
    queryKey: ["analysis", "production-progress", businessDate, language],
    queryFn: () => getAnalyticsProductionProgress(businessDate, language),
  });

  const payload = analyticsQuery.data;
  const daily = payload?.daily ?? [];
  const equipmentRows = sortEquipmentByRisk(payload?.equipment ?? []);
  const openExceptions = (payload?.exceptions ?? []).filter((item) => item.status === "open").slice(0, 8);
  const injection = daily.find((row) => row.process === "injection");
  const machining = daily.find((row) => row.process === "machining");

  return (
    <section className="page">
      <PageHeader
        eyebrow={copy.eyebrow}
        icon="analysis"
        title={copy.title}
        description={copy.description}
      />

      {analyticsQuery.isLoading ? <LoadingBlock label={copy.loading} /> : null}

      <div className="stats-grid">
        <StatCard hint={copy.dateHint} title={copy.businessDate} value={businessDate} />
        <StatCard
          hint={`${copy.progress} ${formatRate(injection?.progress_rate)} · ${copy.gap} ${formatNumber(injection?.gap_qty)}`}
          hintTone={injection ? statusTone(injection) : "neutral"}
          title={`${copy.injection} ${copy.actualPlan}`}
          value={`${formatNumber(injection?.actual_qty)} / ${formatNumber(injection?.planned_qty)}`}
        />
        <StatCard
          hint={`${copy.progress} ${formatRate(machining?.progress_rate)} · ${copy.gap} ${formatNumber(machining?.gap_qty)}`}
          hintTone={machining ? statusTone(machining) : "neutral"}
          title={`${copy.machining} ${copy.actualPlan}`}
          value={`${formatNumber(machining?.actual_qty)} / ${formatNumber(machining?.planned_qty)}`}
        />
        <StatCard
          hint={payload?.freshness.is_persisted ? copy.persisted : copy.liveComputed}
          title={copy.exceptions}
          value={formatNumber(openExceptions.length)}
          hintTone={openExceptions.length ? "negative" : "positive"}
        />
      </div>

      {payload?.freshness.is_persisted === false ? (
        <div className="notice notice--warning">{copy.liveComputed}</div>
      ) : null}

      <section className="panel panel--split">
        <article>
          <p className="panel-card__eyebrow">Overview</p>
          <h3 className="panel__title">{copy.overview}</h3>
          <div className="production-progress-metrics">
            {daily.map((row) => (
              <div key={row.process}>
                <dt>{processLabel(row.process, language)}</dt>
                <dd>{formatRate(row.progress_rate)}</dd>
                <span>{copy.activeEquipment} {formatNumber(row.active_equipment_count)}</span>
              </div>
            ))}
          </div>
        </article>

        <article>
          <p className="panel-card__eyebrow">Exceptions</p>
          <h3 className="panel__title">{copy.exceptionTitle}</h3>
          {openExceptions.length ? (
            <div className="plan-highlight-list">
              {openExceptions.map((item) => (
                <div className="plan-highlight" key={item.source_key}>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <em className={`mes-machining-status mes-machining-status--${item.exception_type === "mes_only" ? "mes_only" : item.exception_type === "plan_only" ? "plan_only" : "matched"}`}>
                    {item.exception_type}
                  </em>
                </div>
              ))}
            </div>
          ) : (
            <div className="notice notice--neutral">{copy.noExceptions}</div>
          )}
        </article>
      </section>

      <section className="panel">
        <p className="panel-card__eyebrow">Equipment</p>
        <h3 className="panel__title">{copy.equipmentTitle}</h3>
        {equipmentRows.length ? (
          <div className="mes-machining-table-wrap">
            <table className="mes-machining-table">
              <thead>
                <tr>
                  <th>{copy.process}</th>
                  <th>{copy.equipment}</th>
                  <th>{copy.status}</th>
                  <th>{copy.actualPlan}</th>
                  <th>{copy.progress}</th>
                  <th>{copy.gap}</th>
                </tr>
              </thead>
              <tbody>
                {equipmentRows.map((row) => {
                  const progress = Math.max(0, Math.min(100, row.progress_rate));
                  return (
                    <tr key={`${row.process}-${row.equipment_key}`}>
                      <td>{processLabel(row.process, language)}</td>
                      <td>
                        <div className="mes-machining-line-cell">
                          <strong>{row.equipment_label || row.equipment_key}</strong>
                          <span>{row.equipment_name}</span>
                        </div>
                      </td>
                      <td>{row.is_running ? copy.running : copy.idle}</td>
                      <td>{formatNumber(row.actual_qty)} / {formatNumber(row.planned_qty)}</td>
                      <td>
                        <div className="mes-machining-progress-cell">
                          <strong>{formatRate(row.progress_rate)}</strong>
                          <div className={row.actual_qty > row.planned_qty ? "mes-machining-progress mes-machining-progress--overrun" : "mes-machining-progress"}>
                            <span style={{ width: `${progress}%` }} />
                          </div>
                        </div>
                      </td>
                      <td>{row.gap_qty >= 0 ? "+" : ""}{formatNumber(row.gap_qty)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="notice notice--neutral">{copy.noEquipment}</div>
        )}
      </section>

      <section className="panel">
        <p className="panel-card__eyebrow">Evidence</p>
        <h3 className="panel__title">{copy.evidenceTitle}</h3>
        <div className="production-brief-evidence">
          <span>{copy.freshness}</span>
          <details open>
            <summary>{copy.freshness}</summary>
            <ul>
              <li>{copy.sourceLatest}: {payload?.freshness.source_latest_at ?? "-"}</li>
              <li>{copy.martGenerated}: {payload?.freshness.mart_generated_at ?? "-"}</li>
            </ul>
          </details>
          <details>
            <summary>{copy.usedData}</summary>
            <ul>
              {(payload?.used_data ?? []).map((item) => (
                <li key={item.name}>{item.name}: {formatNumber(item.row_count)}</li>
              ))}
            </ul>
          </details>
          <details>
            <summary>{copy.calculationBasis}</summary>
            <ul>
              {(payload?.calculation_basis ?? []).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
          {payload?.warnings.length ? (
            <details open>
              <summary>{copy.warnings}</summary>
              <ul>
                {payload.warnings.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </section>

      {analyticsQuery.isError ? <div className="notice notice--warning">{copy.fetchError}</div> : null}
    </section>
  );
}
