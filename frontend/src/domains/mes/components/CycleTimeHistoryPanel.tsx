import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router-dom";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AppLanguage } from "@/shared/i18n/language";
import { getCycleTimeHistory } from "../cycle-time-api";
import { buildCycleTimeTrend, cycleTimeAttribution, cycleTimePartSearch, cycleTimePreviousDay, cycleTimeRangeDays, resolveCycleTimeScope, shiftCycleTimeDate, validCycleTimeRange } from "../cycle-time-history";
import type { CycleTimeAttribution, CycleTimeDaily, CycleTimeHistoryResponse, CycleTimeHistoryScope, CycleTimeQuality } from "../cycle-time-types";
import "./cycle-time-history.css";

const copy = {
  ko: {
    title: "C/T 기록 · 이력", subtitle: "설비·생산일별 추정 C/T를 확인하고 Part No.를 눌러 변동 추이를 추적합니다.",
    allMachines: "전체 설비", machine: "설비", machineSuffix: "호기", start: "시작일", end: "종료일", apply: "조회", last7: "최근 7일", last30: "최근 30일", selectedDay: "기준일 하루", previous: "이전 기간", next: "다음 기간",
    rangeError: "조회 기간은 1~366일이며 종료일은 현재 생산일을 넘을 수 없습니다.", partSearch: "Part No. 검색", partHint: "전체 Part No. 입력", partSubmit: "품번 이력", back: "설비별 이력으로 돌아가기", crossMachine: "해당 품번의 전체 설비 이력", period: "기간 추정 C/T", seconds: "초", usedShots: "C/T 계산 형합수", savedRows: "보존된 설비·일자", latest: "종료일 / 전일 변화", noCompare: "전일 비교 자료 부족", trend: "생산일별 C/T 추이", trendHint: "빈 구간은 C/T를 계산할 근거가 없는 날짜입니다. 정지 또는 0초로 해석하지 않습니다.", selectForTrend: "설비를 선택하거나 Part No.를 누르면 날짜별 추이 그래프를 볼 수 있습니다.", daily: "일자별 기록", date: "생산일", cycleTime: "추정 C/T", shots: "계산 형합수", coverage: "관측률", quality: "자료 상태", parts: "Part No. · 연결 근거", archived: "보존 기록", loading: "보존된 C/T 기록을 불러오는 중입니다.", error: "C/T 기록을 불러오지 못했습니다.", retry: "다시 시도", empty: "이 조건으로 보존된 C/T 기록이 없습니다.", emptyHint: "다른 날짜·설비·품번으로 조회해 주세요. 과거 원시 기록이 이미 축약됐다면 정확한 C/T를 복구하지 못할 수 있습니다. 최초 이력 보존 작업이 완료됐는지도 확인이 필요합니다.", refresh: "새로고침", available: "관측 자료 있음", limited: "관측 제한", unavailable: "계산 근거 부족", noProduction: "형합 미관측", actual: "실제 생산시간 연결", estimated: "계획 순서로 추정", unattributed: "품번 미연결", mixed: "연결 근거 혼합", hourly: "시간대별 보존 기록", hour: "시간대", revision: "기록 버전", source: "원천 최종시각", savedAt: "보존 갱신시각", hourlyHint: "시간대별 기록은 설비 또는 품번을 선택하고 31일 이내로 조회하면 표시됩니다.", dayBasis: "생산일: 상하이 08:00 ~ 다음 날 08:00", method: "C/T는 5분 이내의 관측 간격 중 형합 증가가 확인된 시간 ÷ 해당 형합수입니다. 개별 사이클 실측값이 아니며 정지·누락 구간은 계산에서 제외됩니다.", preservation: "이 화면은 서버에 보존된 집계 기록을 조회합니다. 원시 기록이 축약되어도 보존된 C/T 기록은 유지됩니다.", attribution: "계획 순서로 추정한 품번은 실제 금형 교체·생산 시각이 확정된 연결과 구분합니다.", observations: "관측률은 C/T 계산의 정확도나 설비 가동률을 의미하지 않습니다.", showing: "표시", records: "건", previousPage: "이전 페이지", nextPage: "다음 페이지", refreshing: "갱신 중", detail: "계산 기준과 보존 안내", warnings: "원천 자료 유의사항", incomplete: "일부 날짜·설비의 원천 자료가 부족하거나 제한되어 있습니다. 각 행의 자료 상태를 확인하세요.", allPart: "전체 품번", noValue: "—",
  },
  zh: {
    title: "C/T 记录 · 历史", subtitle: "按设备、生产日查看估算 C/T，点击 Part No. 追踪变化趋势。",
    allMachines: "全部设备", machine: "设备", machineSuffix: "号机", start: "开始日期", end: "结束日期", apply: "查询", last7: "最近 7 天", last30: "最近 30 天", selectedDay: "仅基准日", previous: "上一期间", next: "下一期间",
    rangeError: "查询期间须为 1~366 天，结束日期不得晚于当前生产日。", partSearch: "搜索 Part No.", partHint: "输入完整 Part No.", partSubmit: "料号历史", back: "返回设备历史", crossMachine: "该料号的全部设备记录", period: "期间估算 C/T", seconds: "秒", usedShots: "C/T 计算模次", savedRows: "已保存设备·日期", latest: "结束日 / 较前日", noCompare: "前日比较资料不足", trend: "每日 C/T 趋势", trendHint: "空白区间表示缺少 C/T 计算依据，不表示停机或 0 秒。", selectForTrend: "选择设备或点击 Part No.，即可查看每日趋势图。", daily: "每日记录", date: "生产日", cycleTime: "估算 C/T", shots: "计算模次", coverage: "观测率", quality: "资料状态", parts: "Part No. · 关联依据", archived: "已保存记录", loading: "正在读取已保存的 C/T 记录。", error: "无法读取 C/T 记录。", retry: "重试", empty: "此条件下暂无已保存的 C/T 记录。", emptyHint: "请尝试其他日期、设备或料号。若过去的原始记录已被压缩，可能无法还原准确 C/T。也需要确认首次历史归档是否已完成。", refresh: "刷新", available: "有观测资料", limited: "观测受限", unavailable: "计算依据不足", noProduction: "未观测到合模", actual: "按实际生产时段关联", estimated: "按计划顺序估算", unattributed: "料号未关联", mixed: "关联依据混合", hourly: "每小时保存记录", hour: "时段", revision: "记录版本", source: "源数据最后时间", savedAt: "归档更新时间", hourlyHint: "选择设备或料号且查询期间在 31 天以内，即可查看每小时时段记录。", dayBasis: "生产日：上海 08:00 ~ 次日 08:00", method: "C/T = 5 分钟以内观测间隔中有模次增长的时间 ÷ 对应模次。它不是单周期实测值，停机及缺失区间不参与计算。", preservation: "此页面查询服务器已保存的汇总记录。原始记录压缩后，已保存的 C/T 记录仍会保留。", attribution: "按计划顺序估算的料号关联，与已确认实际换模、生产时间的关联分别标明。", observations: "观测率不代表 C/T 准确率或设备开机率。", showing: "显示", records: "条", previousPage: "上一页", nextPage: "下一页", refreshing: "刷新中", detail: "计算依据及保存说明", warnings: "源资料注意事项", incomplete: "部分日期、设备的源资料不足或受限，请检查各行的资料状态。", allPart: "全部料号", noValue: "—",
  },
};
type Copy = typeof copy.ko;

const warningCopy: Record<string, { ko: string; zh: string }> = {
  observation_gap: { ko: "5분을 넘는 관측 공백 구간을 C/T 계산에서 제외했습니다.", zh: "超过 5 分钟的观测缺口已从 C/T 计算中排除。" },
  counter_reset: { ko: "형합 누적값이 초기화된 구간을 제외했습니다.", zh: "合模累计值归零或重置的区间已排除。" },
  counter_correction: { ko: "형합 누적값이 감소·보정된 구간을 제외했습니다.", zh: "合模累计值减少或修正的区间已排除。" },
  invalid_counter: { ko: "유효하지 않은 형합 계측값이 포함돼 있습니다.", zh: "源数据中包含无效合模计数值。" },
  incomplete_coverage: { ko: "관측 자료가 일부 시간대를 충분히 포함하지 못합니다.", zh: "观测资料未充分覆盖部分时段。" },
  no_archived_data: { ko: "선택 조건의 보존 기록이 없습니다.", zh: "所选条件下暂无保存记录。" },
  plan_estimated: { ko: "일부 품번은 생산계획 순서와 Cavity로 추정해 연결했습니다.", zh: "部分料号按生产计划顺序及模穴数估算关联。" },
  unattributed: { ko: "일부 형합 기록은 품번이 연결되지 않았습니다.", zh: "部分合模记录尚未关联料号。" },
  execution_boundary_ambiguous: { ko: "실제 생산시간이 겹치거나 교체 경계가 불명확해 품번 연결을 보류했습니다.", zh: "实际生产时段重叠或换模边界不明确，暂缓关联料号。" },
  source_identity_retained: { ko: "현재 계획에서 사라진 항목은 당시 저장된 품번·원천 정보로 보존합니다.", zh: "当前计划中已不存在的项目，保留归档时的料号及源信息。" },
  archived_source_retained: { ko: "원시 기록이 줄어든 구간은 이전에 보존한 관측 자료를 유지합니다.", zh: "原始记录减少的时段，继续保留先前归档的观测资料。" },
  ambiguous_device_mapping: { ko: "같은 설비·시간대에 여러 수집 장치의 기록이 겹쳐 해당 구간을 C/T 계산에서 제외했습니다.", zh: "同一设备时段存在多个采集装置的重叠记录，该区间已从 C/T 计算中排除。" },
};

function warningLabel(value: string, language: AppLanguage) {
  return warningCopy[value]?.[language] ?? (language === "ko" ? "원천 자료를 추가 확인해야 하는 기록이 있습니다." : "部分记录需要进一步核对源资料。");
}

function number(value: number | null | undefined, digits?: number) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits ?? 2, minimumFractionDigits: digits ?? 0 });
}
function qualityLabel(value: CycleTimeQuality, text: Copy) {
  return ({ available: text.available, limited: text.limited, unavailable: text.unavailable, no_production: text.noProduction })[value] ?? text.unavailable;
}
function attributionLabel(value: CycleTimeAttribution, text: Copy) {
  return ({ execution_interval: text.actual, plan_estimated: text.estimated, unattributed: text.unattributed, mixed: text.mixed })[value] ?? text.unattributed;
}
function sourceTime(value: string | null, language: AppLanguage) {
  return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "—";
}

function RangeForm({ scope, date, currentDate, text, onRange }: { scope: CycleTimeHistoryScope; date: string; currentDate: string; text: Copy; onRange: (start: string, end: string) => void }) {
  const [start, setStart] = useState(scope.startDate);
  const [end, setEnd] = useState(scope.endDate);
  const [invalid, setInvalid] = useState(false);
  const days = cycleTimeRangeDays(scope.startDate, scope.endDate);
  return <div className="ct-history__range">
    <form className="ct-history__range-form" onSubmit={(event) => { event.preventDefault(); const valid = validCycleTimeRange(start, end, currentDate); setInvalid(!valid); if (valid) onRange(start, end); }}>
      <label><span>{text.start}</span><input type="date" value={start} max={currentDate} required onChange={(event) => setStart(event.target.value)} /></label>
      <label><span>{text.end}</span><input type="date" value={end} max={currentDate} required onChange={(event) => setEnd(event.target.value)} /></label>
      <button type="submit" className="button button--primary">{text.apply}</button>
    </form>
    <div className="ct-history__quick-ranges" aria-label={`${text.start} / ${text.end}`}>
      <button type="button" onClick={() => onRange(shiftCycleTimeDate(scope.startDate, -days), shiftCycleTimeDate(scope.endDate, -days))} aria-label={text.previous}>←</button>
      <button type="button" onClick={() => onRange(date, date)}>{text.selectedDay}</button>
      <button type="button" onClick={() => onRange(shiftCycleTimeDate(date, -6), date)}>{text.last7}</button>
      <button type="button" onClick={() => onRange(shiftCycleTimeDate(date, -29), date)}>{text.last30}</button>
      <button type="button" disabled={shiftCycleTimeDate(scope.endDate, days) > currentDate} onClick={() => onRange(shiftCycleTimeDate(scope.startDate, days), shiftCycleTimeDate(scope.endDate, days))} aria-label={text.next}>→</button>
    </div>
    {invalid && <p className="notice notice--warning" role="alert">{text.rangeError}</p>}
  </div>;
}

function PartSearch({ partNo, text, onPart }: { partNo: string | null; text: Copy; onPart: (part: string | null) => void }) {
  const [value, setValue] = useState(partNo ?? "");
  return <form className="ct-history__part-search" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onPart(value.trim()); }}>
    <label><span>{text.partSearch}</span><input type="search" value={value} placeholder={text.partHint} required maxLength={100} onChange={(event) => setValue(event.target.value)} /></label>
    <button type="submit" className="button button--ghost">{text.partSubmit}</button>
  </form>;
}

function Parts({ row, text, onPart }: { row: CycleTimeDaily; text: Copy; onPart: (part: string) => void }) {
  if (!row.parts.length) return <span className="ct-history__muted">{text.unattributed}</span>;
  return <div className="ct-history__parts">{row.parts.map((part, index) => <div key={`${part.part_no}:${part.lot_no}:${part.sequence}:${index}`}>
    {part.part_no ? <button type="button" className="ct-history__part-link" onClick={() => onPart(part.part_no!)}>{part.part_no}</button> : <span>{text.unattributed}</span>}
    <small>{attributionLabel(part.attribution, text)}{part.lot_no ? ` · LOT ${part.lot_no}` : ""}</small>
  </div>)}</div>;
}

function HistoryResults({ data, scope, language, text, onPart, onMachine }: { data: CycleTimeHistoryResponse; scope: CycleTimeHistoryScope; language: AppLanguage; text: Copy; onPart: (part: string) => void; onMachine: (machine: number) => void }) {
  const [page, setPage] = useState(0);
  const rows = useMemo(() => [...data.daily].sort((a, b) => b.business_date.localeCompare(a.business_date) || a.machine_number - b.machine_number), [data.daily]);
  const trend = useMemo(() => buildCycleTimeTrend(data.daily, scope.startDate, scope.endDate), [data.daily, scope.startDate, scope.endDate]);
  const comparison = cycleTimePreviousDay(rows, scope.endDate);
  const selected = scope.machineNumber !== null || Boolean(scope.partNo);
  const pageSize = 20;
  const displayedRows = rows.slice(page * pageSize, (page + 1) * pageSize);
  if (!rows.length) return <div className="ct-history__empty" role="status"><strong>{text.empty}</strong><p>{text.emptyHint}</p></div>;
  return <>
    <div className="ct-history__metrics">
      <div><span>{text.period}</span><strong>{number(data.summary.cycle_time_seconds, 1)} <small>{text.seconds}</small></strong><small>{scope.partNo ?? (scope.machineNumber ? `${scope.machineNumber}${text.machineSuffix}` : text.allMachines)} · {attributionLabel(cycleTimeAttribution(data.parts), text)}</small></div>
      <div><span>{text.usedShots}</span><strong>{number(data.summary.shot_count)}</strong><small>{text.archived}</small></div>
      <div><span>{text.latest}</span><strong>{number(comparison.current, 1)} <small>{text.seconds}</small></strong><small>{comparison.change === null ? text.noCompare : `${comparison.change > 0 ? "+" : ""}${number(comparison.change, 1)} ${text.seconds}`}</small></div>
    </div>
    {data.warnings.length > 0 && <div className="notice notice--warning ct-history__warnings"><strong>{text.warnings}</strong><ul>{[...new Set(data.warnings)].map((warning) => <li key={warning}>{warningLabel(warning, language)}</li>)}</ul></div>}
    {selected ? <section className="ct-history__trend" aria-label={text.trend}>
      <h4>{text.trend}</h4><p>{text.trendHint}</p>
      <div className="ct-history__chart" role="img" aria-label={`${text.trend} · ${scope.startDate} ~ ${scope.endDate} · ${text.daily}`}>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={trend.points} margin={{ top: 12, right: 18, left: 0, bottom: 0 }} accessibilityLayer>
            <CartesianGrid vertical={false} stroke="var(--surface-border)" />
            <XAxis dataKey="label" minTickGap={24} tick={{ fill: "var(--muted)", fontSize: 12 }} />
            <YAxis unit={` ${text.seconds}`} width={65} domain={[0, "auto"]} tick={{ fill: "var(--muted)", fontSize: 12 }} />
            <Tooltip content={({ active, payload }) => active && payload?.length ? <div className="ct-history__tooltip"><strong>{payload[0]?.payload?.date}</strong>{payload.map((item) => <div key={String(item.dataKey)}><span>{item.name}: {number(typeof item.value === "number" ? item.value : null, 1)} {text.seconds}</span><small>{attributionLabel(item.payload?.[`attribution_${String(item.dataKey).replace("machine_", "")}`] ?? "unattributed", text)}</small></div>)}</div> : null} />
            <Legend />
            {trend.machines.map((machine, index) => <Line key={machine} type="linear" dataKey={`machine_${machine}`} name={`${machine}${text.machineSuffix}`} stroke={["#006fa5", "#142b3d", "#627789"][index % 3]} strokeWidth={2} strokeDasharray={index >= 3 ? `${3 + index} 3` : undefined} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section> : <p className="ct-history__hint">{text.selectForTrend}</p>}
    <div className="ct-history__table-heading"><h4>{text.daily}</h4><span>{text.savedRows} {number(rows.length)}{text.records}</span></div>
    <div className="ct-history__table-wrap" tabIndex={0} role="region" aria-label={text.daily}>
      <table><thead><tr><th scope="col">{text.date}</th><th scope="col">{text.machine}</th><th scope="col">{text.cycleTime}</th><th scope="col">{text.shots}</th><th scope="col">{text.coverage}</th><th scope="col">{text.quality}</th><th scope="col">{text.parts}</th></tr></thead>
        <tbody>{displayedRows.map((row) => <tr key={`${row.business_date}:${row.machine_number}`}>
          <td>{row.business_date}</td><td><button type="button" className="ct-history__part-link" onClick={() => onMachine(row.machine_number)}>{row.machine_number}{text.machineSuffix}</button></td>
          <td className="ct-history__value">{number(row.cycle_time_seconds, 1)}{row.cycle_time_seconds !== null ? ` ${text.seconds}` : ""}</td><td>{number(row.shot_count)}</td>
          <td>{number(row.coverage_percent, 1)}{row.coverage_percent !== null && row.coverage_percent !== undefined ? "%" : ""}</td>
          <td><span className={`ct-history__quality ct-history__quality--${row.quality}`}>{qualityLabel(row.quality, text)}</span><small className="ct-history__saved">{text.archived}</small>{Boolean(row.warnings?.length) && <details className="ct-history__row-warnings"><summary>{text.warnings}</summary><ul>{[...new Set(row.warnings)].map((warning) => <li key={warning}>{warningLabel(warning, language)}</li>)}</ul></details>}</td>
          <td><Parts row={row} text={text} onPart={onPart} /></td>
        </tr>)}</tbody></table>
    </div>
    {rows.length > pageSize && <nav className="ct-history__pagination" aria-label={text.daily}>
      <span>{text.showing} {page * pageSize + 1}–{Math.min((page + 1) * pageSize, rows.length)} / {number(rows.length)}</span>
      <button type="button" className="button button--ghost" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{text.previousPage}</button>
      <button type="button" className="button button--ghost" disabled={(page + 1) * pageSize >= rows.length} onClick={() => setPage((value) => value + 1)}>{text.nextPage}</button>
    </nav>}
    <details className="ct-history__hourly"><summary>{text.hourly} <span>{data.hourly.length ? `(${number(data.hourly.length)})` : ""}</span></summary>
      {data.hourly.length ? <div className="ct-history__table-wrap ct-history__table-wrap--hourly" tabIndex={0} role="region" aria-label={text.hourly}><table><thead><tr><th>{text.hour}</th><th>{text.machine}</th><th>{text.cycleTime}</th><th>{text.quality}</th><th>{text.parts}</th><th>{text.source}</th><th>{text.savedAt}</th><th>{text.revision}</th></tr></thead><tbody>
        {data.hourly.map((row) => <tr key={`${row.machine_number}:${row.device_code}:${row.bucket_start}`}><td>{sourceTime(row.bucket_start, language)} → {sourceTime(row.bucket_end, language)}</td><td>{row.machine_number}{text.machineSuffix}<small className="ct-history__saved">{row.device_code}</small></td><td>{number(row.cycle_time_seconds, 1)} {row.cycle_time_seconds !== null ? text.seconds : ""}</td><td>{qualityLabel(row.quality, text)}</td><td><Parts row={row} text={text} onPart={onPart} /></td><td>{sourceTime(row.source_latest_at, language)}</td><td>{sourceTime(row.archived_at, language)}</td><td>{row.revision}</td></tr>)}
      </tbody></table></div> : <p>{text.hourlyHint}</p>}
    </details>
  </>;
}

export function CycleTimeHistoryPanel({ date, currentDate, machineNumber, language, onMachineChange }: { date: string; currentDate: string; machineNumber: number | null; language: AppLanguage; onMachineChange: (machine: number | null) => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const scope = resolveCycleTimeScope(searchParams.toString(), date, machineNumber, currentDate);
  const [isOpen, setIsOpen] = useState(() => machineNumber !== null || Boolean(scope.partNo) || location.hash === "#cycle-time-history");
  const text = copy[language];
  const query = useQuery({ queryKey: ["mes", "cycle-time-history", scope], queryFn: ({ signal }) => getCycleTimeHistory(scope, signal), enabled: isOpen, staleTime: 60_000, retry: 1 });
  const onRange = (start: string, end: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("ct_start", start); next.set("ct_end", end); setSearchParams(next);
  };
  const onPart = (part: string | null) => { setSearchParams(cycleTimePartSearch(searchParams.toString(), part)); };
  return <details className="panel ct-history" id="cycle-time-history" open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
    <summary className="ct-history__summary"><div><span className="panel-card__eyebrow">CYCLE TIME HISTORY</span><h3>{text.title}</h3><p>{text.subtitle}</p></div><span className="ct-history__scope-label">{scope.partNo ?? (machineNumber ? `${machineNumber}${text.machineSuffix}` : text.allMachines)}</span></summary>
    {isOpen && <div className="ct-history__body">
      <div className="ct-history__scope-row">
        <label className="ct-history__machine-select"><span>{text.machine}</span><select value={scope.partNo ? "part" : machineNumber ?? "all"} onChange={(event) => onMachineChange(event.target.value === "all" ? null : Number(event.target.value))}>
          {scope.partNo && <option value="part" disabled>{text.crossMachine}</option>}<option value="all">{text.allMachines}</option>{Array.from({ length: 17 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}{text.machineSuffix}</option>)}
        </select></label>
        <PartSearch key={scope.partNo} partNo={scope.partNo} text={text} onPart={onPart} />
      </div>
      {scope.partNo && <div className="ct-history__part-context"><div><strong>{scope.partNo}</strong><span>{text.crossMachine}</span></div><button type="button" className="button button--ghost" onClick={() => onPart(null)}>← {text.back}</button></div>}
      <RangeForm key={`${scope.startDate}:${scope.endDate}`} scope={scope} date={date} currentDate={currentDate} text={text} onRange={onRange} />
      <div className="ct-history__basis"><span>{text.dayBasis} · {scope.startDate} ~ {scope.endDate}</span><button type="button" className="button button--ghost" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{query.isFetching && !query.isPending ? text.refreshing : text.refresh}</button></div>
      {query.data?.calculation.completed_hours_only && <p className="ct-history__archive-note">{language === "ko" ? `각 시간대 종료 ${query.data.calculation.archive_delay_minutes ?? 5}분 후부터 보존합니다. 현재 진행 중인 시간대는 다음 보존 주기에 반영됩니다.` : `各时段结束 ${query.data.calculation.archive_delay_minutes ?? 5} 分钟后开始归档，正在进行的时段将在下一归档周期更新。`}</p>}
      {query.isPending ? <p className="ct-history__empty" role="status">{text.loading}</p> : query.isError ? <div className="notice notice--warning" role="alert"><p>{text.error}</p><button type="button" className="button button--ghost" onClick={() => { void query.refetch(); }}>{text.retry}</button></div> : query.data ? <HistoryResults key={`${scope.startDate}:${scope.endDate}:${scope.machineNumber}:${scope.partNo}`} data={query.data} scope={scope} language={language} text={text} onPart={onPart} onMachine={onMachineChange} /> : null}
      <details className="ct-history__method"><summary>{text.detail}</summary><p>{text.method}</p><p>{text.attribution}</p><p>{text.observations}</p><p>{text.preservation}</p>{query.data && <small>{query.data.calculation.version}</small>}</details>
    </div>}
  </details>;
}
