/* Firmware .syx encoding for the Nava bootloader - the browser half of
 * nava/bootloader.py.
 *
 *     F0 7D 08 08 02 7E 00 <nibblized page + checksum> F7
 *     F0 7D 08 08 02 7F 00 F7                            (reset / jump to app)
 *
 * Nibblization rather than 7-in-8 packing is what the bootloader in flash
 * decodes, so it is not a choice this tool can revisit. `7D 08 08 02` differs
 * from the application's `7D 07 1A`, so the two message families cannot be
 * confused for one another.
 */

export const START_OF_SYSEX = 0xf0;
export const END_OF_SYSEX = 0xf7;

export const MANUFACTURER_ID = Uint8Array.of(0x7d, 0x08);
export const DEVICE_ID = 2050;
export const UPDATE_COMMAND = Uint8Array.of(0x7e, 0x00);
export const RESET_COMMAND = Uint8Array.of(0x7f, 0x00);

// Flash page size in *words*; the ATmega1284p writes 128-word (256-byte) pages
// and the bootloader commits exactly one page per message.
export const DEFAULT_PAGE_WORDS = 128;

const PREFIX = Uint8Array.of(START_OF_SYSEX, 0x7d, 0x08, DEVICE_ID >> 8, DEVICE_ID & 0xff);

/** Split each byte into two 7-bit-safe nibbles, high nibble first. */
export function nibblize(data, addChecksum = true) {
  const src = data instanceof Uint8Array ? data : Uint8Array.from(data);
  let sum = 0;
  for (const byte of src) sum += byte;
  const extra = addChecksum ? 1 : 0;
  const out = new Uint8Array((src.length + extra) * 2);
  let w = 0;
  const emit = (byte) => {
    out[w] = byte >> 4;
    out[w + 1] = byte & 0x0f;
    w += 2;
  };
  for (const byte of src) emit(byte);
  if (addChecksum) emit(sum & 0xff);
  return out;
}

/** Inverse of nibblize, verifying the trailing checksum. */
export function denibblize(data, hasChecksum = true) {
  if (data.length % 2) throw new Error('nibble stream has an odd length');
  const out = new Uint8Array(data.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const hi = data[i * 2];
    const lo = data[i * 2 + 1];
    if (hi > 0x0f || lo > 0x0f) throw new Error('nibble out of range; stream is not nibblized');
    out[i] = (hi << 4) | lo;
  }
  if (!hasChecksum) return out;
  if (out.length === 0) throw new Error('nibble stream carries no checksum');
  const payload = out.subarray(0, out.length - 1);
  const want = out[out.length - 1];
  let sum = 0;
  for (const byte of payload) sum += byte;
  sum &= 0xff;
  if (sum !== want) {
    throw new Error(
      `page checksum mismatch: computed 0x${sum.toString(16).toUpperCase()}, ` +
        `stored 0x${want.toString(16).toUpperCase()}`,
    );
  }
  return payload;
}

function message(command, body = new Uint8Array(0)) {
  const out = new Uint8Array(PREFIX.length + command.length + body.length + 1);
  out.set(PREFIX, 0);
  out.set(command, PREFIX.length);
  out.set(body, PREFIX.length + command.length);
  out[out.length - 1] = END_OF_SYSEX;
  // Everything between the delimiters has to be a data byte; F0 and F7
  // themselves are the two that are allowed to have bit 7 set.
  for (let i = 1; i < out.length - 1; i += 1) {
    if (out[i] > 0x7f) throw new Error('message contains a byte with bit 7 set');
  }
  return out;
}

/** Encode a flat flash image as bootloader messages, one per page plus reset.
 *
 * Returned as a list rather than one stream because flashing sends them
 * individually, paced: the bootloader commits a page per message and does not
 * buffer a second while erasing.
 *
 * The final partial page is zero-padded - the bootloader always writes a whole
 * page and would otherwise commit whatever the previous message left in its
 * buffer.
 */
export function firmwareMessages(data, pageWords = DEFAULT_PAGE_WORDS) {
  const src = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const pageSize = pageWords * 2;
  const out = [];
  for (let offset = 0; offset < src.length; offset += pageSize) {
    const page = new Uint8Array(pageSize);
    page.set(src.subarray(offset, offset + pageSize));
    out.push(message(UPDATE_COMMAND, nibblize(page)));
  }
  out.push(message(RESET_COMMAND));
  return out;
}

/** The whole .syx stream, for saving a converted .hex to a file. */
export function encodeFirmware(data, pageWords = DEFAULT_PAGE_WORDS) {
  const messages = firmwareMessages(data, pageWords);
  let total = 0;
  for (const m of messages) total += m.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const m of messages) {
    out.set(m, offset);
    offset += m.length;
  }
  return out;
}

/** Recover the flash image from a bootloader .syx stream. */
export function decodeFirmware(stream, pageWords = DEFAULT_PAGE_WORDS) {
  const data = stream instanceof Uint8Array ? stream : Uint8Array.from(stream);
  const pageSize = pageWords * 2;
  const pages = [];
  let total = 0;
  let i = 0;
  while (i < data.length) {
    const start = data.indexOf(START_OF_SYSEX, i);
    if (start < 0) break;
    const end = data.indexOf(END_OF_SYSEX, start);
    if (end < 0) throw new Error(`unterminated message at offset ${start}`);
    const msg = data.subarray(start, end + 1);
    i = end + 1;

    for (let k = 0; k < PREFIX.length; k += 1) {
      if (msg[k] !== PREFIX[k]) {
        const got = Array.from(msg.subarray(0, 5), (b) =>
          b.toString(16).padStart(2, '0').toUpperCase(),
        ).join(' ');
        throw new Error(`message at offset ${start} is not a bootloader message: ${got}`);
      }
    }
    const command = msg.subarray(5, 7);
    if (command[0] === RESET_COMMAND[0] && command[1] === RESET_COMMAND[1]) continue;
    if (command[0] !== UPDATE_COMMAND[0] || command[1] !== UPDATE_COMMAND[1]) {
      const got = Array.from(command, (b) => b.toString(16).padStart(2, '0').toUpperCase());
      throw new Error(`message at offset ${start} has unknown command ${got.join(' ')}`);
    }
    const page = denibblize(msg.subarray(7, msg.length - 1));
    if (page.length !== pageSize) {
      throw new Error(
        `message at offset ${start} decodes to ${page.length} bytes, ` +
          `expected a ${pageSize}-byte page`,
      );
    }
    pages.push(page);
    total += page.length;
  }
  const image = new Uint8Array(total);
  let offset = 0;
  for (const page of pages) {
    image.set(page, offset);
    offset += page.length;
  }
  return image;
}
