import pytest

from fakenava import FakeNava, FakePorts
from nava import cli, midiio, protocol


def pattern_bytes(seed: int) -> bytes:
    """A pattern with bit 7 set throughout, so packing errors cannot hide."""
    return bytes(((i * 31 + seed * 7) | 0x80) & 0xFF for i in range(protocol.PATTERN_BYTES))


@pytest.fixture
def device():
    nava = FakeNava()
    for number in range(protocol.MAX_PTRN):
        nava.seed_pattern(number, pattern_bytes(number))
    return nava


def test_request_returns_the_stored_pattern(device):
    ports = FakePorts(device)
    message = midiio.request_dump(ports, protocol.NAVA_PTRN_REQ, 42, timeout=1, retries=0)
    assert message.payload == pattern_bytes(42)


def test_request_retries_after_a_dropped_reply(device):
    ports = FakePorts(device, drop_first=1)
    message = midiio.request_dump(ports, protocol.NAVA_PTRN_REQ, 3, timeout=1, retries=2)
    assert message.payload == pattern_bytes(3)
    assert ports.sent == 2


def test_request_retries_after_a_corrupt_reply(device):
    ports = FakePorts(device, corrupt_first=1)
    message = midiio.request_dump(ports, protocol.NAVA_PTRN_REQ, 3, timeout=1, retries=2)
    assert message.payload == pattern_bytes(3)


def test_request_gives_up_and_says_why(device):
    ports = FakePorts(device, drop_first=99)
    with pytest.raises(midiio.MidiError, match="no valid reply"):
        midiio.request_dump(ports, protocol.NAVA_PTRN_REQ, 3, timeout=0.05, retries=1)


def test_busy_device_is_reported_not_retried_forever(device):
    device.running = True
    ports = FakePorts(device)
    with pytest.raises(midiio.MidiError, match="sequencer running"):
        midiio.request_dump(ports, protocol.NAVA_PTRN_REQ, 0, timeout=1, retries=0)


def test_full_round_trip_through_a_file(device, tmp_path, monkeypatch):
    ports = FakePorts(device)
    monkeypatch.setattr(cli.midiio, "open_ports", lambda **kwargs: ports)
    backup = tmp_path / "backup.syx"

    args = cli.build_parser().parse_args(
        ["backup", "--out", "0", "--in", "0", "-o", str(backup)]
    )
    assert args.func(args) == 0

    # 128 patterns + 16 tracks + config
    stored = protocol.split_messages(backup.read_bytes())
    assert len(stored) == protocol.MAX_PTRN + protocol.MAX_TRACK + 1

    # Wipe the device, then restore from the file and compare every byte.
    blank = FakeNava()
    restore_ports = FakePorts(blank)
    monkeypatch.setattr(cli.midiio, "open_ports", lambda **kwargs: restore_ports)
    args = cli.build_parser().parse_args(
        ["restore", str(backup), "--out", "0", "--in", "0"]
    )
    assert args.func(args) == 0
    assert blank.eeprom == device.eeprom


def test_restore_is_acknowledged_per_item(device, tmp_path, monkeypatch):
    blank = FakeNava()
    ports = FakePorts(blank)
    monkeypatch.setattr(cli.midiio, "open_ports", lambda **kwargs: ports)
    backup = tmp_path / "one.syx"
    backup.write_bytes(protocol.encode(protocol.NAVA_PTRN_DMP, 9, pattern_bytes(9)))

    args = cli.build_parser().parse_args(
        ["restore", str(backup), "--out", "0", "--in", "0"]
    )
    assert args.func(args) == 0
    assert blank.writes == [(protocol.NAVA_PTRN_DMP, 9)]
    assert blank.read_pattern(9) == pattern_bytes(9)


def test_restore_retries_a_dropped_ack(device, tmp_path, monkeypatch):
    blank = FakeNava()
    ports = FakePorts(blank, drop_first=1)
    monkeypatch.setattr(cli.midiio, "open_ports", lambda **kwargs: ports)
    backup = tmp_path / "one.syx"
    backup.write_bytes(protocol.encode(protocol.NAVA_PTRN_DMP, 9, pattern_bytes(9)))

    args = cli.build_parser().parse_args(
        ["restore", str(backup), "--out", "0", "--in", "0", "--retries", "2"]
    )
    assert args.func(args) == 0


def test_device_rejects_a_corrupt_dump():
    blank = FakeNava()
    message = bytearray(protocol.encode(protocol.NAVA_PTRN_DMP, 0, pattern_bytes(1)))
    message[10] ^= 0x01
    replies = [protocol.decode(r) for r in blank.handle(bytes(message))]
    assert replies[0].cmd == protocol.NAVA_ACK
    assert replies[0].param == protocol.ACK_BAD_CHECKSUM
    assert blank.writes == []  # nothing written on a failed checksum


def test_device_rejects_an_out_of_range_pattern():
    blank = FakeNava()
    replies = [protocol.decode(r) for r in blank.handle(protocol.request(protocol.NAVA_PTRN_REQ, 127))]
    assert replies[0].cmd == protocol.NAVA_PTRN_DMP


def test_bank_request_returns_sixteen_patterns(device):
    replies = device.handle(protocol.request(protocol.NAVA_BANK_REQ, 2))
    decoded = [protocol.decode(r) for r in replies]
    assert [m.param for m in decoded] == list(range(32, 48))


def test_partial_selection(device, tmp_path, monkeypatch):
    ports = FakePorts(device)
    monkeypatch.setattr(cli.midiio, "open_ports", lambda **kwargs: ports)
    backup = tmp_path / "bankC.syx"
    args = cli.build_parser().parse_args(
        ["backup", "--out", "0", "--in", "0", "-o", str(backup), "--patterns", "C"]
    )
    assert args.func(args) == 0
    decoded = [protocol.decode(m) for m in protocol.split_messages(backup.read_bytes())]
    assert [m.param for m in decoded] == list(range(32, 48))


def test_dry_run_sends_nothing(device, tmp_path, monkeypatch, capsys):
    blank = FakeNava()
    ports = FakePorts(blank)
    monkeypatch.setattr(cli.midiio, "open_ports", lambda **kwargs: ports)
    backup = tmp_path / "one.syx"
    backup.write_bytes(protocol.encode(protocol.NAVA_PTRN_DMP, 9, pattern_bytes(9)))

    args = cli.build_parser().parse_args(
        ["restore", str(backup), "--out", "0", "--in", "0", "--dry-run"]
    )
    assert args.func(args) == 0
    assert ports.sent == 0
    assert "would write pattern A10" in capsys.readouterr().out


def test_flashing_a_backup_is_refused(tmp_path):
    backup = tmp_path / "backup.syx"
    backup.write_bytes(protocol.encode(protocol.NAVA_PTRN_DMP, 0, pattern_bytes(0)))
    args = cli.build_parser().parse_args(["flash", str(backup), "--out", "0"])
    with pytest.raises(cli.CommandError, match="not a Nava bootloader image"):
        args.func(args)
