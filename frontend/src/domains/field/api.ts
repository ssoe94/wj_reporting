import { http } from "@/shared/api/http";

export type FieldLanguageLabel = {
  zh: string;
  ko: string;
};

export type FieldMaterialMatchRule = "exact" | "part_family_last_two";

export type FieldDocument = {
  id: string;
  kind: "work_instruction" | "drawing";
  part_no: string;
  model_name: string;
  revision: string;
  original_name: string;
  source_url: string | null;
  preview_url: string | null;
  page_count: number | null;
  ready: boolean;
  uploaded_at: string | null;
  verification_status: "matched" | "pending" | "mismatch" | null;
  verification_label: FieldLanguageLabel | null;
  match_rule: FieldMaterialMatchRule;
  match_basis: string | null;
  matched_from_part_no: string | null;
};

export type FieldKanbanPlan = {
  plan_id: number | null;
  sequence: number;
  part_no: string;
  model_name: string;
  lot_no: string;
  planned_piece_qty: number;
  actual_piece_qty: number;
  allocated_shots: number;
  cavity: number;
  progress_rate: number;
  status: string;
};

export type FieldQualityIssue = {
  key: string;
  label: FieldLanguageLabel;
  summary_points: FieldLanguageLabel[];
  evidence_count: number;
  latest_report_dt: string | null;
  section: string;
  section_counts: Array<{
    section: string;
    evidence_count: number;
  }>;
  image_url: string | null;
  image_urls: string[];
  action_result: string;
  disposition: string;
  source_document: string;
  source_model: string;
  verification_status: "matched" | "pending" | "mismatch" | null;
  verification_label: FieldLanguageLabel | null;
};

export type FieldPendingPrompt = {
  business_date: string;
  event_key: string;
  trigger: string;
  due_at: string | null;
  is_overdue: boolean;
  plan_id: number | null;
  sequence: number | null;
  part_no: string;
  model_name: string;
};

export type FieldKanbanResponse = {
  schema_version: string;
  business_date: string;
  server_time: string;
  machine: {
    number: number;
    key: string;
    label: string;
    monitoring_name: string;
    device_counter: number | null;
    shot_count: number;
    recent_60m_shots: number;
    latest_mes_time: string | null;
    estimated_change_at: string | null;
    is_stale: boolean;
    is_running: boolean;
  };
  active_plan: FieldKanbanPlan | null;
  next_plan: FieldKanbanPlan | null;
  queue: FieldKanbanPlan[];
  counters: {
    business_day_shots: number;
    current_plan_shots: number;
    theoretical_piece_qty: number;
  };
  documents: {
    work_instruction: FieldDocument | null;
    drawing: FieldDocument | null;
  };
  quality: {
    matching_report_count: number;
    issues: FieldQualityIssue[];
    disclaimer: FieldLanguageLabel;
  };
  pending_prompt: FieldPendingPrompt | null;
};

export type FieldDefectItem = {
  code: string;
  quantity: number;
};

export type FieldDefectCheckpoint = {
  event_key: string;
  trigger: string;
  business_date: string;
  machine_number: number;
  plan_id: number | null;
  sequence: number | null;
  part_no: string;
  model_name: string;
  ending_business_day_shots: number;
  segment_shots: number;
  cavity: number;
  gross_piece_qty: number;
  defect_piece_qty: number;
  good_piece_qty: number;
  created_at?: string | null;
};

export type FieldMaterialModel = {
  machine_numbers: number[];
  part_no: string;
  model_name: string;
  planned_quantity: number;
  work_instruction: FieldDocument | null;
  drawing: FieldDocument | null;
  readiness: {
    work_instruction: boolean;
    drawing: boolean;
    complete: boolean;
  };
};

export type FieldMaterialScheduleStatus = "completed" | "current" | "waiting";

export type FieldMaterialSchedulePlan = FieldMaterialModel & {
  plan_id: number | null;
  sequence: number;
  source_sequence: number;
  display_order: number;
  lot_no: string;
  actual_quantity: number;
  progress: number;
  mes_estimated_status: string | null;
  status: FieldMaterialScheduleStatus;
  is_current: boolean;
  is_completed: boolean;
};

export type FieldMaterialMachineSchedule = {
  machine_number: number;
  machine_label: string;
  plans: FieldMaterialSchedulePlan[];
};

export type FieldMaterialsResponse = {
  business_date: string;
  models: FieldMaterialModel[];
  machine_schedules?: FieldMaterialMachineSchedule[];
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeVerificationStatus(value: unknown) {
  return value === "matched" || value === "pending" || value === "mismatch" ? value : null;
}

function normalizeMaterialMatchRule(value: unknown): FieldMaterialMatchRule {
  return value === "part_family_last_two" ? "part_family_last_two" : "exact";
}

function normalizeLabel(value: unknown, fallbackZh = "", fallbackKo = ""): FieldLanguageLabel {
  const row = asRecord(value);
  return {
    zh: asString(row.zh, fallbackZh),
    ko: asString(row.ko, fallbackKo || fallbackZh),
  };
}

function normalizeDocument(value: unknown, fallbackKind: FieldDocument["kind"]): FieldDocument | null {
  if (!value || typeof value !== "object") return null;
  const row = asRecord(value);
  const sourceUrl = asString(row.source_url || row.file_url || row.secure_url || row.url) || null;
  const previewUrl = asString(row.preview_url || row.pdf_url)
    || (asString(row.format).toLowerCase() === "pdf" ? sourceUrl : null)
    || (asString(row.original_name || row.file_name).toLowerCase().endsWith(".pdf") ? sourceUrl : null);
  const kindValue = asString(row.kind) === "drawing" ? "drawing" : fallbackKind;
  const explicitReady = typeof row.ready === "boolean" ? row.ready : undefined;

  return {
    id: asString(row.id || row.document_id || row.public_id, `${kindValue}:${asString(row.part_no)}:${asString(row.model_name)}`),
    kind: kindValue,
    part_no: asString(row.part_no),
    model_name: asString(row.model_name),
    revision: asString(row.revision),
    original_name: asString(row.original_name || row.source_file_name || row.file_name || row.name),
    source_url: sourceUrl,
    preview_url: previewUrl,
    page_count: row.page_count === null || row.page_count === undefined ? null : Math.max(1, asNumber(row.page_count, 1)),
    ready: explicitReady ?? Boolean(previewUrl),
    uploaded_at: asString(row.uploaded_at || row.created_at) || null,
    verification_status: normalizeVerificationStatus(row.verification_status),
    verification_label: row.verification_label
      ? normalizeLabel(row.verification_label)
      : null,
    match_rule: normalizeMaterialMatchRule(row.match_rule),
    match_basis: asString(row.match_basis) || null,
    matched_from_part_no: asString(row.matched_from_part_no) || null,
  };
}

function normalizePlan(value: unknown): FieldKanbanPlan | null {
  if (!value || typeof value !== "object") return null;
  const row = asRecord(value);
  return {
    plan_id: row.plan_id === null || row.plan_id === undefined ? null : asNumber(row.plan_id),
    sequence: asNumber(row.sequence),
    part_no: asString(row.part_no),
    model_name: asString(row.model_name),
    lot_no: asString(row.lot_no),
    planned_piece_qty: asNumber(row.planned_piece_qty || row.planned_quantity),
    actual_piece_qty: asNumber(row.actual_piece_qty || row.actual_quantity),
    allocated_shots: asNumber(row.allocated_shots),
    cavity: Math.max(0, asNumber(row.cavity)),
    progress_rate: asNumber(row.progress_rate || row.progress),
    status: asString(row.status),
  };
}

export function normalizeFieldKanbanResponse(value: unknown, date: string, machineNumber: number): FieldKanbanResponse {
  const root = asRecord(value);
  const machine = asRecord(root.machine);
  const counters = asRecord(root.counters);
  const documents = asRecord(root.documents);
  const quality = asRecord(root.quality);
  const prompt = root.pending_prompt ? asRecord(root.pending_prompt) : null;
  const queue = Array.isArray(root.queue)
    ? root.queue.map(normalizePlan).filter((item): item is FieldKanbanPlan => Boolean(item))
    : [];
  const activePlan = normalizePlan(root.active_plan) ?? queue[0] ?? null;
  const nextPlan = normalizePlan(root.next_plan) ?? queue[1] ?? null;

  return {
    schema_version: asString(root.schema_version, "field-kanban-v1"),
    business_date: asString(root.business_date, date),
    server_time: asString(root.server_time, new Date().toISOString()),
    machine: {
      number: asNumber(machine.number, machineNumber),
      key: asString(machine.key, String(machineNumber)),
      label: asString(machine.label, `${String(machineNumber).padStart(2, "0")}号机`),
      monitoring_name: asString(machine.monitoring_name),
      device_counter: machine.device_counter === null || machine.device_counter === undefined
        ? null
        : asNumber(machine.device_counter),
      shot_count: asNumber(machine.shot_count || counters.business_day_shots),
      recent_60m_shots: asNumber(machine.recent_60m_shots),
      latest_mes_time: asString(machine.latest_mes_time) || null,
      estimated_change_at: asString(machine.estimated_change_at) || null,
      is_stale: asBoolean(machine.is_stale),
      is_running: asBoolean(machine.is_running),
    },
    active_plan: activePlan,
    next_plan: nextPlan,
    queue,
    counters: {
      business_day_shots: asNumber(counters.business_day_shots || machine.shot_count),
      current_plan_shots: asNumber(counters.current_plan_shots || activePlan?.allocated_shots),
      theoretical_piece_qty: asNumber(counters.theoretical_piece_qty || activePlan?.actual_piece_qty),
    },
    documents: {
      work_instruction: normalizeDocument(documents.work_instruction, "work_instruction"),
      drawing: normalizeDocument(documents.drawing, "drawing"),
    },
    quality: {
      matching_report_count: asNumber(quality.matching_report_count),
      issues: Array.isArray(quality.issues) ? quality.issues.map((item, index) => {
        const row = asRecord(item);
        return {
          key: asString(row.key, `issue-${index + 1}`),
          label: normalizeLabel(row.label, asString(row.key), asString(row.key)),
          summary_points: Array.isArray(row.summary_points)
            ? row.summary_points.slice(0, 3).map((point) => normalizeLabel(point))
            : [],
          evidence_count: asNumber(row.evidence_count),
          latest_report_dt: asString(row.latest_report_dt) || null,
          section: asString(row.section),
          section_counts: Array.isArray(row.section_counts)
            ? row.section_counts.map((item) => {
              const sectionRow = asRecord(item);
              return {
                section: asString(sectionRow.section),
                evidence_count: asNumber(sectionRow.evidence_count ?? sectionRow.count),
              };
            }).filter((item) => item.section && item.evidence_count > 0)
            : [],
          image_url: asString(row.image_url) || null,
          image_urls: Array.isArray(row.image_urls)
            ? row.image_urls.map((url) => asString(url)).filter(Boolean).slice(0, 4)
            : [],
          action_result: asString(row.action_result),
          disposition: asString(row.disposition),
          source_document: asString(row.source_document),
          source_model: asString(row.source_model),
          verification_status: normalizeVerificationStatus(row.verification_status),
          verification_label: row.verification_label
            ? normalizeLabel(row.verification_label)
            : null,
        };
      }) : [],
      disclaimer: normalizeLabel(
        quality.disclaimer,
        "以下内容来自历史质量记录，并不表示当前发生不良。",
        "아래 내용은 과거 품질 이력이며 현재 불량 발생을 의미하지 않습니다.",
      ),
    },
    pending_prompt: prompt ? {
      business_date: asString(prompt.business_date, asString(root.business_date, date)),
      event_key: asString(prompt.event_key),
      trigger: asString(prompt.trigger),
      due_at: asString(prompt.due_at) || null,
      is_overdue: asBoolean(prompt.is_overdue),
      plan_id: prompt.plan_id === null || prompt.plan_id === undefined
        ? null
        : asNumber(prompt.plan_id),
      sequence: prompt.sequence === null || prompt.sequence === undefined
        ? null
        : asNumber(prompt.sequence),
      part_no: asString(prompt.part_no),
      model_name: asString(prompt.model_name),
    } : null,
  };
}

export async function getFieldKanban(
  date: string,
  machineNumber: number,
  options: { includeQuality?: boolean } = {},
) {
  const params = new URLSearchParams({
    date,
    machine_number: String(machineNumber),
    include_quality: options.includeQuality === false ? "false" : "true",
  });
  const response = await http.get<unknown>(`/production/field-kanban/?${params.toString()}`);
  return normalizeFieldKanbanResponse(response.data, date, machineNumber);
}

export async function submitFieldDefects(payload: {
  event_key: string;
  trigger: string;
  business_date: string;
  machine_number: number;
  plan_id?: number | null;
  part_no?: string;
  sequence?: number | null;
  items: FieldDefectItem[];
}) {
  const response = await http.post<{ checkpoint?: FieldDefectCheckpoint } | FieldDefectCheckpoint>(
    "/production/field-kanban/defects/",
    payload,
  );
  const candidate = asRecord(response.data);
  const checkpoint = asRecord(candidate.checkpoint || candidate);
  return {
    checkpoint: {
      event_key: asString(checkpoint.event_key, payload.event_key),
      trigger: asString(checkpoint.trigger, payload.trigger),
      business_date: asString(checkpoint.business_date, payload.business_date),
      machine_number: asNumber(checkpoint.machine_number, payload.machine_number),
      plan_id: checkpoint.plan_id === null || checkpoint.plan_id === undefined
        ? payload.plan_id ?? null
        : asNumber(checkpoint.plan_id),
      sequence: checkpoint.sequence === null || checkpoint.sequence === undefined
        ? payload.sequence ?? null
        : asNumber(checkpoint.sequence),
      part_no: asString(checkpoint.part_no, payload.part_no ?? ""),
      model_name: asString(checkpoint.model_name),
      ending_business_day_shots: asNumber(checkpoint.ending_business_day_shots),
      segment_shots: asNumber(checkpoint.segment_shots),
      cavity: asNumber(checkpoint.cavity),
      gross_piece_qty: asNumber(checkpoint.gross_piece_qty),
      defect_piece_qty: asNumber(checkpoint.defect_piece_qty),
      good_piece_qty: asNumber(checkpoint.good_piece_qty),
      created_at: asString(checkpoint.completed_at || checkpoint.created_at) || null,
    } satisfies FieldDefectCheckpoint,
  };
}

function normalizeMaterialModel(value: unknown): FieldMaterialModel {
  const row = asRecord(value);
  const readiness = asRecord(row.readiness);
  const workInstruction = normalizeDocument(row.work_instruction, "work_instruction");
  const drawing = normalizeDocument(row.drawing, "drawing");
  const workReady = typeof readiness.work_instruction === "boolean"
    ? readiness.work_instruction
    : Boolean(workInstruction?.ready);
  const drawingReady = typeof readiness.drawing === "boolean"
    ? readiness.drawing
    : Boolean(drawing?.ready);
  return {
    machine_numbers: Array.isArray(row.machine_numbers)
      ? row.machine_numbers.map((item) => asNumber(item)).filter((item) => item > 0)
      : [],
    part_no: asString(row.part_no),
    model_name: asString(row.model_name),
    planned_quantity: asNumber(row.planned_quantity),
    work_instruction: workInstruction,
    drawing,
    readiness: {
      work_instruction: workReady,
      drawing: drawingReady,
      complete: typeof readiness.complete === "boolean" ? readiness.complete : workReady && drawingReady,
    },
  };
}

function normalizeMaterialScheduleStatus(row: UnknownRecord): FieldMaterialScheduleStatus {
  const status = asString(row.status).trim().toLowerCase();
  if (asBoolean(row.is_completed) || ["completed", "complete", "done", "finished"].includes(status)) {
    return "completed";
  }
  if (asBoolean(row.is_current)) {
    return "current";
  }
  return "waiting";
}

function normalizeMaterialMachineSchedule(value: unknown): FieldMaterialMachineSchedule | null {
  const row = asRecord(value);
  const machineNumber = asNumber(row.machine_number || row.machine_no || row.number);
  if (machineNumber <= 0) return null;
  const rawPlans = Array.isArray(row.plans) ? row.plans : [];
  const normalizedPlans = rawPlans.map((planValue, index) => {
    const plan = asRecord(planValue);
    const model = normalizeMaterialModel(planValue);
    const status = normalizeMaterialScheduleStatus(plan);
    const sourceSequence = asNumber(plan.source_sequence ?? plan.sequence);
    const displayOrder = Math.max(1, asNumber(plan.display_order, index + 1));
    return {
      ...model,
      machine_numbers: [machineNumber],
      plan_id: plan.plan_id === null || plan.plan_id === undefined ? null : asNumber(plan.plan_id),
      sequence: asNumber(plan.sequence, sourceSequence || displayOrder),
      source_sequence: sourceSequence,
      display_order: displayOrder,
      lot_no: asString(plan.lot_no),
      actual_quantity: asNumber(plan.actual_quantity),
      progress: Math.max(0, asNumber(plan.progress)),
      mes_estimated_status: asString(plan.mes_estimated_status) || null,
      status,
      is_current: status === "current",
      is_completed: status === "completed",
    } satisfies FieldMaterialSchedulePlan;
  }).sort((left, right) => left.display_order - right.display_order || left.source_sequence - right.source_sequence);
  let hasCurrentPlan = false;
  const plans = normalizedPlans.map((plan) => {
    if (!plan.is_current) return plan;
    if (!hasCurrentPlan) {
      hasCurrentPlan = true;
      return plan;
    }
    return { ...plan, status: "waiting", is_current: false } satisfies FieldMaterialSchedulePlan;
  });
  return {
    machine_number: machineNumber,
    machine_label: asString(row.machine_label, `${String(machineNumber).padStart(2, "0")}号机`),
    plans,
  };
}

export async function getFieldMaterials(date: string): Promise<FieldMaterialsResponse> {
  const response = await http.get<unknown>(`/production/field-materials/?date=${encodeURIComponent(date)}`);
  const root = asRecord(response.data);
  const machineSchedules = Array.isArray(root.machine_schedules)
    ? root.machine_schedules
      .map(normalizeMaterialMachineSchedule)
      .filter((item): item is FieldMaterialMachineSchedule => Boolean(item))
      .sort((left, right) => left.machine_number - right.machine_number)
    : undefined;
  return {
    business_date: asString(root.business_date, date),
    models: Array.isArray(root.models) ? root.models.map(normalizeMaterialModel) : [],
    machine_schedules: machineSchedules,
  };
}

export async function uploadFieldMaterial(input: {
  kind: FieldDocument["kind"];
  partNo: string;
  modelName: string;
  revision: string;
  file: File;
  previewPdf?: File | null;
  matchRule?: FieldMaterialMatchRule;
}) {
  const form = new FormData();
  form.append("kind", input.kind);
  form.append("part_no", input.partNo.trim());
  form.append("model_name", input.modelName.trim());
  form.append("revision", input.revision.trim());
  form.append("match_rule", input.matchRule ?? "exact");
  form.append("file", input.file);
  if (input.previewPdf) form.append("preview_pdf", input.previewPdf);
  const response = await http.post<unknown>("/production/field-materials/", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  const root = asRecord(response.data);
  return normalizeDocument(root.document || root, input.kind);
}
