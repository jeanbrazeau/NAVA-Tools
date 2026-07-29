"""The firmware and the host tool each define the protocol's numbers in their own
language. Parsing the headers and comparing keeps them from drifting apart - a
mismatch here would show up on hardware as a backup that silently reads the wrong
EEPROM record, which nothing else in either test suite would catch."""

import os
import re

import pytest

from nava import protocol

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIRMWARE = os.path.join(REPO_ROOT, "downtown-solutions_firmware")

# Values may carry a cast, as EEprom.ino's `#define PTRN_SIZE (unsigned long)(448)` does.
DEFINE_RE = re.compile(
    r"^\s*#define\s+(\w+)\s+(?:\([\w\s]+\)\s*)?\(?(0x[0-9a-fA-F]+|\d+)\)?\s*(?://.*)?$"
)


def defines(filename: str) -> dict[str, int]:
    found = {}
    with open(os.path.join(FIRMWARE, filename), encoding="utf-8") as handle:
        for line in handle:
            match = DEFINE_RE.match(line)
            if match:
                found[match.group(1)] = int(match.group(2), 0)
    return found


@pytest.fixture(scope="module")
def sysex_h():
    return defines("Sysex.h")


@pytest.fixture(scope="module")
def define_h():
    return defines("define.h")


@pytest.mark.parametrize(
    "name,value",
    [
        ("SYSEX_MANUFACTURER", protocol.MANUFACTURER),
        ("SYSEX_DEVID_1", protocol.DEV_ID_1),
        ("SYSEX_DEVID_2", protocol.DEV_ID_2),
        ("HEADERSIZE", protocol.HEADERSIZE),
        ("NAVA_PTRN_DMP", protocol.NAVA_PTRN_DMP),
        ("NAVA_TRACK_DMP", protocol.NAVA_TRACK_DMP),
        ("NAVA_CONFIG_DMP", protocol.NAVA_CONFIG_DMP),
        ("NAVA_BANK_REQ", protocol.NAVA_BANK_REQ),
        ("NAVA_PTRN_REQ", protocol.NAVA_PTRN_REQ),
        ("NAVA_TRACK_REQ", protocol.NAVA_TRACK_REQ),
        ("NAVA_CONFIG_REQ", protocol.NAVA_CONFIG_REQ),
        ("NAVA_FULL_REQ", protocol.NAVA_FULL_REQ),
        ("NAVA_ACK", protocol.NAVA_ACK),
        ("NAVA_ACK_OK", protocol.ACK_OK),
        ("NAVA_ACK_BAD_CHECKSUM", protocol.ACK_BAD_CHECKSUM),
        ("NAVA_ACK_BAD_LENGTH", protocol.ACK_BAD_LENGTH),
        ("NAVA_ACK_BAD_PARAM", protocol.ACK_BAD_PARAM),
        ("NAVA_ACK_BUSY", protocol.ACK_BUSY),
        ("SYSEX_PTRN_BYTES", protocol.PATTERN_BYTES),
        ("SYSEX_TRACK_BYTES", protocol.TRACK_BYTES),
        ("SYSEX_CONFIG_BYTES", protocol.CONFIG_BYTES),
    ],
)
def test_sysex_header_agrees(sysex_h, name, value):
    assert sysex_h[name] == value, f"{name} disagrees with tools/nava/protocol.py"


@pytest.mark.parametrize(
    "name,value",
    [
        ("MAX_PTRN", protocol.MAX_PTRN),
        ("MAX_TRACK", protocol.MAX_TRACK),
        ("NBR_PATTERN", protocol.PTRN_PER_BANK),
    ],
)
def test_define_header_agrees(define_h, name, value):
    assert define_h[name] == value, f"{name} disagrees with tools/nava/protocol.py"


def test_bank_count_is_consistent(define_h):
    # MAX_BANK is the highest valid index, not a count.
    assert define_h["MAX_BANK"] + 1 == protocol.MAX_BANK


def test_record_sizes_match_the_eeprom_layout():
    """The dumps are EEPROM images, so their sizes are the layout's, not ours."""
    eeprom = defines("EEprom.ino")
    assert eeprom["PTRN_SIZE"] == protocol.PATTERN_BYTES
    assert eeprom["TRACK_SIZE"] == protocol.TRACK_BYTES
    assert eeprom["SETUP_SIZE"] == protocol.CONFIG_BYTES


def test_records_are_whole_eeprom_pages():
    """SysexStoreRecord() writes a page at a time and assumes no straddling."""
    page = defines("EEprom.ino")["MAX_PAGE_SIZE"]
    for size in (protocol.PATTERN_BYTES, protocol.TRACK_BYTES, protocol.CONFIG_BYTES):
        assert size % page == 0, f"record of {size} bytes is not a whole number of pages"


def test_sysex_buffer_holds_the_largest_message():
    """A record larger than the reassembly buffer would arrive as fragments the
    handler drops, which would look like an unreliable cable."""
    largest = max(
        len(protocol.encode(protocol.NAVA_TRACK_DMP, 0, bytes(protocol.TRACK_BYTES))),
        len(protocol.encode(protocol.NAVA_PTRN_DMP, 0, bytes(protocol.PATTERN_BYTES))),
        len(protocol.encode(protocol.NAVA_CONFIG_DMP, 0, bytes(protocol.CONFIG_BYTES))),
    )
    assert largest == 1179
    # Sysex.h derives SYSEX_BUFFER_SIZE from SYSEX_TRACK_SIZE; platformio.ini must
    # not override it with something smaller.
    with open(os.path.join(REPO_ROOT, "platformio.ini"), encoding="utf-8") as handle:
        ini = handle.read()
    override = re.search(r"^\s*-DSYSEX_BUFFER_SIZE=(\d+)", ini, re.MULTILINE)
    if override:
        assert int(override.group(1)) >= largest
