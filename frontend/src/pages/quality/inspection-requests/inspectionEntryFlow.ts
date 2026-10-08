import type { InspectionItem, InspectionMeasurement } from './model';
import { safeInspectionEvidenceUrl } from './workflow';

/** Match the existing item rules before offering a final decision; server validation remains authoritative. */
export function inspectionEntryReady(items: InspectionItem[], rows: InspectionMeasurement[]): boolean {
  if (!items.length) return true;
  return items.every((item) => {
    const row = rows.find((entry) => entry.item_id === item.id);
    if (!row?.value.trim()) return item.required === false;
    if (!['pass', 'fail'].includes(row.judgement)) return false;
    if (item.evidence_required && !safeInspectionEvidenceUrl(row.evidence_url || '')) return false;
    if (row.evidence_url && !safeInspectionEvidenceUrl(row.evidence_url)) return false;
    if (item.kind === 'choice' && !item.options?.includes(row.value)) return false;
    if (item.kind === 'number') {
      const value = Number(row.value);
      if (!Number.isFinite(value) || Math.abs(value) > 1e12) return false;
      if (((item.minimum !== undefined && value < Number(item.minimum)) || (item.maximum !== undefined && value > Number(item.maximum))) && row.judgement !== 'fail') return false;
    }
    return true;
  });
}

export function inspectionEntryCount(items: InspectionItem[], rows: InspectionMeasurement[]): number {
  return items.filter((item) => rows.some((row) => row.item_id === item.id && row.value.trim() && row.judgement)).length;
}

/** Missing optional link fields and server trimming do not make a saved row look pending. */
export function inspectionEntrySame(a?: InspectionMeasurement, b?: InspectionMeasurement): boolean {
  return a?.item_id === b?.item_id && ['value', 'judgement', 'evidence_url'].every((key) =>
    String(a?.[key as keyof InspectionMeasurement] || '').trim() === String(b?.[key as keyof InspectionMeasurement] || '').trim());
}
