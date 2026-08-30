/* The backup / restore / flash loops - the browser half of nava/transfer.py.
 *
 * `progress` is called with (done, total, label) after each item. `shouldStop`,
 * if given, is polled between items so the UI can cancel; it is checked BETWEEN
 * items rather than mid-item so a cancel can never leave a half-written record
 * on the device.
 */

import * as protocol from './protocol.js';
import * as midi from './midi.js';

export class Selection {
  constructor(requestCmd, dumpCmd, param) {
    this.requestCmd = requestCmd;
    this.dumpCmd = dumpCmd;
    this.param = param;
  }

  get label() {
    if (this.dumpCmd === protocol.NAVA_PTRN_DMP) {
      return `pattern ${protocol.patternLabel(this.param)}`;
    }
    if (this.dumpCmd === protocol.NAVA_TRACK_DMP) return `track ${this.param + 1}`;
    return 'config';
  }
}

export function selections({ patterns = [], tracks = [], config = false } = {}) {
  const out = [];
  for (const number of patterns) {
    out.push(new Selection(protocol.NAVA_PTRN_REQ, protocol.NAVA_PTRN_DMP, number));
  }
  for (const number of tracks) {
    out.push(new Selection(protocol.NAVA_TRACK_REQ, protocol.NAVA_TRACK_DMP, number));
  }
  if (config) {
    out.push(new Selection(protocol.NAVA_CONFIG_REQ, protocol.NAVA_CONFIG_DMP, 0));
  }
  return out;
}

/** Fetch each item, keeping whatever succeeds.
 *
 * A partial result is returned rather than discarded: 120 good patterns are
 * worth keeping, and throwing them away because one timed out would be the
 * worse failure.
 */
export async function backup(ports, items, timeout, retries, { progress, shouldStop } = {}) {
  const collected = [];
  const failures = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (shouldStop && shouldStop()) {
      failures.push('cancelled');
      break;
    }
    try {
      const message = await midi.requestDump(
        ports,
        item.requestCmd,
        item.param,
        timeout,
        retries,
      );
      collected.push(protocol.encode(message.cmd, message.param, message.payload));
    } catch (error) {
      failures.push(`${item.label}: ${error.message ?? error}`);
    }
    if (progress) progress(index + 1, items.length, item.label);
  }

  return { collected: protocol.joinMessages(collected), failures, ok: !failures.length };
}

/** Write each dump, waiting for the device to acknowledge the EEPROM write.
 *
 * Unlike backup this stops at the first failure. A restore that keeps going
 * after an error leaves the device in a state nobody can describe.
 */
export async function restore(ports, dumps, timeout, retries, { progress, shouldStop } = {}) {
  const failures = [];

  for (let index = 0; index < dumps.length; index += 1) {
    const message = dumps[index];
    if (shouldStop && shouldStop()) {
      failures.push('cancelled');
      break;
    }
    const label = new Selection(0, message.cmd, message.param).label;
    const raw = protocol.encode(message.cmd, message.param, message.payload);
    try {
      await midi.sendDump(ports, raw, timeout, retries);
    } catch (error) {
      failures.push(`${label}: ${error.message ?? error}`);
      break;
    }
    if (progress) progress(index + 1, dumps.length, label);
  }

  return { collected: new Uint8Array(0), failures, ok: !failures.length };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How far ahead of real time pages are handed to the MIDI service. Timestamped
// sends are paced by the browser's MIDI thread rather than by setTimeout, which
// a background tab throttles to once a minute - a tab switch mid-flash would
// otherwise stall the transfer for as long as the user looked away.
const SCHEDULE_WINDOW_MS = 2000;
const SCHEDULE_LEAD_MS = 100;

/** Send firmware pages with a fixed inter-message delay.
 *
 * The delay is not politeness: the bootloader commits a flash page per message
 * and does not buffer a second one while erasing, so pushing faster drops pages
 * and reports nothing either way. Slower is harmless - it waits.
 *
 * Pages go out in scheduled windows rather than all at once so a cancel takes
 * effect within one window without depending on MIDIOutput.clear(), and so the
 * pacing survives the tab losing focus. Cancelling mid-flash leaves the unit
 * with a partial image; the caller is expected to have said so before offering
 * the option.
 */
export async function flash(ports, messages, delayMs, { progress, shouldStop } = {}) {
  const total = messages.length;
  const perWindow = Math.max(1, Math.floor(SCHEDULE_WINDOW_MS / Math.max(delayMs, 1)));
  const start = performance.now() + SCHEDULE_LEAD_MS;
  let scheduled = 0;

  // Pages that have actually reached the wire, not pages handed to the queue:
  // the progress bar is the only thing telling the user how long to keep the
  // unit still, and it must not reach the end two seconds early.
  const delivered = () =>
    Math.max(0, Math.min(total, Math.floor((performance.now() - start) / delayMs) + 1));

  while (scheduled < total || delivered() < total) {
    if (shouldStop && shouldStop()) {
      if (ports.output && typeof ports.output.clear === 'function') ports.output.clear();
      return { collected: new Uint8Array(0), failures: ['cancelled mid-flash'], ok: false };
    }

    if (scheduled < total) {
      const end = Math.min(scheduled + perWindow, total);
      for (let index = scheduled; index < end; index += 1) {
        ports.sendRaw(messages[index], start + index * delayMs);
      }
      scheduled = end;
    }

    // Sleep in slices: the window has to play out before the next is queued, so
    // that a cancel flushes at most one window, but the bar still moves.
    const windowEnd = start + (scheduled - 1) * delayMs;
    while (performance.now() < windowEnd) {
      if (shouldStop && shouldStop()) break;
      if (progress) progress(delivered(), total, `page ${delivered()}`);
      await sleep(Math.min(100, Math.max(1, windowEnd - performance.now())));
    }
    if (progress) progress(delivered(), total, `page ${delivered()}`);
  }

  return { collected: new Uint8Array(0), failures: [], ok: true };
}
