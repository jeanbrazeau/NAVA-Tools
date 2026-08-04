"""Parsing for the pattern/track selection arguments.

Kept apart from cli.py so the range semantics are unit-testable without going
near argparse or a MIDI port.
"""

from __future__ import annotations

from . import protocol


def parse_patterns(spec: str) -> list[int]:
    """'all', 'A1', 'A1,B3', 'A1-A4', 'A' (a whole bank), or plain numbers."""
    if spec.strip().lower() == "all":
        return list(range(protocol.MAX_PTRN))

    selected: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        # A bare bank letter expands to its 16 patterns - the panel's own unit of
        # organisation, and what someone means by "back up bank C".
        if len(part) == 1 and part.upper().isalpha():
            base = protocol.parse_pattern_label(part.upper() + "1")
            selected.extend(range(base, base + protocol.PTRN_PER_BANK))
            continue
        if "-" in part:
            first, last = part.split("-", 1)
            start = protocol.parse_pattern_label(first)
            end = protocol.parse_pattern_label(last)
            if end < start:
                raise ValueError(f"range {part!r} runs backwards")
            selected.extend(range(start, end + 1))
            continue
        selected.append(protocol.parse_pattern_label(part))

    if not selected:
        raise ValueError("empty pattern selection")
    return _dedupe(selected)


def parse_tracks(spec: str) -> list[int]:
    """'all', '1', '1,3', '1-4'. Tracks are 1-based on the panel, 0-based here."""
    if spec.strip().lower() == "all":
        return list(range(protocol.MAX_TRACK))

    selected: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            first, last = part.split("-", 1)
            start, end = _track_number(first), _track_number(last)
            if end < start:
                raise ValueError(f"range {part!r} runs backwards")
            selected.extend(range(start, end + 1))
            continue
        selected.append(_track_number(part))

    if not selected:
        raise ValueError("empty track selection")
    return _dedupe(selected)


def _track_number(text: str) -> int:
    text = text.strip()
    if not text.isdigit():
        raise ValueError(f"unrecognised track {text!r}: use 1-{protocol.MAX_TRACK}")
    number = int(text)
    if not 1 <= number <= protocol.MAX_TRACK:
        raise ValueError(f"track {number} out of range 1-{protocol.MAX_TRACK}")
    return number - 1


def _dedupe(values: list[int]) -> list[int]:
    """Order-preserving, so a dump follows the order the user asked for."""
    seen = set()
    out = []
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out
