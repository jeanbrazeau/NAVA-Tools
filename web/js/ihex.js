/* Intel HEX reader - the browser half of nava/ihex.py.
 *
 * Records of type 02 (extended segment) and 04 (extended linear) are handled:
 * the ATmega1284p has 128KB of flash and the bootloader lives at 0x1F000, so an
 * implementation that only ever read the 16-bit address field would wrap an
 * image past 64KB back over its own start.
 */

export class HexFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HexFileError';
  }
}

/** Parse Intel HEX into a flat image, zero-filled across gaps. */
export function load(text) {
  let image = new Uint8Array(0);
  let base = 0;
  let sawEof = false;

  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineno = index + 1;
    const line = lines[index].trim();
    if (!line) continue;
    if (!line.startsWith(':')) {
      throw new HexFileError(`line ${lineno}: record does not start with ':'`);
    }
    const body = line.slice(1);
    if (body.length % 2 || /[^0-9a-fA-F]/.test(body)) {
      throw new HexFileError(`line ${lineno}: non-hexadecimal digit found`);
    }
    const raw = new Uint8Array(body.length / 2);
    for (let i = 0; i < raw.length; i += 1) {
      raw[i] = parseInt(body.substr(i * 2, 2), 16);
    }
    if (raw.length < 5) throw new HexFileError(`line ${lineno}: record too short`);

    const count = raw[0];
    const rectype = raw[3];
    if (count !== raw.length - 5) {
      throw new HexFileError(
        `line ${lineno}: byte count ${count} disagrees with record length`,
      );
    }
    let sum = 0;
    for (const byte of raw) sum += byte;
    if (sum & 0xff) throw new HexFileError(`line ${lineno}: checksum failure`);

    const data = raw.subarray(4, raw.length - 1);
    const address = base + (raw[1] << 8) + raw[2];

    if (rectype === 0x00) {
      if (address + count > image.length) {
        const grown = new Uint8Array(address + count);
        grown.set(image);
        image = grown;
      }
      image.set(data, address);
    } else if (rectype === 0x01) {
      sawEof = true;
      break;
    } else if (rectype === 0x02) {
      if (count !== 2) throw new HexFileError(`line ${lineno}: bad extended segment record`);
      base = ((data[0] << 8) | data[1]) << 4;
    } else if (rectype === 0x04) {
      if (count !== 2) throw new HexFileError(`line ${lineno}: bad extended linear record`);
      base = ((data[0] << 8) | data[1]) * 0x10000;
    } else if (rectype === 0x05) {
      // Start linear address; nothing to place in the image.
    } else {
      throw new HexFileError(
        `line ${lineno}: unsupported record type 0x${rectype.toString(16).toUpperCase()}`,
      );
    }
  }

  if (!sawEof) throw new HexFileError('no end-of-file record; the .hex is truncated');
  return image;
}
