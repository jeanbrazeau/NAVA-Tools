/* Reading .syx files as collections of items - the browser half of
 * nava/library.py, minus the directory scan the browser has no access to.
 *
 * Both kinds of .syx are easy to confuse by eye, so classification happens here
 * once: a firmware image is addressed to the bootloader (7D 08), a backup to
 * the application (7D 07 1A). Sending the wrong one is not a recoverable
 * mistake, and it is the only thing standing between a dropped file and a
 * bricked unit.
 */

import * as protocol from './protocol.js';
import * as bootloader from './bootloader.js';
import * as records from './records.js';

export const KIND_BACKUP = 'backup';
export const KIND_FIRMWARE = 'firmware';
export const KIND_UNKNOWN = 'unknown';

export class Item {
  constructor(cmd, param, payload) {
    this.cmd = cmd;
    this.param = param;
    this.payload = payload;
  }

  get label() {
    if (this.cmd === protocol.NAVA_PTRN_DMP) return protocol.patternLabel(this.param);
    if (this.cmd === protocol.NAVA_TRACK_DMP) return `track ${this.param + 1}`;
    return 'config';
  }

  get kind() {
    return (
      {
        [protocol.NAVA_PTRN_DMP]: 'pattern',
        [protocol.NAVA_TRACK_DMP]: 'track',
        [protocol.NAVA_CONFIG_DMP]: 'config',
      }[this.cmd] ?? '?'
    );
  }

  /** The decoded record, or null if this item type has no decoder. */
  decoded() {
    if (this.cmd === protocol.NAVA_PTRN_DMP) return records.decodePattern(this.payload);
    if (this.cmd === protocol.NAVA_TRACK_DMP) return records.decodeTrack(this.payload);
    if (this.cmd === protocol.NAVA_CONFIG_DMP) return records.decodeConfig(this.payload);
    return null;
  }
}

export class SyxFile {
  constructor(name, kind, size) {
    this.name = name;
    this.kind = kind;
    this.size = size;
    this.items = [];
    this.errors = [];
    this.flashBytes = 0;
    this.pages = 0;
    this.bytes = new Uint8Array(0);
  }

  /** The config record if the backup carries one.
   *
   * The ext track note map lives there, and the pattern grid needs it to label
   * ext lanes with note names rather than track numbers. */
  get config() {
    for (const item of this.items) {
      if (item.cmd === protocol.NAVA_CONFIG_DMP) {
        try {
          return records.decodeConfig(item.payload);
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  summary() {
    if (this.kind === KIND_FIRMWARE) {
      return `firmware, ${this.flashBytes} bytes, ${this.pages} pages`;
    }
    if (this.kind === KIND_UNKNOWN) return 'unrecognised';
    const counts = new Map();
    for (const item of this.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    const parts = [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([kind, n]) => `${n} ${kind}` + (n !== 1 && kind !== 'config' ? 's' : ''));
    let text = parts.join(', ') || 'empty';
    if (this.errors.length) text += `  (${this.errors.length} bad)`;
    return text;
  }

  patterns() {
    return this.items.filter((i) => i.cmd === protocol.NAVA_PTRN_DMP);
  }
}

export function classify(stream) {
  if (
    stream.length >= 3 &&
    stream[0] === protocol.START_OF_SYSEX &&
    stream[1] === bootloader.MANUFACTURER_ID[0] &&
    stream[2] === bootloader.MANUFACTURER_ID[1]
  ) {
    return KIND_FIRMWARE;
  }
  if (stream.length >= protocol.HEADER.length) {
    let match = true;
    for (let i = 0; i < protocol.HEADER.length; i += 1) {
      if (stream[i] !== protocol.HEADER[i]) match = false;
    }
    if (match) return KIND_BACKUP;
  }
  return KIND_UNKNOWN;
}

/** Read and classify one .syx. Never throws for content problems - a partly
 *  corrupt backup is still worth listing, with the damage recorded. */
export function load(name, stream) {
  const bytes = stream instanceof Uint8Array ? stream : new Uint8Array(stream);
  const kind = classify(bytes);
  const out = new SyxFile(name, kind, bytes.length);
  out.bytes = bytes;

  if (kind === KIND_FIRMWARE) {
    try {
      out.flashBytes = bootloader.decodeFirmware(bytes).length;
      out.pages = protocol.splitMessages(bytes).length - 1;
    } catch (error) {
      out.kind = KIND_UNKNOWN;
      out.errors.push(String(error.message ?? error));
    }
    return out;
  }

  if (kind === KIND_UNKNOWN) return out;

  let messages;
  try {
    messages = protocol.splitMessages(bytes);
  } catch (error) {
    out.errors.push(String(error.message ?? error));
    return out;
  }

  for (const raw of messages) {
    let message;
    try {
      message = protocol.decode(raw);
    } catch (error) {
      out.errors.push(String(error.message ?? error));
      continue;
    }
    if (protocol.DUMP_PAYLOAD_SIZES[message.cmd] !== undefined) {
      out.items.push(new Item(message.cmd, message.param, message.payload));
    }
  }
  return out;
}
