"""Text rendering of a decoded pattern.

Kept out of the TUI so `nava show` and the browser draw the same grid, and so the
layout can be tested as plain strings rather than through a terminal.

Markers follow how the panel programs a step - a step cycles off -> soft -> loud,
so the grid distinguishes those three and nothing else:

    #  loud (the instrument's high level)
    o  soft (its low level)
    .  off
    f  suffixed to a step that carries the flam flag
"""

from __future__ import annotations

from .records import (
    INSTRUMENT_NAMES,
    NBR_STEP,
    TOTAL_ACC,
    Config,
    Pattern,
    note_name,
)

MARKERS = {"accent": "#", "normal": "o", "off": "."}

# Width of the lane label column: 'T16 C#-1' is the widest thing that goes there.
LABEL_WIDTH = 8


def _ruler(steps: int) -> str:
    """Beat ruler. Marks every fourth step so 16ths are countable at a glance."""
    cells = []
    for i in range(steps):
        cells.append(str(i // 4 + 1) if i % 4 == 0 else "·")
    return " " * LABEL_WIDTH + " ".join(cells)


def _lane(label: str, cells: list[str]) -> str:
    return f"{label:<{LABEL_WIDTH}}" + " ".join(cells)


def pattern_lines(
    pattern: Pattern,
    *,
    config: Config | None = None,
    title: str | None = None,
) -> list[str]:
    """The full grid, as lines. Empty lanes are omitted - a 909 pattern uses a
    handful of voices and printing all 16 would bury them."""
    steps = pattern.steps
    lines: list[str] = []

    if title:
        lines.append(title)
        lines.append("")

    header = (
        f"len {steps}  scale {pattern.scale_name}  "
        f"shuffle {pattern.shuffle}  flam {pattern.flam}"
    )
    if pattern.ext_length != pattern.length:
        header += f"  ext len {pattern.ext_steps}"
    if pattern.group_length:
        header += f"  group {pattern.group_pos + 1}/{pattern.group_length}"
    lines.append(header)
    lines.append("")
    lines.append(_ruler(steps))

    for instrument in pattern.active_voices():
        cells = []
        for i in range(steps):
            step = pattern.step(instrument, i)
            marker = MARKERS[step.level(instrument)]
            cells.append("f" if step.flam and step.on else marker)
        lines.append(_lane(INSTRUMENT_NAMES[instrument], cells))

    if pattern.total_acc:
        cells = [
            MARKERS["accent"] if pattern.inst[TOTAL_ACC] >> i & 1 else MARKERS["off"]
            for i in range(steps)
        ]
        lines.append(_lane("ACC", cells))

    ext_tracks = pattern.active_ext_tracks()
    if ext_tracks:
        lines.append("")
        lines.append(f"ext MIDI  ({pattern.ext_steps} steps)")
        notes = config.ext_notes if config else None
        for track in ext_tracks:
            label = f"T{track + 1}"
            if notes:
                label += f" {note_name(notes[track])}"
            cells = []
            # The ext layer wraps on its own length, so a shorter ext loop repeats
            # against the kit rather than leaving the tail blank.
            for i in range(steps):
                cells.append(MARKERS[pattern.ext_step(track, i % pattern.ext_steps)])
            lines.append(_lane(label, cells))

    if pattern.is_empty():
        lines.append("")
        lines.append("(empty pattern)")

    return lines


def pattern_text(pattern: Pattern, **kwargs) -> str:
    return "\n".join(pattern_lines(pattern, **kwargs))


def legend() -> str:
    return "#  loud    o  soft    .  off    f  flam"


def config_lines(config: Config) -> list[str]:
    lines = [
        f"tempo          {config.bpm} BPM",
        f"sync           {config.sync_name}",
        f"boot mode      {config.boot_mode_name}",
        f"MIDI TX / RX   {config.tx_channel} / {config.rx_channel}",
        f"MIDI ext ch    {config.ext_channel}",
        f"ext velocity   {config.ext_vel_low} soft / {config.ext_vel_high} loud",
        f"pattern change {'SYNC' if config.pattern_change_sync else 'FREE'}",
        f"HH mute mode   {'HH' if config.mute_mode_hh else 'C/O'}",
        "",
        "ext track notes" + ("" if config.ext_notes_stored else "  (defaults, none stored)"),
    ]
    for row in range(0, 16, 4):
        cells = [
            f"T{track + 1:<2} {note_name(config.ext_notes[track]):<4}"
            for track in range(row, row + 4)
        ]
        lines.append("  " + " ".join(cells))
    return lines


def track_lines(track, number: int) -> list[str]:
    used = track.used
    lines = [f"track {number + 1}: {len(used)} pattern(s), stored length {track.length}"]
    if not used:
        lines.append("(empty)")
        return lines
    from .protocol import pattern_label

    for row in range(0, len(used), 8):
        chunk = used[row : row + 8]
        lines.append(
            f"  {row + 1:>4}: " + " ".join(pattern_label(p) for p in chunk)
        )
    return lines


def summarise_pattern(pattern: Pattern) -> str:
    """One line for a table row."""
    if pattern.is_empty():
        return "empty"
    voices = [INSTRUMENT_NAMES[i] for i in pattern.active_voices()]
    ext = len(pattern.active_ext_tracks())
    parts = [f"{pattern.steps}st", pattern.scale_name]
    if voices:
        parts.append(" ".join(voices[:6]) + ("…" if len(voices) > 6 else ""))
    if ext:
        parts.append(f"+{ext} ext")
    return "  ".join(parts)


assert LABEL_WIDTH >= len("T16 C#-1"), "lane labels would be truncated"
assert NBR_STEP == 16
