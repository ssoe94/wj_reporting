import { useId } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { http } from "@/shared/api/http";
import { useModalFocusTrap } from "@/shared/hooks/useModalFocusTrap";
import type { AppLanguage } from "@/shared/i18n/language";
import "./plan-master-gaps.css";

type Category = { code: string; name: string };
type ConfirmedCategory = Category & { path: string; source: "user_confirmed_2026-10-10" };
type MasterGapRow = {
  part_no: string;
  sources: { plan_id: number; uid: string | null; version: number; plan_date: string; machine_name: string;
    lot_no: string | null; model_name: string | null; part_spec: string | null }[];
  source_specs: string[]; source_spec_conflict: boolean; status: "ok" | "unknown"; issue: string | null;
  mes: { material_id: string; specification: string | null; category: Category | null } | null;
  spec_state: "existing" | "blank_candidate" | "source_conflict" | "source_missing" | "unknown";
  spec_candidate: string | null;
  category_state: "existing" | "blank_confirmed" | "decision_required" | "unknown";
  category_candidate: ConfirmedCategory | null; confirmed_category: ConfirmedCategory | null;
};
type MasterGaps = { checked_at: string; rows: MasterGapRow[] };

const copy = {
  ko: { title: "MES 규격·분류 공란 확인", close: "닫기", reload: "다시 조회", loading: "저장된 사출계획과 MES를 조회하고 있습니다.",
    scope: "저장된 사출계획의 SPEC만 비교합니다. 가공 SUFFIX는 포함하지 않습니다.",
    readOnly: "조회 전용 · MES 기존값은 유지하며, 후보는 자동 반영하지 않습니다.",
    error: "MES 조회 실패 · 규격과 분류는 미확인입니다. 다시 조회하세요.", empty: "선택 기준일에 저장된 사출계획이 없습니다.",
    part: "품번", source: "사출계획 SPEC", spec: "MES 규격", category: "MES 분류", unknown: "미확인", blank: "공란",
    preserved: "기존값 유지", candidate: "계획 후보", confirmed: "기존 확인 후보", review: "SPEC 확인 필요", missing: "계획 SPEC 없음",
    decision: "분류 결정 필요", sourceCount: "계획", count: "건", checked: "조회 시각", scroll: "표를 좌우로 이동해 모든 항목을 확인할 수 있습니다.",
    table: "저장된 사출계획 SPEC와 MES 규격·분류 비교", unknownHint: "조회 자료를 확인하지 못했습니다.",
  },
  zh: { title: "检查 MES 规格·分类空白", close: "关闭", reload: "重新查询", loading: "正在查询已保存的注塑计划与 MES。",
    scope: "仅比较已保存注塑计划的 SPEC，不包含加工 SUFFIX。", readOnly: "只读比较 · 保留 MES 现有值，候选值不会自动写入。",
    error: "MES 查询失败 · 规格与分类待核实，请重新查询。", empty: "所选基准日没有已保存的注塑计划。",
    part: "料号", source: "注塑计划 SPEC", spec: "MES 规格", category: "MES 分类", unknown: "待核实", blank: "空白",
    preserved: "保留现有值", candidate: "计划候选", confirmed: "此前确认候选", review: "需确认 SPEC", missing: "计划无 SPEC",
    decision: "需决定分类", sourceCount: "计划", count: "项", checked: "查询时间", scroll: "可左右滚动表格查看全部项目。",
    table: "已保存注塑计划 SPEC 与 MES 规格·分类比较", unknownHint: "未能核实查询资料。",
  },
} as const;

function validResponse(data: MasterGaps): boolean {
  return !!data && typeof data.checked_at === "string" && Number.isFinite(Date.parse(data.checked_at)) && Array.isArray(data.rows)
    && data.rows.every(row => !!row && typeof row.part_no === "string"
      && Array.isArray(row.source_specs) && row.source_specs.every(spec => typeof spec === "string")
      && Array.isArray(row.sources) && row.sources.every(source => !!source && typeof source.plan_date === "string" && typeof source.machine_name === "string")
      && (row.status === "ok" || row.status === "unknown")
      && (row.status !== "ok" || (!!row.mes && typeof row.mes.material_id === "string"
        && (row.mes.specification === null || typeof row.mes.specification === "string")
        && (row.mes.category === null || (!!row.mes.category && typeof row.mes.category.code === "string" && !!row.mes.category.code.trim()
          && typeof row.mes.category.name === "string" && !!row.mes.category.name.trim())))));
}

export function PlanMasterGapsModal({ date, language, onClose }: {
  date: string; language: AppLanguage; onClose: () => void;
}) {
  const text = copy[language];
  const titleId = useId();
  const scopeId = useId();
  const focusRef = useModalFocusTrap<HTMLDivElement>({ onEscape: onClose });
  const query = useQuery({
    queryKey: ["production", "plan-master-gaps", date, "injection"],
    queryFn: async () => {
      const { data } = await http.get<MasterGaps>("/production/plan-workflow/", {
        params: { action: "master_gaps", start: date, end: date, plan_type: "injection" },
      });
      if (!validResponse(data)) throw Error("Invalid master comparison response");
      return data;
    },
    retry: false, refetchOnWindowFocus: false, refetchOnMount: "always" as const,
  });
  const available = !query.isFetching && !query.isError ? query.data : undefined;
  return createPortal(<div className="plan-master-gaps-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={focusRef} className="plan-master-gaps" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={scopeId} tabIndex={-1}>
      <header><div><h2 id={titleId}>{text.title}</h2><p>{date} · {language === "ko" ? "사출" : "注塑"}</p></div>
        <button type="button" onClick={onClose} data-modal-initial-focus>{text.close}</button></header>
      <div className="plan-master-gaps__scope" id={scopeId}><p>{text.scope}</p><p>{text.readOnly}</p></div>
      <div className="plan-master-gaps__toolbar">
        {available && <span>{text.checked}: <time dateTime={available.checked_at}>{new Date(available.checked_at).toLocaleString(language === "ko" ? "ko-KR" : "zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time></span>}
        <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>{text.reload}</button>
      </div>
      {query.isFetching || query.isPending ? <p role="status">{text.loading}</p> : query.isError ? <p role="alert" className="plan-master-gaps__attention">{text.error}</p>
        : available?.rows.length === 0 ? <p role="status">{text.empty}</p> : available && <>
          <p className="plan-master-gaps__scroll-hint">{text.scroll}</p>
          <div className="plan-master-gaps__table-scroll" role="region" aria-label={text.table} tabIndex={0}>
            <table><caption>{text.table}</caption><thead><tr><th scope="col">{text.part}</th><th scope="col">{text.source}</th><th scope="col">{text.spec}</th><th scope="col">{text.category}</th></tr></thead>
              <tbody>{available.rows.map((row, index) => {
                const known = row.status === "ok" && row.mes !== null;
                const spec = known && typeof row.mes?.specification === "string" ? row.mes.specification : null;
                const category = known ? row.mes?.category : null;
                const specExisting = !!spec?.trim();
                const categoryExisting = !!category?.code && !!category?.name;
                return <tr key={`${row.part_no}:${index}`}>
                  <th scope="row"><strong>{row.part_no || "—"}</strong><details><summary>{text.sourceCount} {row.sources.length}{text.count}</summary>
                    <ul>{row.sources.map(source => <li key={source.plan_id}>{source.plan_date} · {source.machine_name} · {source.part_spec?.trim() || text.missing}</li>)}</ul>
                  </details></th>
                  <td>{row.source_specs.length ? <ul>{row.source_specs.map(specification => <li key={specification}>{specification}</li>)}</ul> : text.missing}
                    {(row.source_spec_conflict || row.source_specs.length > 1) && <span className="plan-master-gaps__attention">{text.review}</span>}</td>
                  <td>{!known ? <span title={text.unknownHint}>{text.unknown}</span> : specExisting ? <>{spec}<small>{text.preserved}</small></>
                    : <><span>{text.blank}</span>{row.spec_state === "blank_candidate" && !row.source_spec_conflict && row.source_specs.length === 1 && row.spec_candidate === row.source_specs[0] && <small>{text.candidate}: {row.spec_candidate}</small>}
                      {row.spec_state === "source_conflict" && <small className="plan-master-gaps__attention">{text.review}</small>}
                      {row.spec_state === "source_missing" && <small>{text.missing}</small>}</>}</td>
                  <td>{!known ? <span title={text.unknownHint}>{text.unknown}</span> : categoryExisting ? <>{category.name} · {category.code}<small>{text.preserved}</small></>
                    : <><span>{text.blank}</span>{row.category_state === "blank_confirmed" && row.category_candidate?.source === "user_confirmed_2026-10-10"
                      ? <small>{text.confirmed}: {row.category_candidate.path} · {row.category_candidate.code}</small>
                      : <small className="plan-master-gaps__attention">{text.decision}</small>}</>}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </>}
    </div>
  </div>, document.body);
}
