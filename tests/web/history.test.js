/* Undo/redo for pattern edits.
 *
 * grid.js needs a DOM to build a chart, so it is not exercised here - what is
 * testable without a browser is the contract grid.js relies on: one entry per
 * gesture, and restoring one puts the record back byte for byte, not just
 * "close enough" to what the decoder reads. That is simulated directly with
 * edit.js, the same module grid.js calls into for every write.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { History } from '../../web/js/history.js';
import * as edit from '../../web/js/edit.js';
import * as records from '../../web/js/records.js';
import * as protocol from '../../web/js/protocol.js';

/** A record with something in every byte, so a missed restore anywhere is
 *  visible - the same fixture edit.test.js uses. */
function scratchRecord() {
  const data = new Uint8Array(protocol.PATTERN_BYTES);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 37 + 11) & 0x7f;
  data[records.OFF_SETUP] = 15;
  data[records.OFF_SETUP + 1] = 24;
  return data;
}

test('undo and redo pop in the right order', () => {
  const history = new History();
  history.push({ id: 1 });
  history.push({ id: 2 });
  history.push({ id: 3 });

  assert.equal(history.undo().id, 3);
  assert.equal(history.undo().id, 2);
  assert.equal(history.redo().id, 2);
  assert.equal(history.redo().id, 3);
  assert.equal(history.undo().id, 3);
  assert.equal(history.undo().id, 2);
  assert.equal(history.undo().id, 1);
  assert.equal(history.undo(), null, 'nothing left to undo');
});

test('canUndo and canRedo track what is actually on each stack', () => {
  const history = new History();
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);

  history.push({ id: 1 });
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);

  history.undo();
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), true);
});

test('a fresh push clears the redo stack', () => {
  const history = new History();
  history.push({ id: 1 });
  history.push({ id: 2 });
  history.undo();
  assert.equal(history.canRedo(), true);

  history.push({ id: 3 });
  assert.equal(history.canRedo(), false, 'redoing past a new edit would overwrite it');
  assert.equal(history.undo().id, 3);
});

test('the stack is capped so a long session cannot grow without bound', () => {
  const history = new History(5);
  for (let i = 0; i < 8; i += 1) history.push({ id: i });

  // Only the 5 most recent survive; the oldest three are gone.
  const popped = [];
  while (history.canUndo()) popped.push(history.undo().id);
  assert.deepEqual(popped, [7, 6, 5, 4, 3]);
});

test('redo() returns null when there is nothing to redo', () => {
  const history = new History();
  assert.equal(history.redo(), null);
  history.push({ id: 1 });
  assert.equal(history.redo(), null, 'nothing was undone yet');
});

/* The byte-level guarantee undo depends on: restoring a snapshot must put the
 * record back exactly as it was, including bytes no decoder looks at. This is
 * grid.js's own contract - snapshot before the gesture, `payload.set()` the
 * snapshot back - exercised here without the DOM grid.js needs to run. */

test('undoing one edit restores the record byte for byte, including reserved bytes', () => {
  const payload = scratchRecord();
  const before = payload.slice();
  assert.equal(before.length, 448);

  const history = new History();
  const snapshot = payload.slice();   // what grid.js takes at pointerdown
  edit.cycleStep(payload, 8, 3);
  edit.setFlam(payload, 8, 3, true);
  history.push({ before: snapshot, after: payload.slice() });

  assert.notDeepEqual(payload, before, 'the edit actually changed something');

  const entry = history.undo();
  payload.set(entry.before);

  for (let i = 0; i < 448; i += 1) {
    assert.equal(payload[i], before[i], `byte ${i} did not come back`);
  }
  assert.deepEqual(payload, before);
});

test('redo replays the edit exactly, including the bytes it stopped touching', () => {
  const payload = scratchRecord();
  const snapshot = payload.slice();
  edit.cycleAccent(payload, 4);
  edit.cycleAccent(payload, 9);
  const afterEdit = payload.slice();

  const history = new History();
  history.push({ before: snapshot, after: afterEdit });

  payload.set(history.undo().before);
  assert.deepEqual(payload, snapshot);

  payload.set(history.redo().after);
  assert.deepEqual(payload, afterEdit);
});

test('a multi-cell gesture undoes as one action', () => {
  // The stroke this simulates: pointerdown snapshots the record once, every
  // cell crossed writes into the same payload, pointerup pushes one entry -
  // exactly what grid.js's begin()/paintStep()/end() do.
  const payload = scratchRecord();
  const OH = 15;
  payload[records.OFF_INST + 2 * OH] = 0;
  payload[records.OFF_INST + 2 * OH + 1] = 0;
  const before = payload.slice();

  const history = new History();
  const snapshot = payload.slice();
  const wanted = edit.nextState(OH, edit.stepState(payload, OH, 0));
  for (let step = 0; step < 16; step += 1) edit.setStep(payload, OH, step, wanted);
  history.push({ before: snapshot, after: payload.slice() });

  // Sixteen cells changed, one entry on the stack.
  assert.equal(history.undoStack.length, 1);
  const decoded = records.decodePattern(payload);
  for (let step = 0; step < 16; step += 1) {
    const level = decoded.step(OH, step).on ? decoded.level(OH, step) : 'off';
    assert.equal(level, wanted, `step ${step} was not painted`);
  }

  // One undo call reverts every cell the drag touched.
  payload.set(history.undo().before);
  assert.deepEqual(payload, before);
});
