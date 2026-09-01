/* filestore.js against two IndexedDB environments: none at all, which is
 * every run of `node --test` (Node has no indexedDB global), and a minimal
 * in-memory fake standing in for a browser's, so the actual read/write/rename
 * logic gets exercised somewhere.
 *
 * Each half imports its own copy of the module (via a cache-busting query
 * string) so the two do not share the lazily-opened database connection
 * filestore.js caches at module scope.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ---------- a browser-shaped indexedDB, just enough of one ----------
 *
 * Callbacks fire as microtasks rather than synchronously, the way the real
 * API does, and a transaction's oncomplete only fires once every request it
 * issued - including ones a request's own onsuccess handler issues, as
 * rename() does - has resolved. Getting that ordering wrong would resolve
 * filestore's promises before the write they are waiting on has happened.
 */

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.result = undefined;
  }
}

function respond(tx, request, result) {
  tx.pending += 1;
  queueMicrotask(() => {
    request.result = result;
    request.onsuccess?.({ target: request });
    tx.pending -= 1;
    if (tx.pending === 0) queueMicrotask(() => tx.oncomplete?.());
  });
}

class FakeStore {
  constructor(map, tx) {
    this.map = map;
    this.tx = tx;
  }
  get(key) {
    const request = new FakeRequest();
    respond(this.tx, request, this.map.get(key));
    return request;
  }
  getAll() {
    const request = new FakeRequest();
    respond(this.tx, request, [...this.map.values()]);
    return request;
  }
  put(record) {
    this.map.set(record.name, record);
    const request = new FakeRequest();
    respond(this.tx, request, undefined);
    return request;
  }
  delete(key) {
    this.map.delete(key);
    const request = new FakeRequest();
    respond(this.tx, request, undefined);
    return request;
  }
}

class FakeTx {
  constructor(map) {
    this.pending = 0;
    this.store = new FakeStore(map, this);
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }
  objectStore() {
    return this.store;
  }
}

function fakeIndexedDB() {
  const map = new Map();
  return {
    open() {
      const request = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      const db = {
        createObjectStore: () => ({}),
        transaction: () => new FakeTx(map),
      };
      queueMicrotask(() => {
        request.result = db;
        request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  };
}

// Cache-busted per import so each gets its own module-scoped `dbPromise`
// rather than reusing whichever environment the first import saw.
const importFilestore = () => import(`../../web/js/filestore.js?t=${Math.random()}`);

test('with no indexedDB global, every call degrades instead of throwing', async () => {
  assert.equal('indexedDB' in globalThis, false, 'Node has no indexedDB; this test needs that to stay true');
  const filestore = await importFilestore();

  assert.deepEqual(await filestore.list(), []);
  await assert.doesNotReject(filestore.put({ name: 'a.syx', bytes: new Uint8Array(), dated: null, added: 1 }));
  await assert.doesNotReject(filestore.remove('a.syx'));
  await assert.doesNotReject(filestore.rename('a.syx', 'b.syx'));
});

test('put, list, rename and remove against a fake IndexedDB', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  try {
    const filestore = await importFilestore();

    await filestore.put({ name: 'old.syx', bytes: new Uint8Array([1, 2, 3]), dated: '2026-01-01', added: 10 });
    await filestore.put({ name: 'new.syx', bytes: new Uint8Array([4]), dated: null, added: 20 });

    const listed = await filestore.list();
    assert.deepEqual(listed.map((r) => r.name), ['old.syx', 'new.syx'], 'sorted oldest (lowest `added`) first');

    // Renaming preserves everything but the key.
    await filestore.rename('old.syx', 'renamed.syx');
    const afterRename = await filestore.list();
    const renamed = afterRename.find((r) => r.name === 'renamed.syx');
    assert.ok(renamed, 'renamed.syx should be in the database');
    assert.equal(renamed.added, 10);
    assert.equal(renamed.dated, '2026-01-01');
    assert.ok(!afterRename.some((r) => r.name === 'old.syx'), 'old.syx should be gone');

    // Renaming a name that was never stored is a no-op, not an error and not
    // a record conjured from nothing.
    await filestore.rename('never-stored.syx', 'also-never-stored.syx');
    const afterNoopRename = await filestore.list();
    assert.equal(afterNoopRename.length, 2, 'a rename of a missing key must not create a record');

    await filestore.remove('new.syx');
    const afterRemove = await filestore.list();
    assert.deepEqual(afterRemove.map((r) => r.name), ['renamed.syx']);
  } finally {
    delete globalThis.indexedDB;
  }
});
