import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changePlanWorkflow, getPlanWorkflow, getPlanBom, workflowLabels, type WorkflowRow, type MaterialSnapshot, type WorkflowGroup } from "../plan-workflow-api";
import type { AppLanguage } from "@/shared/i18n/language";
import type { PlanType } from "../api";
import "./plan-workflow.css";
import { PlanBomPrimaryInput, PlanBomInputs, initialPlanBomInputs, isPlanBomSelectionValid,
  type PlanBomSource, type PlanBomInputSelection } from "./PlanBomInputs";
import { materialRequirement } from "../plan-workflow-form";
import { canRecheckPlanRequest, canReleasePlanSendAttempt, canSendPlanRequest, PLAN_CREATE_BATCH_LIMIT, planRequestState, safeMesId,
  planWorkflowStage, planConfirmationTime, type PlanWorkflowStage, type PlanServiceResult } from "../plan-workflow-service";
import { recheckPlanRequest, sendPlanSelection } from "../plan-workflow-service-api";

type Props = { date: string; language: AppLanguage; openRequest?: number };
type EditorProps = Props & { onDirtyChange: (dirty: boolean) => void; onPendingChange: (pending: boolean) => void;
  sendAttempts: Set<string> };
const fields = ["bom_version", "mold_code", "resource_code", "process_code", "process_num", "route_code", "output_unit_name", "output_unit_id", "output_version"] as const;
const fieldLabels: Record<string, [string, string]> = { bom_version: ["BOM/배합 버전", "BOM／配方版本"],
  mold_code: ["금형·셋업 코드 (있는 경우)", "模具／设置编号（如有）"], resource_code: ["MES 설비 코드", "MES设备编号"],
  process_code: ["MES 공정 코드", "MES工序编号"], process_num: ["공정 순번", "工序序号"],
  route_code: ["공정경로 코드", "工艺路线编号"], output_unit_name: ["제품 단위명", "产品单位名称"],
  output_unit_id: ["제품 단위 ID", "产品单位ID"], output_version: ["제품 물료 버전 (있는 경우)", "产品物料版本（如有）"] };
const queueLabels: Record<PlanWorkflowStage, [string, string]> = {
  plan: ["계획 · 徐佳", "计划 · 徐佳"], materials: ["원료 · 韦凯", "原料 · 韦凯"],
  issue: ["생성 · 徐佳", "创建 · 徐佳"], review: ["결과 확인", "结果核对"], created: ["생성됨", "已创建"],
};

export function PlanWorkflowPanel({ date, language, openRequest = 0 }: Props) {
  const [open, setOpen] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => { if (openRequest > 0) setOpen(true); }, [openRequest]);
  // Ambiguous sends remain fenced when this panel is collapsed or its scope changes.
  const sendAttempts = useRef(new Set<string>());
  return <section className="panel plan-workflow" id="plan-mes-workflow">
    <div className="plan-workflow__heading"><div><h3 className="panel__title">{language === "ko" ? "생산계획 → 원료 확정 → MES 작업지시" : "生产计划 → 原料确认 → MES工单"}</h3>
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
  const [stageFilter, setStageFilter] = useState<PlanWorkflowStage | "all">("all");
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
  function clearDraft() { bomReadGeneration.current += 1; setBomLoading(false); setBomSource(null); setBomError(false); setEditing(null); setDefaultTarget(null); setDirty(false); setPendingChange(null); setNeedsReview(false); }
  function changed() { setDirty(true); setConfirmed(false); }
  const [type, setType] = useState<PlanType>("injection");
  const [end, setEnd] = useState(date);
  const [editing, setEditing] = useState<WorkflowRow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [bomSource, setBomSource] = useState<PlanBomSource | null>(null);
  const [inputs, setInputs] = useState<PlanBomInputSelection[]>([]);
  const [bomLoading, setBomLoading] = useState(false);
  const [bomError, setBomError] = useState(false);
  const bomReadGeneration = useRef(0);
  useEffect(() => () => { bomReadGeneration.current += 1; }, []);
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
      setMessage(payload.action === "approve"
        ? (zh ? "原料确认已保存，请营业复核并准备MES工单。尚未发送MES。" : "원료 확정을 저장했습니다. 영업에서 검토 후 MES 생성 준비를 진행하세요. 아직 MES에 전송하지 않았습니다.")
        : payload.action === "recheck"
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
  async function createRequests(uids: string[]) {
    if (!data || serviceInFlight.current || serviceLocked || !uids.length || uids.length > PLAN_CREATE_BATCH_LIMIT
      || !uids.every(uid => data.preview.some(group => canSendPlanRequest(data, group,
        data.requests.find(row => row.uid === uid && row.work_order_code === group.work_order_code), sendAttempts)))) return;
    serviceInFlight.current = true;
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
  async function loadBom(row: WorkflowRow, restore?: MaterialSnapshot | null,
    retained?: { source: PlanBomSource; inputs: PlanBomInputSelection[] }) {
    const generation = ++bomReadGeneration.current;
    setBomLoading(true); setBomError(false); setConfirmed(false);
    try {
      const source = await getPlanBom({ ...scope }, row.id);
      if (generation !== bomReadGeneration.current) return false;
      if (source?.part_no !== row.part_no || typeof source.hash !== "string" || !source.hash
        || !source.setup || !Array.isArray(source.inputs) || !source.inputs.length) throw Error("Invalid BOM source");
      let next = initialPlanBomInputs(source);
      if (retained?.source.hash === source.hash && retained.source.part_no === source.part_no) next = retained.inputs;
      else if (restore?.bom_source?.hash === source.hash && restore.bom_source.part_no === source.part_no)
        next = restore.inputs.map(input => ({ source_row_id: input.source_row_id || "", material_code: input.material_code }));
      setConfirmed(false); setBomSource(source); setInputs(next);
      setValues(current => ({ ...current, ...source.setup }));
      return true;
    } catch {
      if (generation === bomReadGeneration.current) setBomError(true);
      return false;
    } finally {
      if (generation === bomReadGeneration.current) setBomLoading(false);
    }
  }
  function edit(row: WorkflowRow) {
    bomReadGeneration.current += 1; setBomSource(null); setInputs([]); setBomError(false); setBomLoading(false);
    setDefaultTarget(null); setDayUid(row.uid); setEditing(row);
    const existing = row.approval?.snapshot || row.previous_approval?.snapshot || row.recommendation?.snapshot;
    setValues({ resource_code: String(existing?.resource_code || ""), mold_code: String(existing?.mold_code || "") });
    setReason(""); setConfirmed(false); setMessage(""); setPrevious(""); setDirty(false); setNeedsReview(false);
    if (row.identity_state === "identified") void loadBom(row, row.approval?.snapshot || row.previous_approval?.snapshot);
  }
  const completeConnection = fields.every(field => ["output_version", "mold_code"].includes(field) || values[field]?.trim());
  const completeMaterial = completeConnection && !bomLoading && !bomError
    && isPlanBomSelectionValid(bomSource, data?.catalog.materials || [], inputs)
    && !!bomSource?.inputs.every(input => materialRequirement(editing?.planned_quantity || "", input.numerator, input.denominator) !== null);
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
    if (current.identity_state === "identified" && !await loadBom(current, null,
      bomSource ? { source: bomSource, inputs } : undefined)) return;
    setEditing(current); setConfirmed(false); setNeedsReview(false); setDirty(true);
    setMessage(zh ? "已重新读取计划与BOM，请核对完整用料后确认。" : "계획과 BOM을 다시 읽었습니다. 전체 투입 자재를 확인한 뒤 승인하세요.");
    } finally { setReviewing(false); }
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
    if (editing.identity_state === "identified" && (bomLoading || bomError || !bomSource)) return <div className="plan-workflow__editor">
      {bomLoading ? <p role="status">{zh ? "正在读取MES BOM…" : "MES BOM 조회 중…"}</p>
        : <div role="alert" className="plan-workflow__blocked"><span>{zh ? "BOM读取失败。保留草稿，请重新查询。" : "BOM을 읽지 못했습니다. 초안을 보존했으니 다시 조회하세요."}</span>
          <button type="button" onClick={() => void (needsReview ? reviewLatest() : loadBom(editing, editing.approval?.snapshot || editing.previous_approval?.snapshot,
            bomSource ? { source: bomSource, inputs } : undefined))}>{zh ? "重新查询BOM" : "BOM 재조회"}</button></div>}
    </div>;
    return <form id="plan-material-draft" className="plan-workflow__editor" onSubmit={e => { e.preventDefault(); if (canSave) submit(editing.identity_state !== "identified"
      ? { action: "resolve_identity", plan_id: editing.id, version: editing.version, previous_uid: previous || null, reason }
      : { action: "approve", plan_id: editing.id, uid: editing.uid, version: editing.version,
          bom_hash: bomSource?.hash, bom_version: bomSource?.version, inputs,
          resource_code: values.resource_code, mold_code: values.mold_code || "", reason }); }}>
      {editing.identity_state !== "identified" ? <div className="plan-workflow__identity-line">
        {dayPicker(rows, editing, true)}<label>{zh ? "任务标识" : "작업 동일성"}<select aria-label={zh ? "任务标识" : "작업 동일성"} value={previous} onChange={e => { changed(); setPrevious(e.target.value); }}><option value="">{zh ? "独立新任务" : "독립 새 작업"}</option>{editing.candidate_details.map(candidate => <option key={candidate.uid} value={candidate.uid}>{candidate.snapshot.plan_date} · {candidate.snapshot.machine_name} · {candidate.snapshot.planned_quantity} · {zh ? "顺序" : "순서"} {candidate.snapshot.sequence}</option>)}</select></label>
      </div> : <>
        {rows.length > 1 && <div className="plan-workflow__material-heading">{dayPicker(rows, editing, true)}</div>}
        {bomSource && <><span className="plan-workflow__source">BOM {bomSource.version}</span>
          <PlanBomInputs source={bomSource} catalog={data.catalog.materials} quantity={editing.planned_quantity}
            value={inputs} onChange={next => { changed(); setInputs(next); }} disabled={busy || needsReview} hidePrimary ko={!zh} />
          {!completeConnection && <span className="plan-workflow__blocked">{zh ? "设备连接信息缺失，请管理员补充。" : "설비 연결정보 부족 · 관리자 등록 필요"}</span>}</>}
      </>}
      <div className="plan-workflow__confirmation"><input aria-label={zh ? "确认理由／依据" : "확인 사유 / 근거"} placeholder={zh ? "确认依据" : "확인 근거"} required maxLength={500} value={reason} onChange={e => { setDirty(true); setReason(e.target.value); }} />
      <label className="plan-workflow__check"><input type="checkbox" checked={confirmed} disabled={editing.identity_state === "identified" && (bomLoading || bomError || !bomSource || needsReview)} onChange={e => { if (editing.identity_state === "identified" && (bomLoading || bomError || !bomSource || needsReview)) return; setDirty(true); setConfirmed(e.target.checked); }} />{zh ? "计划·原料确认" : "계획·원료 확인"}</label>
      <button type="button" onClick={() => leave(clearDraft)}>{zh ? "取消" : "취소"}</button></div>
    </form>;
  }
  function compactDetail(group: WorkflowGroup, rows: WorkflowRow[], selected: boolean) {
    if (selected) return materialForm(rows);
    const row = rows.find(row => row.uid === dayUid) || rows[0];
    if (!row) return <span>{zh ? "扩大日期范围以确认。" : "조회 기간을 넓혀 확인하세요."}</span>;
    return <><div className="plan-workflow__basic">{row.part_spec?.trim() && row.part_spec !== "-" && <span>SPEC: {row.part_spec}</span>}{row.model_name?.trim() && row.model_name !== "-" && <span>MODEL: {row.model_name}</span>}{row.lot_no?.trim() && row.lot_no !== "-" && <span>LOT: {row.lot_no}</span>}</div><div className="plan-workflow__read-line">{rows.length > 1 && dayPicker(rows, row, false)}
      <span className="plan-workflow__material-summary">{row.approval?.snapshot.inputs.map(input => <span key={`${input.material_id}:${input.unit_id}`}>{input.material_name} · {zh ? "配比" : "배합"} {input.numerator}/{input.denominator} · {zh ? "所需" : "필요"} {materialRequirement(row.planned_quantity, input.numerator, input.denominator) ?? "—"} {input.unit_name}</span>)}{!row.approval && label(group.blockers[0] || "material_confirmation")}</span>
      {row.approval && <span className="plan-workflow__actor">{zh ? "实际确认" : "실제 확인"}: {row.approval.actor_name || "—"}<small><time dateTime={row.approval.approved_at}>{planConfirmationTime(row.approval.approved_at)}</time></small></span>}
      <button type="button" disabled={!data?.can_edit || mutate.isPending} onClick={() => leave(() => edit(row))}>{zh ? "编辑" : "편집"}</button>
      {rows.length < group.members.length && <span title={zh ? "扩大日期范围可确认其余日期" : "조회 기간을 넓히면 다른 날짜 확인 가능"}>+{group.members.length - rows.length}{zh ? "日" : "일"}</span>}
    </div></>;
  }
  const workflowItems = (data?.preview || []).map(group => {
    const rows = group.members.map(uid => data?.rows.find(row => row.uid === uid)).filter((row): row is WorkflowRow => !!row);
    const requests = data?.requests.filter(row => row.work_order_code === group.work_order_code) || [];
    const request = requests.find(row => row.can_send === true) || requests.find(row => row.state !== "superseded") || requests[0];
    const serviceResult = request && !["created", "already_exists", "confirmed"].includes(request.state)
      && (!canReleasePlanSendAttempt(request) || sendAttempts.has(request.uid)) ? serviceResults[request.uid] : undefined;
    const mesId = safeMesId(serviceResult?.mes_id) || safeMesId(request?.mes_id) || safeMesId(group.mes_id);
    const requestState = serviceResult?.state || planRequestState(request);
    return { group, rows, request, mesId, requestState, stage: planWorkflowStage(group, rows, requestState, mesId) };
  });
  const visibleItems = workflowItems.filter(item => stageFilter === "all" || item.stage === stageFilter
    || (editing && item.group.members.includes(editing.uid)));
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
      {data?.write_enabled === false && <span className="plan-workflow__off" role="status">{zh ? "MES创建OFF · 可确认原料" : "MES 생성 OFF · 원료 확인 가능"}</span>}
      <button type="button" onClick={() => query.refetch()}>{zh ? "刷新" : "새로고침"}</button>
    </div>
    {pendingChange && <div className="plan-workflow__discard" role="alert"><span>{zh ? "有未保存的草稿。是否放弃？" : "미저장 초안이 있습니다. 버리고 이동할까요?"}</span>
      <button type="button" onClick={() => { const next = pendingChange; setPendingChange(null); next(); }}>{zh ? "放弃草稿并继续" : "초안 버리고 이동"}</button><button type="button" onClick={() => setPendingChange(null)}>{zh ? "继续编辑" : "계속 편집"}</button></div>}
    {query.isLoading && <p role="status">{zh ? "加载准备信息…" : "준비 정보를 불러오는 중…"}</p>}
    {query.isError && <p role="alert">{zh ? "准备信息加载失败，现有生产计划仍可使用。" : "준비 정보를 불러오지 못했습니다. 기존 생산계획은 계속 사용할 수 있습니다."}</p>}
    {message && <p role="status" className="plan-workflow__message">{message}</p>}
    {serviceNotice && <p role="status" className="plan-workflow__message">{serviceNotice}</p>}
    {needsReview && <button type="button" disabled={query.isFetching || mutate.isPending} onClick={reviewLatest}>{zh ? "核对最新计划" : "최신 계획 확인"}</button>}
    {data && <><div className="plan-workflow__queue" role="group" aria-label={zh ? "按待办筛选" : "할 일별 보기"}>
      {(["all", "plan", "materials", "issue", "review", "created"] as const).filter(stage => stage === "all" || workflowItems.some(item => item.stage === stage)).map(stage => <button type="button" key={stage} data-stage={stage} aria-pressed={stageFilter === stage}
        onClick={() => leave(() => { clearDraft(); setExpanded(null); setStageFilter(stage); setSelectedRequests([]); })}>
        {stage === "all" ? (zh ? "全部" : "전체") : queueLabels[stage][zh ? 1 : 0]} · {stage === "all" ? workflowItems.length : workflowItems.filter(item => item.stage === stage).length}
      </button>)}
    </div><div className="plan-workflow__send-actions">
      <span>{zh ? `已选 ${selectedRequests.length}／${PLAN_CREATE_BATCH_LIMIT}` : `선택 ${selectedRequests.length} / ${PLAN_CREATE_BATCH_LIMIT}`}</span>
      {serviceProgress && <span role="status" aria-live="polite">{zh ? `已处理 ${serviceProgress.completed}／${serviceProgress.total}` : `처리 ${serviceProgress.completed} / ${serviceProgress.total}`}</span>}
      <button type="button" className="btn btn-primary" disabled={serviceLocked || !selectedEligible.length || selectedEligible.length !== selectedRequests.length}
        onClick={() => createRequests([...selectedEligible])}>{servicePending ? (zh ? "正在核对结果…" : "결과 확인 중…") : (zh ? "选择工单 MES 创建" : "선택 工单 MES 생성")}</button>
      <button type="button" disabled={busy || !selectedRequests.length} onClick={() => setSelectedRequests([])}>{zh ? "清除选择" : "선택 해제"}</button>
      {(dirty || editing || defaultTarget) && <span>{zh ? "请先保存或取消原料草稿。" : "원료 초안을 먼저 저장하거나 취소하세요."}</span>}
    </div><div className="plan-workflow__table-wrap"><table className="plan-workflow__orders"><caption className="plan-workflow__caption">{zh ? "每行一个工单 · 用料在表内确认" : "工单별 한 행 · 표 안에서 투입 자재 확인"}</caption><colgroup><col className="pw-select"/><col className="pw-product"/><col className="pw-machine"/><col className="pw-period"/><col className="pw-quantity"/><col className="pw-material"/><col className="pw-status"/><col className="pw-actions"/></colgroup><thead><tr>{(zh ? ["选择", "产品／工单", "设备", "期间 08→08", "计划量", "用料清单", "当前待办", "操作"] : ["선택", "품번 / 工单", "호기", "기간 08→08", "계획수량", "투입 자재·원료", "현재 할 일", "동작"]).map(v => <th scope="col" key={v}>{v}</th>)}</tr></thead><tbody>
      {visibleItems.map(({ group, rows, request, mesId, requestState, stage }) => {
        const selected = editing && group.members.includes(editing.uid);
        const snapshot = rows[0]?.approval?.snapshot;
        const rawId = snapshot?.bom_source?.inputs.find(input => input.replaceable)?.source_row_id;
        const primary = (rawId && snapshot?.inputs.find(input => input.source_row_id === rawId)) || snapshot?.inputs[0];
        const materialSummary = primary ? primary.material_code + ((snapshot?.inputs.length || 0) > 1
          ? (zh ? ` 等${snapshot!.inputs.length}项` : ` 외 ${snapshot!.inputs.length - 1}개`) : "")
          : (zh ? "确认用料" : "투입 자재 확인");
        const eligible = canSendPlanRequest(data, group, request, sendAttempts);
        const isOpen = expanded === group.key || !!selected;
        const taskLabels: Record<PlanWorkflowStage, [string, string]> = {
          plan: ["계획 확인 필요", "待核对计划"], materials: ["원료 확인 필요", "待确认原料"],
          issue: request?.can_send === true ? (data.write_enabled ? ["생성 가능", "可创建"] : ["생성 대기", "等待创建"]) : ["생성 준비", "准备创建"],
          review: ["결과 확인 필요", "待核对结果"], created: ["생성 완료", "已创建"],
        };
        const currentTask = selected && dirty ? (zh ? "草稿未确认" : "초안 미확정")
          : group.blockers.length ? label(group.blockers[0])
          : requestState && !["disabled", "prepared"].includes(requestState) ? label(requestState)
          : taskLabels[stage][zh ? 1 : 0];
        const rowToEdit = rows.find(row => row.uid === dayUid) || rows[0];
        const toggleLabel = `${group.part_no} ${zh ? "详细内容" : "상세 내용"}`;
        return <Fragment key={group.key}><tr className={isOpen ? "plan-workflow__order is-open" : "plan-workflow__order"} data-group-key={group.key}>
          <td><input type="checkbox" aria-label={zh ? `选择 ${group.part_no} ${group.machine_name} ${group.planned_start.slice(0, 10)}` : `선택 ${group.part_no} ${group.machine_name} ${group.planned_start.slice(0, 10)}`}
            checked={!!request && selectedRequests.includes(request.uid)} disabled={serviceLocked || !eligible || (!selectedRequests.includes(request?.uid || "") && selectedRequests.length >= PLAN_CREATE_BATCH_LIMIT)}
            onChange={e => { if (!request || !eligible || serviceLocked) return; setSelectedRequests(prior => e.target.checked
              ? (prior.includes(request.uid) || prior.length >= PLAN_CREATE_BATCH_LIMIT ? prior : [...prior, request.uid]) : prior.filter(uid => uid !== request.uid)); }} /></td>
          <th scope="row" className="plan-workflow__product"><div className="plan-workflow__product-line"><button type="button" className="plan-workflow__expand" aria-label={toggleLabel} title={mesId ? `MES #${mesId}` : toggleLabel} aria-description={mesId ? `MES #${mesId}` : undefined} aria-expanded={isOpen} aria-controls={`group-${group.key}`} onClick={() => openGroup(group.key, isOpen)}>{isOpen ? "▾" : "▸"}</button><strong title={group.part_no}>{group.part_no || (zh ? "品号待确认" : "품번 확인 필요")}</strong><span className="plan-workflow__mobile-machine">{group.machine_name}</span></div>
            <span className="plan-workflow__mobile-summary">{group.planned_start.slice(5, 10)}→{group.planned_end.slice(5, 10)} · {group.quantity.replace(/\.0+$/, "")}</span>
          </th>
          <td className="plan-workflow__machine">{group.machine_name}</td><td className="plan-workflow__period" title={`${group.planned_start} → ${group.planned_end}`}><time dateTime={group.planned_start}>{group.planned_start.slice(5, 10)}</time> → <time dateTime={group.planned_end}>{group.planned_end.slice(5, 10)}</time></td>
          <td className="plan-workflow__quantity">{group.quantity.replace(/\.0+$/, "")}</td>
          <td className={`plan-workflow__material${selected && editing.identity_state === "identified" ? " is-editing" : ""}`}>{selected && editing.identity_state === "identified" ? (bomLoading || bomError || !bomSource
            ? <span className="plan-workflow__blocked">{bomLoading ? (zh ? "读取BOM…" : "BOM 조회 중…") : (zh ? "需重新查询BOM" : "BOM 재조회 필요")}</span>
            : <PlanBomPrimaryInput source={bomSource} catalog={data.catalog.materials} quantity={editing.planned_quantity}
              value={inputs} onChange={next => { changed(); setInputs(next); }} disabled={busy || needsReview} ko={!zh} />) : <button type="button" className="plan-workflow__material-cell" disabled={!data.can_edit || mutate.isPending} title={snapshot?.inputs.map(input => input.material_code).join(" + ")} onClick={() => { if (rowToEdit) leave(() => edit(rowToEdit)); }}>{materialSummary}</button>}</td>
          <td className="plan-workflow__task"><span className={group.blockers.length || (selected && dirty) || stage === "review" ? "plan-workflow__blocked" : "plan-workflow__approved"} title={currentTask}>{currentTask}</span></td>
          <td className="plan-workflow__action"><div className="plan-workflow__row-actions">{selected ? <button className="btn btn-primary" form="plan-material-draft" disabled={!canSave}>{zh ? "保存" : "저장"}</button>
            : stage === "materials" || stage === "plan" && rowToEdit?.identity_state !== "identified" ? <button type="button" className="btn btn-primary" disabled={!data.can_edit || busy || !rowToEdit} onClick={() => rowToEdit && leave(() => edit(rowToEdit))}>{stage === "plan" ? (zh ? "核对计划" : "계획 확인") : (zh ? "确认原料" : "원료 확정")}</button>
            : stage === "issue" ? (request?.can_send === true && data.write_enabled !== true ? <span className="plan-workflow__mobile-status" title={currentTask}>{["disabled", "prepared"].includes(requestState || "") ? (zh ? "准备已保存" : "준비 저장됨") : currentTask}</span> : <button type="button" className="btn btn-primary" disabled={serviceLocked || !data.can_edit || (request?.can_send === true ? !eligible : !!group.blockers.length || group.operation === "unchanged")}
              onClick={() => request?.can_send === true ? createRequests([request.uid]) : submit({ action: "prepare", keys: [group.key] })}>{request?.can_send === true ? (zh ? "创建MES" : "MES 생성") : (zh ? "准备工单" : "생성 준비")}</button>)
            : canRecheckPlanRequest(request) ? <button type="button" className="btn btn-primary" disabled={serviceLocked} onClick={() => request && recheck(request.uid)}>{zh ? "复查MES" : "MES 재조회"}</button>
            : <button type="button" disabled={busy} aria-expanded={isOpen} aria-controls={`group-${group.key}`} onClick={() => openGroup(group.key, isOpen)}>{stage === "plan" ? (zh ? "核对计划" : "계획 확인") : (zh ? "查看" : "상세 확인")}</button>}</div></td>
        </tr>
        {isOpen && <tr className="plan-workflow__detail-row"><td colSpan={8}><div id={`group-${group.key}`} className="plan-workflow__detail">{!selected && <div className="plan-workflow__detail-status"><span>{currentTask}</span>{requestState && !["disabled", "prepared"].includes(requestState) && !!group.blockers.length && <span>{label(requestState)}</span>}{mesId && <span>MES #{mesId}</span>}</div>}{compactDetail(group, rows, !!selected)}</div></td></tr>}
        </Fragment>;
      })}
      {!visibleItems.length && <tr><td colSpan={8}>{!data.preview.length ? (zh ? "所选范围没有计划。" : "선택 기간의 계획이 없습니다.") : (zh ? "此待办暂无项目。" : "이 단계에 해당하는 항목이 없습니다.")}</td></tr>}
    </tbody></table></div>
    {data.can_manage_defaults && <details className="plan-workflow__diagnostics"><summary>{zh ? "管理员设置" : "관리자 설정"}</summary>
      <details className="plan-workflow__policy"><summary>{zh ? "生产规则" : "생산 규칙"}</summary><p>{zh ? "08:00～次日08:00；同设备、产品、设置及原料确认的注塑计划连续合并。生产中每2小时检验政策维持；本阶段不自动生成检验、不自动下达／开工／关闭。" : "08:00~익일 08:00. 같은 호기·제품·셋업·원료가 확인된 사출만 연속 묶음. 생산 중 2시간 검사 유지. 이번 단계 검사 자동 생성·下达·开工·마감은 실행하지 않습니다."}</p></details>
      {editing && <><div className="plan-workflow__fields">{fields.map(field => <label key={field}>{fieldLabels[field][zh ? 1 : 0]}<input form="plan-material-draft" value={values[field] || ""}
        readOnly={field !== "resource_code" && field !== "mold_code"} onChange={e => { if (field !== "resource_code" && field !== "mold_code") return; changed(); setValues({ ...values, [field]: e.target.value }); }} /></label>)}</div>
      {editing.approval && <button type="button" onClick={() => leave(() => { const row = editing; clearDraft(); setDefaultTarget(row); setDefaultReason(""); setDefaultConfirmed(false); })}>{zh ? "修改默认原料" : "기본원료 변경"}</button>}</>}
    </details>}
    {defaultForm}
    {data.can_manage_defaults && !!data.requests.length && <details className="plan-workflow__requests"><summary>{zh ? "管理员记录" : "관리자 기록"} ({data.requests.length})</summary>{data.requests.map(row => <div key={row.uid}><span>{zh ? "本地准备编号" : "로컬 준비번호"}: <strong>{row.work_order_code}</strong></span><span>{label(planRequestState(row) || row.state)}</span>{safeMesId(row.mes_id) && <span>MES #{row.mes_id}</span>}{row.blockers.map(code => <span key={code}>{label(code)}</span>)}{canRecheckPlanRequest(row) && <button type="button" disabled={serviceLocked} onClick={() => recheck(row.uid)}>{zh ? "复查MES" : "MES 재조회"}</button>}</div>)}</details>}
    </>}
    </fieldset>
  </div>;
}
