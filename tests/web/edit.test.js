/* Editing writes bytes that end up on a drum machine, so these check two
 * things for every edit: that the decoder reads back what was clicked, and
 * that nothing else in the 448-byte record moved.
 *
 * The second half matters more than it looks. A backup round-trips through
 * firmware revisions only because records are carried verbatim, padding and
 * all; an editor that rebuilt the record from a decoded Pattern would zero
 * every field this decoder does not know about, and the damage would not show
 * up until someone restored the file onto a newer machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as edit from '../../web/js/edit.js';
import * as records from '../../web/js/records.js';
import * as protocol from '../../web/js/protocol.js';

/** A record with something in every byte, so an accidental write anywhere is
 *  visible - including in the reserved areas the decoder never looks at. */
function scratchRecord() {
  const data = new Uint8Array(protocol.PATTERN_BYTES);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 37 + 11) & 0x7f;
  // A sane header, so the decoded Pattern is a 16-step 1/16 one.
  data[records.OFF_SETUP] = 15;
  data[records.OFF_SETUP + 1] = 24;
  return data;
}

/** Byte offsets that differ between two records. */
function changed(before, after) {
  const out = [];
  for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) out.push(i);
  return out;
}

test('a voice step cycles off -> soft -> loud -> off', () => {
  const payload = scratchRecord();
  const BD = 8;
  // Start from a known off.
  payload[records.OFF_INST + 2 * BD] = 0;
  payload[records.OFF_INST + 2 * BD + 1] = 0;

  assert.equal(edit.stepState(payload, BD, 4), 'off');
  assert.equal(edit.cycleStep(payload, BD, 4), 'normal');
  assert.equal(records.decodePattern(payload).level(BD, 4), 'normal');
  assert.equal(edit.cycleStep(payload, BD, 4), 'accent');
  assert.equal(records.decodePattern(payload).level(BD, 4), 'accent');
  assert.equal(edit.cycleStep(payload, BD, 4), 'off');
  assert.equal(records.decodePattern(payload).level(BD, 4), 'off');
});

test('a voice edit touches only its own mask and velocity byte', () => {
  const payload = scratchRecord();
  const before = payload.slice();
  const SD = 9;
  const step = 11;

  edit.cycleStep(payload, SD, step);

  const touched = changed(before, payload);
  const allowed = new Set([
    records.OFF_INST + 2 * SD,
    records.OFF_INST + 2 * SD + 1,
    records.OFF_VELOCITY + SD * records.NBR_STEP + step,
  ]);
  for (const offset of touched) {
    assert.ok(allowed.has(offset), `edit wrote byte ${offset}, which is not its own`);
  }
});

test('the trigger output and total accent have no soft level to land on', () => {
  const payload = scratchRecord();
  for (const gate of [0, records.TOTAL_ACC]) {
    assert.equal(edit.isGate(gate), true, `instrument ${gate} should be a gate`);
  }
  // Every voice does have one.
  for (const voice of [8, 9, 10, 11, 2, 3, 4, 14, 15, 7, 6]) {
    assert.equal(edit.isGate(voice), false, `instrument ${voice} should not be a gate`);
  }

  const TRIG = 0;
  payload[records.OFF_INST] = 0;
  payload[records.OFF_INST + 1] = 0;
  assert.equal(edit.cycleStep(payload, TRIG, 2), 'accent');
  assert.equal(records.decodePattern(payload).step(TRIG, 2).on, true);
  assert.equal(edit.cycleStep(payload, TRIG, 2), 'off');
  assert.equal(records.decodePattern(payload).step(TRIG, 2).on, false);
});

test('flam survives a level change and cannot be set on a silent step', () => {
  const payload = scratchRecord();
  const MT = 11;
  payload[records.OFF_INST + 2 * MT] = 0;
  payload[records.OFF_INST + 2 * MT + 1] = 0;

  assert.equal(edit.toggleFlam(payload, MT, 3), false, 'refused on an off step');

  edit.cycleStep(payload, MT, 3);                       // soft
  assert.equal(edit.toggleFlam(payload, MT, 3), true);
  assert.equal(records.decodePattern(payload).step(MT, 3).flam, true);

  edit.cycleStep(payload, MT, 3);                       // loud, flam kept
  const step = records.decodePattern(payload).step(MT, 3);
  assert.equal(step.flam, true, 'the level moved, the flam did not');
  assert.equal(records.decodePattern(payload).level(MT, 3), 'accent');

  assert.equal(edit.toggleFlam(payload, MT, 3), false);
  assert.equal(records.decodePattern(payload).step(MT, 3).flam, false);
});

test('total accent toggles, and keeps the used flag in step with the mask', () => {
  const payload = scratchRecord();
  payload[records.OFF_INST + 2 * records.TOTAL_ACC] = 0;
  payload[records.OFF_INST + 2 * records.TOTAL_ACC + 1] = 0;
  payload[records.OFF_SETUP + 7] = 0;

  assert.equal(edit.cycleAccent(payload, 0), 'accent');
  assert.equal(payload[records.OFF_SETUP + 7], 1, 'the lane is marked used');
  assert.equal(records.decodePattern(payload).totalAcc, 1);

  edit.cycleAccent(payload, 8);
  assert.equal(edit.accentState(payload, 8), 'accent');

  edit.cycleAccent(payload, 0);
  edit.cycleAccent(payload, 8);
  assert.equal(payload[records.OFF_SETUP + 7], 0, 'the last accent left, so did the flag');
});

test('an ext step cycles, and writes the accent word inverted', () => {
  const payload = scratchRecord();
  const track = 5;
  const step = 9;
  payload[records.OFF_EXT_TRACK + 2 * track] = 0;
  payload[records.OFF_EXT_TRACK + 2 * track + 1] = 0;

  assert.equal(edit.cycleExtStep(payload, track, step), 'normal');
  assert.equal(records.decodePattern(payload).extStep(track, step), 'normal');

  assert.equal(edit.cycleExtStep(payload, track, step), 'accent');
  assert.equal(records.decodePattern(payload).extStep(track, step), 'accent');
  // Accented means the STORED bit is clear; getting this backwards would decode
  // as the opposite of what was clicked.
  const stored = payload[records.OFF_EXT_ACCENT + 2 * track] |
    (payload[records.OFF_EXT_ACCENT + 2 * track + 1] << 8);
  assert.equal((stored >> step) & 1, 0);

  assert.equal(edit.cycleExtStep(payload, track, step), 'off');
  assert.equal(records.decodePattern(payload).extStep(track, step), 'off');
});

test('an ext edit touches only its own two words', () => {
  const payload = scratchRecord();
  const before = payload.slice();
  const track = 2;

  edit.cycleExtStep(payload, track, 6);

  const allowed = new Set([
    records.OFF_EXT_TRACK + 2 * track,
    records.OFF_EXT_TRACK + 2 * track + 1,
    records.OFF_EXT_ACCENT + 2 * track,
    records.OFF_EXT_ACCENT + 2 * track + 1,
  ]);
  for (const offset of changed(before, payload)) {
    assert.ok(allowed.has(offset), `ext edit wrote byte ${offset}, which is not its own`);
  }
});

test('the reserved bytes a decoder ignores are never written', () => {
  const payload = scratchRecord();
  const before = payload.slice();

  // A whole pattern's worth of editing, across every kind of lane.
  for (let step = 0; step < records.NBR_STEP; step += 1) {
    edit.cycleStep(payload, 8, step);
    edit.cycleStep(payload, 14, step);
    edit.cycleStep(payload, 0, step);
    edit.cycleAccent(payload, step);
    edit.cycleExtStep(payload, 0, step);
    edit.toggleFlam(payload, 8, step);
  }

  // 128..191 is the page the firmware writes as zeros and skips on read, and
  // 40..63 is the reserved tail of the setup block. Neither has any business
  // changing because someone clicked a step.
  for (let offset = 128; offset < 192; offset += 1) {
    assert.equal(payload[offset], before[offset], `reserved byte ${offset} changed`);
  }
  for (let offset = records.OFF_SETUP + 8; offset < 64; offset += 1) {
    assert.equal(payload[offset], before[offset], `setup padding byte ${offset} changed`);
  }
});

test('an edited record still encodes and decodes as a dump', () => {
  const payload = scratchRecord();
  // scratchRecord fills every byte, so the lane starts with steps already on;
  // clear it first or the cycle starts somewhere other than 'off'.
  payload[records.OFF_INST + 2 * 8] = 0;
  payload[records.OFF_INST + 2 * 8 + 1] = 0;
  edit.cycleStep(payload, 8, 0);
  edit.cycleStep(payload, 8, 4);
  edit.cycleAccent(payload, 0);

  const message = protocol.decode(protocol.encode(protocol.NAVA_PTRN_DMP, 3, payload));
  assert.equal(message.param, 3);
  assert.deepEqual(message.payload, payload);
  const pattern = records.decodePattern(message.payload);
  assert.equal(pattern.level(8, 0), 'normal');
  assert.equal(pattern.level(8, 4), 'normal');
});

/* The setters exist for dragging: the cell a stroke starts on decides a value
 * and every cell it crosses is set to that same value, so painting needs to
 * write a state rather than advance one. */

test('setStep writes the state asked for, whatever the step held before', () => {
  const payload = scratchRecord();
  const CH = 14;
  for (const from of ['off', 'normal', 'accent']) {
    for (const to of ['off', 'normal', 'accent']) {
      edit.setStep(payload, CH, 7, from);
      assert.equal(edit.setStep(payload, CH, 7, to), to, `${from} -> ${to}`);
      const decoded = records.decodePattern(payload);
      const level = decoded.step(CH, 7).on ? decoded.level(CH, 7) : 'off';
      assert.equal(level, to, `${from} -> ${to} read back`);
    }
  }
});

test('setStep on a gate lane gives the only level it has', () => {
  const payload = scratchRecord();
  // Asking a gate for 'normal' must not store a step that reads back as off:
  // its soft level is 0, which is below its own accent threshold of 1.
  assert.equal(edit.setStep(payload, 0, 5, 'normal'), 'accent');
  const decoded = records.decodePattern(payload);
  assert.equal(decoded.step(0, 5).on, true);
  assert.equal(decoded.level(0, 5), 'accent');
});

test('setExtStep writes the state asked for, inversion included', () => {
  const payload = scratchRecord();
  for (const from of ['off', 'normal', 'accent']) {
    for (const to of ['off', 'normal', 'accent']) {
      edit.setExtStep(payload, 4, 2, from);
      edit.setExtStep(payload, 4, 2, to);
      assert.equal(records.decodePattern(payload).extStep(4, 2), to, `${from} -> ${to}`);
    }
  }
});

test('painting a run leaves every step in the stroke at one value', () => {
  const payload = scratchRecord();
  const OH = 15;
  // A stroke: the first cell cycles, the rest take its result.
  const wanted = edit.nextState(OH, edit.stepState(payload, OH, 0));
  for (let step = 0; step < 8; step += 1) edit.setStep(payload, OH, step, wanted);

  const decoded = records.decodePattern(payload);
  for (let step = 0; step < 8; step += 1) {
    const level = decoded.step(OH, step).on ? decoded.level(OH, step) : 'off';
    assert.equal(level, wanted, `step ${step} did not take the stroke's value`);
  }
});

test('setFlam is explicit, and still refuses a silent step', () => {
  const payload = scratchRecord();
  const LT = 10;
  edit.setStep(payload, LT, 6, 'off');
  assert.equal(edit.setFlam(payload, LT, 6, true), false, 'refused while off');
  assert.equal(edit.flamState(payload, LT, 6), false);

  edit.setStep(payload, LT, 6, 'normal');
  assert.equal(edit.setFlam(payload, LT, 6, true), true);
  assert.equal(edit.setFlam(payload, LT, 6, true), true, 'setting twice is idempotent');
  assert.equal(records.decodePattern(payload).step(LT, 6).flam, true);
  edit.setFlam(payload, LT, 6, false);
  assert.equal(records.decodePattern(payload).step(LT, 6).flam, false);
});

test('a chart column maps onto the ext loop it repeats', () => {
  // The bug this pins: the chart draws column c as step c % extSteps, so an
  // editor writing the raw column sets a step past the end of the loop. The
  // machine never plays it and the clicked cell does not change, because it is
  // showing a different step - a click that looks dead and quietly writes junk.
  assert.equal(edit.extStepIndex(7, 5), 2);
  assert.equal(edit.extStepIndex(4, 5), 4);
  assert.equal(edit.extStepIndex(15, 5), 0);
  // A loop as long as the kit is its own identity.
  for (let c = 0; c < 16; c += 1) assert.equal(edit.extStepIndex(c, 16), c);
  // Defensive: extSteps is never 0 through decodePattern, but division by it
  // would be a silent NaN rather than a visible failure.
  assert.equal(edit.extStepIndex(9, 0), 9);
});

test('editing a repeated column changes the step it is repeating', () => {
  const payload = scratchRecord();
  const track = 0;
  const extSteps = 5;
  payload[records.OFF_EXT_TRACK + 2 * track] = 0;
  payload[records.OFF_EXT_TRACK + 2 * track + 1] = 0;

  // Column 7 of a 5-step loop is step 2.
  edit.setExtStep(payload, track, edit.extStepIndex(7, extSteps), 'normal');

  const decoded = records.decodePattern(payload);
  assert.equal(decoded.extStep(track, 2), 'normal', 'the underlying step is set');
  assert.equal(decoded.extStep(track, 7), 'off', 'nothing was written past the loop');
  // And the chart, which draws column c as step c % extSteps, now shows it on
  // every column that repeats step 2.
  for (const column of [2, 7, 12]) {
    assert.equal(
      decoded.extStep(track, column % extSteps), 'normal',
      `column ${column} should draw the step it repeats`,
    );
  }
});
