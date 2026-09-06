import { http } from "@/shared/api/http";
import { getOverviewBoard } from "@/domains/boards/overview/api";
import type { AppLanguage } from "@/shared/i18n/language";
import { hasOverviewEvidence, parseFieldOperations } from "./model";

export async function getAnalysisOverview(date: string, language: AppLanguage) {
  const result = await getOverviewBoard(date, language, { allowDemo: false });
  if (result.mode !== "live" || result.model.businessDate !== date || !hasOverviewEvidence(result.model)) {
    throw new Error("Production overview is empty or belongs to another business day.");
  }
  return result.model;
}

export async function getFieldOperations(date: string) {
  const response = await http.get<unknown>("/analytics/field-operations/", { params: { date } });
  return parseFieldOperations(response.data, date);
}
