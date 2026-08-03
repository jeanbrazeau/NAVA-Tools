"""Compiling firmware and converting it to a bootloader image.

PlatformIO is replaced with a shell script that writes the .hex a real build
would leave behind, so the parts under test are the ones this package owns:
finding the checkout, streaming output while the build runs, and converting the
result. Compiling AVR code for real belongs to the simulator suite, not here.
"""

import os
import stat

import pytest

from nava import bootloader, building, ihex

FLASH = b"\x11\x22\x33\x44"


def hex_record(kind: int, address: int, data: bytes) -> str:
    """One Intel HEX record with its checksum computed, not typed by hand."""
    body = bytes([len(data), (address >> 8) & 0xFF, address & 0xFF, kind]) + data
    return ":" + (body + bytes([(-sum(body)) & 0xFF])).hex().upper()


# Two words of program text, enough to make one short page.
HEX_LINES = "\n".join([hex_record(0, 0, FLASH), hex_record(1, 0, b"")]) + "\n"


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    """A directory that looks like a clone: platformio.ini, and a `pio` on PATH
    that produces the .hex the real one would."""
    (tmp_path / "platformio.ini").write_text("[env:nava_sysex]\n")
    out_dir = tmp_path / ".pio" / "build" / "nava_sysex"

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    pio = bin_dir / "pio"
    pio.write_text(
        "#!/bin/sh\n"
        'echo "Building nava_sysex"\n'
        f"mkdir -p '{out_dir}'\n"
        f"printf '{HEX_LINES}' > '{out_dir}/firmware.hex'\n"
        'echo "RAM:   [====      ]  42.0%"\n'
    )
    pio.chmod(pio.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", str(bin_dir), prepend=os.pathsep)
    return tmp_path


def test_build_emits_a_syx_beside_the_hex(checkout):
    built = building.build(root=str(checkout))
    assert built.syx_path.endswith(os.path.join(".pio", "build", "nava_sysex", "firmware.syx"))
    assert os.path.exists(built.syx_path)
    assert built.flash_bytes == 4
    assert built.pages == 1


def test_built_syx_decodes_back_to_the_compiled_image(checkout):
    """The whole point of the conversion: what comes out must be what the
    bootloader will write to flash."""
    built = building.build(root=str(checkout))
    with open(built.syx_path, "rb") as handle:
        stream = handle.read()
    image = bootloader.decode_firmware(stream)
    assert image[:4] == FLASH
    assert len(image) == built.pages * bootloader.DEFAULT_PAGE_WORDS * 2


def test_build_streams_output_while_it_runs(checkout):
    lines: list[str] = []
    building.build(root=str(checkout), on_line=lines.append)
    assert any("Building nava_sysex" in line for line in lines)
    assert any("RAM:" in line for line in lines)


def test_output_path_can_be_chosen(checkout, tmp_path):
    target = str(tmp_path / "elsewhere.syx")
    built = building.build(root=str(checkout), output=target)
    assert built.syx_path == target
    assert os.path.exists(target)


def test_failed_build_names_the_rosetta_case(tmp_path, monkeypatch):
    """A non-zero exit on Apple Silicon is nearly always the x86-only AVR
    toolchain, and 'Bad CPU type' on its own tells the user nothing."""
    (tmp_path / "platformio.ini").write_text("[env:nava_sysex]\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    pio = bin_dir / "pio"
    pio.write_text("#!/bin/sh\necho 'Bad CPU type in executable' >&2\nexit 1\n")
    pio.chmod(pio.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", str(bin_dir), prepend=os.pathsep)

    with pytest.raises(building.BuildError, match="rosetta"):
        building.build(root=str(tmp_path))


def test_missing_hex_is_not_reported_as_success(tmp_path, monkeypatch):
    (tmp_path / "platformio.ini").write_text("[env:nava_sysex]\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    pio = bin_dir / "pio"
    pio.write_text("#!/bin/sh\nexit 0\n")
    pio.chmod(pio.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", str(bin_dir), prepend=os.pathsep)

    with pytest.raises(building.BuildError, match="missing"):
        building.build(root=str(tmp_path))


def test_checkout_is_found_by_walking_up_from_the_cwd(tmp_path, monkeypatch):
    """An installed nava lives under site-packages, so package-relative lookup
    alone finds nothing however deep in a clone the user is standing."""
    (tmp_path / "platformio.ini").write_text("[env:nava_sysex]\n")
    deep = tmp_path / "downtown-solutions_firmware" / "src" / "SPI"
    deep.mkdir(parents=True)
    monkeypatch.chdir(deep)
    assert building.checkout_root() == str(tmp_path.resolve())


def test_cwd_outside_any_checkout_falls_back_to_the_package(tmp_path, monkeypatch):
    """Run from somewhere unrelated, an installed copy still has to report no
    checkout rather than picking up whatever is above the working directory."""
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    monkeypatch.setattr(building, "repo_root", lambda: str(tmp_path / "nowhere"))
    assert building.checkout_root() is None


def test_installed_copy_reports_no_checkout(tmp_path):
    """An installed nava sits under site-packages with no firmware anywhere near
    it. That has to be a clear message about downloading instead, not a
    PlatformIO error from a directory with nothing to build."""
    assert building.checkout_root(str(tmp_path)) is None
    with pytest.raises(building.BuildError, match="download a released build"):
        building.build(root=str(tmp_path))


def test_checkout_is_keyed_on_platformio_ini(tmp_path):
    assert building.checkout_root(str(tmp_path)) is None
    (tmp_path / "platformio.ini").write_text("")
    assert building.checkout_root(str(tmp_path)) == str(tmp_path)


def test_convert_rejects_a_file_that_is_not_intel_hex(tmp_path):
    bad = tmp_path / "not.hex"
    bad.write_text("this is not a hex file\n")
    with pytest.raises((building.BuildError, ihex.HexFileError)):
        building.convert(str(bad), str(tmp_path / "out.syx"))
