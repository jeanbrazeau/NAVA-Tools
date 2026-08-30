/* Nava SysEx dump/request protocol - the browser half of nava/protocol.py.
 *
 * Frame layout, identical in both directions:
 *
 *     F0 7D 07 1A <cmd> <param> [packed payload] <checksum> F7
 *
 * This is a second implementation of a wire format the firmware defines, so it
 * is pinned to the Python one by tests/fixtures/vectors.json rather than by
 * eye: both sides decode the same committed byte images and must agree.
 */

export const START_OF_SYSEX = 0xf0;
export const END_OF_SYSEX = 0xf7;

export const MANUFACTURER = 0x7d;
export const DEV_ID_1 = 0x07;
export const DEV_ID_2 = 0x1a;
export const HEADER = Uint8Array.of(START_OF_SYSEX, MANUFACTURER, DEV_ID_1, DEV_ID_2);
export const HEADERSIZE = 6;

export const NAVA_BANK_DMP = 0x00;
export const NAVA_PTRN_DMP = 0x01;
export const NAVA_TRACK_DMP = 0x02;
export const NAVA_CONFIG_DMP = 0x03;
export const NAVA_LEVELS_DMP = 0x04;
export const NAVA_FULL_DMP = 0x05;

export const NAVA_BANK_REQ = 0x40;
export const NAVA_PTRN_REQ = 0x41;
export const NAVA_TRACK_REQ = 0x42;
export const NAVA_CONFIG_REQ = 0x43;
export const NAVA_LEVELS_REQ = 0x44;
export const NAVA_FULL_REQ = 0x45;
export const NAVA_FBANK_REQ = 0x46;
export const NAVA_FTRACK_REQ = 0x47;
export const NAVA_ACK = 0x48;

// Verbatim EEPROM record sizes from EEprom.ino.
export const PATTERN_BYTES = 448;
export const TRACK_BYTES = 1024;
export const CONFIG_BYTES = 64;

export const MAX_PTRN = 128;
export const MAX_TRACK = 16;
export const MAX_BANK = 8;
export const PTRN_PER_BANK = 16;

export const ACK_OK = 0;
export const ACK_BAD_CHECKSUM = 1;
export const ACK_BAD_LENGTH = 2;
export const ACK_BAD_PARAM = 3;
export const ACK_BUSY = 4;

export const ACK_MESSAGES = {
  [ACK_OK]: 'ok',
  [ACK_BAD_CHECKSUM]: 'checksum mismatch',
  [ACK_BAD_LENGTH]: 'wrong payload length',
  [ACK_BAD_PARAM]: 'parameter out of range',
  [ACK_BUSY]: 'device busy (sequencer running?)',
};

export const DUMP_PAYLOAD_SIZES = {
  [NAVA_PTRN_DMP]: PATTERN_BYTES,
  [NAVA_TRACK_DMP]: TRACK_BYTES,
  [NAVA_CONFIG_DMP]: CONFIG_BYTES,
};

export const COMMAND_NAMES = {
  [NAVA_BANK_DMP]: 'bank-dump',
  [NAVA_PTRN_DMP]: 'pattern-dump',
  [NAVA_TRACK_DMP]: 'track-dump',
  [NAVA_CONFIG_DMP]: 'config-dump',
  [NAVA_BANK_REQ]: 'bank-request',
  [NAVA_PTRN_REQ]: 'pattern-request',
  [NAVA_TRACK_REQ]: 'track-request',
  [NAVA_CONFIG_REQ]: 'config-request',
  [NAVA_FULL_REQ]: 'full-request',
  [NAVA_ACK]: 'ack',
};

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class NavaMessage {
  constructor(cmd, param, payload) {
    this.cmd = cmd;
    this.param = param;
    this.payload = payload;
  }

  get name() {
    return COMMAND_NAMES[this.cmd] ?? `unknown-0x${this.cmd.toString(16).padStart(2, '0')}`;
  }

  describe() {
    if (this.cmd === NAVA_PTRN_DMP) return `pattern ${patternLabel(this.param)}`;
    if (this.cmd === NAVA_TRACK_DMP) return `track ${this.param + 1}`;
    if (this.cmd === NAVA_CONFIG_DMP) return 'config';
    if (this.cmd === NAVA_ACK) {
      return `ack (${ACK_MESSAGES[this.param] ?? 'unknown status'})`;
    }
    return `${this.name} param=${this.param}`;
  }
}

/** Pattern 0..127 as the panel shows it: bank letter + 1-based slot. */
export function patternLabel(number) {
  const bank = String.fromCharCode(65 + Math.floor(number / PTRN_PER_BANK));
  return `${bank}${(number % PTRN_PER_BANK) + 1}`;
}

/** Inverse of patternLabel. Accepts 'A1'..'H16' and plain '0'..'127'. */
export function parsePatternLabel(label) {
  const text = String(label).trim().toUpperCase();
  let number;
  if (/^\d+$/.test(text)) {
    number = parseInt(text, 10);
  } else if (/^[A-H]\d+$/.test(text)) {
    const slot = parseInt(text.slice(1), 10);
    if (slot < 1 || slot > PTRN_PER_BANK) {
      throw new RangeError(`pattern slot out of range in '${label}': 1-16`);
    }
    number = (text.charCodeAt(0) - 65) * PTRN_PER_BANK + slot - 1;
  } else {
    throw new RangeError(`unrecognised pattern '${label}': use A1-H16 or 0-127`);
  }
  if (number < 0 || number >= MAX_PTRN) {
    throw new RangeError(`pattern out of range in '${label}': 0-127`);
  }
  return number;
}

/** 7-in-8 pack: each group of 7 bytes gains a leading byte of their MSBs. */
export function pack7(raw) {
  const src = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  const out = new Uint8Array(packedSize(src.length));
  let w = 0;
  for (let i = 0; i < src.length; i += 7) {
    const group = src.subarray(i, i + 7);
    let msbs = 0;
    for (let bit = 0; bit < group.length; bit += 1) msbs |= (group[bit] >> 7) << bit;
    out[w] = msbs;
    w += 1;
    for (const byte of group) {
      out[w] = byte & 0x7f;
      w += 1;
    }
  }
  return out;
}

/** Inverse of pack7. Rejects a truncated group rather than guessing. */
export function unpack7(packed) {
  const src = packed instanceof Uint8Array ? packed : Uint8Array.from(packed);
  const out = [];
  for (let i = 0; i < src.length; i += 8) {
    const group = src.subarray(i, i + 8);
    if (group.length < 2) throw new ProtocolError('truncated packed group');
    const msbs = group[0];
    if (msbs > 0x7f) {
      throw new ProtocolError('MSB byte has bit 7 set; not a SysEx data byte');
    }
    for (let bit = 0; bit < group.length - 1; bit += 1) {
      out.push(group[bit + 1] | (((msbs >> bit) & 1) << 7));
    }
  }
  return Uint8Array.from(out);
}

/** Wire size of pack7 output, without building it. */
export function packedSize(rawLength) {
  const full = Math.floor(rawLength / 7);
  const rest = rawLength % 7;
  return full * 8 + (rest ? rest + 1 : 0);
}

export function checksum(raw) {
  let sum = 0;
  for (const byte of raw) sum += byte;
  return sum & 0x7f;
}

/** Build one complete F0..F7 message. */
export function encode(cmd, param = 0, payload = new Uint8Array(0)) {
  if (!(cmd >= 0 && cmd <= 0x7f)) throw new RangeError(`command out of 7-bit range: ${cmd}`);
  if (!(param >= 0 && param <= 0x7f)) throw new RangeError(`param out of 7-bit range: ${param}`);
  const packed = pack7(payload);
  const out = new Uint8Array(HEADER.length + 2 + packed.length + 2);
  out.set(HEADER, 0);
  out[4] = cmd;
  out[5] = param;
  out.set(packed, 6);
  out[6 + packed.length] = checksum(payload);
  out[out.length - 1] = END_OF_SYSEX;
  return out;
}

const hex = (byte) => byte.toString(16).padStart(2, '0').toUpperCase();

/** Parse one complete F0..F7 message, verifying the checksum. */
export function decode(msg) {
  const data = msg instanceof Uint8Array ? msg : Uint8Array.from(msg);
  if (data.length < HEADERSIZE + 2) {
    throw new ProtocolError(`message too short: ${data.length} bytes`);
  }
  if (data[0] !== START_OF_SYSEX || data[data.length - 1] !== END_OF_SYSEX) {
    throw new ProtocolError('message is not delimited by F0/F7');
  }
  for (let i = 0; i < HEADER.length; i += 1) {
    if (data[i] !== HEADER[i]) {
      const got = Array.from(data.subarray(0, 4), hex).join(' ');
      const want = Array.from(HEADER, hex).join(' ');
      throw new ProtocolError(`not a Nava message: header is ${got}, expected ${want}`);
    }
  }

  const cmd = data[4];
  const param = data[5];
  const body = data.subarray(HEADERSIZE, data.length - 1);
  if (body.length === 0) throw new ProtocolError('message has no checksum byte');
  const packed = body.subarray(0, body.length - 1);
  const want = body[body.length - 1];

  const payload = unpack7(packed);
  const expected = DUMP_PAYLOAD_SIZES[cmd];
  // Length before checksum: a short record and a corrupt one both fail the sum,
  // and the length says which.
  if (expected !== undefined && payload.length !== expected) {
    const name = COMMAND_NAMES[cmd] ?? `0x${hex(cmd)}`;
    throw new ProtocolError(
      `${name} payload is ${payload.length} bytes, expected ${expected}`,
    );
  }
  const got = checksum(payload);
  if (got !== want) {
    throw new ProtocolError(
      `checksum mismatch: got 0x${hex(got)}, message says 0x${hex(want)}`,
    );
  }
  return new NavaMessage(cmd, param, payload);
}

/** Split a .syx byte stream into complete F0..F7 messages. */
export function splitMessages(stream) {
  const data = stream instanceof Uint8Array ? stream : Uint8Array.from(stream);
  const messages = [];
  let i = 0;
  for (;;) {
    const start = data.indexOf(START_OF_SYSEX, i);
    if (start < 0) break;
    const end = data.indexOf(END_OF_SYSEX, start);
    if (end < 0) {
      throw new ProtocolError(
        `unterminated SysEx message at offset ${start}: no F7 before end of data`,
      );
    }
    messages.push(data.subarray(start, end + 1));
    i = end + 1;
  }
  return messages;
}

export function request(cmd, param = 0) {
  return encode(cmd, param);
}

/** Concatenate encoded messages into one .syx stream. */
export function joinMessages(messages) {
  let total = 0;
  for (const message of messages) total += message.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const message of messages) {
    out.set(message, offset);
    offset += message.length;
  }
  return out;
}
