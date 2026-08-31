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

// How far ahead of real time a page's timestamp may sit when it is handed to
// the MIDI service. Small on purpose - see the pacing note below.
const SCHEDULE_LEAD_MS = 20;

/** Send firmware pages with a fixed inter-message delay.
 *
 * The delay is not politeness: the bootloader commits a flash page per message
 * and does not buffer a second one while erasing, so pushing faster drops pages
 * and reports nothing either way. Slower is harmless - it waits.
 *
 * The pacing is enforced HERE, in real time, one message per turn of the loop -
 * not by queuing a window of timestamped sends and trusting the MIDI stack to
 * space them. That trust failed on hardware: the same image over the same
 * dongle flashed from the CLI, which sleeps between sends, and did nothing from
 * this path, which handed the service 2s of pages at a time. Every layer
 * between send() and the DIN jack - the browser's scheduler, the OS MIDI
 * service, the dongle's own buffer re-serialising onto a 3125-byte/s wire - has
 * to honour the spacing for a queued window to arrive intact, and at least one
 * of them did not. Each send still carries its due time as a timestamp, so a
 * stack that does schedule places the page precisely; one that sends
 * immediately is only SCHEDULE_LEAD_MS early, never bursty.
 *
 * The cost is that a background tab's setTimeout throttling now slows the
 * transfer instead of being ridden out by a pre-queued window. That trade is
 * right: the bootloader sits waiting between pages, so a late page is a pause,
 * while a burst is a corrupted transfer with no symptom until the unit fails to
 * restart. Cancelling mid-flash leaves the unit with a partial image; the
 * caller is expected to have said so before offering the option.
 */
export async function flash(ports, messages, delayMs, { progress, shouldStop } = {}) {
  const total = messages.length;
  const start = performance.now() + SCHEDULE_LEAD_MS;

  for (let index = 0; index < total; index += 1) {
    const due = start + index * delayMs;
    // Wait in slices so a cancel lands between pages and the bar still moves.
    while (performance.now() < due - SCHEDULE_LEAD_MS) {
      if (shouldStop && shouldStop()) break;
      if (progress) progress(index, total, `page ${index}`);
      await sleep(Math.min(100, Math.max(1, due - SCHEDULE_LEAD_MS - performance.now())));
    }
    if (shouldStop && shouldStop()) {
      if (ports.output && typeof ports.output.clear === 'function') ports.output.clear();
      return { collected: new Uint8Array(0), failures: ['cancelled mid-flash'], ok: false };
    }
    ports.sendRaw(messages[index], due);
    if (progress) progress(index + 1, total, `page ${index + 1}`);
  }

  return { collected: new Uint8Array(0), failures: [], ok: true };
}
