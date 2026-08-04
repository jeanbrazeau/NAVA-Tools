"""Reading .syx files as collections of items.

Both kinds of .syx this tool deals with live side by side in a directory and are
easy to confuse by eye, so classification happens here once: a firmware image is
addressed to the bootloader (7D 08), a backup to the application (7D 07 1A).
Sending the wrong one is not a recoverable mistake.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from . import bootloader, protocol, records

KIND_BACKUP = "backup"
KIND_FIRMWARE = "firmware"
KIND_UNKNOWN = "unknown"

SYX_SUFFIXES = (".syx", ".SYX")


@dataclass
class Item:
    """One dump message from a backup file."""

    cmd: int
    param: int
    payload: bytes

    @property
    def label(self) -> str:
        if self.cmd == protocol.NAVA_PTRN_DMP:
            return protocol.pattern_label(self.param)
        if self.cmd == protocol.NAVA_TRACK_DMP:
            return f"track {self.param + 1}"
        return "config"

    @property
    def kind(self) -> str:
        return {
            protocol.NAVA_PTRN_DMP: "pattern",
            protocol.NAVA_TRACK_DMP: "track",
            protocol.NAVA_CONFIG_DMP: "config",
        }.get(self.cmd, "?")

    def decoded(self):
        """The decoded record, or None if this item type has no decoder."""
        if self.cmd == protocol.NAVA_PTRN_DMP:
            return records.decode_pattern(self.payload)
        if self.cmd == protocol.NAVA_TRACK_DMP:
            return records.decode_track(self.payload)
        if self.cmd == protocol.NAVA_CONFIG_DMP:
            return records.decode_config(self.payload)
        return None


@dataclass
class SyxFile:
    path: str
    kind: str
    size: int
    items: list[Item] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    flash_bytes: int = 0
    pages: int = 0

    @property
    def name(self) -> str:
        return os.path.basename(self.path)

    @property
    def config(self):
        """The config record if the backup carries one.

        The ext track note map lives there, and the pattern grid needs it to
        label ext lanes with note names rather than track numbers.
        """
        for item in self.items:
            if item.cmd == protocol.NAVA_CONFIG_DMP:
                try:
                    return records.decode_config(item.payload)
                except records.RecordError:
                    return None
        return None

    def summary(self) -> str:
        if self.kind == KIND_FIRMWARE:
            return f"firmware, {self.flash_bytes} bytes, {self.pages} pages"
        if self.kind == KIND_UNKNOWN:
            return "unrecognised"
        counts = {}
        for item in self.items:
            counts[item.kind] = counts.get(item.kind, 0) + 1
        parts = [f"{n} {k}" + ("s" if n != 1 and k != "config" else "")
                 for k, n in sorted(counts.items())]
        text = ", ".join(parts) or "empty"
        if self.errors:
            text += f"  ({len(self.errors)} bad)"
        return text

    def patterns(self) -> list[Item]:
        return [i for i in self.items if i.cmd == protocol.NAVA_PTRN_DMP]


def classify(stream: bytes) -> str:
    if stream.startswith(bytes([protocol.START_OF_SYSEX, bootloader.MANUFACTURER_ID[0],
                                bootloader.MANUFACTURER_ID[1]])):
        return KIND_FIRMWARE
    if stream.startswith(protocol.HEADER):
        return KIND_BACKUP
    return KIND_UNKNOWN


def load(path: str) -> SyxFile:
    """Read and classify one .syx. Never raises for content problems - a partly
    corrupt backup is still worth listing, with the damage recorded."""
    with open(path, "rb") as handle:
        stream = handle.read()

    kind = classify(stream)
    out = SyxFile(path=path, kind=kind, size=len(stream))

    if kind == KIND_FIRMWARE:
        try:
            image = bootloader.decode_firmware(stream)
            out.flash_bytes = len(image)
            out.pages = len(protocol.split_messages(stream)) - 1
        except (ValueError, protocol.ProtocolError) as exc:
            out.kind = KIND_UNKNOWN
            out.errors.append(str(exc))
        return out

    if kind == KIND_UNKNOWN:
        return out

    try:
        messages = protocol.split_messages(stream)
    except protocol.ProtocolError as exc:
        out.errors.append(str(exc))
        return out

    for raw in messages:
        try:
            message = protocol.decode(raw)
        except protocol.ProtocolError as exc:
            out.errors.append(str(exc))
            continue
        if message.cmd in protocol.DUMP_PAYLOAD_SIZES:
            out.items.append(Item(message.cmd, message.param, message.payload))
    return out


def scan(directory: str) -> list[SyxFile]:
    """Every .syx in a directory, newest first - a fresh backup is what someone
    is usually looking for."""
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    paths = [
        os.path.join(directory, n) for n in names if n.endswith(SYX_SUFFIXES)
    ]
    paths.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    out = []
    for path in paths:
        try:
            out.append(load(path))
        except OSError:
            continue
    return out
