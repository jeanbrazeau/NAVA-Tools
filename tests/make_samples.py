"""Write sample .syx files for poking at the web app by hand.

Not fixtures - nothing asserts against these. They exist so the Browse and
Detail views can be driven without a Nava on the desk, and so the cases with
their own rendering branches (a short pattern, a shorter ext loop, a flam, a
blank EEPROM slot, a corrupt record, a firmware image) are all one drag away.

Seeded, so the same command always writes the same bytes and a screenshot taken
today still matches one taken next month.

    uv run python tests/make_samples.py [DIR]

Default DIR is samples/ at the repository root, which is gitignored.
"""

from __future__ import annotations

import os
import random
import sys

from nava import bootloader, protocol, records

# Instruments worth putting in a generated pattern, with how often each should
# land on a step. A 909 pattern is mostly kick, snare and hats; scattering all
# 16 voices uniformly produces something no one would ever program.
VOICE_DENSITY = [
    (8, 0.30),   # BD
    (9, 0.18),   # SD
    (14, 0.55),  # CH
    (15, 0.12),  # OH
    (10, 0.08),  # LT
    (11, 0.08),  # MT
    (2, 0.06),   # HT
    (3, 0.07),   # RIM
    (4, 0.05),   # HCL
    (7, 0.04),   # CRH
    (6, 0.05),   # RID
]

SCALES = [24, 24, 24, 12, 16, 32]  # 1/16 is the common case, so weight it


def pattern_record(
    rng: random.Random,
    *,
    length: int | None = None,
    scale: int | None = None,
    ext_tracks: int = 0,
    stored_ext_length: int = 0,
    flams: int = 0,
    accent: bool = False,
    empty: bool = False,
) -> bytes:
    data = bytearray(protocol.PATTERN_BYTES)
    steps = length if length is not None else rng.choice([16, 16, 16, 12, 8])
    data[records.OFF_SETUP] = steps - 1
    data[records.OFF_SETUP + 1] = scale if scale is not None else rng.choice(SCALES)
    data[records.OFF_SETUP + 2] = rng.choice([0, 0, 0, 2, 4, 6])   # shuffle
    data[records.OFF_SETUP + 3] = rng.choice([0, 0, 3, 5])         # flam depth
    data[records.OFF_SETUP + 4] = stored_ext_length
    if empty:
        return bytes(data)

    for instrument, density in VOICE_DENSITY:
        mask = 0
        for step in range(steps):
            # The kick lands on the quarters far more often than anywhere else,
            # which is what makes the generated grids look like patterns rather
            # than like noise.
            chance = density * (2.2 if instrument == 8 and step % 4 == 0 else 1.0)
            if rng.random() >= chance:
                continue
            mask |= 1 << step
            loud = rng.random() < 0.45
            level = records.INST_VEL_HIGH if loud else records.INST_VEL_LOW
            data[records.OFF_VELOCITY + instrument * records.NBR_STEP + step] = level[instrument]
        data[records.OFF_INST + 2 * instrument] = mask & 0xFF
        data[records.OFF_INST + 2 * instrument + 1] = mask >> 8

    for _ in range(flams):
        instrument = rng.choice([8, 9, 10, 11])
        step = rng.randrange(steps)
        if (data[records.OFF_INST + 2 * instrument] | (data[records.OFF_INST + 2 * instrument + 1] << 8)) >> step & 1:
            data[records.OFF_VELOCITY + instrument * records.NBR_STEP + step] |= 0x80

    if accent:
        mask = 0
        for step in range(0, steps, 4):
            mask |= 1 << step
        data[records.OFF_INST + 2 * records.TOTAL_ACC] = mask & 0xFF
        data[records.OFF_INST + 2 * records.TOTAL_ACC + 1] = mask >> 8
        data[records.OFF_SETUP + 7] = 1

    for track in range(ext_tracks):
        mask = 0
        accents = 0
        span = (stored_ext_length - 1 if stored_ext_length else steps - 1) + 1
        for step in range(span):
            if rng.random() < 0.25:
                mask |= 1 << step
                if rng.random() < 0.5:
                    accents |= 1 << step
        data[records.OFF_EXT_TRACK + 2 * track] = mask & 0xFF
        data[records.OFF_EXT_TRACK + 2 * track + 1] = mask >> 8
        stored = ~accents & 0xFFFF   # extAccent is stored inverted
        data[records.OFF_EXT_ACCENT + 2 * track] = stored & 0xFF
        data[records.OFF_EXT_ACCENT + 2 * track + 1] = stored >> 8

    return bytes(data)


def config_record(rng: random.Random, *, store_notes: bool = True) -> bytes:
    data = bytearray(protocol.CONFIG_BYTES)
    data[0] = rng.choice([0, 1, 2])          # sync
    data[1] = rng.randrange(90, 150)         # bpm
    data[2] = rng.randrange(1, 17)           # tx channel
    data[3] = rng.randrange(1, 17)           # rx channel
    data[4] = rng.choice([0, 1])
    data[5] = rng.choice([0, 1])
    data[6] = rng.randrange(1, 17)           # ext channel
    data[7] = rng.randrange(0, 6)            # boot mode
    data[8] = 63
    data[9] = 111
    if store_notes:
        data[records.EXT_NOTES_OFFSET] = records.EXT_NOTES_SIG
        # A General MIDI drum map, which is what anyone driving a sampler from
        # the ext lanes would actually store.
        for i, note in enumerate([36, 38, 42, 46, 49, 51, 45, 47, 48, 50, 52, 53, 55, 57, 59, 60]):
            data[records.EXT_NOTES_OFFSET + 1 + i] = note
    return bytes(data)


def track_record(rng: random.Random, patterns: list[int]) -> bytes:
    data = bytearray(protocol.TRACK_BYTES)
    for i, number in enumerate(patterns):
        data[i] = number
    data[len(patterns)] = records.END_OF_TRACK
    data[1022] = (len(patterns) + 1) & 0xFF
    data[1023] = (len(patterns) + 1) >> 8
    return bytes(data)


def write(path: str, blocks: list[bytes]) -> None:
    with open(path, "wb") as handle:
        for block in blocks:
            handle.write(block)
    print(f"  {os.path.basename(path):<26} {os.path.getsize(path):>7} bytes")


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "samples")
    os.makedirs(out, exist_ok=True)
    rng = random.Random(909)

    print(f"writing samples to {out}")

    # A whole machine: 128 patterns, 16 tracks, the config. The one that shows
    # what the lists do when they are full.
    blocks = [
        protocol.encode(protocol.NAVA_PTRN_DMP, n,
                        pattern_record(rng, ext_tracks=2 if n % 7 == 0 else 0,
                                       flams=1 if n % 5 == 0 else 0,
                                       accent=n % 3 == 0))
        for n in range(protocol.MAX_PTRN)
    ]
    blocks += [
        protocol.encode(protocol.NAVA_TRACK_DMP, t,
                        track_record(rng, [rng.randrange(0, 128) for _ in range(rng.randrange(2, 24))]))
        for t in range(protocol.MAX_TRACK)
    ]
    blocks.append(protocol.encode(protocol.NAVA_CONFIG_DMP, 0, config_record(rng)))
    write(os.path.join(out, "full-backup.syx"), blocks)

    # One bank, the everyday case.
    blocks = [
        protocol.encode(protocol.NAVA_PTRN_DMP, 32 + i,
                        pattern_record(rng, accent=i % 2 == 0, flams=1))
        for i in range(protocol.PTRN_PER_BANK)
    ]
    blocks.append(protocol.encode(protocol.NAVA_CONFIG_DMP, 0, config_record(rng)))
    write(os.path.join(out, "bank-c.syx"), blocks)

    # One pattern, for the smallest thing the Detail view can be pointed at.
    write(os.path.join(out, "one-pattern.syx"), [
        protocol.encode(protocol.NAVA_PTRN_DMP, 0,
                        pattern_record(rng, length=16, scale=24, accent=True, flams=2)),
    ])

    # Every branch the chart has: a short pattern, a triplet scale, an ext loop
    # shorter than the kit, a blank EEPROM slot, an empty pattern.
    write(os.path.join(out, "edge-cases.syx"), [
        protocol.encode(protocol.NAVA_PTRN_DMP, 0, pattern_record(rng, length=12, scale=12, accent=True)),
        protocol.encode(protocol.NAVA_PTRN_DMP, 1, pattern_record(rng, length=8, scale=16, flams=2)),
        protocol.encode(protocol.NAVA_PTRN_DMP, 2, pattern_record(rng, length=16, ext_tracks=4, stored_ext_length=9)),
        protocol.encode(protocol.NAVA_PTRN_DMP, 3, pattern_record(rng, length=16, ext_tracks=8)),
        protocol.encode(protocol.NAVA_PTRN_DMP, 4, pattern_record(rng, empty=True)),
        # A never-written EEPROM slot reads as 0xFF everywhere; the decoder is
        # meant to clamp it rather than trust it.
        protocol.encode(protocol.NAVA_PTRN_DMP, 5, bytes([0xFF] * protocol.PATTERN_BYTES)),
        protocol.encode(protocol.NAVA_TRACK_DMP, 0, track_record(rng, list(range(20)))),
        protocol.encode(protocol.NAVA_TRACK_DMP, 1, track_record(rng, [])),
        protocol.encode(protocol.NAVA_CONFIG_DMP, 0, config_record(rng)),
    ])

    # No config record, so the ext lanes fall back to the power-on note map.
    write(os.path.join(out, "no-config.syx"), [
        protocol.encode(protocol.NAVA_PTRN_DMP, n, pattern_record(rng, ext_tracks=3))
        for n in range(4)
    ])

    # Two good records around a damaged one: the file should still list what
    # survived and say how much did not.
    good = protocol.encode(protocol.NAVA_PTRN_DMP, 0, pattern_record(rng, accent=True))
    damaged = bytearray(protocol.encode(protocol.NAVA_PTRN_DMP, 1, pattern_record(rng)))
    damaged[protocol.HEADERSIZE + 3] ^= 0x01   # flip a payload bit; the checksum catches it
    write(os.path.join(out, "corrupt.syx"), [
        good,
        bytes(damaged),
        protocol.encode(protocol.NAVA_CONFIG_DMP, 0, config_record(rng)),
    ])

    # A firmware image, so the classifier has something to refuse to restore.
    image = bytes((i * 7 + 3) & 0xFF for i in range(48000))
    write(os.path.join(out, "firmware-0.99.syx"), [bootloader.encode_firmware(image)])

    # An Intel HEX, converted to a bootloader .syx on the way in.
    lines = []
    for offset in range(0, 512, 16):
        chunk = image[offset : offset + 16]
        body = bytes([len(chunk), offset >> 8 & 0xFF, offset & 0xFF, 0x00]) + chunk
        lines.append(":" + (body + bytes([-sum(body) & 0xFF])).hex().upper())
    lines.append(":00000001FF")
    with open(os.path.join(out, "firmware.hex"), "w", encoding="ascii") as handle:
        handle.write("\n".join(lines) + "\n")
    print(f"  {'firmware.hex':<26} {os.path.getsize(os.path.join(out, 'firmware.hex')):>7} bytes")


if __name__ == "__main__":
    main()
