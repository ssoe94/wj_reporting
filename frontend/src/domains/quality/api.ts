import { http } from '@/shared/api/http';
import { parseQualityAnalysis, qualityScopeParams } from './model';
import type { QualityScope } from './model';

export async function getQualityAnalysis(scope: QualityScope) {
  const response = await http.get<unknown>(`/quality/analysis/?${qualityScopeParams(scope)}`);
  return parseQualityAnalysis(response.data, scope);
}
export interface QualitySourceReport {
  id: number; report_dt: string; section: string; model: string; part_no: string;
  lot_qty: number | null; inspection_qty: number | null; defect_qty: number | null;
  defect_rate: string; judgement: string; phenomenon: string; disposition: string; action_result: string;
  source_import?: { occurrence_location?: string; sheet_name?: string; source_row_number?: number | null } | null;
}
export async function getQualitySourceReport(id: number): Promise<QualitySourceReport> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid report id');
  const response = await http.get<QualitySourceReport>(`/quality/reports/${id}/`);
  if (!response.data || response.data.id !== id) throw new Error('Quality report identity mismatch');
  return response.data;
}
