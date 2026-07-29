"""The reference file is a released Nava image built by the original Python 2
hex2sysex.py. Reproducing it byte for byte is the only available proof that this
port encodes what the bootloader in flash actually decodes."""

import os
import zipfile

import pytest

from nava import bootloader

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REFERENCE_ZIP = os.path.join(REPO_ROOT, "Nava0tone_0.90b.syx.zip")


@pytest.fixture(scope="module")
def reference_syx():
    if not os.path.exists(REFERENCE_ZIP):
        pytest.skip("released reference image not present")
    with zipfile.ZipFile(REFERENCE_ZIP) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".syx"))
        return archive.read(name)


def test_reference_image_round_trips(reference_syx):
    image = bootloader.decode_firmware(reference_syx)
    assert bootloader.encode_firmware(image) == reference_syx


def test_reference_framing(reference_syx):
    messages = reference_syx.split(b"\xf7")[:-1]
    assert len(messages) == 257
    # 256 page messages of F0 + 6 header + 514 nibbles, then the reset message.
    assert all(len(m) + 1 == 522 for m in messages[:-1])
    assert messages[-1] + b"\xf7" == bytes.fromhex("f07d0808027f00f7")


def test_nibblize_round_trip():
    data = bytes(range(256))
    assert bootloader.denibblize(bootloader.nibblize(data)) == data


def test_nibblize_is_7bit_safe():
    assert all(b <= 0x0F for b in bootloader.nibblize(bytes(range(256))))


def test_denibblize_rejects_corruption():
    corrupt = bytearray(bootloader.nibblize(b"\x01\x02\x03"))
    corrupt[0] ^= 0x01
    with pytest.raises(ValueError, match="checksum mismatch"):
        bootloader.denibblize(bytes(corrupt))


def test_final_page_is_zero_padded():
    stream = bootloader.encode_firmware(b"\xff" * 10)
    image = bootloader.decode_firmware(stream)
    assert len(image) == 256
    assert image == b"\xff" * 10 + b"\x00" * 246


def test_empty_image_still_resets():
    assert bootloader.encode_firmware(b"") == bytes.fromhex("f07d0808027f00f7")
