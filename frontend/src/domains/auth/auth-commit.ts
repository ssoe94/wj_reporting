import { getAuthSessionSnapshot, startAuthSession } from './auth-storage.ts';

const DATABASE = 'wj-auth-commit-coordinator-v1';
const STORE = 'commit';

// One metadata-only read/write transaction serializes login commits across
// cooperating tabs. No token, identity, or session record is stored in IDB.
export function withAuthCommitLock<T>(commit: () => T, factory: IDBFactory | undefined = window.indexedDB, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let database: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let result: T;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      database?.close();
      if (success) resolve(result);
      else reject(new Error('Authentication session coordination unavailable'));
    };
    const timer = window.setTimeout(() => {
      try { transaction?.abort(); } catch { /* The transaction may have completed. */ }
      finish(false);
    }, timeoutMs);
    try {
      if (!factory) { finish(false); return; }
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onerror = () => { finish(false); };
      request.onblocked = () => { finish(false); };
      request.onsuccess = () => {
        database = request.result;
        if (settled) { database.close(); return; }
        try {
          transaction = database.transaction(STORE, 'readwrite');
          transaction.oncomplete = () => { if (!settled) finish(false); };
          transaction.onabort = transaction.onerror = () => { finish(false); };
          const ownership = transaction.objectStore(STORE).get('coordinator');
          ownership.onsuccess = () => {
            if (settled) return;
            // The commit itself is synchronous localStorage work. Once it has
            // succeeded, a later IDB close/abort cannot undo it or turn it into
            // a false login failure. close() releases the connection only after
            // this active transaction finishes, retaining serialization.
            try { result = commit(); finish(true); }
            catch { transaction?.abort(); finish(false); }
          };
        } catch { finish(false); }
      };
    } catch { finish(false); }
  });
}

export async function commitAuthSession(access: string, refresh: string, stillCurrent: () => boolean): Promise<string | null> {
  const sessionId = await withAuthCommitLock(() => {
    // Recheck *inside* the transaction, after every earlier tab's commit.
    if (!stillCurrent()) return null;
    return startAuthSession(access, refresh);
  });
  return sessionId && getAuthSessionSnapshot().id === sessionId ? sessionId : null;
}
