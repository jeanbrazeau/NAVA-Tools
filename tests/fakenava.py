"""An in-memory Nava that speaks the dump protocol.

This is the executable statement of what Midi.ino's SysEx handler must do, and
it lets backup/restore be tested end to end with no hardware. The firmware and
this model are checked against the same protocol module, so a change to the
framing breaks both rather than letting them drift apart silently.
"""

from __future__ import annotations

from nava import midiio, protocol

EEPROM_SIZE = 131072
PTRN_OFFSET = 0
TRACK_OFFSET = protocol.PATTERN_BYTES * protocol.MAX_PTRN
SETUP_OFFSET = TRACK_OFFSET + protocol.TRACK_BYTES * protocol.MAX_TRACK


class FakeNava:
    """Models the device's EEPROM and its request/dump behaviour."""

    def __init__(self, *, running: bool = False):
        self.eeprom = bytearray(EEPROM_SIZE)
        self.running = running  # a running sequencer refuses SysEx work
        self.writes: list[tuple[int, int]] = []  # (cmd, param) actually stored

    # -- EEPROM addressing, mirroring EEprom.ino ---------------------------

    def _span(self, cmd: int, param: int) -> tuple[int, int]:
        if cmd in (protocol.NAVA_PTRN_DMP, protocol.NAVA_PTRN_REQ):
            return PTRN_OFFSET + param * protocol.PATTERN_BYTES, protocol.PATTERN_BYTES
        if cmd in (protocol.NAVA_TRACK_DMP, protocol.NAVA_TRACK_REQ):
            return TRACK_OFFSET + param * protocol.TRACK_BYTES, protocol.TRACK_BYTES
        return SETUP_OFFSET, protocol.CONFIG_BYTES

    def _param_valid(self, cmd: int, param: int) -> bool:
        if cmd in (protocol.NAVA_PTRN_DMP, protocol.NAVA_PTRN_REQ):
            return 0 <= param < protocol.MAX_PTRN
        if cmd in (protocol.NAVA_TRACK_DMP, protocol.NAVA_TRACK_REQ):
            return 0 <= param < protocol.MAX_TRACK
        if cmd == protocol.NAVA_BANK_REQ:
            return 0 <= param < protocol.MAX_BANK
        return param == 0

    def seed_pattern(self, number: int, data: bytes) -> None:
        assert len(data) == protocol.PATTERN_BYTES
        start = PTRN_OFFSET + number * protocol.PATTERN_BYTES
        self.eeprom[start : start + len(data)] = data

    def read_pattern(self, number: int) -> bytes:
        start = PTRN_OFFSET + number * protocol.PATTERN_BYTES
        return bytes(self.eeprom[start : start + protocol.PATTERN_BYTES])

    # -- protocol ----------------------------------------------------------

    def handle(self, raw: bytes) -> list[bytes]:
        """Process one incoming message, returning whatever it replies with."""
        try:
            message = protocol.decode(raw)
        except protocol.ProtocolError as exc:
            status = (
                protocol.ACK_BAD_LENGTH
                if "expected" in str(exc)
                else protocol.ACK_BAD_CHECKSUM
            )
            return [protocol.encode(protocol.NAVA_ACK, status)]

        if self.running:
            return [protocol.encode(protocol.NAVA_ACK, protocol.ACK_BUSY)]

        if not self._param_valid(message.cmd, message.param):
            return [protocol.encode(protocol.NAVA_ACK, protocol.ACK_BAD_PARAM)]

        if message.cmd in protocol.DUMP_PAYLOAD_SIZES:
            start, size = self._span(message.cmd, message.param)
            self.eeprom[start : start + size] = message.payload
            self.writes.append((message.cmd, message.param))
            return [protocol.encode(protocol.NAVA_ACK, protocol.ACK_OK)]

        if message.cmd == protocol.NAVA_PTRN_REQ:
            return [self._dump(protocol.NAVA_PTRN_DMP, message.param)]
        if message.cmd == protocol.NAVA_TRACK_REQ:
            return [self._dump(protocol.NAVA_TRACK_DMP, message.param)]
        if message.cmd == protocol.NAVA_CONFIG_REQ:
            return [self._dump(protocol.NAVA_CONFIG_DMP, 0)]
        if message.cmd == protocol.NAVA_BANK_REQ:
            base = message.param * protocol.PTRN_PER_BANK
            return [
                self._dump(protocol.NAVA_PTRN_DMP, base + i)
                for i in range(protocol.PTRN_PER_BANK)
            ]
        if message.cmd == protocol.NAVA_FULL_REQ:
            out = [self._dump(protocol.NAVA_PTRN_DMP, i) for i in range(protocol.MAX_PTRN)]
            out += [self._dump(protocol.NAVA_TRACK_DMP, i) for i in range(protocol.MAX_TRACK)]
            out.append(self._dump(protocol.NAVA_CONFIG_DMP, 0))
            return out

        return [protocol.encode(protocol.NAVA_ACK, protocol.ACK_BAD_PARAM)]

    def _dump(self, cmd: int, param: int) -> bytes:
        start, size = self._span(cmd, param)
        return protocol.encode(cmd, param, bytes(self.eeprom[start : start + size]))


class FakePorts(midiio.Ports):
    """A Ports whose wire is a FakeNava, plus fault injection for the retry paths."""

    def __init__(self, device: FakeNava, *, drop_first: int = 0, corrupt_first: int = 0):
        super().__init__()
        self.device = device
        self.queue: list[bytes] = []
        self.drop_first = drop_first
        self.corrupt_first = corrupt_first
        self.sent = 0

    def send_raw(self, message: bytes) -> None:
        assert message[0] == 0xF0 and message[-1] == 0xF7
        self.sent += 1
        replies = self.device.handle(message)
        if self.drop_first > 0:
            self.drop_first -= 1
            return
        if self.corrupt_first > 0 and replies:
            self.corrupt_first -= 1
            broken = bytearray(replies[0])
            broken[8] ^= 0x01  # flip a payload bit; the checksum must catch it
            replies = [bytes(broken)] + replies[1:]
        self.queue.extend(replies)

    def drain(self) -> None:
        self.queue.clear()

    def wait_sysex(self, timeout: float) -> bytes:
        if not self.queue:
            raise TimeoutError("no reply queued")
        return self.queue.pop(0)

    def __exit__(self, *exc_info) -> None:
        return None
