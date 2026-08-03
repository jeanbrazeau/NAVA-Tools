"""The TUI is driven through Textual's own test pilot rather than by hand.

These cover the paths that lose data if they are wrong: classifying a file, so a
firmware image is never offered to Restore; refusing to flash a backup, which
would brick a unit; and decoding a pattern into the grid, which is the whole
point of browsing.
"""

import os

import pytest

from nava import bootloader, protocol, records
from nava.tui.app import ConfirmScreen, NavaApp

from textual.widgets import DataTable, Input, Label, RichLog, Static, TabbedContent

pytestmark = pytest.mark.asyncio


def detail_text(app) -> str:
    return str(app.query_one("#detail-grid", Static).content)


def log_text(app, log_id: str) -> str:
    """RichLog renders to Strips; joining their text is the stable way to read it."""
    return "\n".join(strip.text for strip in app.query_one(log_id, RichLog).lines)


async def show_tab(app, pilot, tab: str) -> None:
    """A button that is not on the active tab is not visible, and Pilot.click
    only reaches visible widgets."""
    app.query_one(TabbedContent).active = tab
    await pilot.pause()


def make_pattern(bd_steps: list[int], velocity: int = 50) -> bytes:
    buf = bytearray(protocol.PATTERN_BYTES)
    buf[records.OFF_SETUP + 0] = 15   # 16 steps
    buf[records.OFF_SETUP + 1] = 24   # 1/16
    mask = 0
    for step in bd_steps:
        mask |= 1 << step
        buf[records.OFF_VELOCITY + 8 * 16 + step] = velocity
    buf[records.OFF_INST + 2 * 8] = mask & 0xFF
    buf[records.OFF_INST + 2 * 8 + 1] = (mask >> 8) & 0xFF
    return bytes(buf)


def make_config() -> bytes:
    buf = bytearray(protocol.CONFIG_BYTES)
    buf[0:10] = bytes([0, 128, 1, 1, 1, 0, 3, 3, 63, 111])
    return bytes(buf)


@pytest.fixture
def library_dir(tmp_path, monkeypatch):
    """A directory holding one backup and one firmware image, with settings
    redirected so a test never writes to the real config."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))

    backup = bytearray()
    backup += protocol.encode(protocol.NAVA_PTRN_DMP, 0, make_pattern([0, 4, 8, 12]))
    backup += protocol.encode(protocol.NAVA_PTRN_DMP, 17, make_pattern([2, 6]))
    backup += protocol.encode(protocol.NAVA_TRACK_DMP, 0, bytes(protocol.TRACK_BYTES))
    backup += protocol.encode(protocol.NAVA_CONFIG_DMP, 0, make_config())
    (tmp_path / "backup.syx").write_bytes(bytes(backup))

    (tmp_path / "firmware.syx").write_bytes(bootloader.encode_firmware(b"\x01\x02\x03"))
    return tmp_path


async def test_lists_and_classifies_files(library_dir):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        assert {f.name for f in app.files} == {"backup.syx", "firmware.syx"}
        kinds = {f.name: f.kind for f in app.files}
        assert kinds["backup.syx"] == "backup"
        assert kinds["firmware.syx"] == "firmware"


async def test_selecting_a_backup_lists_its_items(library_dir):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.current_file = next(f for f in app.files if f.name == "backup.syx")
        app.populate_items()
        await pilot.pause()
        table = app.query_one("#items", DataTable)
        labels = [str(table.get_cell_at((row, 0))) for row in range(table.row_count)]
        assert labels == ["A1", "B2", "track 1", "config"]


async def test_highlighting_a_pattern_renders_the_grid(library_dir):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.current_file = next(f for f in app.files if f.name == "backup.syx")
        app.populate_items()
        await pilot.pause()

        table = app.query_one("#items", DataTable)
        table.move_cursor(row=0)
        await pilot.pause()

        text = detail_text(app)
        assert "A1" in text
        bd = next(line for line in text.splitlines() if line.startswith("BD"))
        # Steps 0, 4, 8, 12 at the loud level.
        assert [i for i, c in enumerate(bd.split()[1:]) if c == "#"] == [0, 4, 8, 12]
        assert "scale 1/16" in text


async def test_config_item_shows_decoded_settings(library_dir):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.current_file = next(f for f in app.files if f.name == "backup.syx")
        app.populate_items()
        await pilot.pause()
        app.query_one("#items", DataTable).move_cursor(row=3)
        await pilot.pause()
        text = detail_text(app)
        assert "128 BPM" in text
        assert "MASTER" in text


async def test_firmware_file_is_routed_to_the_firmware_tab(library_dir):
    """Selecting a firmware image must not leave it sitting in the Restore box."""
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.current_file = next(f for f in app.files if f.name == "firmware.syx")
        app.populate_items()
        await pilot.pause()
        assert app.query_one("#firmware-file", Input).value.endswith("firmware.syx")
        assert "Firmware image" in detail_text(app)


async def test_flashing_a_backup_is_refused(library_dir):
    """Sending pattern data to a unit in bootloader mode would write it to flash."""
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.settings["output_port"] = "fake port"
        await show_tab(app, pilot, "tab-firmware")
        app.query_one("#firmware-file", Input).value = str(library_dir / "backup.syx")
        await pilot.click("#do-flash")
        await pilot.pause()
        text = log_text(app, "#firmware-log")
        assert "not firmware" in text or "backup file" in text


async def test_restoring_a_firmware_image_is_refused(library_dir):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.settings["output_port"] = "fake port"
        app.settings["input_port"] = "fake port"
        await show_tab(app, pilot, "tab-transfer")
        app.query_one("#restore-file", Input).value = str(library_dir / "firmware.syx")
        await pilot.click("#do-restore")
        await pilot.pause()
        text = log_text(app, "#transfer-log")
        assert "firmware image" in text


async def test_transfer_without_a_port_says_so_instead_of_hanging(library_dir):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.settings["output_port"] = None
        await show_tab(app, pilot, "tab-transfer")
        await pilot.click("#do-dump")
        await pilot.pause()
        text = log_text(app, "#transfer-log")
        assert "No MIDI output selected" in text


async def test_bad_pattern_selection_is_reported(library_dir):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.settings["output_port"] = "fake"
        app.settings["input_port"] = "fake"
        await show_tab(app, pilot, "tab-transfer")
        app.query_one("#dump-patterns", Input).value = "Z9"
        await pilot.click("#do-dump")
        await pilot.pause()
        text = log_text(app, "#transfer-log")
        assert "unrecognised pattern" in text


async def test_flash_asks_before_overwriting_firmware(library_dir):
    """push_screen_wait() needs an active worker; called from a plain handler it
    raises NoActiveWorker and the confirmation never appears."""
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.settings["output_port"] = "fake port"
        await show_tab(app, pilot, "tab-firmware")
        app.query_one("#firmware-file", Input).value = str(library_dir / "firmware.syx")
        await pilot.click("#do-flash")
        for _ in range(5):
            await pilot.pause()
        assert isinstance(app.screen, ConfirmScreen)
        assert "Replace the firmware" in str(app.screen.query_one(Label).content)


async def test_cancelling_the_flash_sends_nothing(library_dir):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.settings["output_port"] = "fake port"
        await show_tab(app, pilot, "tab-firmware")
        app.query_one("#firmware-file", Input).value = str(library_dir / "firmware.syx")
        await pilot.click("#do-flash")
        for _ in range(5):
            await pilot.pause()
        await pilot.click("#cancel")
        for _ in range(5):
            await pilot.pause()
        assert not isinstance(app.screen, ConfirmScreen)
        # A cancelled flash must not have opened a port; "fake port" does not exist,
        # so any attempt would have logged an error.
        assert "error" not in log_text(app, "#firmware-log").lower()


async def test_restore_asks_before_overwriting_patterns(library_dir):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.settings["output_port"] = "fake port"
        app.settings["input_port"] = "fake port"
        await show_tab(app, pilot, "tab-transfer")
        app.query_one("#restore-file", Input).value = str(library_dir / "backup.syx")
        await pilot.click("#do-restore")
        for _ in range(5):
            await pilot.pause()
        assert isinstance(app.screen, ConfirmScreen)
        body = " ".join(str(w.content) for w in app.screen.query(Static))
        assert "cannot be undone" in body


async def test_settings_are_not_written_to_the_real_config(library_dir, monkeypatch):
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        app.settings["output_port"] = "something"
        from nava.tui import settings as settings_store

        settings_store.save(app.settings)
        assert str(library_dir / "config") in settings_store.settings_path()
        assert os.path.exists(settings_store.settings_path())


# --------------------------------------------------------------- firmware sources


async def test_download_fetches_a_release_and_arms_the_flash_row(library_dir, monkeypatch):
    """The whole point of the button: after it, Flash has something to send.

    The network is stubbed - what is under test is that the release the TUI
    asked for is the one written to disk, that it lands in the library
    directory under the release's own name, and that the file input ends up
    pointing at it."""
    from nava import releases
    from nava.tui import app as app_module

    asked: list[str] = []
    body = bootloader.encode_firmware(b"\x0a\x0b\x0c")

    def fake_fetch(tag=None, repo=releases.DEFAULT_REPO):
        asked.append(tag)
        return releases.Release(
            tag="0.91b", name="Nava 0.91b", prerelease=False, published="2026-07-28",
            assets=[releases.Asset("nava-0.91b.syx", "https://api/assets/2", len(body))],
        )

    def fake_download(asset, dest, progress=None):
        with open(dest, "wb") as handle:
            handle.write(body)
        if progress:
            progress(len(body), len(body), asset.name)
        return dest

    monkeypatch.setattr(app_module.releases, "fetch", fake_fetch)
    monkeypatch.setattr(app_module.releases, "download", fake_download)

    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        await show_tab(app, pilot, "tab-firmware")
        await pilot.click("#do-download")
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert asked == ["latest"]
        expected = str(library_dir / "nava-0.91b.syx")
        assert (library_dir / "nava-0.91b.syx").read_bytes() == body
        assert app.query_one("#firmware-file", Input).value == expected
        assert "Downloaded 0.91b" in log_text(app, "#firmware-log")


async def test_download_honours_a_named_tag(library_dir, monkeypatch):
    from nava import releases
    from nava.tui import app as app_module

    asked: list[str] = []

    def fake_fetch(tag=None, repo=releases.DEFAULT_REPO):
        asked.append(tag)
        raise releases.ReleaseError("not found: releases/tags/0.90b")

    monkeypatch.setattr(app_module.releases, "fetch", fake_fetch)

    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        await show_tab(app, pilot, "tab-firmware")
        app.query_one("#release-tag", Input).value = "0.90b"
        await pilot.click("#do-download")
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert asked == ["0.90b"]
        assert "not found" in log_text(app, "#firmware-log")


async def test_release_without_firmware_does_not_arm_the_flash_row(library_dir, monkeypatch):
    """A release carrying only notes must leave the file input alone rather
    than pointing it at something that is not an image."""
    from nava import releases
    from nava.tui import app as app_module

    monkeypatch.setattr(
        app_module.releases, "fetch",
        lambda tag=None, repo=None: releases.Release(
            tag="0.91b", name="n", prerelease=False, published="", 
            assets=[releases.Asset("notes.txt", "u", 3)],
        ),
    )
    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        await show_tab(app, pilot, "tab-firmware")
        app.query_one("#firmware-file", Input).value = ""
        await pilot.click("#do-download")
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert app.query_one("#firmware-file", Input).value == ""
        assert "no .syx" in log_text(app, "#firmware-log")


async def test_build_arms_the_flash_row_with_what_it_compiled(library_dir, monkeypatch):
    from nava.tui import app as app_module

    syx = library_dir / "compiled.syx"
    syx.write_bytes(bootloader.encode_firmware(b"\x01\x02"))

    monkeypatch.setattr(
        app_module.building, "checkout_root", lambda root=None: str(library_dir)
    )
    monkeypatch.setattr(
        app_module.building, "build",
        lambda **kw: app_module.building.Built(str(syx), "x.hex", 2, 1, len(syx.read_bytes())),
    )

    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        await show_tab(app, pilot, "tab-firmware")
        await pilot.click("#do-build")
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert app.query_one("#firmware-file", Input).value == str(syx)
        assert "Built 2 bytes" in log_text(app, "#firmware-log")


async def test_build_is_refused_when_there_is_no_checkout(library_dir, monkeypatch):
    """An installed nava has no firmware source. Saying so beats running
    PlatformIO in site-packages and reporting whatever it makes of that."""
    from nava.tui import app as app_module

    monkeypatch.setattr(app_module.building, "checkout_root", lambda root=None: None)
    called: list[int] = []
    monkeypatch.setattr(
        app_module.building, "build", lambda **kw: called.append(1)
    )

    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        await show_tab(app, pilot, "tab-firmware")
        await pilot.click("#do-build")
        await pilot.pause()

        assert not called
        assert "Nothing to build here" in log_text(app, "#firmware-log")
        assert "Build is unavailable" in str(
            app.query_one("#source-hint", Static).content
        )


async def test_build_failure_is_reported_not_raised(library_dir, monkeypatch):
    from nava.tui import app as app_module

    def boom(**kw):
        raise app_module.building.BuildError("PlatformIO build failed (exit 1).")

    monkeypatch.setattr(
        app_module.building, "checkout_root", lambda root=None: str(library_dir)
    )
    monkeypatch.setattr(app_module.building, "build", boom)

    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        await show_tab(app, pilot, "tab-firmware")
        await pilot.click("#do-build")
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert "PlatformIO build failed" in log_text(app, "#firmware-log")


async def test_downloaded_image_can_then_be_inspected(library_dir, monkeypatch):
    """Download -> Inspect -> Flash is the path a user without a clone takes;
    the middle step must recognise what the first one wrote."""
    from nava import releases
    from nava.tui import app as app_module

    body = bootloader.encode_firmware(bytes(300))
    monkeypatch.setattr(
        app_module.releases, "fetch",
        lambda tag=None, repo=None: releases.Release(
            tag="0.91b", name="n", prerelease=False, published="",
            assets=[releases.Asset("nava-0.91b.syx", "u", len(body))],
        ),
    )

    def fake_download(asset, dest, progress=None):
        with open(dest, "wb") as handle:
            handle.write(body)
        return dest

    monkeypatch.setattr(app_module.releases, "download", fake_download)

    app = NavaApp(directory=str(library_dir))
    async with app.run_test() as pilot:
        await pilot.pause()
        await show_tab(app, pilot, "tab-firmware")
        await pilot.click("#do-download")
        await app.workers.wait_for_complete()
        await pilot.pause()
        await pilot.click("#do-inspect")
        await pilot.pause()

        assert "bytes of flash in" in log_text(app, "#firmware-log")
