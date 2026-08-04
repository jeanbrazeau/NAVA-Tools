"""MIDI port discovery and transport.

mido is imported lazily so that `nava hex2syx`, `nava inspect` and the test
suite work on a machine with no MIDI backend installed - those paths never touch
a port, and requiring python-rtmidi to convert a file would be gratuitous.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from . import protocol


class MidiError(Exception):
    pass


def _mido():
    try:
        import mido  # noqa: PLC0415 - deliberate lazy import, see module docstring
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise MidiError(
            "python MIDI support is missing. Install it with:\n"
            "    pip install mido python-rtmidi"
        ) from exc
    return mido


def list_ports() -> tuple[list[str], list[str]]:
    """(inputs, outputs) as the backend reports them."""
    mido = _mido()
    try:
        return list(mido.get_input_names()), list(mido.get_output_names())
    except Exception as exc:  # pragma: no cover - backend-dependent
        raise MidiError(f"could not enumerate MIDI ports: {exc}") from exc


def resolve(spec: str, names: list[str], direction: str) -> str:
    """Resolve a port spec to exactly one name.

    Accepts an index or a case-insensitive substring. An ambiguous substring is
    an error rather than a silent first-match: interfaces routinely expose
    several similarly named ports and picking the wrong one flashes nothing at
    best, and the wrong device at worst.
    """
    if not names:
        raise MidiError(f"no MIDI {direction} ports found")

    if spec.isdigit():
        index = int(spec)
        if not 0 <= index < len(names):
            raise MidiError(
                f"{direction} port index {index} out of range 0-{len(names) - 1}"
            )
        return names[index]

    exact = [n for n in names if n == spec]
    if exact:
        return exact[0]

    matches = [n for n in names if spec.lower() in n.lower()]
    if not matches:
        listing = "\n".join(f"  {i}: {n}" for i, n in enumerate(names))
        raise MidiError(f"no {direction} port matches {spec!r}. Available:\n{listing}")
    if len(matches) > 1:
        listing = "\n".join(f"  {n}" for n in matches)
        raise MidiError(
            f"{spec!r} matches {len(matches)} {direction} ports; be more specific:\n{listing}"
        )
    return matches[0]


@dataclass
class Ports:
    """Open MIDI ports, closed together on exit."""

    outport: object | None = None
    inport: object | None = None

    def __enter__(self) -> "Ports":
        return self

    def __exit__(self, *exc_info) -> None:
        for port in (self.inport, self.outport):
            if port is not None:
                port.close()

    def send_raw(self, message: bytes) -> None:
        """Send one complete F0..F7 message."""
        mido = _mido()
        if message[0] != 0xF0 or message[-1] != 0xF7:
            raise MidiError("refusing to send a message that is not delimited by F0/F7")
        self.outport.send(mido.Message("sysex", data=message[1:-1]))

    def drain(self) -> None:
        """Discard anything already queued on the input."""
        if self.inport is not None:
            for _ in self.inport.iter_pending():
                pass

    def wait_sysex(self, timeout: float) -> bytes:
        """Wait for one complete SysEx message, returning it with F0/F7 intact.

        Non-SysEx traffic is ignored: a Nava in MASTER sync emits MIDI clock
        continuously, and that must not be mistaken for a reply or for silence.
        """
        if self.inport is None:
            raise MidiError("no input port is open")
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("timed out waiting for a SysEx reply")
            message = self.inport.receive(block=False)
            if message is None:
                time.sleep(0.002)
                continue
            if message.type == "sysex":
                return bytes([0xF0]) + bytes(message.data) + bytes([0xF7])


def open_ports(out_spec: str | None = None, in_spec: str | None = None) -> Ports:
    mido = _mido()
    inputs, outputs = list_ports()
    ports = Ports()
    try:
        if out_spec is not None:
            ports.outport = mido.open_output(resolve(out_spec, outputs, "output"))
        if in_spec is not None:
            ports.inport = mido.open_input(resolve(in_spec, inputs, "input"))
    except Exception:
        ports.__exit__(None, None, None)
        raise
    return ports


def send_stream(
    ports: Ports,
    messages: list[bytes],
    delay_ms: float,
    progress=None,
) -> None:
    """Send messages with a fixed inter-message delay.

    The delay is not politeness. The bootloader commits a flash page per message
    and does not buffer a second one while erasing, so pushing faster drops
    pages silently - the unit reports nothing either way.
    """
    for index, message in enumerate(messages):
        ports.send_raw(message)
        if progress is not None:
            progress(index + 1, len(messages))
        if delay_ms > 0 and index + 1 < len(messages):
            time.sleep(delay_ms / 1000.0)


def request_dump(
    ports: Ports,
    cmd: int,
    param: int,
    timeout: float,
    retries: int,
) -> protocol.Message:
    """Send a request and return the matching dump, retrying on loss.

    A reply for a different item is discarded rather than accepted: a request
    that timed out once may still be in flight, and storing pattern B3 under
    A1's name would corrupt a backup in a way nothing downstream could detect.
    """
    last_error: Exception | None = None
    for _ in range(retries + 1):
        ports.drain()
        ports.send_raw(protocol.request(cmd, param))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                raw = ports.wait_sysex(deadline - time.monotonic())
            except TimeoutError as exc:
                last_error = exc
                break
            try:
                message = protocol.decode(raw)
            except protocol.ProtocolError as exc:
                last_error = exc
                continue
            if message.cmd == protocol.NAVA_ACK and message.param != protocol.ACK_OK:
                raise MidiError(
                    "device refused the request: "
                    + protocol.ACK_MESSAGES.get(message.param, "unknown status")
                )
            if message.param == param and message.cmd in protocol.DUMP_PAYLOAD_SIZES:
                return message
            last_error = MidiError(f"ignored unexpected reply: {message.describe()}")
    raise MidiError(f"no valid reply for {protocol.COMMAND_NAMES.get(cmd, cmd)} "
                    f"param {param}: {last_error}")


def send_dump(
    ports: Ports,
    message: bytes,
    timeout: float,
    retries: int,
) -> None:
    """Send one dump and wait for the device to acknowledge the EEPROM write."""
    last_error: Exception | None = None
    for _ in range(retries + 1):
        ports.drain()
        ports.send_raw(message)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                raw = ports.wait_sysex(deadline - time.monotonic())
            except TimeoutError as exc:
                last_error = exc
                break
            try:
                reply = protocol.decode(raw)
            except protocol.ProtocolError as exc:
                last_error = exc
                continue
            if reply.cmd != protocol.NAVA_ACK:
                continue
            if reply.param == protocol.ACK_OK:
                return
            last_error = MidiError(
                protocol.ACK_MESSAGES.get(reply.param, f"status {reply.param}")
            )
            break
    raise MidiError(f"device did not accept the dump: {last_error}")
