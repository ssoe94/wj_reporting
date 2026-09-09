import { http } from "@/shared/api/http";
import { getOverviewBoard, getProductionOverview } from "@/domains/boards/overview/api";
import type { AppLanguage } from "@/shared/i18n/language";
import { hasOverviewEvidence, parseFieldOperations } from "./model";

export async function getAnalysisOverview(date: string, language: AppLanguage, signal?: AbortSignal) {
  const model = await getProductionOverview(date, language, signal);
  if (model.businessDate !== date || !hasOverviewEvidence(model)) {
    throw new Error("Production overview is empty or belongs to another business day.");
  }
  return model;
}

export async function getAnalysisSources(date: string, language: AppLanguage, signal?: AbortSignal) {
  const result = await getOverviewBoard(date, language, { allowDemo: false, signal });
  if (result.mode !== "live" || result.model.businessDate !== date || !hasOverviewEvidence(result.model)) {
    throw new Error("Production overview is empty or belongs to another business day.");
  }
  return result.model;
}

export async function getFieldOperations(date: string, machineNumber?: number | null, signal?: AbortSignal) {
  const response = await http.get<unknown>("/analytics/field-operations/", {
    params: { date, ...(machineNumber !== null && machineNumber !== undefined ? { machine_number: machineNumber } : {}) },
    signal,
  });
  const data = parseFieldOperations(response.data, date);
  if (machineNumber !== null && machineNumber !== undefined
    && (data.machines.length !== 1 || data.machines[0].machine_number !== machineNumber || data.coverage.total_machine_count !== 1)) {
    throw new Error("Field operation data belongs to a different equipment scope.");
  }
  return data;
}
