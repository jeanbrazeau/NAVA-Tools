"""The backup / restore / flash loops, independent of how they are driven.

Both front ends call these. Duplicating the retry-and-acknowledge logic in the
TUI would let it drift from the CLI, and the difference would only ever show up
mid-transfer against real hardware.

`progress` is called with (done, total, label) after each item. `should_stop`, if
given, is polled between items so a UI can cancel; it is checked BETWEEN items
rather than mid-item so a cancel can never leave a half-written record on the
device.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from . import midiio, protocol


@dataclass
class Selection:
    """One thing to fetch: the request to send and the dump to expect back."""

    request_cmd: int
    dump_cmd: int
    param: int

    @property
    def label(self) -> str:
        if self.dump_cmd == protocol.NAVA_PTRN_DMP:
            return f"pattern {protocol.pattern_label(self.param)}"
        if self.dump_cmd == protocol.NAVA_TRACK_DMP:
            return f"track {self.param + 1}"
        return "config"


@dataclass
class Outcome:
    collected: bytes
    failures: list[str]

    @property
    def ok(self) -> bool:
        return not self.failures


def selections(patterns=None, tracks=None, config=False) -> list[Selection]:
    out = []
    for number in patterns or []:
        out.append(Selection(protocol.NAVA_PTRN_REQ, protocol.NAVA_PTRN_DMP, number))
    for number in tracks or []:
        out.append(Selection(protocol.NAVA_TRACK_REQ, protocol.NAVA_TRACK_DMP, number))
    if config:
        out.append(Selection(protocol.NAVA_CONFIG_REQ, protocol.NAVA_CONFIG_DMP, 0))
    return out


def backup(
    ports,
    items: list[Selection],
    timeout: float,
    retries: int,
    progress=None,
    should_stop=None,
) -> Outcome:
    """Fetch each item, keeping whatever succeeds.

    A partial result is returned rather than discarded: 120 good patterns are
    worth keeping, and throwing them away because one timed out would be the
    worse failure.
    """
    collected = bytearray()
    failures: list[str] = []

    for index, item in enumerate(items, start=1):
        if should_stop is not None and should_stop():
            failures.append("cancelled")
            break
        try:
            message = midiio.request_dump(
                ports, item.request_cmd, item.param, timeout, retries
            )
            collected += protocol.encode(message.cmd, message.param, message.payload)
        except midiio.MidiError as exc:
            failures.append(f"{item.label}: {exc}")
        if progress is not None:
            progress(index, len(items), item.label)

    return Outcome(collected=bytes(collected), failures=failures)


def restore(
    ports,
    dumps: list[protocol.Message],
    timeout: float,
    retries: int,
    progress=None,
    should_stop=None,
) -> Outcome:
    """Write each dump, waiting for the device to acknowledge the EEPROM write.

    Unlike backup this stops at the first failure. A restore that keeps going
    after an error leaves the device in a state nobody can describe.
    """
    failures: list[str] = []

    for index, message in enumerate(dumps, start=1):
        if should_stop is not None and should_stop():
            failures.append("cancelled")
            break
        label = Selection(0, message.cmd, message.param).label
        raw = protocol.encode(message.cmd, message.param, message.payload)
        try:
            midiio.send_dump(ports, raw, timeout, retries)
        except midiio.MidiError as exc:
            failures.append(f"{label}: {exc}")
            break
        if progress is not None:
            progress(index, len(dumps), label)

    return Outcome(collected=b"", failures=failures)


def flash(
    ports,
    messages: list[bytes],
    delay_ms: float,
    progress=None,
    should_stop=None,
) -> Outcome:
    """Send firmware pages with a fixed inter-message delay.

    The bootloader commits a flash page per message and does not buffer a second
    one while erasing, so pushing faster drops pages and reports nothing either
    way. Cancelling mid-flash leaves the unit with a partial image; the caller is
    expected to have said so before offering the option.
    """
    for index, message in enumerate(messages, start=1):
        if should_stop is not None and should_stop():
            return Outcome(collected=b"", failures=["cancelled mid-flash"])
        ports.send_raw(message)
        if progress is not None:
            progress(index, len(messages), f"page {index}")
        if delay_ms > 0 and index < len(messages):
            time.sleep(delay_ms / 1000.0)
    return Outcome(collected=b"", failures=[])
