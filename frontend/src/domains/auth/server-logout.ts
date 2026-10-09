import { isDisconnectConfirmed } from './mes-connection.ts';

// Dependencies are explicit so races and failed acknowledgements can be tested
// without a browser, credentials, or an HTTP request.
export async function finishServerLogout(sessionId: string | null, actions: {
  revoke: () => Promise<unknown>;
  currentSessionId: () => string | null;
  invalidateLocal: (expectedSessionId: string) => boolean;
}): Promise<boolean> {
  if (!sessionId || actions.currentSessionId() !== sessionId) return false;
  try {
    const result = await actions.revoke();
    if (!isDisconnectConfirmed(result) || actions.currentSessionId() !== sessionId) return false;
    // The session can change in another tab after the preceding check. The
    // write must target only this session; never clear the global control key.
    return actions.invalidateLocal(sessionId) && actions.currentSessionId() === null;
  } catch {
    return false;
  }
}
