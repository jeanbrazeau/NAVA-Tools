/* Web MIDI transport - what nava/midiio.py is to the CLI.
 *
 * The whole reason this tool can be a web page: navigator.requestMIDIAccess
 * with `sysex: true` gives a page raw SysEx in both directions. That permission
 * is granted per origin and is the one thing a visitor has to agree to; without
 * it the API still resolves, but every SysEx send throws.
 *
 * Ports are remembered by NAME rather than by id or index. Web MIDI ids are
 * stable per browser profile but say nothing to a human, and an index moves
 * whenever a USB device is added or removed - a remembered index would silently
 * point at a different device.
 */

import * as protocol from './protocol.js';

export class MidiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MidiError';
  }
}

export function isSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

/** Ask for SysEx-capable MIDI access, translating the two ways it can fail.
 *
 * A denied permission and an unimplemented API are different problems with
 * different fixes, and the raw DOMException says neither clearly. */
export async function requestAccess() {
  if (!isSupported()) {
    throw new MidiError(
      'This browser has no Web MIDI. Any Chromium-based browser - Chrome, Edge, ' +
        'Opera, Brave, Arc, Helium, Vivaldi - can talk to the unit; Safari and ' +
        'Firefox cannot.',
    );
  }
  try {
    return await navigator.requestMIDIAccess({ sysex: true });
  } catch (error) {
    if (error && error.name === 'SecurityError') {
      throw new MidiError(
        'MIDI access was refused. Allow MIDI for this site (the lock icon in ' +
          'the address bar) and reload.',
      );
    }
    throw new MidiError(`could not get MIDI access: ${error.message ?? error}`);
  }
}

export function listPorts(access) {
  return {
    inputs: [...access.inputs.values()],
    outputs: [...access.outputs.values()],
  };
}

const REALTIME_FLOOR = 0xf8;

/** One open input/output pair, with the input reassembled into whole messages.
 *
 * Chrome delivers a SysEx message in a single event today, but the reassembly
 * costs nothing and covers the case it does not: a 1KB track dump is ~1180
 * bytes on the wire, comfortably past any driver's buffer. Real-time bytes
 * (0xF8 clock and friends) are dropped wherever they appear, including in the
 * middle of a SysEx - a Nava in MASTER sync emits clock continuously and an
 * interface is free to interleave it.
 */
export class Ports {
  constructor(input, output) {
    this.input = input ?? null;
    this.output = output ?? null;
    this.queue = [];
    this.waiters = [];
    this.building = null;

    if (this.input) {
      this.input.onmidimessage = (event) => this.receive(event.data);
    }
  }

  close() {
    if (this.input) this.input.onmidimessage = null;
    this.input = null;
    this.output = null;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new MidiError('port closed'));
    }
  }

  receive(data) {
    for (const byte of data) {
      if (byte >= REALTIME_FLOOR && byte !== protocol.END_OF_SYSEX) continue;
      if (byte === protocol.START_OF_SYSEX) {
        this.building = [byte];
        continue;
      }
      if (this.building === null) continue;
      this.building.push(byte);
      if (byte === protocol.END_OF_SYSEX) {
        const message = Uint8Array.from(this.building);
        this.building = null;
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else {
          this.queue.push(message);
        }
      }
    }
  }

  /** Discard anything already queued on the input. */
  drain() {
    this.queue.length = 0;
    this.building = null;
  }

  /** Send one complete F0..F7 message, optionally at a scheduled time. */
  sendRaw(message, timestamp) {
    if (!this.output) throw new MidiError('no output port is open');
    if (message[0] !== 0xf0 || message[message.length - 1] !== 0xf7) {
      throw new MidiError('refusing to send a message that is not delimited by F0/F7');
    }
    try {
      this.output.send(message, timestamp);
    } catch (error) {
      // InvalidAccessError here means the page holds MIDI access without the
      // sysex permission, which is the only interesting way send() fails.
      throw new MidiError(
        `the browser refused to send SysEx: ${error.message ?? error}. ` +
          'Allow MIDI for this site and reload.',
      );
    }
  }

  /** Wait for one complete SysEx message, F0/F7 intact. */
  waitSysex(timeout) {
    if (!this.input) return Promise.reject(new MidiError('no input port is open'));
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new MidiError('timed out waiting for a SysEx reply'));
      }, timeout);
      this.waiters.push(waiter);
    });
  }
}

/** Send a request and return the matching dump, retrying on loss.
 *
 * A reply for a different item is discarded rather than accepted: a request
 * that timed out once may still be in flight, and storing pattern B3 under A1's
 * name would corrupt a backup in a way nothing downstream could detect.
 */
export async function requestDump(ports, cmd, param, timeout, retries) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    ports.drain();
    ports.sendRaw(protocol.request(cmd, param));
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      let raw;
      try {
        raw = await ports.waitSysex(deadline - performance.now());
      } catch (error) {
        lastError = error;
        break;
      }
      let message;
      try {
        message = protocol.decode(raw);
      } catch (error) {
        lastError = error;
        continue;
      }
      if (message.cmd === protocol.NAVA_ACK && message.param !== protocol.ACK_OK) {
        throw new MidiError(
          'device refused the request: ' +
            (protocol.ACK_MESSAGES[message.param] ?? 'unknown status'),
        );
      }
      if (message.param === param && protocol.DUMP_PAYLOAD_SIZES[message.cmd] !== undefined) {
        return message;
      }
      lastError = new MidiError(`ignored unexpected reply: ${message.describe()}`);
    }
  }
  const name = protocol.COMMAND_NAMES[cmd] ?? cmd;
  throw new MidiError(`no valid reply for ${name} param ${param}: ${lastError?.message ?? lastError}`);
}

/** Send one dump and wait for the device to acknowledge the EEPROM write. */
export async function sendDump(ports, message, timeout, retries) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    ports.drain();
    ports.sendRaw(message);
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      let raw;
      try {
        raw = await ports.waitSysex(deadline - performance.now());
      } catch (error) {
        lastError = error;
        break;
      }
      let reply;
      try {
        reply = protocol.decode(raw);
      } catch (error) {
        lastError = error;
        continue;
      }
      if (reply.cmd !== protocol.NAVA_ACK) continue;
      if (reply.param === protocol.ACK_OK) return;
      lastError = new MidiError(
        protocol.ACK_MESSAGES[reply.param] ?? `status ${reply.param}`,
      );
      break;
    }
  }
  throw new MidiError(`device did not accept the dump: ${lastError?.message ?? lastError}`);
}
