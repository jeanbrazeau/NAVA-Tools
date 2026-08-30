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

/** Advance one voice step through the cycle, returning its new state.
 *
 * The flam flag rides in bit 7 of the velocity byte and is left where it is:
 * it is a property of the step, not of the level, and clearing it because the
 * level moved would lose an edit the user never asked to undo. */
export function cycleStep(payload, instrument, step) {
  const offset = OFF_INST + 2 * instrument;
  const mask = readMask(payload, offset);
  const velocityAt = OFF_VELOCITY + instrument * NBR_STEP + step;
  const flam = payload[velocityAt] & FLAM_BIT;
  const state = stepState(payload, instrument, step);

  if (state === 'off') {
    writeMask(payload, offset, mask | bit(step));
    const level = isGate(instrument) ? INST_VEL_HIGH[instrument] : INST_VEL_LOW[instrument];
    payload[velocityAt] = level | flam;
    return isGate(instrument) ? 'accent' : 'normal';
  }
  if (state === 'normal') {
    payload[velocityAt] = INST_VEL_HIGH[instrument] | flam;
    return 'accent';
  }
  writeMask(payload, offset, mask & ~bit(step));
  return 'off';
}

/** Turn the flam flag on a voice step on or off, returning the new value.
 *
 * Only meaningful on a step that is on, and the machine cannot flam a step
 * that is not playing, so this refuses rather than storing a flag nothing will
 * ever read. */
export function toggleFlam(payload, instrument, step) {
  if (stepState(payload, instrument, step) === 'off') return false;
  const velocityAt = OFF_VELOCITY + instrument * NBR_STEP + step;
  payload[velocityAt] ^= FLAM_BIT;
  return Boolean(payload[velocityAt] & FLAM_BIT);
}

/** Total accent is a mask and nothing else - there is no velocity to set. */
export function cycleAccent(payload, step) {
  const offset = OFF_INST + 2 * TOTAL_ACC;
  const mask = readMask(payload, offset);
  const on = (mask >> step) & 1;
  writeMask(payload, offset, on ? mask & ~bit(step) : mask | bit(step));
  // The record carries a flag saying whether the lane is used at all; keeping
  // it in step with the mask is what makes the lane appear and disappear.
  const next = readMask(payload, offset);
  payload[OFF_SETUP + 7] = next ? 1 : 0;
  return on ? 'off' : 'accent';
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
export function cycleExtStep(payload, track, step) {
  const maskAt = OFF_EXT_TRACK + 2 * track;
  const accentAt = OFF_EXT_ACCENT + 2 * track;
  const mask = readMask(payload, maskAt);
  const stored = readMask(payload, accentAt);
  const state = extState(payload, track, step);

  if (state === 'off') {
    writeMask(payload, maskAt, mask | bit(step));
    writeMask(payload, accentAt, stored | bit(step));   // stored 1 = not accented
    return 'normal';
  }
  if (state === 'normal') {
    writeMask(payload, accentAt, stored & ~bit(step));  // stored 0 = accented
    return 'accent';
  }
  writeMask(payload, maskAt, mask & ~bit(step));
  writeMask(payload, accentAt, stored | bit(step));
  return 'off';
}
