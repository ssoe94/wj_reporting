import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowUpRight, CalendarDays, ChartNoAxesCombined, ClipboardCheck, Database, Factory, RefreshCw } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useLang } from "@/i18n";
import { PageContainer, PageHeader } from "@/components/layout/PageLayout";
import PermissionLink from "@/components/common/PermissionLink";
import { useShanghaiBusinessDate } from "@/shared/hooks/useShanghaiBusinessDate";
import type { OverviewBoardModel } from "@/domains/boards/overview/types";
import { getAnalysisOverview, getFieldOperations } from "./api";
import { getFieldStationPath, getPriorityEquipment, getProcessEvidence, resolveAnalysisDate } from "./model";
import type { EquipmentReason, FieldOperationsData } from "./model";
import "./analysis.css";

type Translate = (ko: string, zh: string) => string;
type CopyProps = { tx: Translate; lang: string };

function quantity(value: number | null | undefined, lang: string, decimals = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "ko-KR", { maximumFractionDigits: decimals }).format(value)
    : "—";
}

function timestamp(value: string | null | undefined, lang: string) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "ko-KR", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function QueryState({ loading, error, hasData, onRetry, tx }: {
  loading: boolean; error: boolean; hasData: boolean; onRetry: () => void; tx: Translate;
}) {
  if (loading) return <p className="analysis-notice" role="status">{tx("선택한 업무일의 데이터를 확인하고 있습니다.", "正在获取所选业务日的数据。")}</p>;
  if (!error) return null;
  return <div className="analysis-notice analysis-notice--warning" role="status">
    <span>{hasData
      ? tx("갱신에 실패했습니다. 아래는 마지막으로 받은 자료입니다. 원천 시각을 확인하세요.", "刷新失败。以下保留最近成功获取的数据，请核对源数据时间。")
      : tx("자료를 가져오지 못했습니다. 생산량이나 불량 0을 의미하지 않습니다.", "未能获取数据，不代表产量或不良数为 0。")}</span>
    <button className="analysis-text-button" onClick={onRetry} type="button">{tx("다시 확인", "重试")}</button>
  </div>;
}

function ProductionSummary({ model, refreshFailed, tx, lang }: CopyProps & { model: OverviewBoardModel; refreshFailed: boolean }) {
  const rows = (["injection", "assembly"] as const).map((key) => ({
    key, label: key === "injection" ? tx("사출", "注塑") : tx("조립", "组装"), ...getProcessEvidence(model, key),
  }));
  const chartRows = rows.filter((row) => !refreshFailed && row.canEvaluate && row.hasPlan && row.actual !== null).map((row) => ({
    name: row.label, plan: row.process.plannedQuantity, actual: row.actual,
  }));
  return <section className="analysis-panel analysis-production" aria-labelledby="analysis-production-title">
    <div className="analysis-section-heading"><div><h2 id="analysis-production-title"><Factory size={19} aria-hidden="true" />{tx("공정별 계획과 관측 실적", "各工序计划与观测实绩")}</h2>
      <p>{tx("같은 업무일로 비교합니다. 공정 간 수량은 합산하지 않습니다.", "按同一业务日比较，不合计不同工序的数量。")}</p></div><span className="analysis-unit">{tx("단위 ea", "单位 ea")}</span></div>
    <div className="analysis-process-grid">{rows.map(({ key, label, process, hasPlan, actual, completionRate, gap, unavailable, canEvaluate, source }) => (
      <article className="analysis-process-card" key={key}>
        <div className="analysis-card-top"><h3>{label}</h3><span className={`analysis-badge ${!canEvaluate || refreshFailed ? "analysis-badge--warning" : ""}`}>
          {refreshFailed ? tx("이전 수신 자료", "此前收到的资料") : unavailable ? tx("원천 확인 필요", "需核对数据源") : !canEvaluate ? tx("원천 상태 주의", "数据源状态需关注") : tx("원천 연결", "已连接数据源")}
        </span></div>
        <div className="analysis-quantity"><strong>{quantity(actual, lang)}</strong><span>/ {quantity(process.plannedQuantity, lang)} ea</span></div>
        <p className="analysis-caption">{actual !== null && (!canEvaluate || refreshFailed) ? tx("마지막 관측 실적 / 계획", "最近观测实绩 / 计划") : tx("관측 실적 / 계획", "观测实绩 / 计划")}</p>
        <dl className="analysis-process-metrics"><div><dt>{tx("계획 달성", "计划达成")}</dt><dd>{refreshFailed || completionRate === null ? "—" : `${quantity(completionRate, lang, 1)}%`}</dd></div>
          <div><dt>{tx("실적 − 계획", "实绩 − 计划")}</dt><dd>{refreshFailed || gap === null ? "—" : `${gap > 0 ? "+" : ""}${quantity(gap, lang)} ea`}</dd></div></dl>
        {canEvaluate && !refreshFailed ? null : <p className="analysis-inline-warning">{tx("원천 누락·지연·갱신 실패로 달성 및 차이 해석을 보류합니다.", "因数据源缺失、延迟或刷新失败，暂不判断达成与差距。")}</p>}
        {!hasPlan && <p className="analysis-inline-warning">{tx("유효한 등록 계획을 확인할 수 없습니다. 휴무·미등록을 확인하세요.", "未能确认有效登记计划，请核对是否休息或漏登记。")}</p>}
        <p className="analysis-basis">{key === "injection"
          ? tx("MES 형합수 × Cavity를 계획 순서로 배분한 추정 실적입니다.", "按计划顺序分配 MES 模次 × 穴数所得的估算实绩。")
          : tx("MES 귀속 실적과 아직 대사되지 않은 수기 보고를 반영합니다.", "反映 MES 归属实绩及尚未完成对账的手工报工。")}</p>
        {key === "assembly" && process.reportingMix?.manualOpenQuantity !== null && process.reportingMix?.manualOpenQuantity !== undefined
          && <p className="analysis-caption">{tx("확인된 수기 미대사분 (전체 실적과 별도)", "已知手工待对账数量（与整体实绩区分）")}: {quantity(process.reportingMix.manualOpenQuantity, lang)} ea</p>}
        {key === "assembly" && process.reportingMix?.statusCounts && <p className="analysis-caption">{tx("계획행 검토 필요 / 수기 불일치", "计划行待核对 / 手工不一致")}: {quantity(process.reportingMix.statusCounts.needsReview, lang)} / {quantity(process.reportingMix.statusCounts.manualMismatch, lang)}{tx("건", "条")}</p>}
        <p className="analysis-caption">{tx("원천 최신", "数据源最新时间")}: {timestamp(source?.sourceLatestAt, lang)} · UTC+8</p>
      </article>
    ))}</div>
    {chartRows.length > 0 && <div className="analysis-chart" role="img" aria-label={tx("위 표의 공정별 계획과 관측 실적 비교, 단위 ea", "上表各工序计划与观测实绩对比，单位 ea")}>
      <ResponsiveContainer width="100%" height={235}><BarChart data={chartRows} margin={{ top: 18, right: 8, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e8edf5" /><XAxis dataKey="name" tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(value: number) => quantity(value, lang)} tickLine={false} axisLine={false} width={70} />
        <Tooltip formatter={(value: number) => `${quantity(value, lang)} ea`} /><Legend />
        <Bar dataKey="plan" name={tx("계획", "计划")} fill="#a6b8d2" maxBarSize={72} radius={[5, 5, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="actual" name={tx("관측 실적", "观测实绩")} fill="#3771df" maxBarSize={72} radius={[5, 5, 0, 0]} isAnimationActive={false} />
      </BarChart></ResponsiveContainer>
    </div>}
    <p className="analysis-caption">{tx("계획이 있고 실적을 확인할 수 있는 공정만 차트에 표시합니다. 계획 달성은 OEE 성능이나 검사 합격률이 아닙니다.", "图表仅显示有计划且实绩可用的工序。计划达成率不是 OEE 性能或检验合格率。")}</p>
  </section>;
}

function PrioritySection({ model, historical, refreshFailed, tx, lang }: CopyProps & { model: OverviewBoardModel; historical: boolean; refreshFailed: boolean }) {
  const priorities = getPriorityEquipment(model);
  const reasonLabels: Record<EquipmentReason, string> = {
    source: tx("MES 원천 확인", "核对 MES 数据源"), unplanned: tx("가동 중 · 계획 미연결", "运行中 · 未关联计划"),
    unresolved: tx("현재 품번 미확정", "当前品号未确定"), stopped: tx("계획 있음 · 최근 가동 없음", "有计划 · 近期未运行"),
    behind: tx("24시간 기준 진도 차이", "与24小时进度有差距"),
  };
  return <section className="analysis-panel analysis-priority" aria-labelledby="analysis-priority-title">
    <div className="analysis-section-heading"><div><h2 id="analysis-priority-title">{tx("실무 우선 확인", "现场优先核对")}</h2>
      <p>{tx("확인 후보입니다. 정지 원인이나 담당자의 조치 완료를 판정하지 않습니다.", "以下为待核对项，不代表已确认停机原因或处理完成。")}</p></div></div>
    {refreshFailed ? <p className="analysis-notice analysis-notice--warning">{tx("갱신에 실패하여 우선 확인 판정을 보류합니다. 위 수량은 마지막 수신값입니다.", "刷新失败，暂停优先核对判断。上方数量为最近收到的值。")}</p> : priorities.length > 0 ? <div className="analysis-table-wrap"><table className="analysis-table"><caption className="analysis-sr-only">{tx("사출 설비 우선 확인 목록", "注塑设备优先核对列表")}</caption>
      <thead><tr><th>{tx("설비", "设备")}</th><th>{tx("확인 이유", "核对原因")}</th><th>{tx("현재 품번", "当前品号")}</th><th>{tx("실적 / 계획 ea", "实绩 / 计划 ea")}</th><th>{tx("현장 연결", "现场入口")}</th></tr></thead>
      <tbody>{priorities.slice(0, 8).map(({ row, reason }) => <tr key={row.id}><th scope="row">{row.label}</th><td>{reasonLabels[reason]}</td>
        <td>{row.currentParts.map((part) => part.partNumber).filter(Boolean).join(", ") || "—"}</td>
        <td className="analysis-tabular">{quantity(reason === "source" ? null : row.actualQuantity, lang)} / {quantity(row.plannedQuantity, lang)}</td>
        <td><Link className="analysis-link" to={getFieldStationPath(row.machineNumber)}>{historical ? tx("현재 현장 화면", "当前现场画面") : tx("기록·확인", "记录·核对")}<ArrowUpRight size={14} aria-hidden="true" /></Link></td>
      </tr>)}</tbody></table></div> : <p className="analysis-notice">{tx("수신한 설비 자료에서 우선 확인 후보가 없습니다. 원천의 누락 여부는 아래에서 확인하세요.", "收到的设备数据中没有优先核对项，请在下方检查数据源是否缺失。")}</p>}
    <p className="analysis-caption">{tx("진도 차이는 08시부터 24시간 경과율과 비교하며 휴무·교대·계획정지를 반영하지 않습니다. 현장 링크는 현재 업무일 입력 화면으로 이동합니다.", "进度差按08时起24小时的经过比例比较，未扣除休息、班次或计划停机。现场入口打开当前业务日的输入画面。")}</p>
  </section>;
}

const defectLabels: Record<string, [string, string]> = {
  scratch: ["스크래치", "划伤"], black_dot: ["흑점", "黑点"], eaten_meat: ["파먹음", "吃肉"], air_mark: ["가스 마크", "气印"],
  deform: ["변형", "变形"], short_shot: ["미성형", "缺胶"], broken_pillar: ["기둥 파손", "断柱子"], flow_mark: ["플로우 마크", "流痕"],
  sink_mark: ["수축", "缩水"], whitening: ["백화", "发白"], other: ["기타", "其他"],
};

function FieldSection({ data, expanded, historical, tx, lang }: CopyProps & { data: FieldOperationsData; expanded: boolean; historical: boolean }) {
  const hasRecords = data.summary.checkpoint_count > 0;
  const defects = [...data.defects].sort((a, b) => b.reported_defect_qty - a.reported_defect_qty).slice(0, 6);
  const largestDefect = Math.max(1, ...defects.map((item) => item.reported_defect_qty));
  return <>
    {data.status === "partial" && <p className="analysis-notice analysis-notice--warning">{tx("일부 기록에 중복·형식·구간 문제가 있습니다. 유효한 기록만 집계했으며 전체 현장 기록과 다를 수 있습니다.", "部分记录存在重复、格式或区间问题。仅汇总有效记录，可能不代表全部现场记录。")}</p>}
    <div className="analysis-field-metrics"><article><span>{tx("기록이 있는 설비", "有记录设备")}</span><strong>{quantity(data.coverage.recorded_machine_count, lang)}<small> / {quantity(data.coverage.total_machine_count, lang)}</small></strong>
      <p>{tx("기록 존재 범위 · 가동률 아님", "记录存在范围 · 非开机率")}</p></article>
      <article><span>{tx("신고 불량", "申报不良")}</span><strong>{hasRecords ? quantity(data.summary.reported_defect_qty, lang) : "—"}<small> ea</small></strong><p>{tx("현장에 저장한 구간 기록의 합", "现场已保存区间记录之和")}</p></article>
      <article><span>{tx("저장한 구간 기록", "已保存区间记录")}</span><strong>{quantity(data.summary.checkpoint_count, lang)}<small>{tx("건", "条")}</small></strong><p>{tx("그중 불량 0 신고", "其中明确申报不良为0")}: {quantity(data.summary.zero_defect_checkpoint_count, lang)}{tx("건", "条")}</p></article>
    </div>
    <p className="analysis-caption">{tx("기록이 없는 설비는 미가동·누락·미저장 등 여러 경우가 있습니다. 교대나 검사 전체를 포함한다는 뜻이 아닙니다.", "无记录设备可能未运行、漏记或未保存，不代表已覆盖全部班次或检验。")}</p>
    {!hasRecords ? <p className="analysis-notice">{tx("선택일에 유효한 현장 구간 기록이 없습니다. 불량 0 또는 양품 100%로 해석할 수 없습니다.", "所选日期没有有效现场区间记录，不能解释为不良为0或良品率100%。")}</p>
      : <div className="analysis-field-detail"><div><h3>{tx("신고 불량 항목 · 상위 6개", "申报不良项目 · 前6项")}</h3>
        {defects.length === 0 ? <p className="analysis-notice">{tx("저장된 기록에서 불량 0을 신고했습니다. 전수 검사 결과를 뜻하지 않습니다.", "已保存记录明确申报不良为0，不代表全数检验结果。")}</p>
          : <ul className="analysis-defects">{defects.map((item) => <li key={item.code}><div><span>{defectLabels[item.code] ? tx(...defectLabels[item.code]) : item.code}</span><strong>{quantity(item.reported_defect_qty, lang)} ea</strong></div>
            <div className="analysis-defect-track" aria-hidden="true"><span style={{ width: `${item.reported_defect_qty / largestDefect * 100}%` }} /></div></li>)}</ul>}
      </div><aside className="analysis-field-basis"><h3>{tx("수량의 해석 범위", "数量解释范围")}</h3>
        <dl><div><dt>{tx("기록 구간 추정 총량", "记录区间估算总量")}</dt><dd>{quantity(data.summary.estimated_gross_qty, lang)} ea</dd></div><div><dt>{tx("추정 총량 − 신고 불량", "估算总量 − 申报不良")}</dt><dd>{quantity(data.summary.derived_good_qty, lang)} ea</dd></div></dl>
        <p>{tx("MES 구간 형합수 × 당시 선택 Cavity로 추정합니다. 차감 후 수량은 검사 확정 양품이나 일일 전체 생산량이 아닙니다. 검사 분모가 없어 불량률은 계산하지 않습니다.", "按区间 MES 模次 × 当时所选穴数估算。扣除后的数量不是检验确认良品或全天总产量。因缺少检验分母，不计算不良率。")}</p>
      </aside></div>}
    <div className="analysis-field-footer"><p className="analysis-caption">{tx("최근 저장", "最近保存")}: {timestamp(data.summary.latest_reported_at, lang)} · {tx("집계 생성", "汇总生成")}: {timestamp(data.freshness.generated_at, lang)} · UTC+8</p>
      <Link className="analysis-link" to="/field/imm01">{historical ? tx("현재 1호기 현장 화면", "当前1号机现场画面") : tx("1호기 현장 기록 열기", "打开1号机现场记录")}<ArrowUpRight size={14} aria-hidden="true" /></Link></div>
    <details className="analysis-disclosure" open={expanded ? true : undefined} key={expanded ? "operations" : "executive"}>
      <summary>{tx("설비별 기록과 현장 연결", "各设备记录与现场入口")}</summary>
      <div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>{tx("설비", "设备")}</th><th>{tx("기록 상태", "记录状态")}</th><th>{tx("구간 수", "区间数")}</th><th>{tx("신고 불량 ea", "申报不良 ea")}</th><th>{tx("최근 저장 UTC+8", "最近保存 UTC+8")}</th><th>{tx("현재 현장", "当前现场")}</th></tr></thead>
        <tbody>{data.machines.map((machine) => <tr key={machine.machine_number}><th scope="row">{machine.machine_number}{tx("호기", "号机")}</th><td>{machine.status === "reported" ? tx("기록 있음", "有记录") : machine.status === "invalid" ? tx("기록 확인 필요", "需核对记录") : tx("기록 없음", "无记录")}</td>
          <td>{quantity(machine.checkpoint_count, lang)}</td><td>{machine.checkpoint_count > 0 ? quantity(machine.reported_defect_qty, lang) : "—"}</td><td>{timestamp(machine.latest_reported_at, lang)}</td>
          <td><Link className="analysis-link" to={getFieldStationPath(machine.machine_number)}>{tx("열기", "打开")}<ArrowUpRight size={14} aria-hidden="true" /></Link></td></tr>)}</tbody></table></div>
      <p className="analysis-caption">{tx("제외된 문서 / 구간 / 중복", "排除文档 / 区间 / 重复")}: {data.coverage.invalid_document_count} / {data.coverage.invalid_checkpoint_count} / {data.coverage.duplicate_checkpoint_count}</p>
    </details>
  </>;
}

function SourceSection({ model, historical, tx, lang }: CopyProps & { model: OverviewBoardModel; historical: boolean }) {
  const warningLabels: Record<string, string> = {
    injection_mes_data_missing: tx("사출 MES 실적이 없어 생산 달성 판단을 보류합니다.", "缺少注塑 MES 实绩，暂停生产达成判断。"),
    injection_mes_data_stale: tx("사출 MES 갱신이 지연되어 마지막 관측값만 참고합니다.", "注塑 MES 更新延迟，仅参考最近观测值。"),
    assembly_mes_data_missing: tx("조립 MES 실적이 없습니다. 확인된 수기 미대사분은 전체 실적과 구분합니다.", "缺少组装 MES 实绩，已知手工待对账数量与整体实绩区分。"),
    injection_plan_missing: tx("사출 계획이 없습니다. 휴무 또는 계획 미등록 여부를 확인하세요.", "无注塑计划，请核对是否休息或未登记计划。"),
    assembly_plan_missing: tx("조립 계획이 없습니다. 휴무 또는 계획 미등록 여부를 확인하세요.", "无组装计划，请核对是否休息或未登记计划。"),
    production_context_unavailable: tx("생산 집계 원천을 불러오지 못했습니다.", "未能获取生产汇总数据源。"),
    mould_board_snapshot_stale: tx("금형 자료가 오래되었습니다. 현재 금형 상태로 단정하지 마세요.", "模具资料已过期，请勿据此判断当前模具状态。"),
    mould_board_snapshot_missing: tx("금형 스냅샷이 없습니다.", "缺少模具快照。"),
    mould_board_snapshot_last_refresh_failed: tx("금형 자료의 최근 갱신이 실패했습니다.", "模具资料最近一次刷新失败。"),
    inventory_snapshot_missing: tx("재고 스냅샷이 없습니다. 재고 0을 뜻하지 않습니다.", "缺少库存快照，不代表库存为0。"),
    inventory_snapshot_not_for_business_date: tx("재고 자료의 기준일이 선택 업무일과 다릅니다.", "库存资料日期与所选业务日不同。"),
    finished_goods_shipping_snapshot_missing: tx("완제품 출하 스냅샷이 없습니다. 다른 출고 원천의 응답 여부와 구분해야 합니다.", "缺少成品出货快照，需与其他出库数据源的响应状态区分。"),
    energy_power_data_missing: tx("전력 원천 자료가 없습니다.", "缺少电力源数据。"),
    energy_power_data_stale: tx("전력 원천 자료 갱신이 지연되었습니다.", "电力源数据更新延迟。"),
    quality_history_unavailable: tx("과거 품질 이력을 불러오지 못했습니다. 현재 불량 0을 뜻하지 않습니다.", "未能获取历史质量记录，不代表当前不良为0。"),
  };
  const names: Record<string, string> = {
    injection_production: tx("사출 생산", "注塑生产"), assembly_production: tx("조립 생산", "组装生产"),
    injection_activity: tx("사출 MES 가동", "注塑 MES 运行"), quality_history: tx("과거 품질 이력", "历史质量记录"),
    inventory: tx("재고", "库存"), weather: tx("날씨", "天气"), moulds: tx("금형", "模具"), mould: tx("금형", "模具"),
    energy: tx("에너지", "能源"), shipping: tx("출하 스냅샷", "出货快照"), outbound: tx("출고", "出库"),
  };
  return <section className="analysis-panel" aria-labelledby="analysis-source-title">
    <div className="analysis-section-heading"><div><h2 id="analysis-source-title"><Database size={19} aria-hidden="true" />{tx("수집 상태와 해석 범위", "采集状态与解释范围")}</h2>
      <p>{tx("응답 행 수는 수집 범위의 단서이며 생산량·불량 건수·완전성을 뜻하지 않습니다.", "响应行数是采集范围的线索，不代表产量、不良件数或完整性。")}</p></div></div>
    {historical && <p className="analysis-notice analysis-notice--warning">{tx("과거일 조회에도 재고·날씨·금형 등 부가 자료는 현재 또는 최근 스냅샷이 섞일 수 있습니다. 당시 상태로 해석하지 마세요.", "查询历史日期时，库存、天气、模具等附加资料可能仍为当前或最近快照，请勿解读为当时状态。")}</p>}
    <div className="analysis-source-grid">{(model.freshness.sources ?? []).map((source) => <article className="analysis-source" key={source.key}>
      <div className="analysis-card-top"><h3>{names[source.key] ?? source.key}</h3><span className={`analysis-badge ${source.status !== "ok" || source.stale ? "analysis-badge--warning" : ""}`}>
        {source.stale || source.status === "stale" ? tx("지연", "延迟") : source.status === "ok" ? tx("응답 확인", "响应可用") : source.status === "missing" ? tx("자료 없음", "无资料") : source.status === "no_resolved_current_parts" ? tx("품번 연결 없음", "无品号关联") : source.status === "partial" ? tx("부분 자료", "部分资料") : tx("확인 필요", "需要核对")}
      </span></div><p>{timestamp(source.sourceLatestAt, lang)} · UTC+8</p><p className="analysis-caption">{tx("응답 행 수", "响应行数")}: {quantity(source.rowCount, lang)}</p>
    </article>)}</div>
    {model.warnings.length > 0 && <details className="analysis-disclosure"><summary>{tx("원천 응답 확인사항", "数据源响应提示")}</summary>
      <ul>{model.warnings.filter((warning) => warningLabels[warning]).map((warning) => <li key={warning}>{warningLabels[warning]}</li>)}</ul>
      <details className="analysis-disclosure"><summary>{tx("근거 코드 상세", "依据代码详情")}</summary><ul>{model.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></details>
    </details>}
  </section>;
}

export default function AnalysisDashboard() {
  const { lang } = useLang();
  const tx: Translate = (ko, zh) => lang === "zh" ? zh : ko;
  const currentDate = useShanghaiBusinessDate();
  const [searchParams, setSearchParams] = useSearchParams();
  const date = resolveAnalysisDate(searchParams.get("date"), currentDate);
  const historical = date !== currentDate;
  const [view, setView] = useState<"executive" | "operations">("executive");
  const overview = useQuery({
    queryKey: ["analysis-overview", date, lang], queryFn: () => getAnalysisOverview(date, lang),
    staleTime: 30_000, retry: 1, refetchInterval: historical ? false : 60_000, refetchOnWindowFocus: false,
  });
  const field = useQuery({
    queryKey: ["analysis-field-operations", date], queryFn: () => getFieldOperations(date),
    staleTime: 30_000, retry: 1, refetchInterval: historical ? false : 60_000, refetchOnWindowFocus: false,
  });
  const setDate = (value: string) => {
    if (!value) return;
    const next = new URLSearchParams(searchParams);
    next.set("date", resolveAnalysisDate(value, currentDate));
    setSearchParams(next);
  };
  const refreshing = overview.isFetching || field.isFetching;
  const collectionItems = [
    [tx("근무 계획", "工作计划"), tx("휴일·설비별 교대·계획정지 시간을 연결해야 가동률과 계획 대비 속도를 비교할 수 있습니다.", "关联休息日、各设备班次和计划停机时间后，才能比较开机率与计划速度。")],
    [tx("품질과 OEE", "质量与 OEE"), tx("검사 대상 수량, 검사 확정 양품, 표준 CT·Cavity의 유효일이 필요합니다. 현재 신고 불량만으로 합격률을 만들지 않습니다.", "需要受检数量、检验确认良品及标准 CT、穴数的有效日期，不以现有不良申报推算合格率。")],
    [tx("납기와 출하", "交期与出货"), tx("약속 납기와 실제 출하 완료 시각을 주문·품번에 연결해야 납기 준수율을 계산할 수 있습니다.", "需将承诺交期及实际出货完成时间关联至订单、品号，才能计算交付准时率。")],
    [tx("원인과 후속 조치", "原因与后续处理"), tx("정지·불량 원인, 담당자, 기한, 종결·재발 확인을 연결해야 경영진의 조치 추적이 가능합니다.", "关联停机、不良原因、负责人、期限及关闭、复发确认后，管理层才能追踪处理进展。")],
    [tx("수집 신뢰도", "采集可信度"), tx("수집 성공 시각·예상 행/설비 범위·누락 구간, MES 확정/추정/수기 대사 상태와 연결키를 보존해야 합니다.", "需保留采集成功时间、预期行数与设备范围、缺失区间，以及 MES 确认、估算、手工对账状态及关联键。")],
  ];
  return <PageContainer className={`analysis-page analysis-view--${view}`}>
    <PageHeader eyebrow="OPERATING INSIGHTS" icon={ChartNoAxesCombined} title={tx("운영 인사이트", "运营洞察")}
      description={tx("생산 진도와 현장 기록을 같은 업무일로 연결해 다음 확인을 정합니다.", "以同一业务日连接生产进度与现场记录，明确下一步核对。")}
      actions={<div className="analysis-date-controls"><label><CalendarDays size={16} aria-hidden="true" /><span className="analysis-sr-only">{tx("업무일", "业务日")}</span><input aria-label={tx("업무일", "业务日")} type="date" value={date} max={currentDate} onChange={(event) => setDate(event.target.value)} /></label>
        <button type="button" className="analysis-button" onClick={() => setDate(currentDate)}>{tx("오늘", "今天")}</button>
        <button type="button" className="analysis-button" disabled={refreshing} onClick={() => { void overview.refetch(); void field.refetch(); }} aria-label={tx("자료 새로고침", "刷新数据")}><RefreshCw size={16} className={refreshing ? "analysis-spin" : ""} aria-hidden="true" /></button></div>} />
    <div className="analysis-context"><div><strong>{date}</strong><span>{tx("중국 업무일 08:00 → 다음 날 08:00 · UTC+8", "中国业务日 08:00 → 次日08:00 · UTC+8")}</span>
      <span>{tx("생산 기준 시각", "生产参考时间")}: {timestamp(overview.data?.businessWindowDetails?.referenceTime ?? overview.data?.generatedAt, lang)}</span></div>
      <div className="ui-segmented-control" role="group" aria-label={tx("보기 선택", "选择视图")}><button type="button" aria-pressed={view === "executive"} className={view === "executive" ? "is-active" : ""} onClick={() => setView("executive")}>{tx("경영 요약", "管理摘要")}</button><button type="button" aria-pressed={view === "operations"} className={view === "operations" ? "is-active" : ""} onClick={() => setView("operations")}>{tx("실무 확인", "现场核对")}</button></div>
    </div>
    <QueryState loading={overview.isPending} error={overview.isError} hasData={Boolean(overview.data)} onRetry={() => { void overview.refetch(); }} tx={tx} />
    {overview.data && <div className="analysis-production-sections"><ProductionSummary model={overview.data} refreshFailed={overview.isError} tx={tx} lang={lang} /><PrioritySection model={overview.data} historical={historical} refreshFailed={overview.isError} tx={tx} lang={lang} /></div>}
    <section className="analysis-panel" aria-labelledby="analysis-field-title"><div className="analysis-section-heading"><div><h2 id="analysis-field-title"><ClipboardCheck size={19} aria-hidden="true" />{tx("현장 입력과 신고 불량", "现场输入与不良申报")}</h2><p>{tx("현장 단말에서 저장한 구간 기록만 집계합니다. 생산 집계와 별도 원천입니다.", "仅汇总现场终端已保存的区间记录，与生产汇总来自不同数据源。")}</p></div></div>
      <QueryState loading={field.isPending} error={field.isError} hasData={Boolean(field.data)} onRetry={() => { void field.refetch(); }} tx={tx} />
      {field.data && <FieldSection data={field.data} expanded={view === "operations"} historical={historical} tx={tx} lang={lang} />}
    </section>
    {overview.data && <SourceSection model={overview.data} historical={historical} tx={tx} lang={lang} />}
    <section className="analysis-panel analysis-next"><details className="analysis-disclosure"><summary>{tx("더 나은 판단을 위해 연결할 데이터", "为改善判断需补充的数据")}</summary><dl>{collectionItems.map(([name, description]) => <div key={name}><dt>{name}</dt><dd>{description}</dd></div>)}</dl></details>
      <nav className="analysis-record-links" aria-label={tx("기존 상세 자료", "原有明细资料")}><span>{tx("상세 자료", "明细资料")}</span>
        <PermissionLink className="analysis-link" to="/injection/dashboard#records">{tx("사출 수기일보", "注塑手工日报")}</PermissionLink>
        <PermissionLink className="analysis-link" to="/assembly#records">{tx("조립 보고", "组装报工")}</PermissionLink>
        <PermissionLink className="analysis-link" to="/quality#stats">{tx("품질 검사", "质量检验")}</PermissionLink>
        <PermissionLink className="analysis-link" to="/sales/inventory-status">{tx("재고 상세", "库存明细")}</PermissionLink>
      </nav>
    </section>
  </PageContainer>;
}
