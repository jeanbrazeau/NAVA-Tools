"""Compile the firmware's own packing header natively and check it against the
host implementation.

The two sides of this transfer are written in different languages and only agree
by construction, so agreement is asserted rather than assumed. Without the AVR
toolchain this is also the only executable check on any firmware code, which is
why it drives the real header rather than a transcription of it.
"""

import ctypes
import os
import random
import shutil
import subprocess

import pytest

from nava import protocol

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HEADER_DIR = os.path.join(REPO_ROOT, "downtown-solutions_firmware")
HEADER = os.path.join(HEADER_DIR, "sysex_pack.h")

SHIM = r"""
#include "sysex_pack.h"

/* Thin non-inline wrappers so the header's functions are reachable through
   ctypes; the firmware calls them inline. */
unsigned char pack_msbs(const unsigned char *group, unsigned char count) {
  return SysexPackMsbs(group, count);
}
unsigned char unpack_at(const unsigned char *packed, unsigned int index) {
  return SysexUnpackByteAt(packed, index);
}
unsigned int packed_len(unsigned int raw) { return SysexPackedLen(raw); }
unsigned int unpacked_len(unsigned int packed) { return SysexUnpackedLen(packed); }
"""


@pytest.fixture(scope="module")
def firmware_pack(tmp_path_factory):
    cc = shutil.which("cc") or shutil.which("clang") or shutil.which("gcc")
    if cc is None:
        pytest.skip("no C compiler available")
    build = tmp_path_factory.mktemp("sysex_pack")
    source = build / "shim.c"
    source.write_text(SHIM)
    library = build / "libsysexpack.so"
    subprocess.run(
        [cc, "-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-Werror",
         f"-I{HEADER_DIR}", str(source), "-o", str(library)],
        check=True,
    )
    lib = ctypes.CDLL(str(library))
    lib.pack_msbs.restype = ctypes.c_ubyte
    lib.pack_msbs.argtypes = [ctypes.POINTER(ctypes.c_ubyte), ctypes.c_ubyte]
    lib.unpack_at.restype = ctypes.c_ubyte
    lib.unpack_at.argtypes = [ctypes.POINTER(ctypes.c_ubyte), ctypes.c_uint]
    lib.packed_len.restype = ctypes.c_uint
    lib.packed_len.argtypes = [ctypes.c_uint]
    lib.unpacked_len.restype = ctypes.c_uint
    lib.unpacked_len.argtypes = [ctypes.c_uint]
    return lib


def _buffer(data: bytes):
    return (ctypes.c_ubyte * len(data))(*data)


def test_header_exists():
    assert os.path.exists(HEADER), "the firmware packing header moved"


@pytest.mark.parametrize("raw_len", [0, 1, 6, 7, 8, 13, 14, 63, 64, 448, 1024])
def test_length_arithmetic_agrees(firmware_pack, raw_len):
    packed = protocol.packed_size(raw_len)
    assert firmware_pack.packed_len(raw_len) == packed
    assert firmware_pack.unpacked_len(packed) == raw_len


def test_firmware_unpacks_what_the_host_packs(firmware_pack):
    """The restore direction: host packs, firmware reads byte by byte."""
    for raw_len in (protocol.PATTERN_BYTES, protocol.TRACK_BYTES, protocol.CONFIG_BYTES):
        raw = bytes(random.randrange(256) for _ in range(raw_len))
        packed = _buffer(protocol.pack7(raw))
        got = bytes(firmware_pack.unpack_at(packed, i) for i in range(raw_len))
        assert got == raw, f"mismatch at raw length {raw_len}"


def test_host_unpacks_what_the_firmware_packs(firmware_pack):
    """The backup direction: firmware emits groups, host unpacks the stream."""
    for raw_len in (protocol.PATTERN_BYTES, protocol.TRACK_BYTES, protocol.CONFIG_BYTES):
        raw = bytes(random.randrange(256) for _ in range(raw_len))
        # Mirrors SysexSendRecord()'s loop: whole groups, then a short final one.
        wire = bytearray()
        for start in range(0, raw_len, 7):
            group = raw[start : start + 7]
            buf = _buffer(group)
            wire.append(firmware_pack.pack_msbs(buf, len(group)))
            wire.extend(b & 0x7F for b in group)
        assert protocol.unpack7(bytes(wire)) == raw


def test_all_high_bits_set(firmware_pack):
    """0xFF throughout is the case a sign-extension bug survives."""
    raw = b"\xff" * 448
    packed = _buffer(protocol.pack7(raw))
    assert bytes(firmware_pack.unpack_at(packed, i) for i in range(len(raw))) == raw


def test_packed_output_is_7bit_safe(firmware_pack):
    group = _buffer(b"\xff" * 7)
    assert firmware_pack.pack_msbs(group, 7) == 0x7F  # never sets bit 7
