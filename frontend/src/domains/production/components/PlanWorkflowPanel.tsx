import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changePlanWorkflow, getPlanWorkflow, workflowLabels, type WorkflowRow, type MaterialSnapshot, type WorkflowGroup } from "../plan-workflow-api";
import type { AppLanguage } from "@/shared/i18n/language";
import type { PlanType } from "../api";
import "./plan-workflow.css";
import { materialRequirement } from "../plan-workflow-form";
import { canRecheckPlanRequest, canReleasePlanSendAttempt, canSendPlanRequest, PLAN_CREATE_BATCH_LIMIT, planRequestState, safeMesId,
  type PlanServiceResult } from "../plan-workflow-service";
import { recheckPlanRequest, sendPlanSelection } from "../plan-workflow-service-api";

type Props = { date: string; language: AppLanguage };
type EditorProps = Props & { onDirtyChange: (dirty: boolean) => void; onPendingChange: (pending: boolean) => void;
  sendAttempts: Set<string> };
type InputDraft = { key: string; numerator: string; denominator: string; material_version: string };
const fields = ["bom_version", "mold_code", "resource_code", "process_code", "process_num", "route_code", "output_unit_name", "output_unit_id", "output_version"] as const;
const fieldLabels: Record<string, [string, string]> = { bom_version: ["BOM/배합 버전", "BOM／配方版本"],
  mold_code: ["금형·셋업 코드", "模具／设置编号"], resource_code: ["MES 설비 코드", "MES设备编号"],
  process_code: ["MES 공정 코드", "MES工序编号"], process_num: ["공정 순번", "工序序号"],
  route_code: ["공정경로 코드", "工艺路线编号"], output_unit_name: ["제품 단위명", "产品单位名称"],
  output_unit_id: ["제품 단위 ID", "产品单位ID"], output_version: ["제품 물료 버전", "产品物料版本"] };

export function PlanWorkflowPanel({ date, language }: Props) {
  const [open, setOpen] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  // Ambiguous sends remain fenced when this panel is collapsed or its scope changes.
  const sendAttempts = useRef(new Set<string>());
  return <section className="panel plan-workflow">
    <div className="plan-workflow__heading"><div><h3 className="panel__title">{language === "ko" ? "원료 확인 · MES 工单 준비" : "原料确认 · MES工单准备"}</h3>
      </div>
      <button type="button" className="btn btn-outline" disabled={saving} onClick={() => { if (saving) return; if (open && draftDirty) setClosing(true); else setOpen(!open); }} aria-expanded={open}>{open ? (language === "ko" ? "접기" : "收起") : (language === "ko" ? "준비 검토" : "审核准备")}</button></div>
    {closing && <div className="plan-workflow__discard" role="alert"><span>{language === "ko" ? "미저장 초안이 있습니다." : "有未保存的草稿。"}</span>
      <button type="button" disabled={saving} onClick={() => { if (saving) return; setOpen(false); setDraftDirty(false); setClosing(false); }}>{language === "ko" ? "초안 버리고 접기" : "放弃草稿并收起"}</button>
      <button type="button" onClick={() => setClosing(false)}>{language === "ko" ? "계속 편집" : "继续编辑"}</button></div>}
    {open && <WorkflowEditor date={date} language={language} onDirtyChange={setDraftDirty} onPendingChange={setSaving} sendAttempts={sendAttempts.current} />}
  </section>;
}

function WorkflowEditor({ date, language, onDirtyChange, onPendingChange, sendAttempts }: EditorProps) {
  const zh = language === "zh";
  const label = (code: string) => workflowLabels[code]?.[zh ? 1 : 0] || (zh ? "请负责人确认后继续" : "담당자 확인 후 진행하세요");
  const [dayUid, setDayUid] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Parent plan navigation remains independent from the scope of an open draft.
  const [start, setStart] = useState(date);
  const [retainedForDate, setRetainedForDate] = useState<string | null>(null);
  const dateChanged = date !== start;
  const dateReviewRequired = dateChanged && retainedForDate !== date;
  const [pendingChange, setPendingChange] = useState<(() => void) | null>(null);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  function leave(action: () => void) { if (busy || dateReviewRequired) return; if (dirty) setPendingChange(() => action); else action(); }
  function clearDraft() { setEditing(null); setDefaultTarget(null); setDirty(false); setPendingChange(null); setNeedsReview(false); }
  function changed() { setDirty(true); setConfirmed(false); }
  const [type, setType] = useState<PlanType>("injection");
  const [end, setEnd] = useState(date);
  const [editing, setEditing] = useState<WorkflowRow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [inputs, setInputs] = useState<InputDraft[]>([{ key: "", numerator: "", denominator: "", material_version: "" }]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [previous, setPrevious] = useState("");
  const [defaultTarget, setDefaultTarget] = useState<WorkflowRow | null>(null);
  const [defaultReason, setDefaultReason] = useState("");
  const [defaultConfirmed, setDefaultConfirmed] = useState(false);
  const [selectedRequests, setSelectedRequests] = useState<string[]>([]);
  const [servicePending, setServicePending] = useState(false);
  const serviceInFlight = useRef(false);
  const attemptReadVersions = useRef(new Map<string, number>());
  const [serviceResults, setServiceResults] = useState<Record<string, PlanServiceResult>>({});
  const [serviceNotice, setServiceNotice] = useState("");
  const [serviceProgress, setServiceProgress] = useState<{ completed: number; total: number } | null>(null);
  const [, updateSendFence] = useState(0);
  const client = useQueryClient();
  const scope = { start, end, plan_type: type };
  const query = useQuery({ queryKey: ["production", "plan-workflow", scope], queryFn: () => getPlanWorkflow(scope), retry: false });
  const data = query.data;
  useEffect(() => {
    if (serviceInFlight.current || servicePending || query.isFetching || query.isError || !query.isFetchedAfterMount) return;
    let released = false;
    data?.requests.forEach(request => {
      if (query.dataUpdatedAt > (attemptReadVersions.current.get(request.uid) ?? 0)
        && canReleasePlanSendAttempt(request) && sendAttempts.delete(request.uid)) {
        attemptReadVersions.current.delete(request.uid); released = true;
      }
    });
    if (released) updateSendFence(value => value + 1);
  }, [data, query.dataUpdatedAt, query.isFetchedAfterMount, query.isError, query.isFetching, servicePending, sendAttempts]);
  const mutate = useMutation({ mutationFn: (payload: Record<string, unknown>) => changePlanWorkflow(scope, payload),
    onSuccess: async (result, payload) => {
      setMessage(payload.action === "recheck"
        ? (result.state === "confirmed"
          ? (zh ? "工单创建快照已核验；生产报工和入库数量仍需另查。" : "工单 생성 스냅샷을 확인했습니다. 생산보고·입고량은 별도 조회가 필요합니다.")
          : (zh ? "创建结果仍未核实，禁止重发。请检查MES连接、权限和完整快照。" : "생성 결과가 아직 미검증입니다. 재전송하지 말고 MES 연결·권한·전체 스냅샷을 확인하세요."))
        : result.results?.some((row: { state: string }) => row.state === "blocked")
        ? (zh ? "部分项目待确认，请检查准备结果。" : "일부 항목은 확인 대기입니다. 준비 결과를 확인하세요.")
        : (zh ? "准备已保存，尚未发送MES。" : "준비를 저장했습니다. MES 전송 전입니다."));
      clearDraft();
      await client.invalidateQueries({ queryKey: ["production", "plan-workflow"] });
    }, onError: (error) => {
      const response = (error as { response?: { status: number; data?: { detail?: unknown } } }).response;
      if (response?.status === 409) { setConfirmed(false); setDefaultConfirmed(false); setNeedsReview(true); }
      setMessage(response?.status === 409 ? (zh ? "计划或原料已变更。草稿已保留，请核对最新计划后重新确认。" : "계획 또는 원료가 변경되었습니다. 초안을 보존했습니다. 최신 계획을 확인하고 다시 승인하세요.")
        : (typeof response?.data?.detail === "string" ? response.data.detail : (zh ? "保存失败，请检查输入后重试。" : "저장하지 못했습니다. 입력을 확인하세요.")));
    } });
  const busy = mutate.isPending || reviewing || servicePending;
  const serviceLocked = busy || dateReviewRequired || dirty || !!editing || !!defaultTarget || needsReview
    || query.isFetching || query.isError || !query.isFetchedAfterMount;
  const selectedEligible = data ? selectedRequests.filter(uid => data.preview.some(group => {
    const request = data.requests.find(row => row.uid === uid && row.work_order_code === group.work_order_code);
    return canSendPlanRequest(data, group, request, sendAttempts);
  })) : [];
  async function createSelected() {
    if (!data || serviceInFlight.current || serviceLocked || !selectedEligible.length
      || selectedEligible.length !== selectedRequests.length || selectedEligible.length > PLAN_CREATE_BATCH_LIMIT) return;
    serviceInFlight.current = true;
    const uids = [...selectedEligible];
    setServicePending(true); setServiceNotice(""); setServiceProgress({ completed: 0, total: uids.length });
    try {
      const outcome = await sendPlanSelection(scope, uids, {
        beforeChunk: chunk => {
          chunk.forEach(uid => { attemptReadVersions.current.set(uid, query.dataUpdatedAt); sendAttempts.add(uid); });
          setSelectedRequests(prior => prior.filter(uid => !chunk.includes(uid)));
        },
        onChunk: (results, completed, total) => {
          setServiceResults(prior => ({ ...prior, ...Object.fromEntries(results.map(row => [row.uid, row])) }));
          setServiceProgress({ completed, total });
        },
      });
      if (outcome.uncertainUids.length) setServiceResults(prior => ({ ...prior,
        ...Object.fromEntries(outcome.uncertainUids.map(uid => [uid,
          { uid, code: "", state: "uncertain", mes_id: null, blockers: ["readback_required"] }])) }));
      setServiceNotice(outcome.stopped
        ? (zh ? `发送已停止。已处理${outcome.completed}项、待核对${outcome.uncertainUids.length}项、未发送${outcome.remainingUids.length}项。待核对项禁止重发，请复查MES；未发送项可重新选择。`
          : `전송을 중단했습니다. 처리 ${outcome.completed}건 · 미확인 ${outcome.uncertainUids.length}건 · 미전송 ${outcome.remainingUids.length}건. 미확인 항목은 재전송하지 말고 MES 재조회로 확인하세요. 미전송 항목은 다시 선택할 수 있습니다.`)
        : (zh ? "已记录各项创建结果。仅核验工单基本信息；原料、报工及入库仍需另查。"
          : "항목별 생성 결과를 기록했습니다. 工单 기본정보만 확인하며 원료·생산보고·입고는 별도 확인이 필요합니다."));
    } catch {
      setServiceNotice(zh ? "未能开始发送，请核对选择及WJ登录状态。" : "전송을 시작하지 못했습니다. 선택과 WJ 로그인 상태를 확인하세요.");
    } finally {
      try { await client.invalidateQueries({ queryKey: ["production", "plan-workflow"] }); }
      finally { serviceInFlight.current = false; setServicePending(false); }
    }
  }
  async function recheck(uid: string) {
    const request = data?.requests.find(row => row.uid === uid);
    if (serviceInFlight.current || serviceLocked || !canRecheckPlanRequest(request)) return;
    serviceInFlight.current = true; setServicePending(true); setServiceNotice("");
    try {
      const result = await recheckPlanRequest(scope, uid);
      // Readback does not grant a second creation attempt or change the material draft.
      setServiceResults(prior => ({ ...prior, [uid]: result }));
      setServiceNotice(result.state === "created" || result.state === "already_exists"
        ? (zh ? "工单基本信息已核验；原料、报工及入库仍需另查。" : "工单 기본정보를 확인했습니다. 원료·생산보고·입고는 별도 확인이 필요합니다.")
        : (zh ? "创建结果仍待核对，禁止重发。" : "생성 결과가 아직 확인 대기입니다. 재전송하지 마세요."));
    } catch {
      setServiceNotice(zh ? "复查失败；保留原状态，禁止重发。请检查WJ登录和MES读取权限。"
        : "재조회하지 못했습니다. 기존 상태를 보존하며 재전송은 차단합니다. WJ 로그인과 MES 조회 권한을 확인하세요.");
    } finally {
      try { await client.invalidateQueries({ queryKey: ["production", "plan-workflow"] }); }
      finally { serviceInFlight.current = false; setServicePending(false); }
    }
  }
  useEffect(() => onPendingChange(busy), [busy, onPendingChange]);
  useEffect(() => {
    if (date === start && retainedForDate !== null) setRetainedForDate(null);
    if (date !== start && !dirty && !editing && !defaultTarget && !busy && retainedForDate !== date) {
      setStart(date); setEnd(date); setExpanded(null); setDayUid(null); setMessage(""); setRetainedForDate(null);
    }
  }, [date, start, dirty, editing, defaultTarget, busy, retainedForDate]);
  function adoptDate() {
    if (busy) return;
    clearDraft(); setStart(date); setEnd(date); setExpanded(null); setDayUid(null); setRetainedForDate(null);
    setMessage(""); setConfirmed(false); setDefaultConfirmed(false); setSelectedRequests([]);
  }
  function submit(payload: Record<string, unknown>) {
    if (!busy && !dateReviewRequired) mutate.mutate(payload);
  }
  function applySnapshot(snapshot: MaterialSnapshot | null) {
    setValues(Object.fromEntries(fields.map(field => [field, String(snapshot?.[field] || "")])));
    setInputs(snapshot?.inputs.length ? snapshot.inputs.map(row => ({ key: data?.catalog.materials.find(option =>
      option.material_id === row.material_id && option.unit_id === row.unit_id && option.material_code === row.material_code)?.key || "",
      numerator: row.numerator, denominator: row.denominator, material_version: row.material_version }))
      : [{ key: "", numerator: "", denominator: "", material_version: "" }]);
  }
  function edit(row: WorkflowRow) {
    setDefaultTarget(null); setDayUid(row.uid); setEditing(row); applySnapshot(row.approval?.snapshot || row.previous_approval?.snapshot || row.recommendation?.snapshot || null);
    setReason(""); setConfirmed(false); setMessage(""); setPrevious(""); setDirty(false); setNeedsReview(false);
  }
  const completeMaterial = fields.every(field => values[field]?.trim()) && inputs.every(input =>
    data?.catalog.materials.some(option => option.key === input.key && option.selectable)
    && input.material_version.trim() && materialRequirement(editing?.planned_quantity || "", input.numerator, input.denominator) !== null);
  const currentRow = data?.rows.find(row => row.uid === editing?.uid);
  const canSave = data?.can_edit && confirmed && reason.trim() && !busy && !dateReviewRequired && !needsReview
    && currentRow?.id === editing?.id && currentRow?.version === editing?.version
    && (editing?.identity_state !== "identified" || (editing.quantity_valid !== false && completeMaterial));
  async function reviewLatest() {
    if (busy || dateReviewRequired) return;
    setReviewing(true);
    try {
    const result = await query.refetch();
    if (!result.data || result.isError) return;
    if (defaultTarget) {
      setMessage(zh ? "请重新选择已确认的计划，再审核默认原料。" : "확인된 계획을 다시 선택해 기본원료 변경을 검토하세요.");
      return;
    }
    const current = result.data.rows.find(row => row.uid === editing?.uid && row.identity_state === editing?.identity_state);
    if (!current) {
      setMessage(zh ? "此计划已移除或需确认任务，请重新选择计划；草稿仍保留。" : "계획이 삭제되었거나 작업 확인이 필요합니다. 초안을 보존했으니 계획을 다시 선택하세요.");
      return;
    }
    setEditing(current); setConfirmed(false); setNeedsReview(false); setDirty(true);
    setMessage(zh ? "已载入最新计划，请核对数量、原料与配比后确认。" : "최신 계획을 불러왔습니다. 수량·원료·배합을 확인한 뒤 승인하세요.");
    } finally { setReviewing(false); }
  }
  function primaryMaterial() {
    return <select aria-label={zh ? "MES原料／单位" : "MES 원료 / 단위"} form="plan-material-draft" required value={inputs[0].key}
      onChange={e => { changed(); const option = data?.catalog.materials.find(row => row.key === e.target.value); setInputs([{ ...inputs[0], key: e.target.value, material_version: option?.material_version || "" }, ...inputs.slice(1)]); }}>
      <option value="">{zh ? "选择原料" : "원료 선택"}</option>{data?.catalog.materials.map(row => <option key={row.key} disabled={!row.selectable} value={row.key}>{row.material_code} · {row.material_name} · {row.unit_name}{!row.selectable ? (zh ? " · ID冲突" : " · ID 충돌") : ""}</option>)}</select>;
  }
  function openGroup(key: string, isOpen: boolean) { leave(() => { clearDraft(); setExpanded(isOpen ? null : key); }); }
  const currentDefaultRow = data?.rows.find(row => row.uid === defaultTarget?.uid);
  const canSaveDefault = data?.can_edit && data.can_manage_defaults && defaultConfirmed && defaultReason.trim()
    && !busy && !dateReviewRequired && !needsReview && currentDefaultRow?.id === defaultTarget?.id
    && currentDefaultRow?.version === defaultTarget?.version && currentDefaultRow?.default_version === defaultTarget?.default_version;
  const defaultForm = data && defaultTarget && <form className="plan-workflow__editor" onSubmit={e => { e.preventDefault(); if (canSaveDefault) submit({ action: "save_default", plan_id: defaultTarget.id, version: defaultTarget.version, default_version: defaultTarget.default_version, reason: defaultReason }); }}>
      <h4>{defaultTarget.part_no} · {zh ? "明确修改默认原料" : "품번 기본원료 명시적 변경"}</h4>
      <p>{zh ? "将此任务已确认的原料快照保存为新默认版本，供该日期起的新确认推荐使用。" : "이 작업에서 이미 확인한 원료 스냅샷을 새 기본 버전으로 저장합니다. 이 날짜부터 새 확인의 추천값으로 사용합니다."}</p>
      <p>{defaultTarget.approval?.snapshot.inputs.map(row => `${row.material_name} · ${row.material_code} (${row.numerator} ${row.unit_name} / ${row.denominator})`).join(", ")}</p>
      <label>{zh ? "默认值变更依据" : "기본값 변경 근거"}<input required maxLength={500} value={defaultReason} onChange={e => { setDirty(true); setDefaultConfirmed(false); setDefaultReason(e.target.value); }} /></label>
      <label className="plan-workflow__check"><input type="checkbox" checked={defaultConfirmed} onChange={e => { setDirty(true); setDefaultConfirmed(e.target.checked); }} />{zh ? "此变更为产品默认原料；并非单次替代" : "일회 대체가 아니라 이 품번의 기본원료 변경임을 확인합니다"}</label>
      <div className="plan-workflow__actions"><button disabled={!canSaveDefault}>{zh ? "保存新默认版本" : "새 기본 버전 저장"}</button>
      <button type="button" onClick={() => leave(clearDraft)}>{zh ? "取消" : "취소"}</button></div>
    </form>;
  function dayPicker(rows: WorkflowRow[], selected: WorkflowRow, editable: boolean) {
    return <select aria-label={zh ? "确认日期／计划量" : "확인 날짜 / 계획량"} value={selected.uid}
      onChange={e => { const next = rows.find(row => row.uid === e.target.value); if (next) leave(() => { setDayUid(next.uid); if (editable) edit(next); }); }}>
      {rows.map(row => <option key={row.uid} value={row.uid}>{row.plan_date} · {row.planned_quantity.replace(/\.0+$/, "")} · {row.approval ? (zh ? "已确认" : "확인됨") : (zh ? "待确认" : "미확인")}</option>)}
    </select>;
  }
  function materialForm(rows: WorkflowRow[]) {
    if (!data || !editing) return null;
    return <form id="plan-material-draft" className="plan-workflow__editor" onSubmit={e => { e.preventDefault(); if (canSave) submit(editing.identity_state !== "identified"
      ? { action: "resolve_identity", plan_id: editing.id, version: editing.version, previous_uid: previous || null, reason }
      : { action: "approve", plan_id: editing.id, uid: editing.uid, version: editing.version, dataset_id: data.catalog.dataset_id, inputs, ...values, reason }); }}>
      {editing.identity_state !== "identified" ? <div className="plan-workflow__identity-line">
        {dayPicker(rows, editing, true)}<label>{zh ? "任务标识" : "작업 동일성"}<select aria-label={zh ? "任务标识" : "작업 동일성"} value={previous} onChange={e => { changed(); setPrevious(e.target.value); }}><option value="">{zh ? "独立新任务" : "독립 새 작업"}</option>{editing.candidate_details.map(candidate => <option key={candidate.uid} value={candidate.uid}>{candidate.snapshot.plan_date} · {candidate.snapshot.machine_name} · {candidate.snapshot.planned_quantity} · {zh ? "顺序" : "순서"} {candidate.snapshot.sequence}</option>)}</select></label>
      </div> : <>
        {(!fields.every(field => values[field]?.trim()) || inputs.some(input => !input.material_version.trim())) && <span className="plan-workflow__blocked">{zh ? "连接信息不完整，请管理员补充。" : "연결정보 부족 · 관리자 등록 필요"}</span>}
        {inputs.map((input, index) => <div className="plan-workflow__input-row" key={index}>
          {index === 0 ? dayPicker(rows, editing, true) : <select aria-label={zh ? "MES原料／单位" : "MES 원료 / 단위"} required value={input.key} onChange={e => { changed(); const next = [...inputs]; const selected = data.catalog.materials.find(row => row.key === e.target.value); next[index] = { ...input, key: e.target.value, material_version: selected?.material_version || "" }; setInputs(next); }}><option value="">{zh ? "选择原料" : "원료 선택"}</option>{data.catalog.materials.map(row => <option disabled={!row.selectable} key={row.key} value={row.key}>{row.material_code} · {row.material_name} · {row.unit_name}</option>)}</select>}
          <div className="plan-workflow__ratio"><span>{zh ? "配比" : "배합"}</span>{(["numerator", "denominator"] as const).map(field => <Fragment key={field}>{field === "denominator" && <span>/</span>}<input aria-label={field === "numerator" ? (zh ? "原料配比" : "원료 배합량") : (zh ? "对应产品数" : "기준 제품수")} required value={input[field]} inputMode="decimal" onChange={e => { changed(); const next = [...inputs]; next[index] = { ...input, [field]: e.target.value }; setInputs(next); }} /><span>{field === "numerator" ? data.catalog.materials.find(row => row.key === input.key)?.unit_name : values.output_unit_name}</span></Fragment>)}</div>
          <span className="plan-workflow__requirement">{zh ? "所需" : "필요"} {materialRequirement(editing.planned_quantity, input.numerator, input.denominator) ?? "—"} {data.catalog.materials.find(row => row.key === input.key)?.unit_name}</span>
          {index > 0 && <button type="button" onClick={() => { changed(); setInputs(inputs.filter((_, i) => i !== index)); }}>{zh ? "移除" : "제거"}</button>}
          {index === 0 && <button type="button" disabled={inputs.length >= 20} onClick={() => { changed(); setInputs([...inputs, { key: "", numerator: "", denominator: "", material_version: "" }]); }}>{zh ? "+ 原料" : "+ 원료"}</button>}
        </div>)}
      </>}
      <div className="plan-workflow__confirmation"><input aria-label={zh ? "确认理由／依据" : "확인 사유 / 근거"} placeholder={zh ? "确认依据" : "확인 근거"} required maxLength={500} value={reason} onChange={e => { setDirty(true); setReason(e.target.value); }} />
      <label className="plan-workflow__check"><input type="checkbox" checked={confirmed} onChange={e => { setDirty(true); setConfirmed(e.target.checked); }} />{zh ? "计划·原料确认" : "계획·원료 확인"}</label>
      <button className="btn btn-primary" disabled={!canSave}>{zh ? "保存" : "저장"}</button><button type="button" onClick={() => leave(clearDraft)}>{zh ? "取消" : "취소"}</button></div>
    </form>;
  }
  function compactDetail(group: WorkflowGroup, rows: WorkflowRow[], selected: boolean) {
    if (selected) return materialForm(rows);
    const row = rows.find(row => row.uid === dayUid) || rows[0];
    if (!row) return <span>{zh ? "扩大日期范围以确认。" : "조회 기간을 넓혀 확인하세요."}</span>;
    return <div className="plan-workflow__read-line">{dayPicker(rows, row, false)}
      <span className="plan-workflow__material-summary">{row.approval?.snapshot.inputs.map(input => <span key={`${input.material_id}:${input.unit_id}`}>{input.material_name} · {zh ? "配比" : "배합"} {input.numerator}/{input.denominator} · {zh ? "所需" : "필요"} {materialRequirement(row.planned_quantity, input.numerator, input.denominator) ?? "—"} {input.unit_name}</span>)}{!row.approval && label(group.blockers[0] || "material_confirmation")}</span>
      {row.approval?.actor_name && <span className="plan-workflow__actor" title={row.approval.actor_name}>{row.approval.actor_name}</span>}
      <button type="button" disabled={!data?.can_edit || mutate.isPending} onClick={() => leave(() => edit(row))}>{zh ? "编辑" : "편집"}</button>
      {rows.length < group.members.length && <span title={zh ? "扩大日期范围可确认其余日期" : "조회 기간을 넓히면 다른 날짜 확인 가능"}>+{group.members.length - rows.length}{zh ? "日" : "일"}</span>}
    </div>;
  }
  return <div className="plan-workflow__body">
    {dateChanged && <div className="plan-workflow__discard" role={dateReviewRequired ? "alert" : "status"} data-workflow-date-review>
      <span>{busy
        ? (zh ? `正在确认${start}的处理结果；生产计划基准日已改为${date}。` : `${start} 처리 결과를 확인 중입니다. 생산계획 기준일은 ${date}로 바뀌었습니다.`)
        : (zh ? `生产计划基准日${date}；原料编辑范围仍从${start}开始。` : `생산계획 기준일 ${date} · 원료 편집 시작일 ${start}`)}</span>
      <button type="button" disabled={busy} onClick={adoptDate}>{dirty || editing || defaultTarget ? (zh ? "放弃草稿并切换基准日" : "초안 버리고 기준일 변경") : (zh ? "切换基准日" : "기준일 변경")}</button>
      {dateReviewRequired && <button type="button" disabled={busy} onClick={() => { if (busy) return; setRetainedForDate(date); setConfirmed(false); setDefaultConfirmed(false); }}>{zh ? "保留原范围继续编辑" : "기존 범위에서 계속 편집"}</button>}
    </div>}
    <fieldset disabled={busy || dateReviewRequired} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <div className="plan-workflow__filters">
      <label>{zh ? "工艺" : "공정"}<select aria-label={zh ? "工艺" : "공정"} value={type} onChange={e => { const next = e.target.value as PlanType; leave(() => { clearDraft(); setExpanded(null); setType(next); }); }}><option value="injection">{zh ? "注塑 · 连续生产" : "사출 · 연속생산"}</option><option value="machining">{zh ? "加工 · 按日期" : "가공 · 날짜별"}</option></select></label>
      <label>{zh ? "开始日" : "시작일"}<input type="date" value={start} readOnly /></label>
      <label>{zh ? "结束日" : "종료일"}<input type="date" value={end} min={start} onChange={e => { const next = e.target.value; leave(() => { clearDraft(); setExpanded(null); setEnd(next); }); }} /></label>
      <span className="plan-workflow__off">{data?.write_enabled === true
        ? (zh ? "MES创建可用 · 仅手动发送" : "MES 생성 사용 가능 · 수동 전송")
        : (zh ? "MES创建OFF · 仍可准备及确认原料" : "MES 생성 OFF · 준비·원료 확인 사용 가능")}</span>
      <button type="button" onClick={() => query.refetch()}>{zh ? "刷新" : "새로고침"}</button>
      <details className="plan-workflow__policy"><summary>{zh ? "生产规则" : "생산 규칙"}</summary><p>{zh ? "08:00～次日08:00；同设备、产品、设置及原料确认的注塑计划连续合并。生产中每2小时检验政策维持；本阶段不自动生成检验、不自动下达／开工／关闭。" : "08:00~익일 08:00. 같은 호기·제품·셋업·원료가 확인된 사출만 연속 묶음. 생산 중 2시간 검사 유지. 이번 단계 검사 자동 생성·下达·开工·마감은 실행하지 않습니다."}</p></details>
    </div>
    {pendingChange && <div className="plan-workflow__discard" role="alert"><span>{zh ? "有未保存的草稿。是否放弃？" : "미저장 초안이 있습니다. 버리고 이동할까요?"}</span>
      <button type="button" onClick={() => { const next = pendingChange; setPendingChange(null); next(); }}>{zh ? "放弃草稿并继续" : "초안 버리고 이동"}</button><button type="button" onClick={() => setPendingChange(null)}>{zh ? "继续编辑" : "계속 편집"}</button></div>}
    {query.isLoading && <p role="status">{zh ? "加载准备信息…" : "준비 정보를 불러오는 중…"}</p>}
    {query.isError && <p role="alert">{zh ? "准备信息加载失败，现有生产计划仍可使用。" : "준비 정보를 불러오지 못했습니다. 기존 생산계획은 계속 사용할 수 있습니다."}</p>}
    {message && <p role="status" className="plan-workflow__message">{message}</p>}
    {serviceNotice && <p role="status" className="plan-workflow__message">{serviceNotice}</p>}
    {needsReview && <button type="button" disabled={query.isFetching || mutate.isPending} onClick={reviewLatest}>{zh ? "核对最新计划" : "최신 계획 확인"}</button>}
    {data && <><div className="plan-workflow__send-actions">
      <span>{zh ? `已选 ${selectedRequests.length}／${PLAN_CREATE_BATCH_LIMIT}` : `선택 ${selectedRequests.length} / ${PLAN_CREATE_BATCH_LIMIT}`}</span>
      {serviceProgress && <span role="status" aria-live="polite">{zh ? `已处理 ${serviceProgress.completed}／${serviceProgress.total}` : `처리 ${serviceProgress.completed} / ${serviceProgress.total}`}</span>}
      <button type="button" className="btn btn-primary" disabled={serviceLocked || !selectedEligible.length || selectedEligible.length !== selectedRequests.length}
        onClick={createSelected}>{servicePending ? (zh ? "正在核对结果…" : "결과 확인 중…") : (zh ? "选择工单 MES 创建" : "선택 工单 MES 생성")}</button>
      <button type="button" disabled={busy || !selectedRequests.length} onClick={() => setSelectedRequests([])}>{zh ? "清除选择" : "선택 해제"}</button>
      {(dirty || editing || defaultTarget) && <span>{zh ? "请先保存或取消原料草稿。" : "원료 초안을 먼저 저장하거나 취소하세요."}</span>}
    </div><div className="plan-workflow__table-wrap"><table className="plan-workflow__orders"><caption className="plan-workflow__caption">{zh ? "每行一个工单 · 原料在表内确认" : "工单별 한 행 · 표 안에서 원료 확인"}</caption><colgroup><col className="pw-select"/><col className="pw-product"/><col className="pw-machine"/><col className="pw-period"/><col className="pw-quantity"/><col className="pw-material"/><col className="pw-status"/><col className="pw-actions"/></colgroup><thead><tr>{(zh ? ["选择", "产品／工单", "设备", "期间 08→08", "计划量", "使用原料", "确认状态", "操作"] : ["선택", "품번 / 工单", "호기", "기간 08→08", "계획수량", "사용 원료", "확인상태", "동작"]).map(v => <th scope="col" key={v}>{v}</th>)}</tr></thead><tbody>
      {data.preview.map(group => {
        const rows = group.members.map(uid => data.rows.find(row => row.uid === uid)).filter((row): row is WorkflowRow => !!row);
        const selected = editing && group.members.includes(editing.uid);
        const snapshot = rows[0]?.approval?.snapshot;
        const requests = data.requests.filter(row => row.work_order_code === group.work_order_code);
        const request = requests.find(row => row.can_send === true) || requests.find(row => row.state !== "superseded") || requests[0];
        const serviceResult = request && !["created", "already_exists", "confirmed"].includes(request.state)
          && (!canReleasePlanSendAttempt(request) || sendAttempts.has(request.uid)) ? serviceResults[request.uid] : undefined;
        const mesId = safeMesId(serviceResult?.mes_id) || safeMesId(request?.mes_id) || safeMesId(group.mes_id);
        const requestState = serviceResult?.state || planRequestState(request);
        const creationUnresolved = !!requestState && ["checking", "sending", "uncertain", "readback_pending", "review", "failed", "blocked"].includes(requestState);
        const eligible = canSendPlanRequest(data, group, request, sendAttempts);
        const isOpen = expanded === group.key || !!selected;
        return <Fragment key={group.key}><tr className={isOpen ? "plan-workflow__order is-open" : "plan-workflow__order"} data-group-key={group.key}>
          <td><input type="checkbox" aria-label={zh ? `选择 ${group.part_no} ${group.machine_name} ${group.planned_start.slice(0, 10)}` : `선택 ${group.part_no} ${group.machine_name} ${group.planned_start.slice(0, 10)}`}
            checked={!!request && selectedRequests.includes(request.uid)} disabled={serviceLocked || !eligible || (!selectedRequests.includes(request?.uid || "") && selectedRequests.length >= PLAN_CREATE_BATCH_LIMIT)}
            onChange={e => { if (!request || !eligible || serviceLocked) return; setSelectedRequests(prior => e.target.checked
              ? (prior.includes(request.uid) || prior.length >= PLAN_CREATE_BATCH_LIMIT ? prior : [...prior, request.uid]) : prior.filter(uid => uid !== request.uid)); }} /></td>
          <th scope="row"><strong>{group.part_no || (zh ? "品号待确认" : "품번 확인 필요")}</strong><small className={mesId ? "" : "plan-workflow__preparing"}>{mesId ? `MES #${mesId}` : creationUnresolved
            ? (zh ? "MES创建状态待核对" : "MES 생성 여부 확인 필요") : (zh ? "准备中 · 尚未创建MES工单" : "준비중 · MES 생성 전")}</small></th>
          <td className="plan-workflow__machine">{group.machine_name}</td><td><time dateTime={group.planned_start}>{group.planned_start.slice(0, 10)}</time><br/><time dateTime={group.planned_end}>~ {group.planned_end.slice(0, 10)}</time></td>
          <td className="plan-workflow__quantity">{group.quantity.replace(/\.0+$/, "")}</td>
          <td>{selected && editing.identity_state === "identified" ? primaryMaterial() : <button type="button" className="plan-workflow__material-cell" disabled={!data.can_edit || mutate.isPending} title={snapshot?.inputs.map(input => input.material_name).join(" + ")} onClick={() => { const row = rows.find(row => row.uid === dayUid) || rows[0]; if (row) leave(() => edit(row)); }}>{snapshot?.inputs.map(input => input.material_code).join(" + ") || (zh ? "选择原料" : "원료 선택")}</button>}</td>
          <td><span className={group.blockers.length || (selected && dirty) ? "plan-workflow__blocked" : "plan-workflow__approved"}>{selected && dirty ? (zh ? "草稿未确认" : "초안 미확정") : group.blockers.length ? (zh ? "待确认" : "확인 대기") : (zh ? "原料已确认" : "원료 확인됨")}</span><small>{selected && dirty ? (zh ? "未保存 · 请确认" : "미저장 · 확인 필요") : requestState && !["disabled", "prepared"].includes(requestState) ? label(requestState) : group.blockers.length ? label(group.blockers[0]) : request ? (zh ? "准备已保存" : "준비 저장됨") : label(group.operation)}</small>
            {!(selected && dirty) && !!group.blockers.length && requestState && !["disabled", "prepared"].includes(requestState)
              && <small className="plan-workflow__blocked">{label(group.blockers[0])}</small>}</td>
          <td><div className="plan-workflow__row-actions"><button type="button" aria-expanded={isOpen} aria-controls={`group-${group.key}`} onClick={() => openGroup(group.key, isOpen)}>{isOpen ? (zh ? "收起" : "접기") : (zh ? "原料" : "원료")}</button><button type="button" disabled={!data.can_edit || !!group.blockers.length || group.operation === "unchanged" || !!editing || !!defaultTarget || busy} onClick={() => submit({ action: "prepare", keys: [group.key] })}>{zh ? "准备" : "준비"}</button>
            {canRecheckPlanRequest(request) && <button type="button" disabled={serviceLocked} onClick={() => request && recheck(request.uid)}>{zh ? "复查MES" : "MES 재조회"}</button>}</div></td>
        </tr>
        {isOpen && <tr className="plan-workflow__detail-row"><td colSpan={8}><div id={`group-${group.key}`} className="plan-workflow__detail">{compactDetail(group, rows, !!selected)}</div></td></tr>}
        </Fragment>;
      })}
      {!data.preview.length && <tr><td colSpan={8}>{zh ? "所选范围没有计划。" : "선택 기간의 계획이 없습니다."}</td></tr>}
    </tbody></table></div>
    {data.can_manage_defaults && editing && <details className="plan-workflow__diagnostics"><summary>{zh ? "管理员连接／默认原料" : "관리자 연결 / 기본원료"}</summary>
      <div className="plan-workflow__fields">{fields.map(field => <label key={field}>{fieldLabels[field][zh ? 1 : 0]}<input form="plan-material-draft" value={values[field] || ""} onChange={e => { changed(); setValues({ ...values, [field]: e.target.value }); }} /></label>)}
        {inputs.map((input, index) => <label key={index}>{zh ? "物料版本" : "물료 버전"} · {data.catalog.materials.find(row => row.key === input.key)?.material_code}<input form="plan-material-draft" value={input.material_version} onChange={e => { changed(); const next = [...inputs]; next[index] = { ...input, material_version: e.target.value }; setInputs(next); }} /></label>)}</div>
      {editing.approval && <button type="button" onClick={() => leave(() => { const row = editing; clearDraft(); setDefaultTarget(row); setDefaultReason(""); setDefaultConfirmed(false); })}>{zh ? "修改默认原料" : "기본원료 변경"}</button>}
    </details>}
    {defaultForm}
    {data.can_manage_defaults && !!data.requests.length && <details className="plan-workflow__requests"><summary>{zh ? "管理员记录" : "관리자 기록"} ({data.requests.length})</summary>{data.requests.map(row => <div key={row.uid}><span>{zh ? "本地准备编号" : "로컬 준비번호"}: <strong>{row.work_order_code}</strong></span><span>{label(planRequestState(row) || row.state)}</span>{safeMesId(row.mes_id) && <span>MES #{row.mes_id}</span>}{row.blockers.map(code => <span key={code}>{label(code)}</span>)}{canRecheckPlanRequest(row) && <button type="button" disabled={serviceLocked} onClick={() => recheck(row.uid)}>{zh ? "复查MES" : "MES 재조회"}</button>}</div>)}</details>}
    </>}
    </fieldset>
  </div>;
}
