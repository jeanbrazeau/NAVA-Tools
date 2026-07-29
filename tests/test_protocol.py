import pytest

from nava import protocol as p


def test_pack_is_7bit_safe():
    assert all(b <= 0x7F for b in p.pack7(bytes(range(256))))


@pytest.mark.parametrize("size", [0, 1, 6, 7, 8, 63, 64, 448, 1024])
def test_pack_round_trip(size):
    raw = bytes((i * 37 + 11) & 0xFF for i in range(size))
    assert p.unpack7(p.pack7(raw)) == raw


@pytest.mark.parametrize("size", [0, 1, 6, 7, 8, 63, 64, 448, 1024])
def test_packed_size_matches_pack(size):
    assert p.packed_size(size) == len(p.pack7(bytes(size)))


def test_high_bits_survive_packing():
    # The failure this guards against is a packer that drops bit 7: velocities
    # carry a flam flag there, so the corruption would be inaudible in a diff
    # and obvious on the hardware.
    raw = bytes([0xFF] * 7 + [0x80, 0x7F])
    assert p.unpack7(p.pack7(raw)) == raw


def test_message_round_trip():
    payload = bytes((i * 3) & 0xFF for i in range(p.PATTERN_BYTES))
    msg = p.encode(p.NAVA_PTRN_DMP, 5, payload)
    decoded = p.decode(msg)
    assert decoded.cmd == p.NAVA_PTRN_DMP
    assert decoded.param == 5
    assert decoded.payload == payload


def test_wire_sizes():
    # Every dump has to fit the firmware's SysEx reassembly buffer in one
    # message; the track record is the largest and sets that buffer's size.
    assert len(p.encode(p.NAVA_PTRN_DMP, 0, bytes(p.PATTERN_BYTES))) == 520
    assert len(p.encode(p.NAVA_TRACK_DMP, 0, bytes(p.TRACK_BYTES))) == 1179
    assert len(p.encode(p.NAVA_CONFIG_DMP, 0, bytes(p.CONFIG_BYTES))) == 82
    assert len(p.encode(p.NAVA_PTRN_REQ, 3)) == 8


def test_header_matches_firmware_sysex_h():
    assert p.encode(p.NAVA_PTRN_REQ, 0)[:6] == bytes([0xF0, 0x7D, 0x07, 0x1A, 0x41, 0x00])


def test_bootloader_messages_are_not_mistaken_for_dumps():
    # 7D 08 is the bootloader; 7D 07 1A is the application.
    with pytest.raises(p.ProtocolError, match="not a Nava message"):
        p.decode(bytes.fromhex("f07d0808027f00f7"))


def test_checksum_detects_single_bit_flip():
    payload = bytearray(p.PATTERN_BYTES)
    payload[100] = 0x40
    msg = bytearray(p.encode(p.NAVA_PTRN_DMP, 0, bytes(payload)))
    msg[20] ^= 0x01
    with pytest.raises(p.ProtocolError, match="checksum mismatch"):
        p.decode(bytes(msg))


def test_short_payload_is_reported_as_length_not_checksum():
    msg = p.encode(p.NAVA_PTRN_DMP, 0, bytes(p.PATTERN_BYTES - 7))
    with pytest.raises(p.ProtocolError, match="expected 448"):
        p.decode(msg)


def test_truncated_message_rejected():
    with pytest.raises(p.ProtocolError, match="too short"):
        p.decode(bytes.fromhex("f07d071a41f7"))


def test_split_messages_skips_interleaved_realtime():
    a = p.encode(p.NAVA_ACK, p.ACK_OK)
    b = p.encode(p.NAVA_PTRN_REQ, 2)
    stream = b"\xf8" + a + b"\xfe\xf8" + b
    assert p.split_messages(stream) == [a, b]


def test_split_messages_rejects_unterminated():
    with pytest.raises(p.ProtocolError, match="unterminated"):
        p.split_messages(p.encode(p.NAVA_ACK, 0)[:-1])


@pytest.mark.parametrize(
    "label,number", [("A1", 0), ("A16", 15), ("B1", 16), ("H16", 127), ("0", 0), ("127", 127)]
)
def test_pattern_label_parsing(label, number):
    assert p.parse_pattern_label(label) == number


@pytest.mark.parametrize("number", [0, 15, 16, 127])
def test_pattern_label_round_trip(number):
    assert p.parse_pattern_label(p.pattern_label(number)) == number


@pytest.mark.parametrize("label", ["A0", "A17", "I1", "128", "", "xx"])
def test_pattern_label_rejects_nonsense(label):
    with pytest.raises(ValueError):
        p.parse_pattern_label(label)
