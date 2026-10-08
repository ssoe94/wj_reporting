import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changePlanWorkflow, getPlanWorkflow, workflowLabels, type WorkflowRow, type MaterialSnapshot } from "../plan-workflow-api";
import type { AppLanguage } from "@/shared/i18n/language";
import type { PlanType } from "../api";
import "./plan-workflow.css";
import { materialRequirement } from "../plan-workflow-form";

type Props = { date: string; language: AppLanguage };
type InputDraft = { key: string; numerator: string; denominator: string; material_version: string };
const fields = ["bom_version", "mold_code", "resource_code", "process_code", "process_num", "route_code", "output_unit_name", "output_unit_id", "output_version"] as const;
const fieldLabels: Record<string, [string, string]> = { bom_version: ["BOM/배합 버전", "BOM／配方版本"],
  mold_code: ["금형·셋업 코드", "模具／设置编号"], resource_code: ["MES 설비 코드", "MES设备编号"],
  process_code: ["MES 공정 코드", "MES工序编号"], process_num: ["공정 순번", "工序序号"],
  route_code: ["공정경로 코드", "工艺路线编号"], output_unit_name: ["제품 단위명", "产品单位名称"],
  output_unit_id: ["제품 단위 ID", "产品单位ID"], output_version: ["제품 물료 버전", "产品物料版本"] };

export function PlanWorkflowPanel({ date, language }: Props) {
  const [open, setOpen] = useState(false);
  return <section className="panel plan-workflow">
    <div className="plan-workflow__heading"><div><h3 className="panel__title">{language === "ko" ? "원료 확인 · MES 工单 준비" : "原料确认 · MES工单准备"}</h3>
      <p>{language === "ko" ? "업로드한 계획은 즉시 사용됩니다. 원료 확인과 MES 준비는 별도로 진행합니다." : "上传后的计划可立即使用，原料确认与MES准备独立进行。"}</p></div>
      <button type="button" className="btn btn-outline" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? (language === "ko" ? "접기" : "收起") : (language === "ko" ? "준비 검토" : "审核准备")}</button></div>
    {open && <WorkflowEditor key={`${date}:${language}`} date={date} language={language} />}
  </section>;
}

function WorkflowEditor({ date, language }: Props) {
  const zh = language === "zh";
  const label = (code: string) => workflowLabels[code]?.[zh ? 1 : 0] || code;
  const [type, setType] = useState<PlanType>("injection");
  const [end, setEnd] = useState(date);
  const [editing, setEditing] = useState<WorkflowRow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [inputs, setInputs] = useState<InputDraft[]>([{ key: "", numerator: "", denominator: "", material_version: "" }]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [previous, setPrevious] = useState("");
  const [defaultTarget, setDefaultTarget] = useState<WorkflowRow | null>(null);
  const [defaultReason, setDefaultReason] = useState("");
  const [defaultConfirmed, setDefaultConfirmed] = useState(false);
  const client = useQueryClient();
  const scope = { start: date, end, plan_type: type };
  const query = useQuery({ queryKey: ["production", "plan-workflow", scope], queryFn: () => getPlanWorkflow(scope), retry: false });
  const data = query.data;
  const mutate = useMutation({ mutationFn: (payload: Record<string, unknown>) => changePlanWorkflow(scope, payload),
    onSuccess: async (result) => {
      setMessage(result.results?.some((row: { state: string }) => row.state === "blocked")
        ? (zh ? "部分项目待确认，请检查准备结果。" : "일부 항목은 확인 대기입니다. 준비 결과를 확인하세요.")
        : (zh ? "已保存本地准备。MES写入仍关闭。" : "로컬 준비를 저장했습니다. MES 쓰기는 OFF입니다."));
      setEditing(null); setDefaultTarget(null);
      await client.invalidateQueries({ queryKey: ["production", "plan-workflow"] });
    }, onError: (error) => {
      const response = (error as { response?: { status: number; data?: { detail?: unknown } } }).response;
      setMessage(response?.status === 409 ? (zh ? "计划或原料源已变更。草稿已保留，请刷新并重新确认。" : "계획 또는 원료 원본이 변경되었습니다. 초안을 보존했습니다. 새 버전을 확인하세요.")
        : (typeof response?.data?.detail === "string" ? response.data.detail : (zh ? "保存失败，请检查输入后重试。" : "저장하지 못했습니다. 입력을 확인하세요.")));
    } });
  function applySnapshot(snapshot: MaterialSnapshot | null) {
    setValues(Object.fromEntries(fields.map(field => [field, String(snapshot?.[field] || "")])));
    setInputs(snapshot?.inputs.length ? snapshot.inputs.map(row => ({ key: data?.catalog.materials.find(option =>
      option.material_id === row.material_id && option.unit_id === row.unit_id && option.material_code === row.material_code)?.key || "",
      numerator: row.numerator, denominator: row.denominator, material_version: row.material_version }))
      : [{ key: "", numerator: "", denominator: "", material_version: "" }]);
  }
  function edit(row: WorkflowRow) {
    setDefaultTarget(null); setEditing(row); applySnapshot(row.approval?.snapshot || row.previous_approval?.snapshot || row.recommendation?.snapshot || null);
    setReason(""); setConfirmed(false); setMessage(""); setPrevious("");
  }
  const canSave = data?.can_edit && confirmed && reason.trim() && !mutate.isPending;
  return <div className="plan-workflow__body">
    <div className="plan-workflow__filters">
      <label>{zh ? "工艺" : "공정"}<select aria-label={zh ? "工艺" : "공정"} value={type} onChange={e => { setType(e.target.value as PlanType); setEditing(null); }}><option value="injection">{zh ? "注塑 · 连续生产" : "사출 · 연속생산"}</option><option value="machining">{zh ? "加工 · 按日期" : "가공 · 날짜별"}</option></select></label>
      <label>{zh ? "开始日" : "시작일"}<input type="date" value={date} readOnly /></label>
      <label>{zh ? "结束日" : "종료일"}<input type="date" value={end} min={date} onChange={e => { setEnd(e.target.value); setEditing(null); }} /></label>
      <span className="plan-workflow__off">MES {zh ? "写入关闭" : "쓰기 OFF"}</span>
      <button type="button" className="btn btn-outline" onClick={() => query.refetch()}>{zh ? "刷新" : "새로고침"}</button>
    </div>
    <p className="plan-workflow__policy">{zh ? "生产日08:00～次日08:00。注塑仅在相同设备、产品、设置及原料确认后连续合并。生产中每2小时检验政策维持；本阶段不自动生成检验、不自动下达／开工／关闭。" : "생산일 08:00~익일 08:00. 사출은 같은 호기·제품·셋업·원료가 확인된 연속 계획만 묶습니다. 생산 중 2시간 검사 정책 유지 · 이번 단계 검사 자동 생성·下达·开工·마감은 실행하지 않습니다."}</p>
    {query.isLoading && <p role="status">{zh ? "加载准备信息…" : "준비 정보를 불러오는 중…"}</p>}
    {query.isError && <p role="alert">{zh ? "准备信息加载失败，现有生产计划仍可使用。" : "준비 정보를 불러오지 못했습니다. 기존 생산계획은 계속 사용할 수 있습니다."}</p>}
    {message && <p role="status" className="plan-workflow__message">{message}</p>}
    {data && <><div className="plan-workflow__table-wrap"><table><thead><tr>{(zh ? ["日期／设备", "产品／计划量", "任务版本", "原料确认", ""] : ["일자 / 호기", "품번 / 계획량", "작업 버전", "원료 확인", ""]).map((v, i) => <th key={i}>{v}</th>)}</tr></thead><tbody>
      {data.rows.map(row => <tr key={row.uid}><td>{row.plan_date}<br /><strong>{row.machine_name}</strong></td><td>{row.part_no || (zh ? "品号待确认" : "품번 확인 필요")}<br />{row.planned_quantity}</td><td><span title={row.uid}>{row.uid?.slice(0, 8)} · v{row.version}</span></td><td>{row.identity_state !== "identified" ? label("identity_confirmation") : row.approval ? (zh ? "已确认" : "확인됨") : label("material_confirmation")}</td><td><button className="btn btn-outline" type="button" disabled={!data.can_edit || mutate.isPending} onClick={() => edit(row)}>{zh ? "确认" : "확인"}</button>{data.can_manage_defaults && row.approval && <button type="button" disabled={mutate.isPending} onClick={() => { setEditing(null); setDefaultTarget(row); setDefaultReason(""); setDefaultConfirmed(false); }}>{zh ? "默认原料" : "기본원료"}</button>}</td></tr>)}
      {!data.rows.length && <tr><td colSpan={5}>{zh ? "所选范围没有计划。" : "선택 기간의 계획이 없습니다."}</td></tr>}
    </tbody></table></div>
    {defaultTarget && <form className="plan-workflow__editor" onSubmit={e => { e.preventDefault(); if (defaultConfirmed && defaultReason.trim()) mutate.mutate({ action: "save_default", plan_id: defaultTarget.id, version: defaultTarget.version, default_version: defaultTarget.default_version, reason: defaultReason }); }}>
      <h4>{defaultTarget.part_no} · {zh ? "明确修改默认原料" : "품번 기본원료 명시적 변경"}</h4>
      <p>{zh ? "将此任务已确认的原料快照保存为新默认版本，供该日期起的新确认推荐使用。" : "이 작업에서 이미 확인한 원료 스냅샷을 새 기본 버전으로 저장합니다. 이 날짜부터 새 확인의 추천값으로 사용합니다."}</p>
      <p>{String(defaultTarget.approval?.snapshot.bom_version)} · {defaultTarget.approval?.snapshot.inputs.map(row => `${row.material_code} (${row.unit_name}, ${row.numerator}/${row.denominator})`).join(", ")}</p>
      <label>{zh ? "默认值变更依据" : "기본값 변경 근거"}<input required maxLength={500} value={defaultReason} onChange={e => setDefaultReason(e.target.value)} /></label>
      <label className="plan-workflow__check"><input type="checkbox" checked={defaultConfirmed} onChange={e => setDefaultConfirmed(e.target.checked)} />{zh ? "此变更为产品默认原料；并非单次替代" : "일회 대체가 아니라 이 품번의 기본원료 변경임을 확인합니다"}</label>
      <button disabled={!defaultConfirmed || !defaultReason.trim() || mutate.isPending}>{zh ? "保存新默认版本" : "새 기본 버전 저장"}</button>
      <button type="button" onClick={() => setDefaultTarget(null)}>{zh ? "取消" : "취소"}</button>
    </form>}
    {editing && <form className="plan-workflow__editor" onSubmit={e => { e.preventDefault(); if (canSave) mutate.mutate({ action: "approve", plan_id: editing.id, uid: editing.uid, version: editing.version, dataset_id: data.catalog.dataset_id, inputs, ...values, reason }); }}>
      <div className="plan-workflow__heading"><h4>{editing.machine_name} · {editing.part_no} · {editing.planned_quantity} · v{editing.version}</h4><button type="button" className="btn btn-outline" onClick={() => setEditing(null)}>{zh ? "关闭草稿" : "초안 닫기"}</button></div>
      {editing.identity_state !== "identified" ? <div><p>{zh ? "请明确选择新任务，或对应之前的任务。禁止凭品号自动合并。" : "새 작업인지 이전 작업의 변경인지 명시적으로 확인하세요. 품번만으로 합치지 않습니다."}</p>
        <label>{zh ? "任务标识" : "작업 동일성"}<select aria-label={zh ? "任务标识" : "작업 동일성"} value={previous} onChange={e => setPrevious(e.target.value)}><option value="">{zh ? "独立新任务" : "독립 새 작업"}</option>{editing.candidate_details.map(candidate => <option key={candidate.uid} value={candidate.uid}>{candidate.snapshot.plan_date} · {candidate.snapshot.machine_name} · {candidate.snapshot.planned_quantity} · #{candidate.snapshot.sequence} · {candidate.uid.slice(0, 8)}</option>)}</select></label>
      </div> : <><p>{zh ? "来源：MES库存原始快照。需确认物料版本、BOM比例、产品单位与设备映射。单次替代不会保存为默认值。" : "출처: MES 재고 원본 스냅샷. 물료 버전·BOM 비율·제품 단위·설비 매핑을 확인하세요. 일회 대체원료는 기본값으로 저장되지 않습니다."}</p>
        {editing.previous_approval && <p>{zh ? "已保留同一任务的原料选择。此计划版本仍需重新确认用量及设置。" : "같은 작업의 이전 원료 선택을 불러왔습니다. 이번 계획 버전의 소요량·셋업을 다시 확인하세요."}</p>}
        <p>{zh ? "原料数据时间" : "원료 데이터 시각"}: {data.catalog.refreshed_at || (zh ? "无可用快照" : "사용 가능한 스냅샷 없음")}</p>
        <div className="plan-workflow__fields">{fields.map(field => <label key={field}>{fieldLabels[field][zh ? 1 : 0]}<input required value={values[field] || ""} onChange={e => setValues({ ...values, [field]: e.target.value })} /></label>)}</div>
        {inputs.map((input, index) => <div className="plan-workflow__input-row" key={index}>
          <label>{zh ? "MES原料／单位" : "MES 원료 / 단위"}<select aria-label={zh ? "MES原料／单位" : "MES 원료 / 단위"} required value={input.key} onChange={e => { const next = [...inputs]; const selected = data.catalog.materials.find(row => row.key === e.target.value); next[index] = { ...input, key: e.target.value, material_version: selected?.material_version || "" }; setInputs(next); }}><option value="">{zh ? "选择原料" : "원료 선택"}</option>{data.catalog.materials.map(row => <option disabled={!row.selectable} key={row.key} value={row.key}>{row.material_code} · {row.material_name} · {row.unit_name}{!row.selectable ? (zh ? " · ID冲突" : " · ID 충돌") : ""}</option>)}</select></label>
          {(["numerator", "denominator", "material_version"] as const).map(field => <label key={field}>{field === "material_version" ? (zh ? "物料版本" : "물료 버전") : field === "numerator" ? (zh ? "原料用量" : "원료 소요량") : (zh ? "对应产品数" : "기준 제품수")}<input required value={input[field]} inputMode={field === "material_version" ? "text" : "decimal"} onChange={e => { const next = [...inputs]; next[index] = { ...input, [field]: e.target.value }; setInputs(next); }} /></label>)}
          <span>{zh ? "所需原料" : "원료 소요량"}: {materialRequirement(editing.planned_quantity, input.numerator, input.denominator) ?? (zh ? "需确认比率" : "비율 확인 필요")} {data.catalog.materials.find(row => row.key === input.key)?.unit_name}</span>
          <button type="button" className="btn btn-outline" disabled={inputs.length === 1} onClick={() => setInputs(inputs.filter((_, i) => i !== index))}>{zh ? "移除" : "제거"}</button>
        </div>)}
        <button type="button" className="btn btn-outline" disabled={inputs.length >= 20} onClick={() => setInputs([...inputs, { key: "", numerator: "", denominator: "", material_version: "" }])}>{zh ? "添加原料" : "원료 추가"}</button>
      </>}
      <label>{zh ? "确认理由／依据" : "확인 사유 / 근거"}<input required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <label className="plan-workflow__check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{zh ? "确认当前任务版本及填写的原料／设置依据" : "현재 작업 버전과 입력한 원료·셋업 근거를 확인했습니다"}</label>
      {editing.identity_state !== "identified" ? <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => mutate.mutate({ action: "resolve_identity", plan_id: editing.id, version: editing.version, previous_uid: previous || null, reason })}>{zh ? "保存任务标识" : "작업 동일성 확인 저장"}</button> : <button className="btn btn-primary" disabled={!canSave}>{zh ? "确认此版本原料" : "이 버전 원료 확인"}</button>}
    </form>}
    <h4>{zh ? "工单创建／修改预览" : "工单 생성 / 수정 미리보기"}</h4>
    <div className="plan-workflow__previews">{data.preview.map(group => <article key={group.key} className="plan-workflow__preview"><strong>{group.machine_name} · {group.part_no}</strong><span>{label(group.operation)} · {group.quantity}</span><span>{group.planned_start.slice(0, 16).replace("T", " ")} ~ {group.planned_end.slice(0, 16).replace("T", " ")}</span><span>{zh ? "计划／报工／入库" : "계획 / 생산보고 / 입고"}: {group.quantity} / {group.reported_quantity ?? "?"} / {group.inbound_quantity ?? "?"}</span><span>{group.work_order_code || (zh ? "待本地准备" : "로컬 준비 전")}</span>{group.blockers.map(code => <span className="plan-workflow__blocked" key={code}>{label(code)}</span>)}<button type="button" className="btn btn-outline" disabled={!data.can_edit || !!group.blockers.length || group.operation === "unchanged" || mutate.isPending} onClick={() => mutate.mutate({ action: "prepare", keys: [group.key] })}>{zh ? "保存准备" : "준비 저장"}</button></article>)}</div>
    <h4>{zh ? "已保存请求" : "저장된 요청"}</h4><div className="plan-workflow__requests">{data.requests.map(row => <div key={row.uid}><strong>{row.work_order_code}</strong><span>{label(row.state)}</span>{row.blockers.map(code => <span key={code}>{label(code)}</span>)}{["sending", "uncertain", "readback_pending", "review"].includes(row.state) && <button type="button" className="btn btn-outline" disabled={mutate.isPending} onClick={() => mutate.mutate({ action: "recheck", request_uid: row.uid })}>{zh ? "复查MES" : "MES 재조회"}</button>}</div>)}</div>
    </>}
  </div>;
}
