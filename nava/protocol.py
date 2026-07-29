"""Nava SysEx dump/request protocol.

Frame layout, identical in both directions:

    F0 7D 07 1A <cmd> <param> [packed payload] <checksum> F7
    |<------ HEADERSIZE 6 ------>|

The manufacturer/device bytes come from the firmware's Sysex.h and are distinct
from the bootloader's `7D 08 08 02` (bootloader.py), so a unit sitting in the
application cannot mistake a firmware page for a pattern dump or vice versa.

Payload bytes are 7-in-8 packed rather than nibblized: SysEx data bytes carry
only 7 bits, so each group of 7 raw bytes is sent as one byte holding their high
bits followed by the 7 stripped bytes. The bootloader's nibblization doubles the
data; this costs 1/7. That matters because a track record is 1KB and has to fit
in one message the firmware can buffer - the MIDI library reassembles a SysEx
message whole before invoking the handler, so the largest record sets the
firmware's RAM cost.

The checksum is over the *raw* bytes, not the packed ones, so a receiver that
mis-unpacks fails the check rather than silently storing garbage.
"""

from __future__ import annotations

from dataclasses import dataclass

START_OF_SYSEX = 0xF0
END_OF_SYSEX = 0xF7

MANUFACTURER = 0x7D
DEV_ID_1 = 0x07
DEV_ID_2 = 0x1A
HEADER = bytes([START_OF_SYSEX, MANUFACTURER, DEV_ID_1, DEV_ID_2])
HEADERSIZE = 6

# Dump commands - carry a payload, sent by either side.
NAVA_BANK_DMP = 0x00
NAVA_PTRN_DMP = 0x01
NAVA_TRACK_DMP = 0x02
NAVA_CONFIG_DMP = 0x03
NAVA_LEVELS_DMP = 0x04
NAVA_FULL_DMP = 0x05

# Request commands - no payload, host to device only.
NAVA_BANK_REQ = 0x40
NAVA_PTRN_REQ = 0x41
NAVA_TRACK_REQ = 0x42
NAVA_CONFIG_REQ = 0x43
NAVA_LEVELS_REQ = 0x44
NAVA_FULL_REQ = 0x45
NAVA_FBANK_REQ = 0x46
NAVA_FTRACK_REQ = 0x47
NAVA_ACK = 0x48

# Record sizes, verbatim EEPROM images. These are the on-device layouts from
# EEprom.ino (PTRN_SIZE, TRACK_SIZE, SETUP_SIZE), dumped without interpretation
# so that a backup round-trips even through firmware revisions that add fields
# in the space those records already reserve as padding.
PATTERN_BYTES = 448
TRACK_BYTES = 1024
CONFIG_BYTES = 64

MAX_PTRN = 128
MAX_TRACK = 16
MAX_BANK = 8
PTRN_PER_BANK = 16

# ACK status codes, mirrored in Midi.ino.
ACK_OK = 0
ACK_BAD_CHECKSUM = 1
ACK_BAD_LENGTH = 2
ACK_BAD_PARAM = 3
ACK_BUSY = 4

ACK_MESSAGES = {
    ACK_OK: "ok",
    ACK_BAD_CHECKSUM: "checksum mismatch",
    ACK_BAD_LENGTH: "wrong payload length",
    ACK_BAD_PARAM: "parameter out of range",
    ACK_BUSY: "device busy (sequencer running?)",
}

DUMP_PAYLOAD_SIZES = {
    NAVA_PTRN_DMP: PATTERN_BYTES,
    NAVA_TRACK_DMP: TRACK_BYTES,
    NAVA_CONFIG_DMP: CONFIG_BYTES,
}

COMMAND_NAMES = {
    NAVA_BANK_DMP: "bank-dump",
    NAVA_PTRN_DMP: "pattern-dump",
    NAVA_TRACK_DMP: "track-dump",
    NAVA_CONFIG_DMP: "config-dump",
    NAVA_BANK_REQ: "bank-request",
    NAVA_PTRN_REQ: "pattern-request",
    NAVA_TRACK_REQ: "track-request",
    NAVA_CONFIG_REQ: "config-request",
    NAVA_FULL_REQ: "full-request",
    NAVA_ACK: "ack",
}


class ProtocolError(Exception):
    """Raised for a malformed or unrecognised Nava SysEx message."""


@dataclass(frozen=True)
class Message:
    cmd: int
    param: int
    payload: bytes  # unpacked raw bytes

    @property
    def name(self) -> str:
        return COMMAND_NAMES.get(self.cmd, f"unknown-0x{self.cmd:02x}")

    def describe(self) -> str:
        if self.cmd == NAVA_PTRN_DMP:
            return f"pattern {pattern_label(self.param)}"
        if self.cmd == NAVA_TRACK_DMP:
            return f"track {self.param + 1}"
        if self.cmd == NAVA_CONFIG_DMP:
            return "config"
        if self.cmd == NAVA_ACK:
            return f"ack ({ACK_MESSAGES.get(self.param, 'unknown status')})"
        return f"{self.name} param={self.param}"


def pattern_label(number: int) -> str:
    """Pattern 0..127 as the panel shows it: bank letter + 1-based slot."""
    return f"{chr(ord('A') + number // PTRN_PER_BANK)}{number % PTRN_PER_BANK + 1}"


def parse_pattern_label(label: str) -> int:
    """Inverse of pattern_label. Accepts 'A1'..'H16' and plain '0'..'127'."""
    label = label.strip().upper()
    if label.isdigit():
        number = int(label)
    elif len(label) >= 2 and "A" <= label[0] <= "H" and label[1:].isdigit():
        slot = int(label[1:])
        if not 1 <= slot <= PTRN_PER_BANK:
            raise ValueError(f"pattern slot out of range in {label!r}: 1-16")
        number = (ord(label[0]) - ord("A")) * PTRN_PER_BANK + slot - 1
    else:
        raise ValueError(f"unrecognised pattern {label!r}: use A1-H16 or 0-127")
    if not 0 <= number < MAX_PTRN:
        raise ValueError(f"pattern out of range in {label!r}: 0-127")
    return number


def pack7(raw: bytes) -> bytes:
    """7-in-8 pack: each group of 7 bytes gains a leading byte of their MSBs."""
    out = bytearray()
    for i in range(0, len(raw), 7):
        group = raw[i : i + 7]
        msbs = 0
        for bit, byte in enumerate(group):
            msbs |= (byte >> 7) << bit
        out.append(msbs)
        out.extend(byte & 0x7F for byte in group)
    return bytes(out)


def unpack7(packed: bytes) -> bytes:
    """Inverse of pack7. Rejects a truncated group rather than guessing."""
    out = bytearray()
    for i in range(0, len(packed), 8):
        group = packed[i : i + 8]
        if len(group) < 2:
            raise ProtocolError("truncated packed group")
        msbs = group[0]
        if msbs > 0x7F:
            raise ProtocolError("MSB byte has bit 7 set; not a SysEx data byte")
        for bit, byte in enumerate(group[1:]):
            out.append(byte | (((msbs >> bit) & 1) << 7))
    return bytes(out)


def packed_size(raw_len: int) -> int:
    """Wire size of pack7 output, without building it."""
    full, rest = divmod(raw_len, 7)
    return full * 8 + (rest + 1 if rest else 0)


def checksum(raw: bytes) -> int:
    return sum(raw) & 0x7F


def encode(cmd: int, param: int = 0, payload: bytes = b"") -> bytes:
    """Build one complete F0..F7 message."""
    if not 0 <= cmd <= 0x7F:
        raise ValueError(f"command out of 7-bit range: {cmd}")
    if not 0 <= param <= 0x7F:
        raise ValueError(f"param out of 7-bit range: {param}")
    return bytes(
        [*HEADER, cmd, param, *pack7(payload), checksum(payload), END_OF_SYSEX]
    )


def decode(msg: bytes) -> Message:
    """Parse one complete F0..F7 message, verifying the checksum."""
    if len(msg) < HEADERSIZE + 2:
        raise ProtocolError(f"message too short: {len(msg)} bytes")
    if msg[0] != START_OF_SYSEX or msg[-1] != END_OF_SYSEX:
        raise ProtocolError("message is not delimited by F0/F7")
    if bytes(msg[:4]) != HEADER:
        raise ProtocolError(
            "not a Nava message: header is "
            + " ".join(f"{b:02X}" for b in msg[:4])
            + f", expected {' '.join(f'{b:02X}' for b in HEADER)}"
        )

    cmd, param = msg[4], msg[5]
    body = msg[HEADERSIZE:-1]
    if not body:
        raise ProtocolError("message has no checksum byte")
    packed, want = bytes(body[:-1]), body[-1]

    payload = unpack7(packed)
    expected_len = DUMP_PAYLOAD_SIZES.get(cmd)
    # Length is checked before the checksum: a short record and a corrupt one
    # both fail the sum, and the length says which.
    if expected_len is not None and len(payload) != expected_len:
        raise ProtocolError(
            f"{COMMAND_NAMES.get(cmd, hex(cmd))} payload is {len(payload)} bytes, "
            f"expected {expected_len}"
        )
    got = checksum(payload)
    if got != want:
        raise ProtocolError(f"checksum mismatch: got 0x{got:02X}, message says 0x{want:02X}")

    return Message(cmd=cmd, param=param, payload=payload)


def split_messages(stream: bytes) -> list[bytes]:
    """Split a .syx byte stream into complete F0..F7 messages.

    Anything outside a message (running-status noise, real-time bytes an
    interface interleaved) is skipped rather than treated as an error, so a file
    captured from a live port is still readable.
    """
    messages = []
    i = 0
    while True:
        start = stream.find(START_OF_SYSEX, i)
        if start < 0:
            break
        end = stream.find(END_OF_SYSEX, start)
        if end < 0:
            raise ProtocolError(
                f"unterminated SysEx message at offset {start}: no F7 before end of data"
            )
        messages.append(stream[start : end + 1])
        i = end + 1
    return messages


def request(cmd: int, param: int = 0) -> bytes:
    return encode(cmd, param)
