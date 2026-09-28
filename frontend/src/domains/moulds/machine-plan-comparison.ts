export type ModelRelation = "exact" | "family" | "different" | "unknown";

export function normalizedModelCode(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  if (!normalized || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(normalized)) return null;
  if (!/[A-Z]/.test(normalized) || !/\d/.test(normalized)) return null;
  return normalized;
}

function leadingModelSize(code: string): string | null {
  return code.match(/^(\d{2,3})(?=[A-Z])/)?.[1] ?? null;
}

export function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export function modelCodeRelation(leftValue: string, rightValue: string): ModelRelation {
  const left = normalizedModelCode(leftValue);
  const right = normalizedModelCode(rightValue);
  if (!left || !right) return "unknown";

  const leftBase = left.split(/[._/-]/, 1)[0];
  const rightBase = right.split(/[._/-]/, 1)[0];
  if (leftBase === rightBase) return "exact";

  const leftSize = leadingModelSize(leftBase);
  const rightSize = leadingModelSize(rightBase);
  if (leftSize && rightSize) {
    if (leftSize === rightSize) return "family";
    return "different";
  }

  const sharedLength = commonPrefixLength(leftBase, rightBase);
  const shared = leftBase.slice(0, sharedLength);
  if (sharedLength >= 4 && /[A-Z]/.test(shared) && /\d/.test(shared)) return "family";
  return "unknown";
}

function comparableText(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
}

export function plannedMouldRelation(mouldModel: string, drawingNo: string, plannedModel: string): ModelRelation {
  const planned = comparableText(plannedModel);
  if (!planned) return "unknown";
  const mouldCode = normalizedModelCode(mouldModel);
  const planCode = normalizedModelCode(plannedModel);
  const drawingCode = normalizedModelCode(drawingNo);
  if (mouldCode && planCode && mouldCode === planCode) return "exact";
  // MES often stores the product type (e.g. 托盘) as the model and JF2 as the drawing.
  // A conflicting structured model still needs review even when its drawing matches.
  if (drawingCode && planCode && drawingCode === planCode) return mouldCode ? "family" : "exact";
  if (comparableText(drawingNo) === planned) return "family";
  const modelRelation = modelCodeRelation(mouldModel, plannedModel);
  const drawingRelation = modelCodeRelation(drawingNo, plannedModel);
  if ([modelRelation, drawingRelation].some((relation) => relation === "exact" || relation === "family")) return "family";
  return modelRelation === "different" ? "different" : "unknown";
}

export function machineIdentityStatus(sourceMachineName: string, machineNumber: number, tonnage: string): "match" | "conflict" | "unknown" {
  const match = sourceMachineName.normalize("NFKC").trim().match(/^(\d{3,4})\s*T\s*[-–—]\s*(\d{1,2})$/i);
  if (!match) return "unknown";
  const boardTonnage = Number(tonnage.replace(/[^\d]/g, ""));
  if (!boardTonnage) return "unknown";
  if (Number(match[2]) !== machineNumber) return "conflict";
  const sourceTonnage = Number(match[1]);
  // Process comparisons use the MES rating; older clients may supply the display rating.
  const knownMachineSevenAlias = machineNumber === 7
    && [1300, 1800].includes(sourceTonnage) && [1300, 1800].includes(boardTonnage);
  return sourceTonnage === boardTonnage || knownMachineSevenAlias ? "match" : "conflict";
}

export function machineIdentityConflict(sourceMachineName: string, machineNumber: number, tonnage: string): boolean {
  return machineIdentityStatus(sourceMachineName, machineNumber, tonnage) === "conflict";
}

export function machineIdentityEvidenceStatus(
  production: { sourceMachineName: string; secondarySourceMachineName?: string },
  machineNumber: number,
  tonnage: string,
): "match" | "conflict" | "unknown" {
  const names = [production.sourceMachineName, production.secondarySourceMachineName].filter((name): name is string => Boolean(name));
  if (!names.length) return "unknown";
  const statuses = names.map((name) => machineIdentityStatus(name, machineNumber, tonnage));
  if (statuses.includes("conflict")) return "conflict";
  return statuses.includes("unknown") ? "unknown" : "match";
}

export function chooseMachineEvidence<T extends { date: string }>(
  planned: T | undefined,
  actual: T | undefined,
  referenceDate: string,
): T | undefined {
  return planned?.date === referenceDate ? planned : actual ?? planned;
}

export function assessOpenPlanGroup(parts: Array<{
  model_name: string | null;
  parts_per_shot?: number;
  production_group_complete?: boolean;
}>): { unambiguous: boolean; multiCavity: boolean } {
  if (!parts.length) return { unambiguous: false, multiCavity: false };
  const expectedSize = Math.max(1, ...parts.map((part) => Number(part.parts_per_shot ?? 1)));
  const complete = parts.every((part) => part.production_group_complete !== false)
    && (expectedSize === 1 || parts.length === expectedSize);
  const models = new Set(parts.map((part) => comparableText(part.model_name ?? "")).filter(Boolean));
  return {
    unambiguous: complete && models.size === 1,
    multiCavity: expectedSize > 1 || parts.length > 1,
  };
}

export function activityEvidenceBasis(modelCount: number, resolutionStatus: string | null): "active_estimate" | "planned_only" | "ambiguous" {
  if (modelCount > 1 || resolutionStatus === "unresolved") return "ambiguous";
  return resolutionStatus === "planned" ? "planned_only" : "active_estimate";
}

export function canCarryoverModel(
  activity: { date: string; model: string; basis: string },
  evidence: { date: string; model: string; basis: string } | undefined,
): boolean {
  if (activity.model || !evidence?.model) return false;
  const age = (Date.parse(`${activity.date}T00:00:00Z`) - Date.parse(`${evidence.date}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(age) || age < 0 || age > 3) return false;
  return activity.basis !== "planned_only"
    || (evidence.basis === "planned_only" && evidence.date === activity.date);
}

export function mergedActivityBasis(activityBasis: string, carryoverEvidenceBasis: string | undefined): string {
  if (!carryoverEvidenceBasis) return activityBasis;
  return carryoverEvidenceBasis === "planned_only" || activityBasis === "planned_only"
    ? "planned_only"
    : "carryover_plan";
}

export type PlannedMouldAssessment = "match" | "review" | "mismatch" | "mould_missing" | "machine_identity_conflict" | "machine_identity_unknown";

export function assessPlannedMould(
  mould: { model: string; drawingNo: string } | undefined,
  production: { model: string; sourceMachineName: string; secondarySourceMachineName?: string },
  machineNumber: number,
  tonnage: string,
): PlannedMouldAssessment {
  const identity = machineIdentityEvidenceStatus(production, machineNumber, tonnage);
  if (identity === "conflict") return "machine_identity_conflict";
  if (identity === "unknown") return "machine_identity_unknown";
  if (!mould) return "mould_missing";
  const relation = plannedMouldRelation(mould.model, mould.drawingNo, production.model);
  if (relation === "exact") return "match";
  if (relation === "different") return "mismatch";
  return "review";
}

export type ModelValidation =
  | "match" | "confirmed_match" | "review" | "mismatch" | "confirmed_mismatch"
  | "unknown" | "no_production" | "mould_missing" | "planned" | "planned_match"
  | "planned_review" | "planned_mismatch" | "planned_mould_missing"
  | "machine_identity_conflict" | "machine_identity_unknown" | "recent_output"
  | "stale" | "activity_unknown" | "ambiguous" | "conflict" | "loading";

export function assessMachineMould(
  moulds: Array<{ model: string; drawingNo: string }>,
  production: { date: string; basis: string; isRunning: boolean; model: string; sourceMachineName: string; secondarySourceMachineName?: string; sourceStatus?: string } | undefined,
  machineNumber: number,
  tonnage: string,
  referenceDate: string,
): ModelValidation {
  if (moulds.length > 1) return "conflict";
  if (!production) return "no_production";
  if (production.basis === "planned_only" && production.date === referenceDate && production.model) {
    const assessment = assessPlannedMould(moulds[0], production, machineNumber, tonnage);
    return ({ match: "planned_match", review: "planned_review", mismatch: "planned_mismatch",
      mould_missing: "planned_mould_missing", machine_identity_conflict: "machine_identity_conflict",
      machine_identity_unknown: "machine_identity_unknown" } as const)[assessment];
  }
  if (production.isRunning || production.date === referenceDate) {
    const identity = machineIdentityEvidenceStatus(production, machineNumber, tonnage);
    if (identity === "conflict") return "machine_identity_conflict";
    if (identity === "unknown" && production.isRunning) return "machine_identity_unknown";
  }
  if (production.basis === "ambiguous" && production.date === referenceDate) return "ambiguous";
  if (production.sourceStatus && production.sourceStatus !== "ok") return "activity_unknown";
  if (!production.isRunning) return "no_production";
  if (!moulds[0]) return "mould_missing";
  if (production.basis === "ambiguous") return "ambiguous";
  if (production.basis === "planned_only") return "planned";
  if (production.basis === "last_output") return "recent_output";
  const age = (Date.parse(`${referenceDate}T00:00:00Z`) - Date.parse(`${production.date}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(age) || age < 0 || age > 3) return "stale";
  const relation = plannedMouldRelation(moulds[0].model, moulds[0].drawingNo, production.model);
  return relation === "exact" ? "match" : relation === "family" ? "review" : relation === "different" ? "mismatch" : "unknown";
}

export function canApplyModelValidation(automatic: ModelValidation): boolean {
  return ["review", "mismatch", "unknown", "planned_review", "planned_mismatch"].includes(automatic);
}

export function applyModelValidationRule(automatic: ModelValidation, decision: "match" | "mismatch" | undefined): ModelValidation {
  // A new automatic identifier match must not erase an existing field rejection.
  if (decision === "mismatch" && automatic === "match") return "confirmed_mismatch";
  if (decision === "mismatch" && automatic === "planned_match") return "planned_mismatch";
  if (!decision || !canApplyModelValidation(automatic)) return automatic;
  if (automatic.startsWith("planned_")) return decision === "match" ? "planned_match" : "planned_mismatch";
  return decision === "match" ? "confirmed_match" : "confirmed_mismatch";
}

export function machineCardModel(
  production: { date: string; basis: string; isRunning: boolean; model: string; sourceStatus?: string } | undefined,
  referenceDate: string,
): { model: string; planned: boolean; recent?: boolean; date?: string } | null {
  if (!production?.model) return null;
  if (production.basis === "planned_only" && production.date === referenceDate) {
    return { model: production.model, planned: true };
  }
  const age = (Date.parse(`${referenceDate}T00:00:00Z`) - Date.parse(`${production.date}T00:00:00Z`)) / 86_400_000;
  if ((!production.isRunning || (production.sourceStatus && production.sourceStatus !== "ok"))
    && ["active_estimate", "carryover_plan", "last_output"].includes(production.basis)
    && Number.isFinite(age) && age >= 0 && age <= 7) {
    return { model: production.model, planned: false, recent: true, date: production.date };
  }
  if (!production.isRunning || !["active_estimate", "carryover_plan"].includes(production.basis)) return null;
  return Number.isFinite(age) && age >= 0 && age <= 3
    ? { model: production.model, planned: false }
    : null;
}
