"""Records are decoded from hand-built byte images rather than round-tripped
through an encoder in this file - a decoder checked against its own inverse
proves nothing about whether either matches EEprom.ino. Each test states the
firmware behaviour it pins."""

import pytest

from nava import protocol, records, render


def blank_pattern() -> bytearray:
    return bytearray(protocol.PATTERN_BYTES)


def set_word(buf: bytearray, offset: int, value: int) -> None:
    buf[offset] = value & 0xFF
    buf[offset + 1] = (value >> 8) & 0xFF


def test_instrument_mask_is_little_endian():
    buf = blank_pattern()
    # BD (index 8) on steps 0 and 8 -> 0x0101
    set_word(buf, records.OFF_INST + 2 * 8, 0x0101)
    pattern = records.decode_pattern(bytes(buf))
    assert pattern.inst[8] == 0x0101
    assert pattern.step(8, 0).on
    assert pattern.step(8, 8).on
    assert not pattern.step(8, 1).on


def test_setup_fields():
    buf = blank_pattern()
    buf[records.OFF_SETUP + 0] = 15   # length (index, so 16 steps)
    buf[records.OFF_SETUP + 1] = 24   # scale = 1/16
    buf[records.OFF_SETUP + 2] = 3    # shuffle
    buf[records.OFF_SETUP + 3] = 5    # flam
    buf[records.OFF_SETUP + 5] = 2    # groupPos
    buf[records.OFF_SETUP + 6] = 4    # groupLength
    pattern = records.decode_pattern(bytes(buf))
    assert pattern.steps == 16
    assert pattern.scale_name == "1/16"
    assert pattern.shuffle == 3
    assert pattern.flam == 5
    assert pattern.group_pos == 2
    assert pattern.group_length == 4


@pytest.mark.parametrize("scale,name", [(24, "1/16"), (12, "1/32"), (16, "1/16t"), (32, "1/8t")])
def test_scale_names(scale, name):
    buf = blank_pattern()
    buf[records.OFF_SETUP + 1] = scale
    assert records.decode_pattern(bytes(buf)).scale_name == name


def test_ext_length_zero_means_unwritten_and_falls_back_to_length():
    """The stored byte is biased by one so 0 can mean 'predates this field'.
    An ext length of 0 is itself legal, which is why the bias exists."""
    buf = blank_pattern()
    buf[records.OFF_SETUP + 0] = 11      # length index -> 12 steps
    buf[records.OFF_SETUP + 4] = 0       # never written
    assert records.decode_pattern(bytes(buf)).ext_length == 11


def test_ext_length_is_debiased():
    buf = blank_pattern()
    buf[records.OFF_SETUP + 0] = 15
    buf[records.OFF_SETUP + 4] = 1       # stored 1 -> ext length 0, a one-step loop
    pattern = records.decode_pattern(bytes(buf))
    assert pattern.ext_length == 0
    assert pattern.ext_steps == 1


def test_ext_accent_is_stored_inverted():
    """Zeros in the accent words mean a pattern written before ext steps had two
    levels, and those played at the HIGH level throughout."""
    buf = blank_pattern()
    set_word(buf, records.OFF_EXT_TRACK, 0x0001)   # track 0, step 0
    # OFF_EXT_ACCENT left as zeros -> decodes to all bits set -> accented
    pattern = records.decode_pattern(bytes(buf))
    assert pattern.ext_step(0, 0) == "accent"


def test_ext_accent_cleared_bit_is_the_soft_level():
    buf = blank_pattern()
    set_word(buf, records.OFF_EXT_TRACK, 0x0001)
    # Stored is the complement, so a SET stored bit decodes to a CLEAR accent bit.
    set_word(buf, records.OFF_EXT_ACCENT, 0x0001)
    pattern = records.decode_pattern(bytes(buf))
    assert pattern.ext_step(0, 0) == "normal"


def test_ext_step_off_when_track_bit_clear():
    buf = blank_pattern()
    assert records.decode_pattern(bytes(buf)).ext_step(3, 5) == "off"


def test_velocity_high_bit_is_the_flam_flag():
    buf = blank_pattern()
    set_word(buf, records.OFF_INST + 2 * 8, 0x0001)
    buf[records.OFF_VELOCITY + 8 * 16 + 0] = 25 | 0x80
    step = records.decode_pattern(bytes(buf)).step(8, 0)
    assert step.flam
    assert step.velocity == 25
    # 25 is BD's low level, so this is the soft state, not the loud one.
    assert step.level(8) == "normal"


def test_level_uses_the_instruments_own_thresholds():
    """instVelHigh is per instrument; a global threshold would misread CH at 111
    as soft and BD at 50 as loud."""
    buf = blank_pattern()
    set_word(buf, records.OFF_INST + 2 * 8, 0x0001)   # BD
    set_word(buf, records.OFF_INST + 2 * 14, 0x0001)  # CH
    buf[records.OFF_VELOCITY + 8 * 16 + 0] = 50       # BD high
    buf[records.OFF_VELOCITY + 14 * 16 + 0] = 80      # CH low
    pattern = records.decode_pattern(bytes(buf))
    assert pattern.step(8, 0).level(8) == "accent"
    assert pattern.step(14, 0).level(14) == "normal"


def test_blank_eeprom_slot_decodes_without_crashing():
    """fx_make_eeprom_image leaves unused slots at 0xFF, and a real unit that has
    never had a bank saved reads the same. Nonsense is clamped, not trusted."""
    pattern = records.decode_pattern(b"\xff" * protocol.PATTERN_BYTES)
    assert pattern.steps <= 16
    assert pattern.ext_steps <= 16
    lines = render.pattern_lines(pattern)
    assert lines  # renders rather than raising


def test_wrong_size_is_rejected():
    with pytest.raises(records.RecordError, match="expected 448"):
        records.decode_pattern(b"\x00" * 100)


# ---- config ----


def test_config_fields():
    buf = bytearray(protocol.CONFIG_BYTES)
    buf[0:10] = bytes([0, 120, 1, 2, 1, 0, 3, 3, 63, 111])
    config = records.decode_config(bytes(buf))
    assert config.sync_name == "MASTER"
    assert config.bpm == 120
    assert config.tx_channel == 1
    assert config.rx_channel == 2
    assert config.ext_channel == 3
    assert config.boot_mode_name == "PTRN STEP"
    assert config.ext_vel_low == 63
    assert config.ext_vel_high == 111


@pytest.mark.parametrize("stored", [0, 0xFF])
def test_ext_velocity_falls_back_when_never_written(stored):
    """Neither 0 nor 0xFF is a legal level, which is what lets a record written
    before these bytes existed be recognised without a signature."""
    buf = bytearray(protocol.CONFIG_BYTES)
    buf[8] = buf[9] = stored
    config = records.decode_config(bytes(buf))
    assert (config.ext_vel_low, config.ext_vel_high) == (63, 111)


def test_ext_notes_need_the_signature():
    buf = bytearray(protocol.CONFIG_BYTES)
    buf[records.EXT_NOTES_OFFSET] = 0x00  # no signature
    buf[records.EXT_NOTES_OFFSET + 1] = 60
    config = records.decode_config(bytes(buf))
    assert not config.ext_notes_stored
    assert config.ext_notes == records.DEFAULT_EXT_NOTES


def test_ext_notes_read_when_signed():
    buf = bytearray(protocol.CONFIG_BYTES)
    buf[records.EXT_NOTES_OFFSET] = records.EXT_NOTES_SIG
    for i in range(16):
        buf[records.EXT_NOTES_OFFSET + 1 + i] = 60 + i
    config = records.decode_config(bytes(buf))
    assert config.ext_notes_stored
    assert config.ext_notes[0] == 60


@pytest.mark.parametrize("note,name", [(60, "C4"), (48, "C3"), (0, "C-1"), (61, "C#4"), (127, "G9")])
def test_note_names_use_the_lcd_convention(note, name):
    assert records.note_name(note) == name


# ---- track ----


def test_track_length_lives_in_the_last_two_bytes():
    buf = bytearray(protocol.TRACK_BYTES)
    buf[0:4] = bytes([5, 6, 7, records.END_OF_TRACK])
    buf[1022] = 10
    track = records.decode_track(bytes(buf))
    assert track.length == 10
    assert track.used == [5, 6, 7]


def test_track_stops_at_the_end_marker():
    buf = bytearray(b"\xff" * protocol.TRACK_BYTES)
    buf[1022] = 0xFF
    buf[1023] = 0x03
    assert records.decode_track(bytes(buf)).used == []


# ---- rendering ----


def test_grid_marks_loud_soft_and_off():
    buf = blank_pattern()
    buf[records.OFF_SETUP + 0] = 3        # 4 steps
    buf[records.OFF_SETUP + 1] = 24
    set_word(buf, records.OFF_INST + 2 * 8, 0b0011)
    buf[records.OFF_VELOCITY + 8 * 16 + 0] = 50   # loud
    buf[records.OFF_VELOCITY + 8 * 16 + 1] = 25   # soft
    text = render.pattern_text(records.decode_pattern(bytes(buf)))
    bd = next(line for line in text.splitlines() if line.startswith("BD"))
    assert bd.split()[1:] == ["#", "o", ".", "."]


def test_grid_omits_silent_lanes():
    buf = blank_pattern()
    set_word(buf, records.OFF_INST + 2 * 8, 0x0001)
    text = render.pattern_text(records.decode_pattern(bytes(buf)))
    assert "BD" in text
    assert "CRH" not in text


def test_ext_lane_labelled_with_note_name():
    buf = blank_pattern()
    buf[records.OFF_SETUP + 0] = 3
    set_word(buf, records.OFF_EXT_TRACK, 0x0001)
    config = records.decode_config(bytes(protocol.CONFIG_BYTES))
    text = render.pattern_text(records.decode_pattern(bytes(buf)), config=config)
    assert "T1 C3" in text  # default ext note 48


def test_short_ext_loop_repeats_against_the_kit():
    """extStepCount wraps on extLength, so a 4-step ext layer under a 16-step
    pattern plays four times rather than leaving 12 steps silent."""
    buf = blank_pattern()
    buf[records.OFF_SETUP + 0] = 15   # 16 steps
    buf[records.OFF_SETUP + 4] = 4    # ext length index 3 -> 4 steps
    set_word(buf, records.OFF_EXT_TRACK, 0x0001)  # ext step 0 only
    text = render.pattern_text(records.decode_pattern(bytes(buf)))
    lane = next(line for line in text.splitlines() if line.startswith("T1"))
    cells = lane.split()[1:]
    assert [i for i, c in enumerate(cells) if c == "#"] == [0, 4, 8, 12]
