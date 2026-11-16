import api from '@/lib/api';
import { recordParams } from './model';
import type {
  FieldEvent, FieldException, FieldFilters, FieldOverview, FieldStation, FieldStationDraft, IssuedToken,
  FieldIssuerAssignment, FieldIssuerDraft, FieldSerialCeiling,
} from './model';

const FIELD_API = '/field/v1';
const ISSUER_API = FIELD_API + '/issuer-assignments/';
type RequestOptions = { authSessionId: string | null; signal?: AbortSignal };
type OverviewScope = { business_date: string; station?: string };

export function fieldOverview(scope: OverviewScope, request: RequestOptions) {
  return api.get<FieldOverview>(FIELD_API + '/overview/', { ...request, params: scope }).then(({ data }) => data);
}

export function fieldExceptions(scope: OverviewScope, request: RequestOptions) {
  return api.get<{ business_date: string; exceptions: FieldException[] }>(
    FIELD_API + '/exceptions/', { ...request, params: scope },
  ).then(({ data }) => data.exceptions);
}

export function fieldEvents(filters: FieldFilters, cursor: string, request: RequestOptions) {
  return api.get<{ results: FieldEvent[]; next_cursor: string | null }>(FIELD_API + '/events/', {
    ...request,
    params: { ...recordParams(filters), page_size: 50, ...(cursor && { cursor }) },
  }).then(({ data }) => data);
}

export async function downloadFieldEvents(filters: FieldFilters, request: RequestOptions) {
  const { data, headers } = await api.get<Blob>(FIELD_API + '/events.csv', {
    ...request, params: recordParams(filters), responseType: 'blob',
  });
  if (!String(headers['content-type']).startsWith('text/csv')) throw new Error('CSV response required');
  downloadFile(data, `field-events-${filters.from}-${filters.to}.csv`);
}

function downloadFile(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  try {
    link.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 15_000);
  }
}

export function fieldStations(request: RequestOptions) {
  return api.get<{ stations: FieldStation[] }>(FIELD_API + '/stations/', request).then(({ data }) => data.stations);
}

const stationUrl = (id: string) => FIELD_API + '/stations/' + encodeURIComponent(id) + '/';

export function registerFieldStation(draft: FieldStationDraft, request: RequestOptions) {
  return api.post<FieldStation>(FIELD_API + '/stations/', draft, request);
}

export function updateFieldStation(id: string, { station_id: _id, ...draft }: FieldStationDraft, request: RequestOptions) {
  return api.patch<FieldStation>(stationUrl(id), draft, request);
}

export function issueFieldToken(id: string, request: RequestOptions) {
  return api.post<IssuedToken>(stationUrl(id) + 'issue-token/', {}, request).then(({ data }) => data);
}

export function revokeFieldToken(id: string, request: RequestOptions) {
  return api.post(stationUrl(id) + 'revoke-token/', {}, request);
}

export function fieldIssuerAssignments(request: RequestOptions) {
  return api.get<{ assignments: FieldIssuerAssignment[] }>(ISSUER_API, request).then(({ data }) => data.assignments);
}

export function assignFieldIssuer(draft: FieldIssuerDraft, request: RequestOptions) {
  return api.post<FieldIssuerAssignment>(ISSUER_API, draft, request);
}

export function stopFieldIssuer(id: number, reason: string, request: RequestOptions) {
  return api.post<FieldIssuerAssignment>(`${ISSUER_API}${id}/stop/`, { reason }, request);
}

export function releaseFieldIssuer(id: number, reason: string, ceilings: FieldSerialCeiling[], request: RequestOptions) {
  return api.post<FieldIssuerAssignment>(`${ISSUER_API}${id}/release/`, { reason, ceilings }, request);
}

export async function downloadFieldIssuerPolicy(id: string, request: RequestOptions) {
  const { data } = await api.get<{ station_id: string }>(stationUrl(id) + 'issuer-policy/', request);
  if (request.signal?.aborted) return;
  if (data?.station_id !== id) throw new Error('Station policy response required');
  downloadFile(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }), `issuer-policy-${id}.json`);
}

export function fieldServerOrigin() {
  return new URL(api.defaults.baseURL ?? '/api', window.location.origin).origin;
}
