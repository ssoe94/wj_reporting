import api from '../../lib/api';
import { isExactDraftRequestUid, parseExactDraftSnapshot } from './exact-draft-diagnostic';

export const EXACT_DRAFT_ENDPOINT = '/production/mes-create-diagnostic/';
export type ExactDraftAction = 'prepare' | 'send' | 'recheck';

export async function getExactDraftDiagnostic(sessionId: string, signal: AbortSignal) {
  const response = await api.get(EXACT_DRAFT_ENDPOINT, { authSessionId: sessionId, signal, skipAuthRefresh: true });
  return parseExactDraftSnapshot(response.data);
}

export async function postExactDraftDiagnostic(action: ExactDraftAction, requestUid: string | null,
  sessionId: string, signal: AbortSignal) {
  if (!['prepare', 'send', 'recheck'].includes(action)) throw new Error('Invalid diagnostic action');
  if (action !== 'prepare' && !isExactDraftRequestUid(requestUid)) throw new Error('Missing exact request');
  const body = action === 'prepare' ? { action } : { action, request_uid: requestUid };
  // Never replay a diagnostic POST after a 401, timeout or uncertain response.
  const response = await api.post(EXACT_DRAFT_ENDPOINT, body, { authSessionId: sessionId, signal, skipAuthRefresh: true });
  return parseExactDraftSnapshot(response.data);
}
