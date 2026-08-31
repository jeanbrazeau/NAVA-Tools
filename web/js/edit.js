/* Editing a pattern record in place.
 *
 * Every function here writes the smallest number of bytes that can express the
 * change and leaves the rest of the 448 alone. That is not tidiness: the whole
 * reason a backup survives a firmware revision is that records are carried
 * verbatim, padding included, so re-encoding a decoded Pattern back over the
 * record would quietly zero every field this decoder does not know about.
 * Nothing here goes through Pattern at all - it is masks and velocity bytes.
 *
 * The step cycle is the machine's: off -> soft -> loud -> off. Instruments
 * whose two levels are 1 and 0 - the trigger output and total accent - have no
 * soft to land on, so they cycle off -> on -> off instead.
 */

import {
  INST_VEL_HIGH,
  INST_VEL_LOW,
  NBR_STEP,
  OFF_EXT_ACCENT,
  OFF_EXT_TRACK,
  OFF_INST,
  OFF_SETUP,
  OFF_VELOCITY,
  TOTAL_ACC,
} from './records.js';

const FLAM_BIT = 0x80;

const readMask = (payload, offset) => payload[offset] | (payload[offset + 1] << 8);

function writeMask(payload, offset, mask) {
  payload[offset] = mask & 0xff;
  payload[offset + 1] = (mask >> 8) & 0xff;
}

const bit = (step) => 1 << step;

/** True when the instrument has only one level, so a soft step is not a thing
 *  it can express. The table says so: high 1, low 0. */
export function isGate(instrument) {
  return INST_VEL_HIGH[instrument] <= 1;
}

/** The state a voice's step is in now: 'off', 'normal' or 'accent'. */
export function stepState(payload, instrument, step) {
  if (!((readMask(payload, OFF_INST + 2 * instrument) >> step) & 1)) return 'off';
  const velocity = payload[OFF_VELOCITY + instrument * NBR_STEP + step] & 0x7f;
  return velocity >= INST_VEL_HIGH[instrument] ? 'accent' : 'normal';
}

/** Put one voice step into a given state, returning the state it ended in.
 *
 * The flam flag rides in bit 7 of the velocity byte and is left where it is:
 * it is a property of the step, not of the level, and clearing it because the
 * level moved would lose an edit the user never asked to undo. */
export function setStep(payload, instrument, step, state) {
  const offset = OFF_INST + 2 * instrument;
  const velocityAt = OFF_VELOCITY + instrument * NBR_STEP + step;
  const flam = payload[velocityAt] & FLAM_BIT;
  // A gate lane has no soft level to hold, so asking for one gives the only
  // level it has rather than a step that reads back as something else.
  const wanted = state === 'normal' && isGate(instrument) ? 'accent' : state;

  if (wanted === 'off') {
    writeMask(payload, offset, readMask(payload, offset) & ~bit(step));
    return 'off';
  }
  writeMask(payload, offset, readMask(payload, offset) | bit(step));
  const level = wanted === 'accent' ? INST_VEL_HIGH[instrument] : INST_VEL_LOW[instrument];
  payload[velocityAt] = level | flam;
  return wanted;
}

/** The state after this one in the machine's cycle: off -> soft -> loud -> off,
 *  with the soft rung missing on a lane that has no soft level. */
export function nextState(instrument, state) {
  if (state === 'off') return isGate(instrument) ? 'accent' : 'normal';
  if (state === 'normal') return 'accent';
  return 'off';
}

/** Advance one voice step through the cycle, returning its new state. */
export function cycleStep(payload, instrument, step) {
  const state = stepState(payload, instrument, step);
  return setStep(payload, instrument, step, nextState(instrument, state));
}

/** Turn the flam flag on a voice step on or off, returning the new value.
 *
 * Only meaningful on a step that is on, and the machine cannot flam a step
 * that is not playing, so this refuses rather than storing a flag nothing will
 * ever read. */
export function setFlam(payload, instrument, step, on) {
  if (stepState(payload, instrument, step) === 'off') return false;
  const velocityAt = OFF_VELOCITY + instrument * NBR_STEP + step;
  if (on) payload[velocityAt] |= FLAM_BIT;
  else payload[velocityAt] &= ~FLAM_BIT;
  return on;
}

export function flamState(payload, instrument, step) {
  return Boolean(payload[OFF_VELOCITY + instrument * NBR_STEP + step] & FLAM_BIT);
}

export function toggleFlam(payload, instrument, step) {
  return setFlam(payload, instrument, step, !flamState(payload, instrument, step));
}

/** Total accent is a mask and nothing else - there is no velocity to set. */
export function setAccent(payload, step, state) {
  const offset = OFF_INST + 2 * TOTAL_ACC;
  const mask = readMask(payload, offset);
  writeMask(payload, offset, state === 'off' ? mask & ~bit(step) : mask | bit(step));
  // The record carries a flag saying whether the lane is used at all; keeping
  // it in step with the mask is what makes the lane appear and disappear.
  payload[OFF_SETUP + 7] = readMask(payload, offset) ? 1 : 0;
  return state === 'off' ? 'off' : 'accent';
}

export function cycleAccent(payload, step) {
  return setAccent(payload, step, accentState(payload, step) === 'off' ? 'accent' : 'off');
}

export function accentState(payload, step) {
  return (readMask(payload, OFF_INST + 2 * TOTAL_ACC) >> step) & 1 ? 'accent' : 'off';
}

export function extState(payload, track, step) {
  if (!((readMask(payload, OFF_EXT_TRACK + 2 * track) >> step) & 1)) return 'off';
  // extAccent is stored inverted, so a stored 0 means accented.
  return (readMask(payload, OFF_EXT_ACCENT + 2 * track) >> step) & 1 ? 'normal' : 'accent';
}

/** Advance one ext step: off -> normal -> accent -> off.
 *
 * The accent word is stored as the complement of what it means, so setting an
 * accent clears its bit. Getting that backwards would decode as the opposite
 * of what was clicked, which is why extState reads it back rather than
 * assuming. */
export function setExtStep(payload, track, step, state) {
  const maskAt = OFF_EXT_TRACK + 2 * track;
  const accentAt = OFF_EXT_ACCENT + 2 * track;
  const mask = readMask(payload, maskAt);
  const stored = readMask(payload, accentAt);

  if (state === 'off') {
    writeMask(payload, maskAt, mask & ~bit(step));
    writeMask(payload, accentAt, stored | bit(step));
    return 'off';
  }
  writeMask(payload, maskAt, mask | bit(step));
  // stored 1 means not accented, stored 0 means accented.
  writeMask(payload, accentAt, state === 'accent' ? stored & ~bit(step) : stored | bit(step));
  return state;
}

export function cycleExtStep(payload, track, step) {
  const state = extState(payload, track, step);
  const next = state === 'off' ? 'normal' : state === 'normal' ? 'accent' : 'off';
  return setExtStep(payload, track, step, next);
}
