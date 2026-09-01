/* Files kept in the browser between visits: dropped/picked backups, firmware
 * images, and whatever Save last committed. The browser's answer to a
 * data directory, one step up from store.js's remembered settings.
 *
 * IndexedDB rather than localStorage: the records here are .syx bytes, and
 * localStorage's string-only API would force every one of them through
 * base64 first - roughly a third more bytes - and localStorage's whole quota
 * is a few MB, which a handful of full backups burns through fast. IndexedDB
 * stores a Uint8Array as-is and gives a browser room to grant a much larger
 * quota, which is what the persist() call below is asking for.
 *
 * This is a cache of what was open in this browser profile, not a backup: it
 * lives in one browser on one machine, and "clear site data" or a private
 * window takes it with it. Save as… writing an actual file to disk is still the
 * only copy worth keeping.
 *
 * Every function here is async, opens the database lazily on first use, and
 * NEVER throws - on any failure (no indexedDB global, a private window that
 * refuses it, a quota refusal, a blocked upgrade) it resolves to [] or
 * undefined, the same shape a successful call with nothing stored would
 * produce. The app already treats "nothing was remembered" as a normal
 * state; a storage failure is just another way to arrive at it.
 */

const DB_NAME = 'nava-tools';
const STORE = 'files';
const VERSION = 1;

// Best effort and asked for once: a page that already keeps files past a
// reload is worth telling the browser not to evict them under storage
// pressure, but nothing downstream reads the answer either way - IndexedDB
// still works without it, just under a smaller, evictable quota.
try {
  globalThis.navigator?.storage?.persist?.()?.catch(() => {});
} catch {
  // No navigator.storage at all - nothing here is required for the app to work.
}

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      if (!globalThis.indexedDB) {
        resolve(null);
        return;
      }
      let request;
      try {
        request = globalThis.indexedDB.open(DB_NAME, VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'name' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Let go when a newer page bumps VERSION: an open connection blocks
        // the upgrade, and a tab left on the old code would otherwise hold a
        // fresher tab in onblocked - which resolves null here and silently
        // turns persistence off for it.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

/** Every stored file, oldest first - the order app.js replays them at
 *  startup in, so the most recently touched one ends up back on top. */
export async function list() {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch {
      resolve([]);
      return;
    }
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => {
      const records = request.result ?? [];
      records.sort((a, b) => a.added - b.added);
      resolve(records);
    };
    request.onerror = () => resolve([]);
    tx.onerror = () => resolve([]);
  });
}

/** Store or overwrite one record, keyed by its own `name`. */
export async function put(record) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve(undefined);
      return;
    }
    try {
      tx.objectStore(STORE).put(record);
    } catch {
      // A malformed record throws synchronously rather than through the
      // transaction, and "never throws" has to cover that too.
      resolve(undefined);
      return;
    }
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => resolve(undefined);
    tx.onabort = () => resolve(undefined);
  });
}

/** Drop one record by name. Removing a name that was never stored is a
 *  no-op, not an error. */
export async function remove(name) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve(undefined);
      return;
    }
    try {
      tx.objectStore(STORE).delete(name);
    } catch {
      resolve(undefined);
      return;
    }
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => resolve(undefined);
    tx.onabort = () => resolve(undefined);
  });
}

/** Move a stored record under a new name, in one transaction, keeping its
 *  `added` and `dated` fields. A name that is not in the database has
 *  nothing to move - harmless, not a record conjured from nothing. */
export async function rename(oldName, newName) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve(undefined);
      return;
    }
    const store = tx.objectStore(STORE);
    const getRequest = store.get(oldName);
    getRequest.onsuccess = () => {
      const record = getRequest.result;
      if (!record) return;
      try {
        store.delete(oldName);
        store.put({ ...record, name: newName });
      } catch {
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => resolve(undefined);
    tx.onabort = () => resolve(undefined);
  });
}
