"""Intel HEX reader.

Replaces tools/hexfile (Python 2). Beyond the port this fixes a real limit of
the original: it only ever used the 16-bit address field, so a firmware image
crossing 64KB would silently wrap and overwrite its own start. The ATmega1284p
has 128KB of flash and the bootloader lives at 0x1F000, so records of type 02
(extended segment) and 04 (extended linear) are handled here.
"""

from __future__ import annotations


class HexFileError(Exception):
    pass


def load(text: str) -> bytes:
    """Parse Intel HEX into a flat image, zero-filled across gaps."""
    image = bytearray()
    base = 0
    saw_eof = False

    for lineno, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        if not line.startswith(":"):
            raise HexFileError(f"line {lineno}: record does not start with ':'")
        try:
            raw = bytes.fromhex(line[1:])
        except ValueError as exc:
            raise HexFileError(f"line {lineno}: {exc}") from exc
        if len(raw) < 5:
            raise HexFileError(f"line {lineno}: record too short")
        count, addr_hi, addr_lo, rectype = raw[0], raw[1], raw[2], raw[3]
        if count != len(raw) - 5:
            raise HexFileError(
                f"line {lineno}: byte count {count} disagrees with record length"
            )
        if sum(raw) & 0xFF:
            raise HexFileError(f"line {lineno}: checksum failure")

        data = raw[4:-1]
        address = base + (addr_hi << 8) + addr_lo

        if rectype == 0x00:
            if address + count > len(image):
                image.extend(b"\x00" * (address + count - len(image)))
            image[address : address + count] = data
        elif rectype == 0x01:
            saw_eof = True
            break
        elif rectype == 0x02:
            if count != 2:
                raise HexFileError(f"line {lineno}: bad extended segment record")
            base = int.from_bytes(data, "big") << 4
        elif rectype == 0x04:
            if count != 2:
                raise HexFileError(f"line {lineno}: bad extended linear record")
            base = int.from_bytes(data, "big") << 16
        elif rectype == 0x05:
            pass  # start linear address; nothing to place in the image
        else:
            raise HexFileError(f"line {lineno}: unsupported record type 0x{rectype:02X}")

    if not saw_eof:
        raise HexFileError("no end-of-file record; the .hex is truncated")
    return bytes(image)


def load_file(path) -> bytes:
    with open(path, "r", encoding="ascii") as handle:
        return load(handle.read())
