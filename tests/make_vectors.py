"""Regenerate tests/fixtures/vectors.json.

The web app is a second implementation of a wire format and a set of EEPROM
layouts the firmware defines. Two implementations of the same spec drift, and
the drift only shows up against hardware, so they are pinned to each other here:
this file builds byte images and the strings the Python code produces from them,
`test_vectors.py` asserts Python still reproduces the committed file, and
`tests/web/vectors.test.js` asserts JavaScript produces the same.

Changing either side alone fails. Changing the Python side deliberately means
running this script and then fixing the JavaScript until its test passes again -
which is the point.

    uv run python tests/make_vectors.py
"""

from __future__ import annotations

import json
import os

from nava import bootloader, ihex, protocol, records, render, selection

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "vectors.json")

NBR_INST = records.NBR_INST
NBR_STEP = records.NBR_STEP


def hexs(data: bytes) -> str:
    return data.hex()


def hex_record(address: int, rectype: int, data: bytes) -> str:
    """One Intel HEX line, checksum included."""
    body = bytes([len(data), address >> 8 & 0xFF, address & 0xFF, rectype]) + data
    return ":" + (body + bytes([-sum(body) & 0xFF])).hex().upper()


def build_pattern(
    *,
    length: int,
    scale: int,
    shuffle: int = 0,
    flam: int = 0,
    stored_ext_length: int = 0,
    group_pos: int = 0,
    group_length: int = 0,
    total_acc_mask: int = 0,
    voices: dict[int, list[tuple[int, int, bool]]] | None = None,
    ext: dict[int, list[tuple[int, bool]]] | None = None,
) -> bytes:
    """A 448-byte pattern record, laid out by hand.

    `voices` maps an instrument index to (step, velocity, flam) triples; `ext`
    maps an ext track to (step, accented) pairs. Building the image rather than
    round-tripping it through an encoder is deliberate: a decoder checked
    against its own inverse proves nothing about whether either matches
    EEprom.ino.
    """
    data = bytearray(protocol.PATTERN_BYTES)

    for instrument, steps in (voices or {}).items():
        mask = 0
        for step, velocity, has_flam in steps:
            mask |= 1 << step
            data[records.OFF_VELOCITY + instrument * NBR_STEP + step] = velocity | (
                0x80 if has_flam else 0
            )
        data[records.OFF_INST + 2 * instrument] = mask & 0xFF
        data[records.OFF_INST + 2 * instrument + 1] = mask >> 8

    if total_acc_mask:
        data[records.OFF_INST + 2 * records.TOTAL_ACC] = total_acc_mask & 0xFF
        data[records.OFF_INST + 2 * records.TOTAL_ACC + 1] = total_acc_mask >> 8

    data[records.OFF_SETUP + 0] = length
    data[records.OFF_SETUP + 1] = scale
    data[records.OFF_SETUP + 2] = shuffle
    data[records.OFF_SETUP + 3] = flam
    data[records.OFF_SETUP + 4] = stored_ext_length
    data[records.OFF_SETUP + 5] = group_pos
    data[records.OFF_SETUP + 6] = group_length
    data[records.OFF_SETUP + 7] = 1 if total_acc_mask else 0

    for track, steps in (ext or {}).items():
        mask = 0
        accents = 0
        for step, accented in steps:
            mask |= 1 << step
            if accented:
                accents |= 1 << step
        data[records.OFF_EXT_TRACK + 2 * track] = mask & 0xFF
        data[records.OFF_EXT_TRACK + 2 * track + 1] = mask >> 8
        # Stored inverted, which is what LoadPattern reads back.
        stored = ~accents & 0xFFFF
        data[records.OFF_EXT_ACCENT + 2 * track] = stored & 0xFF
        data[records.OFF_EXT_ACCENT + 2 * track + 1] = stored >> 8

    return bytes(data)


def build_config(*, store_notes: bool, notes: list[int] | None = None) -> bytes:
    data = bytearray(protocol.CONFIG_BYTES)
    data[0] = 1  # SLAVE
    data[1] = 122  # BPM
    data[2] = 10  # TX
    data[3] = 11  # RX
    data[4] = 1  # pattern change SYNC
    data[5] = 0  # HH mute mode C/O
    data[6] = 12  # ext channel
    data[7] = 2  # PTRN PLAY
    data[8] = 70  # ext vel low
    data[9] = 120  # ext vel high
    if store_notes:
        data[records.EXT_NOTES_OFFSET] = records.EXT_NOTES_SIG
        for i, note in enumerate(notes or []):
            data[records.EXT_NOTES_OFFSET + 1 + i] = note
    return bytes(data)


def build_track(sequence: list[int], length: int) -> bytes:
    data = bytearray(protocol.TRACK_BYTES)
    for i, value in enumerate(sequence):
        data[i] = value
    data[1022] = length & 0xFF
    data[1023] = length >> 8
    return bytes(data)


def pattern_case(name: str, record: bytes, config: records.Config | None) -> dict:
    decoded = records.decode_pattern(record)
    return {
        "name": name,
        "record": hexs(record),
        "config": config is not None,
        "lines": render.pattern_lines(decoded, config=config, title=name),
        "summary": render.summarise_pattern(decoded),
        "steps": decoded.steps,
        "ext_steps": decoded.ext_steps,
        "scale_name": decoded.scale_name,
        "empty": decoded.is_empty(),
    }


def build() -> dict:
    stored_notes = [36, 38, 42, 46, 49, 51, 45, 47, 48, 50, 52, 53, 55, 57, 59, 60]
    config_stored = build_config(store_notes=True, notes=stored_notes)
    config_bare = build_config(store_notes=False)
    decoded_config = records.decode_config(config_stored)

    # A four-on-the-floor with a flam, a soft hat lane, a shorter ext loop and a
    # total-accent mask: between them these reach every branch in the renderer.
    house = build_pattern(
        length=15,
        scale=24,
        shuffle=2,
        flam=3,
        stored_ext_length=9,  # ext loop of 8 steps against 16
        group_pos=1,
        group_length=4,
        total_acc_mask=0b0000000100000001,
        voices={
            8: [(0, 50, False), (4, 50, False), (8, 25, False), (12, 50, True)],
            9: [(4, 50, False), (12, 25, False)],
            14: [(i, 80, False) for i in range(0, 16, 2)],
            15: [(2, 109, False), (10, 108, False)],
        },
        ext={
            0: [(0, True), (3, False), (6, True)],
            5: [(1, False), (5, True)],
        },
    )

    # A 12-step 1/32 pattern with no ext layer and no accents.
    short = build_pattern(
        length=11,
        scale=12,
        voices={
            2: [(0, 50, False), (6, 25, False)],
            11: [(3, 50, True)],
        },
    )

    # A blank EEPROM slot: 0xFF everywhere. Nothing here is a legal value, and
    # the decoder is expected to clamp rather than trust it.
    blank = bytes([0xFF] * protocol.PATTERN_BYTES)

    empty = build_pattern(length=15, scale=24)

    track = build_track([0, 1, 2, 17, 33, 128, 5], 7)
    long_track = build_track(list(range(20)), 20)

    # Built rather than pasted so the checksums are right by construction. The
    # extended records are here because they are the reason ihex.py exists: the
    # Python 2 tool it replaces only ever read the 16-bit address field, so an
    # image past 64KB wrapped over its own start.
    hex_text = "".join(
        hex_record(address, rectype, data) + "\n"
        for address, rectype, data in (
            (0x0000, 0x00, bytes(range(0x11, 0x21))),
            (0x0010, 0x02, b"\x00\x10"),   # extended segment: base becomes 0x100
            (0x0000, 0x00, b"\xde\xad\xbe\xef"),
            (0x0000, 0x04, b"\x00\x00"),   # extended linear back to base 0
            (0x0140, 0x00, b"\x01\x02\x03"),
            (0x0000, 0x01, b""),
        )
    )

    firmware_image = bytes((i * 7 + 3) & 0xFF for i in range(300))

    return {
        "_generated_by": "tests/make_vectors.py",
        "pack7": [
            {"raw": hexs(raw), "packed": hexs(protocol.pack7(raw))}
            for raw in (
                b"",
                b"\x01",
                b"\x80",
                bytes(range(7)),
                bytes(range(8)),
                bytes([0xFF] * 15),
                bytes((i * 13) & 0xFF for i in range(64)),
            )
        ],
        "messages": [
            {
                "cmd": cmd,
                "param": param,
                "payload": hexs(payload),
                "encoded": hexs(protocol.encode(cmd, param, payload)),
            }
            for cmd, param, payload in (
                (protocol.NAVA_PTRN_REQ, 17, b""),
                (protocol.NAVA_CONFIG_REQ, 0, b""),
                (protocol.NAVA_CONFIG_DMP, 0, config_stored),
                (protocol.NAVA_PTRN_DMP, 17, house),
                (protocol.NAVA_TRACK_DMP, 3, track),
            )
        ],
        "pattern_labels": [
            {"number": n, "label": protocol.pattern_label(n)}
            for n in (0, 15, 16, 63, 64, 127)
        ],
        "patterns": [
            pattern_case("house", house, decoded_config),
            pattern_case("short", short, None),
            pattern_case("blank", blank, None),
            pattern_case("empty", empty, decoded_config),
        ],
        "configs": [
            {"name": "stored", "record": hexs(config_stored),
             "lines": render.config_lines(records.decode_config(config_stored))},
            {"name": "bare", "record": hexs(config_bare),
             "lines": render.config_lines(records.decode_config(config_bare))},
        ],
        "tracks": [
            {"name": "short", "number": 3, "record": hexs(track),
             "lines": render.track_lines(records.decode_track(track), 3),
             "used": records.decode_track(track).used},
            {"name": "long", "number": 0, "record": hexs(long_track),
             "lines": render.track_lines(records.decode_track(long_track), 0),
             "used": records.decode_track(long_track).used},
        ],
        "selections": [
            {"kind": "patterns", "spec": spec, "result": selection.parse_patterns(spec)}
            for spec in ("A1", "A1,B3", "A1-A4", "C", "b", "0,127", "A1,A1,A2")
        ] + [
            {"kind": "tracks", "spec": spec, "result": selection.parse_tracks(spec)}
            for spec in ("1", "1-4", "16", "2,2,1")
        ],
        "ihex": [{"text": hex_text, "image": hexs(ihex.load(hex_text))}],
        "firmware": [
            {
                "image": hexs(firmware_image),
                "syx": hexs(bootloader.encode_firmware(firmware_image)),
                "pages": (len(firmware_image) + 255) // 256,
            }
        ],
        "legend": render.legend(),
    }


def main() -> None:
    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    with open(FIXTURE, "w", encoding="utf-8") as handle:
        json.dump(build(), handle, indent=1, ensure_ascii=False)
        handle.write("\n")
    print(f"wrote {FIXTURE}")


if __name__ == "__main__":
    main()
