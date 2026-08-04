"""Decoding of the EEPROM records a dump carries.

The transfer path treats records as opaque bytes on purpose - that is what lets a
backup survive firmware revisions that add fields inside the padding. This module
is the other half: it interprets them so a backup can be read without the
hardware, and it is the only place in the tool that knows the layout.

Everything here is derived from EEprom.ino's LoadPattern/LoadTempPattern, which
is authoritative over SavePattern - the reader is what the firmware actually
believes. Offsets come from that file's own constants:

    0..31    inst[16], one 16-bit little-endian step mask per instrument
    32..63   length, scale, shuffle, flam, extLength+1, groupPos, groupLength,
             totalAcc, then 24 reserved bytes
    64..95   extTrack[16], one 16-bit step mask per ext MIDI track
    96..127  extAccent[16], INVERTED (see below)
    128..191 a second page the firmware writes as zeros and skips on read
    192..447 velocity[16][16], one byte per instrument per step

`extAccent` is stored inverted because a pattern written before ext steps had two
velocity levels has zeros there, and those patterns played at the HIGH level -
the only one the ext lane had. Reading the complement decodes them as accented,
which is what they sounded like.

`extLength` is biased by one so that 0 still means "written before this existed",
because an ext length of 0 is itself legal (a one-step loop).
"""

from __future__ import annotations

from dataclasses import dataclass

from . import protocol

NBR_INST = 16
NBR_STEP = 16
NBR_EXT_TRACK = 16

# Offsets within the 448-byte pattern record.
OFF_INST = 0
OFF_SETUP = 32
OFF_EXT_TRACK = 64
OFF_EXT_ACCENT = 96
OFF_VELOCITY = 192

END_OF_TRACK = 128

# Instrument index -> panel label, from nameInst[] in nava_strings.h. Indices 1
# and 5 drive no voice of their own (HH_SLCT and the HH select line), and 0 is the
# trigger output, so they are unnamed on the panel too.
INSTRUMENT_NAMES = [
    "TRG", "", "HT", "RIM", "HCL", "", "RID", "CRH",
    "BD", "SD", "LT", "MT", "ACC", "EXT", "CH", "OH",
]

# The instruments worth showing as a lane, in the order a 909 panel reads.
# ACC (TOTAL_ACC) and EXT are shown separately: one accents the whole machine and
# the other is the MIDI layer, so neither is a drum voice.
VOICE_ORDER = [8, 9, 10, 11, 2, 3, 4, 14, 15, 7, 6]

TOTAL_ACC = 12
EXT_INST = 13

# instVelHigh/instVelLow from define.h - the two levels a step cycles through.
# They are per instrument and deliberately not uniform; the table matches the
# original TR-909.
INST_VEL_HIGH = [1, 1, 50, 50, 50, 108, 112, 107, 50, 50, 50, 50, 1, 50, 111, 109]
INST_VEL_LOW = [0, 0, 25, 25, 25, 50, 111, 106, 25, 25, 25, 25, 0, 25, 80, 108]

# PPQN ticks per step -> the division the panel shows.
SCALE_NAMES = {24: "1/16", 12: "1/32", 16: "1/16t", 32: "1/8t"}

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Power-on ext track notes, EXT_TRACK_NOTES[] in define.h. Used when a backup
# carries no config record to say otherwise.
DEFAULT_EXT_NOTES = list(range(48, 64))

EXT_NOTES_OFFSET = 32  # within the 64-byte setup record
EXT_NOTES_SIG = 0x4E


class RecordError(Exception):
    pass


def note_name(note: int) -> str:
    """MIDI number as a name under the 60 = C4 convention the LCD uses."""
    return f"{NOTE_NAMES[note % 12]}{note // 12 - 1}"


@dataclass(frozen=True)
class Step:
    on: bool
    velocity: int  # 0-127, the flam flag stripped
    flam: bool

    def level(self, instrument: int) -> str:
        """'accent', 'normal' or 'off', by comparison with this instrument's own
        two levels rather than a global threshold."""
        if not self.on:
            return "off"
        return "accent" if self.velocity >= INST_VEL_HIGH[instrument] else "normal"


@dataclass(frozen=True)
class Pattern:
    length: int
    scale: int
    shuffle: int
    flam: int
    ext_length: int
    group_pos: int
    group_length: int
    total_acc: int
    inst: list[int]
    velocity: list[list[int]]
    ext_track: list[int]
    ext_accent: list[int]

    @property
    def scale_name(self) -> str:
        return SCALE_NAMES.get(self.scale, f"{self.scale}ppqn")

    @property
    def steps(self) -> int:
        return self.length + 1

    @property
    def ext_steps(self) -> int:
        return self.ext_length + 1

    def step(self, instrument: int, index: int) -> Step:
        raw = self.velocity[instrument][index]
        return Step(
            on=bool(self.inst[instrument] >> index & 1),
            velocity=raw & 0x7F,
            flam=bool(raw & 0x80),
        )

    def ext_step(self, track: int, index: int) -> str:
        """'accent', 'normal' or 'off' for one ext track's step."""
        if not (self.ext_track[track] >> index & 1):
            return "off"
        return "accent" if (self.ext_accent[track] >> index & 1) else "normal"

    def active_voices(self) -> list[int]:
        return [i for i in VOICE_ORDER if self.inst[i]]

    def active_ext_tracks(self) -> list[int]:
        return [i for i in range(NBR_EXT_TRACK) if self.ext_track[i]]

    def is_empty(self) -> bool:
        return not self.active_voices() and not self.active_ext_tracks() and not self.total_acc


def _word(data: bytes, offset: int) -> int:
    return data[offset] | (data[offset + 1] << 8)


def decode_pattern(data: bytes) -> Pattern:
    if len(data) != protocol.PATTERN_BYTES:
        raise RecordError(
            f"pattern record is {len(data)} bytes, expected {protocol.PATTERN_BYTES}"
        )

    inst = [_word(data, OFF_INST + 2 * i) for i in range(NBR_INST)]

    length = data[OFF_SETUP]
    scale = data[OFF_SETUP + 1]
    shuffle = data[OFF_SETUP + 2]
    flam = data[OFF_SETUP + 3]
    stored_ext_length = data[OFF_SETUP + 4]
    group_pos = data[OFF_SETUP + 5]
    group_length = data[OFF_SETUP + 6]
    total_acc = data[OFF_SETUP + 7]

    ext_length = stored_ext_length - 1 if stored_ext_length else length

    ext_track = [_word(data, OFF_EXT_TRACK + 2 * i) for i in range(NBR_EXT_TRACK)]
    ext_accent = [
        ~_word(data, OFF_EXT_ACCENT + 2 * i) & 0xFFFF for i in range(NBR_EXT_TRACK)
    ]

    velocity = [
        list(data[OFF_VELOCITY + i * NBR_STEP : OFF_VELOCITY + (i + 1) * NBR_STEP])
        for i in range(NBR_INST)
    ]

    # A blank (0xFF-filled) EEPROM slot decodes to nonsense rather than failing, so
    # the obviously-impossible values are clamped instead of trusted. length is a
    # 0-15 index and scale is one of four PPQN divisions.
    return Pattern(
        length=min(length, NBR_STEP - 1),
        scale=scale,
        shuffle=shuffle,
        flam=flam,
        ext_length=min(ext_length, NBR_STEP - 1),
        group_pos=group_pos,
        group_length=group_length,
        total_acc=total_acc,
        inst=inst,
        velocity=velocity,
        ext_track=ext_track,
        ext_accent=ext_accent,
    )


@dataclass(frozen=True)
class Config:
    sync: int
    bpm: int
    tx_channel: int
    rx_channel: int
    pattern_change_sync: int
    mute_mode_hh: int
    ext_channel: int
    boot_mode: int
    ext_vel_low: int
    ext_vel_high: int
    ext_notes: list[int]
    ext_notes_stored: bool

    @property
    def sync_name(self) -> str:
        return {0: "MASTER", 1: "SLAVE", 2: "EXPANDER"}.get(self.sync, f"?{self.sync}")

    @property
    def boot_mode_name(self) -> str:
        modes = ["TRACK PLAY", "TRACK WRITE", "PTRN PLAY", "PTRN STEP", "PTRN TAP", "MUTE"]
        return modes[self.boot_mode] if self.boot_mode < len(modes) else f"?{self.boot_mode}"


def decode_config(data: bytes) -> Config:
    if len(data) != protocol.CONFIG_BYTES:
        raise RecordError(
            f"config record is {len(data)} bytes, expected {protocol.CONFIG_BYTES}"
        )

    # Bytes 8 and 9 postdate the original record. A unit written before they
    # existed reads 0 or 0xFF there, neither of which is a legal level, so both
    # fall back to the compiled-in defaults exactly as LoadSeqSetup() does.
    def level(raw: int, default: int) -> int:
        return raw if 1 <= raw <= 127 else default

    stored_sig = data[EXT_NOTES_OFFSET]
    notes_valid = stored_sig == EXT_NOTES_SIG
    notes = []
    for i in range(NBR_EXT_TRACK):
        stored = data[EXT_NOTES_OFFSET + 1 + i]
        notes.append(stored if notes_valid and stored <= 127 else DEFAULT_EXT_NOTES[i])

    return Config(
        sync=data[0],
        bpm=data[1],
        tx_channel=data[2],
        rx_channel=data[3],
        pattern_change_sync=data[4],
        mute_mode_hh=data[5],
        ext_channel=data[6],
        boot_mode=data[7],
        ext_vel_low=level(data[8], 63),
        ext_vel_high=level(data[9], 111),
        ext_notes=notes,
        ext_notes_stored=notes_valid,
    )


@dataclass(frozen=True)
class Track:
    patterns: list[int]
    length: int

    @property
    def used(self) -> list[int]:
        """Entries up to the end marker, which is what the sequencer plays."""
        out = []
        for value in self.patterns[: min(self.length, len(self.patterns))]:
            if value >= END_OF_TRACK:
                break
            out.append(value)
        return out


def decode_track(data: bytes) -> Track:
    if len(data) != protocol.TRACK_BYTES:
        raise RecordError(
            f"track record is {len(data)} bytes, expected {protocol.TRACK_BYTES}"
        )
    # SaveTrack stores the length in the last two bytes of the record itself.
    length = data[1022] | (data[1023] << 8)
    return Track(patterns=list(data[:1022]), length=length)
