"""Firmware .syx encoding for the Nava bootloader.

Byte-compatible with tools/hex2sysex/hex2sysex.py (Python 2), which is what
every released Nava image was built with. Verified against the shipped
Nava0tone_0.90b.syx in tests/test_bootloader.py rather than against the old
script, since that script cannot run on a current interpreter.

Wire format, one message per flash page:

    F0 7D 08 08 02 7E 00 <nibblized page + checksum> F7

and a final reset message that makes the bootloader jump to the application:

    F0 7D 08 08 02 7F 00 F7

The bootloader here is not the Nava's own product code: `7D` is the
non-commercial manufacturer ID and `08 02` is device 2050, inherited from the
Mutable Instruments loader this was derived from. It differs from the
application's `7D 07 1A` (protocol.py), so the two message families cannot be
confused.

Nibblization (high nibble first) rather than 7-in-8 packing is what the
bootloader in flash decodes, so it is not a choice this tool can revisit.
"""

from __future__ import annotations

START_OF_SYSEX = 0xF0
END_OF_SYSEX = 0xF7

MANUFACTURER_ID = bytes([0x7D, 0x08])
DEVICE_ID = 2050
UPDATE_COMMAND = bytes([0x7E, 0x00])
RESET_COMMAND = bytes([0x7F, 0x00])

# Flash page size in *words*; the ATmega1284p writes 128-word (256-byte) pages
# and the bootloader commits exactly one page per message.
DEFAULT_PAGE_WORDS = 128


def nibblize(data: bytes, add_checksum: bool = True) -> bytes:
    """Split each byte into two 7-bit-safe nibbles, high nibble first."""
    body = bytes(data)
    if add_checksum:
        body += bytes([sum(body) & 0xFF])
    out = bytearray()
    for byte in body:
        out.append(byte >> 4)
        out.append(byte & 0x0F)
    return bytes(out)


def denibblize(data: bytes, has_checksum: bool = True) -> bytes:
    """Inverse of nibblize, verifying the trailing checksum."""
    if len(data) % 2:
        raise ValueError("nibble stream has an odd length")
    out = bytearray()
    for hi, lo in zip(data[0::2], data[1::2]):
        if hi > 0x0F or lo > 0x0F:
            raise ValueError("nibble out of range; stream is not nibblized")
        out.append((hi << 4) | lo)
    if not has_checksum:
        return bytes(out)
    if not out:
        raise ValueError("nibble stream carries no checksum")
    payload, want = bytes(out[:-1]), out[-1]
    if (sum(payload) & 0xFF) != want:
        raise ValueError(f"page checksum mismatch: computed 0x{sum(payload) & 0xFF:02X}, stored 0x{want:02X}")
    return payload


def _message(command: bytes, body: bytes = b"") -> bytes:
    device = DEVICE_ID.to_bytes(2, "big")
    message = bytes([START_OF_SYSEX]) + MANUFACTURER_ID + device + command + body
    if any(b > 0x7F for b in message[1:]):
        raise ValueError("message contains a byte with bit 7 set")
    return message + bytes([END_OF_SYSEX])


def encode_firmware(data: bytes, page_words: int = DEFAULT_PAGE_WORDS) -> bytes:
    """Encode a flat flash image as a complete bootloader .syx stream.

    The final partial page is zero-padded: the bootloader always writes a whole
    page and would otherwise commit whatever the previous message left in its
    buffer.
    """
    page_size = page_words * 2
    out = bytearray()
    for offset in range(0, len(data), page_size):
        page = data[offset : offset + page_size]
        page += b"\x00" * (page_size - len(page))
        out += _message(UPDATE_COMMAND, nibblize(page))
    out += _message(RESET_COMMAND)
    return bytes(out)


def decode_firmware(stream: bytes, page_words: int = DEFAULT_PAGE_WORDS) -> bytes:
    """Recover the flash image from a bootloader .syx stream.

    Used by `nava verify` and by the round-trip test; also the only way to
    inspect a released .syx when the matching .hex is not at hand.
    """
    prefix = bytes([START_OF_SYSEX]) + MANUFACTURER_ID + DEVICE_ID.to_bytes(2, "big")
    page_size = page_words * 2
    image = bytearray()
    i = 0
    while i < len(stream):
        start = stream.find(START_OF_SYSEX, i)
        if start < 0:
            break
        end = stream.find(END_OF_SYSEX, start)
        if end < 0:
            raise ValueError(f"unterminated message at offset {start}")
        message = stream[start : end + 1]
        i = end + 1

        if not message.startswith(prefix):
            raise ValueError(
                f"message at offset {start} is not a bootloader message: "
                + " ".join(f"{b:02X}" for b in message[:5])
            )
        command = message[5:7]
        if command == RESET_COMMAND:
            continue
        if command != UPDATE_COMMAND:
            raise ValueError(
                f"message at offset {start} has unknown command "
                f"{command[0]:02X} {command[1]:02X}"
            )
        page = denibblize(message[7:-1])
        if len(page) != page_size:
            raise ValueError(
                f"message at offset {start} decodes to {len(page)} bytes, "
                f"expected a {page_size}-byte page"
            )
        image += page
    return bytes(image)
