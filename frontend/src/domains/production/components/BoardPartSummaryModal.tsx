import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { boardPartTrend, type BoardPartDay } from "../board-part-trend";
import { useId } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { http } from "@/shared/api/http";
import { useModalFocusTrap } from "@/shared/hooks/useModalFocusTrap";
import type { AppLanguage } from "@/shared/i18n/language";
import "./board-part-summary.css";

export type BoardPartMachine = { machineNumber: number; model: string; cycleTime: number | null; stale: boolean };

const copy = {
  ko: { title: "품번 C/T 요약", close: "닫기", live: "현재 현황판", machine: "호기", recent: "설비 C/T · 최근 60분", stale: "수집 지연", history: "최근 30일 품번 C/T", average: "기간 평균 C/T", latest: "최근 기록 C/T", range: "일별 최저~최고", graph: "최근 30일 C/T 추이", graphHint: "선이 끊긴 구간은 계산 자료가 없는 날짜입니다.", noChart: "그래프로 표시할 유효한 C/T 기록이 없습니다.", date: "생산일", ct: "추정 C/T", machines: "설비", loading: "보존된 요약을 불러오는 중입니다.", error: "이력 요약을 불러오지 못했습니다.", retry: "다시 시도", empty: "이 품번에 연결된 보존 기록이 없습니다.", basis: "생산일: 상하이 08:00~다음 날 08:00. 종료된 시간대의 보존 기록이며, 근거 없는 값은 —로 표시합니다.", estimate: "품번 연결에 생산계획 순서에 따른 추정이 포함될 수 있습니다.", liveHint: "현재 값은 설비 기준입니다. 복수 품번을 함께 생산하는 경우 품번별 실측 C/T가 아닙니다." },
  zh: { title: "料号 C/T 概览", close: "关闭", live: "当前看板", machine: "号机", recent: "设备 C/T · 最近60分钟", stale: "采集延迟", history: "最近30天料号 C/T", average: "期间平均 C/T", latest: "最近记录 C/T", range: "每日最低~最高", graph: "最近30天 C/T 趋势", graphHint: "折线中断处表示该日期缺少计算资料。", noChart: "暂无可用于绘图的有效 C/T 记录。", date: "生产日", ct: "估算 C/T", machines: "设备", loading: "正在读取保存的概览。", error: "无法读取历史概览。", retry: "重试", empty: "暂无与此料号关联的保存记录。", basis: "生产日：上海08:00~次日08:00。显示已结束时段的保存记录，缺少依据的值显示为 —。", estimate: "料号关联可能包含按生产计划顺序的估算。", liveHint: "当前值按设备统计。多料号同时生产时，不代表各料号的单独实测 C/T。" },
};
const ct = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}s`;

export function BoardPartSummaryModal({ partNo, businessDate, machines, language, onClose }: {
  partNo: string; businessDate: string; machines: BoardPartMachine[]; language: AppLanguage; onClose: () => void;
}) {
  const text = copy[language];
  const titleId = useId();
  const ref = useModalFocusTrap<HTMLDivElement>({ onEscape: onClose });
  const query = useQuery({
    queryKey: ["board-part-cycle-time", partNo, businessDate],
    queryFn: async ({ signal }) => (await http.get<{ start_date: string; end_date: string; cycle_time_seconds: number | null; daily: BoardPartDay[] }>(`/injection/board-part-cycle-time/?${new URLSearchParams({ part_no: partNo })}`, { signal })).data,
    staleTime: 60_000, retry: 1,
  });
  const trend = boardPartTrend(query.data?.daily ?? []);
  return createPortal(<div className="board-part-summary-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="board-part-summary" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><div><span>{text.title}</span><h2 id={titleId}>{partNo}</h2></div><button type="button" onClick={onClose} data-modal-initial-focus>{text.close} ×</button></header>
      <section aria-label={text.live}>
        <h3>{text.live} <small>{businessDate}</small></h3>
        <div className="board-part-summary__machines">{machines.map((machine) => <article key={machine.machineNumber}>
          <div><strong>{machine.machineNumber}{text.machine}</strong><span>{machine.model}</span></div>
          <div><small>{machine.stale ? text.stale : text.recent}</small><b>{ct(machine.stale ? null : machine.cycleTime)}</b></div>
        </article>)}</div>
        <p>{text.liveHint}</p>
      </section>
      <section aria-label={text.history}>
        <h3>{text.history} <small>{query.data ? `${query.data.start_date} ~ ${query.data.end_date}` : ""}</small></h3>
        {query.isPending ? <p role="status">{text.loading}</p> : query.isError ? <div role="alert"><p>{text.error}</p><button type="button" onClick={() => { void query.refetch(); }}>{text.retry}</button></div> : query.data?.daily.some((day) => day.machine_numbers.length) ? <>
          <div className="board-part-summary__stats">
            <div><span>{text.average}</span><strong>{ct(query.data.cycle_time_seconds)}</strong></div>
            <div><span>{text.latest}</span><strong>{ct(trend.latest?.cycle_time_seconds ?? null)}</strong><small>{trend.latest?.business_date ?? "—"}</small></div>
            <div><span>{text.range}</span><strong className="board-part-summary__range">{trend.minimum === null ? "—" : `${trend.minimum.toFixed(1)}–${trend.maximum?.toFixed(1)}s`}</strong></div>
          </div>
          {trend.latest ? <div className="board-part-summary__chart" role="img" aria-label={`${text.graph}. ${text.graphHint}`}>
            <ResponsiveContainer width="100%" height={190}>
              <LineChart data={trend.points} margin={{ top: 12, right: 15, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#dce6ec" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={28} tickLine={false} />
                <YAxis width={50} domain={["auto", "auto"]} tick={{ fontSize: 12 }} tickFormatter={(value: number) => `${value}s`} tickLine={false} axisLine={false} />
                <Tooltip formatter={(value: number) => [ct(value), text.ct]} labelFormatter={(label) => `${text.date} ${label}`} />
                <Line type="linear" dataKey="cycle_time_seconds" stroke="#087da5" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div> : <p role="status">{text.noChart}</p>
          <p className="board-part-summary__graph-hint">{text.graphHint}</p>
          <div className="board-part-summary__table" tabIndex={0} role="region" aria-label={text.history}><table><thead><tr><th>{text.date}</th><th>{text.ct}</th><th>{text.machines}</th></tr></thead><tbody>{[...query.data.daily].reverse().map((day) => <tr key={day.business_date}><td>{day.business_date.slice(5)}</td><td>{ct(day.cycle_time_seconds)}</td><td>{day.machine_numbers.map((number) => `${number}${text.machine}`).join(", ") || "—"}</td></tr>)}</tbody></table></div>
          <p>{text.estimate}</p>
        </> : <p>{text.empty}</p>}
        <p>{text.basis}</p>
      </section>
    </div>
  </div>, document.fullscreenElement ?? document.body);
}
