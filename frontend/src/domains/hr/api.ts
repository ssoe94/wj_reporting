import api from "@/lib/api";
import type {
  HrAccessUser,
  HrImportCommit,
  HrImportPayload,
  HrImportPreview,
  HrLayoutUpdate,
  HrMonthList,
  HrWorkspace,
} from "./types";

const ROOT = "/analytics/hr";

function workspaceUrl(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("기준 월을 YYYY-MM 형식으로 선택해 주세요.");
  }
  return `${ROOT}/workspaces/${encodeURIComponent(month)}/`;
}

export async function listHrMonths(signal?: AbortSignal): Promise<HrMonthList> {
  return (await api.get<HrMonthList>(`${ROOT}/workspaces/`, { signal })).data;
}

export async function getHrWorkspace(month: string, signal?: AbortSignal): Promise<HrWorkspace> {
  return (await api.get<HrWorkspace>(workspaceUrl(month), { signal })).data;
}

export async function previewHrImport(payload: HrImportPayload): Promise<HrImportPreview> {
  return (await api.post<HrImportPreview>(`${ROOT}/import-preview/`, payload)).data;
}

export async function importHrWorkspace(month: string, payload: HrImportCommit): Promise<HrWorkspace> {
  return (await api.post<HrWorkspace>(`${workspaceUrl(month)}import/`, payload)).data;
}

export async function updateHrWorkspace(month: string, payload: HrLayoutUpdate): Promise<HrWorkspace> {
  return (await api.patch<HrWorkspace>(workspaceUrl(month), payload)).data;
}

export async function getHrAccess(signal?: AbortSignal): Promise<{ users: HrAccessUser[] }> {
  return (await api.get<{ users: HrAccessUser[] }>(`${ROOT}/access/`, { signal })).data;
}

export async function updateHrAccess(id: number, granted: boolean): Promise<{ users: HrAccessUser[] }> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("계정 ID를 확인해 주세요.");
  return (await api.patch<{ users: HrAccessUser[] }>(`${ROOT}/access/${id}/`, { granted })).data;
}
