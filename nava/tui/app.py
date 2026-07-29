"""The `nava tui` application.

Four panes, in the order the work usually happens: pick a port, look at what you
have, move data, flash firmware.

Every MIDI operation blocks - mido and the retry loops in transfer.py are
synchronous - so each runs in a worker thread and reports back through
`call_from_thread`. Nothing touches a port from the UI thread; a 20-second flash
would otherwise freeze the interface completely.

Destructive actions (restore, flash) go through a confirmation screen that names
what is about to be overwritten. Both write to a device that gives no
confirmation of its own, and a mistaken restore cannot be undone.
"""

from __future__ import annotations

import os

from textual import on, work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Header,
    Input,
    Label,
    ListItem,
    ListView,
    ProgressBar,
    RichLog,
    Static,
    TabbedContent,
    TabPane,
)
from textual.worker import get_current_worker

from .. import bootloader, library, midiio, protocol, records, render, selection, transfer
from . import settings as settings_store

DEFAULT_TIMEOUT = 3.0
DEFAULT_RETRIES = 2
DEFAULT_FLASH_DELAY_MS = 250.0

SYSEX_PAGE_HINT = (
    "Stop the sequencer and press SHIFT+TEMPO to the SysEx page (\"Type / select\") "
    "before transferring."
)


class ConfirmScreen(ModalScreen[bool]):
    """A yes/no gate for something that cannot be undone."""

    BINDINGS = [("escape", "dismiss(False)", "Cancel")]

    def __init__(self, title: str, body: str, confirm_label: str = "Continue"):
        super().__init__()
        self._title = title
        self._body = body
        self._confirm_label = confirm_label

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm-box"):
            yield Label(self._title, classes="panel-title warning")
            yield Static(self._body)
            with Horizontal(id="confirm-buttons"):
                yield Button("Cancel", id="cancel")
                yield Button(self._confirm_label, variant="error", id="confirm")

    @on(Button.Pressed, "#confirm")
    def _confirm(self) -> None:
        self.dismiss(True)

    @on(Button.Pressed, "#cancel")
    def _cancel(self) -> None:
        self.dismiss(False)


class NavaApp(App):
    CSS_PATH = "app.tcss"
    TITLE = "nava"

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("r", "refresh", "Refresh"),
        ("escape", "stop_work", "Stop"),
    ]

    def __init__(self, directory: str | None = None):
        super().__init__()
        self.settings = settings_store.load()
        if directory:
            self.settings["directory"] = os.path.abspath(directory)
        elif not self.settings.get("directory"):
            self.settings["directory"] = os.getcwd()
        self.files: list[library.SyxFile] = []
        self.current_file: library.SyxFile | None = None
        self._cancel = False

    # ---------------------------------------------------------------- layout

    def compose(self) -> ComposeResult:
        yield Header()
        with TabbedContent(initial="tab-device"):
            with TabPane("Device", id="tab-device"):
                yield Static(
                    "Pick the ports the Nava is on. Names, not indices - an index "
                    "moves whenever a USB device is added or removed.",
                    id="device-hint",
                )
                with Horizontal(id="device-body"):
                    with Vertical(classes="port-column", id="out-column"):
                        yield Label("MIDI out  (to the Nava)", classes="column-title")
                        yield ListView(id="out-ports")
                    with Vertical(classes="port-column", id="in-column"):
                        yield Label("MIDI in  (replies)", classes="column-title")
                        yield ListView(id="in-ports")

            with TabPane("Browse", id="tab-browse"):
                with Horizontal(id="browse-body"):
                    with Vertical(id="file-pane"):
                        yield Input(
                            value=self.settings["directory"],
                            placeholder="directory",
                            id="dir-input",
                        )
                        yield ListView(id="files")
                    with Vertical(id="item-pane"):
                        yield DataTable(id="items", cursor_type="row")
                    with VerticalScroll(id="detail-pane"):
                        yield Static(id="detail-grid")

            with TabPane("Transfer", id="tab-transfer"):
                with Vertical(classes="panel"):
                    yield Label("Back up from the Nava", classes="panel-title")
                    with Horizontal(classes="action-row"):
                        yield Input(value="all", placeholder="patterns: all, C, A1-A16", id="dump-patterns")
                        yield Input(value="all", placeholder="tracks: all, 1-4", id="dump-tracks")
                        yield Button("Dump", variant="primary", id="do-dump")
                    with Horizontal(classes="action-row"):
                        yield Input(placeholder="write to file…", id="dump-output")
                with Vertical(classes="panel"):
                    yield Label("Restore to the Nava", classes="panel-title")
                    with Horizontal(classes="action-row"):
                        yield Input(placeholder="backup .syx to send", id="restore-file")
                        yield Button("Restore", variant="error", id="do-restore")
                yield ProgressBar(id="transfer-progress", show_eta=False)
                yield RichLog(id="transfer-log", markup=True, wrap=True)

            with TabPane("Firmware", id="tab-firmware"):
                with Vertical(classes="panel"):
                    yield Label("Flash firmware", classes="panel-title")
                    with Horizontal(classes="action-row"):
                        yield Input(
                            value=self.settings.get("firmware") or "",
                            placeholder="firmware .syx",
                            id="firmware-file",
                        )
                        yield Button("Inspect", id="do-inspect")
                        yield Button("Flash", variant="error", id="do-flash")
                    yield Static(
                        "Put the Nava in bootloader mode first: stop the sequencer, "
                        "SHIFT+TEMPO to the BOOTLOADER page, press the encoder. "
                        "The panel will not react afterwards - it is no longer "
                        "running the firmware.",
                        classes="muted",
                    )
                yield ProgressBar(id="firmware-progress", show_eta=False)
                yield RichLog(id="firmware-log", markup=True, wrap=True)

        yield Static("", id="status")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#items", DataTable)
        table.add_columns("item", "contents")
        self.refresh_ports()
        self.refresh_files()
        self.update_status()

    # ---------------------------------------------------------------- status

    def update_status(self) -> None:
        out = self.settings.get("output_port") or "— no output —"
        inp = self.settings.get("input_port") or "— no input —"
        self.query_one("#status", Static).update(f"out: {out}    in: {inp}")

    def action_refresh(self) -> None:
        self.refresh_ports()
        self.refresh_files()

    def action_stop_work(self) -> None:
        self._cancel = True

    # ---------------------------------------------------------------- device

    def refresh_ports(self) -> None:
        out_list = self.query_one("#out-ports", ListView)
        in_list = self.query_one("#in-ports", ListView)
        out_list.clear()
        in_list.clear()
        try:
            inputs, outputs = midiio.list_ports()
        except midiio.MidiError as exc:
            out_list.append(ListItem(Label(str(exc), classes="error")))
            return
        if not outputs:
            out_list.append(ListItem(Label("(none found)", classes="muted")))
        for name in outputs:
            out_list.append(ListItem(Label(name), name=name))
        if not inputs:
            in_list.append(ListItem(Label("(none found)", classes="muted")))
        for name in inputs:
            in_list.append(ListItem(Label(name), name=name))

    @on(ListView.Selected, "#out-ports")
    def _pick_output(self, event: ListView.Selected) -> None:
        if event.item.name:
            self.settings["output_port"] = event.item.name
            settings_store.save(self.settings)
            self.update_status()

    @on(ListView.Selected, "#in-ports")
    def _pick_input(self, event: ListView.Selected) -> None:
        if event.item.name:
            self.settings["input_port"] = event.item.name
            settings_store.save(self.settings)
            self.update_status()

    # ---------------------------------------------------------------- browse

    def refresh_files(self) -> None:
        directory = self.query_one("#dir-input", Input).value or os.getcwd()
        self.files = library.scan(directory)
        listing = self.query_one("#files", ListView)
        listing.clear()
        if not self.files:
            listing.append(ListItem(Label("(no .syx files here)", classes="muted")))
            return
        for index, syx in enumerate(self.files):
            style = "warning" if syx.kind == library.KIND_FIRMWARE else ""
            listing.append(
                ListItem(
                    Label(f"{syx.name}\n  [dim]{syx.summary()}[/dim]", markup=True, classes=style),
                    name=str(index),
                )
            )

    @on(Input.Submitted, "#dir-input")
    def _change_directory(self) -> None:
        directory = self.query_one("#dir-input", Input).value
        if os.path.isdir(directory):
            self.settings["directory"] = os.path.abspath(directory)
            settings_store.save(self.settings)
            self.refresh_files()
        else:
            self.notify(f"not a directory: {directory}", severity="error")

    @on(ListView.Selected, "#files")
    def _pick_file(self, event: ListView.Selected) -> None:
        if event.item.name is None:
            return
        self.current_file = self.files[int(event.item.name)]
        self.populate_items()

    def populate_items(self) -> None:
        table = self.query_one("#items", DataTable)
        table.clear()
        detail = self.query_one("#detail-grid", Static)
        syx = self.current_file
        if syx is None:
            return

        if syx.kind == library.KIND_FIRMWARE:
            detail.update(
                f"{syx.name}\n\nFirmware image.\n"
                f"{syx.flash_bytes} bytes of flash in {syx.pages} pages.\n\n"
                "Send this from the Firmware tab, not from Restore."
            )
            self.query_one("#firmware-file", Input).value = syx.path
            return

        if syx.kind == library.KIND_UNKNOWN:
            detail.update(f"{syx.name}\n\nNot a Nava file.\n" + "\n".join(syx.errors))
            return

        config = syx.config
        for item in syx.items:
            if item.cmd == protocol.NAVA_PTRN_DMP:
                try:
                    summary = render.summarise_pattern(item.decoded())
                except records.RecordError as exc:
                    summary = f"corrupt: {exc}"
            elif item.cmd == protocol.NAVA_TRACK_DMP:
                track = item.decoded()
                summary = f"{len(track.used)} pattern(s)"
            else:
                summary = f"{config.bpm} BPM  {config.sync_name}" if config else "config"
            table.add_row(item.label, summary)

        detail.update(
            f"{syx.name}\n\n{syx.summary()}\n{syx.size} bytes\n\n"
            "Select an item on the left."
            + ("\n\n" + "\n".join(syx.errors) if syx.errors else "")
        )
        self.query_one("#restore-file", Input).value = syx.path

    @on(DataTable.RowHighlighted, "#items")
    def _show_item(self, event: DataTable.RowHighlighted) -> None:
        syx = self.current_file
        if syx is None or event.cursor_row < 0 or event.cursor_row >= len(syx.items):
            return
        item = syx.items[event.cursor_row]
        detail = self.query_one("#detail-grid", Static)
        try:
            decoded = item.decoded()
        except records.RecordError as exc:
            detail.update(f"{item.label}\n\ncorrupt record: {exc}")
            return

        if item.cmd == protocol.NAVA_PTRN_DMP:
            text = render.pattern_text(
                decoded, config=syx.config, title=f"{syx.name}  ›  {item.label}"
            )
            detail.update(text + "\n\n" + render.legend())
        elif item.cmd == protocol.NAVA_TRACK_DMP:
            detail.update("\n".join(render.track_lines(decoded, item.param)))
        else:
            detail.update("\n".join(render.config_lines(decoded)))

    # ---------------------------------------------------------------- shared

    def _ports_ready(self, need_input: bool, log_id: str) -> bool:
        log = self.query_one(log_id, RichLog)
        if not self.settings.get("output_port"):
            log.write("[red]No MIDI output selected — pick one on the Device tab.[/red]")
            return False
        if need_input and not self.settings.get("input_port"):
            log.write("[red]No MIDI input selected — pick one on the Device tab.[/red]")
            return False
        return True

    def _progress(self, bar_id: str, log_id: str):
        """Progress callback that marshals back onto the UI thread."""

        def report(done: int, total: int, label: str) -> None:
            self.call_from_thread(self._set_progress, bar_id, done, total, label, log_id)

        return report

    def _set_progress(self, bar_id: str, done: int, total: int, label: str, log_id: str) -> None:
        bar = self.query_one(bar_id, ProgressBar)
        bar.update(total=total, progress=done)
        # One line per item would scroll a 145-item backup past the point of being
        # readable; the bar carries the detail and the log carries the milestones.
        if total > 20 and done % 16 and done != total:
            return
        self.query_one(log_id, RichLog).write(f"  {done}/{total}  {label}")

    def _write(self, log_id: str, text: str) -> None:
        self.query_one(log_id, RichLog).write(text)

    def _finish(self, log_id: str, outcome: transfer.Outcome, done_text: str) -> None:
        log = self.query_one(log_id, RichLog)
        if outcome.failures:
            for failure in outcome.failures:
                log.write(f"[red]{failure}[/red]")
            self.notify("finished with errors", severity="error")
        else:
            log.write(f"[green]{done_text}[/green]")
            self.notify(done_text)

    # ---------------------------------------------------------------- backup

    @on(Button.Pressed, "#do-dump")
    def _start_dump(self) -> None:
        if not self._ports_ready(need_input=True, log_id="#transfer-log"):
            return
        try:
            patterns = selection.parse_patterns(
                self.query_one("#dump-patterns", Input).value or "all"
            )
            tracks = selection.parse_tracks(
                self.query_one("#dump-tracks", Input).value or "all"
            )
        except ValueError as exc:
            self._write("#transfer-log", f"[red]{exc}[/red]")
            return

        output = self.query_one("#dump-output", Input).value.strip()
        if not output:
            output = os.path.join(self.settings["directory"], "nava-backup.syx")
            self.query_one("#dump-output", Input).value = output

        items = transfer.selections(patterns, tracks, config=True)
        self._cancel = False
        self._write("#transfer-log", f"[b]Dumping {len(items)} item(s)[/b] — {SYSEX_PAGE_HINT}")
        self._run_backup(items, output)

    @work(thread=True, exclusive=True, group="midi")
    def _run_backup(self, items: list[transfer.Selection], output: str) -> None:
        worker = get_current_worker()
        try:
            with midiio.open_ports(
                out_spec=self.settings["output_port"],
                in_spec=self.settings["input_port"],
            ) as ports:
                outcome = transfer.backup(
                    ports, items, DEFAULT_TIMEOUT, DEFAULT_RETRIES,
                    progress=self._progress("#transfer-progress", "#transfer-log"),
                    should_stop=lambda: self._cancel or worker.is_cancelled,
                )
        except midiio.MidiError as exc:
            self.call_from_thread(self._write, "#transfer-log", f"[red]{exc}[/red]")
            return

        if outcome.collected:
            try:
                with open(output, "wb") as handle:
                    handle.write(outcome.collected)
            except OSError as exc:
                self.call_from_thread(self._write, "#transfer-log", f"[red]{exc}[/red]")
                return
            count = len(protocol.split_messages(outcome.collected))
            self.call_from_thread(
                self._write, "#transfer-log",
                f"wrote {output} — {count} item(s), {len(outcome.collected)} bytes",
            )
        self.call_from_thread(self._finish, "#transfer-log", outcome, "Backup complete")
        self.call_from_thread(self.refresh_files)

    # --------------------------------------------------------------- restore

    @on(Button.Pressed, "#do-restore")
    def _restore_pressed(self) -> None:
        self._start_restore()

    # An async worker, not a plain handler: push_screen_wait() needs an active
    # worker to suspend in, and raises NoActiveWorker from a message handler.
    # Its own group, so it is not cancelled by the exclusive transfer worker it
    # goes on to start.
    @work(group="ui")
    async def _start_restore(self) -> None:
        if not self._ports_ready(need_input=True, log_id="#transfer-log"):
            return
        path = self.query_one("#restore-file", Input).value.strip()
        if not path:
            self._write("#transfer-log", "[red]No backup file given.[/red]")
            return
        try:
            syx = library.load(path)
        except OSError as exc:
            self._write("#transfer-log", f"[red]{exc}[/red]")
            return

        if syx.kind == library.KIND_FIRMWARE:
            self._write(
                "#transfer-log",
                "[red]That is a firmware image, not a backup. Use the Firmware tab.[/red]",
            )
            return
        if not syx.items:
            self._write("#transfer-log", "[red]No dumps in that file.[/red]")
            return

        patterns = len(syx.patterns())
        confirmed = await self.push_screen_wait(
            ConfirmScreen(
                "Overwrite patterns on the Nava?",
                f"{syx.name}\n\n{syx.summary()}\n\n"
                f"This replaces {patterns} stored pattern(s) on the device. "
                "It cannot be undone — dump a backup first if you have not.\n\n"
                + SYSEX_PAGE_HINT,
                confirm_label="Overwrite",
            )
        )
        if not confirmed:
            return

        dumps = [protocol.Message(i.cmd, i.param, i.payload) for i in syx.items]
        self._cancel = False
        self._write("#transfer-log", f"[b]Restoring {len(dumps)} item(s) from {syx.name}[/b]")
        self._run_restore(dumps)

    @work(thread=True, exclusive=True, group="midi")
    def _run_restore(self, dumps: list[protocol.Message]) -> None:
        worker = get_current_worker()
        try:
            with midiio.open_ports(
                out_spec=self.settings["output_port"],
                in_spec=self.settings["input_port"],
            ) as ports:
                outcome = transfer.restore(
                    ports, dumps, DEFAULT_TIMEOUT, DEFAULT_RETRIES,
                    progress=self._progress("#transfer-progress", "#transfer-log"),
                    should_stop=lambda: self._cancel or worker.is_cancelled,
                )
        except midiio.MidiError as exc:
            self.call_from_thread(self._write, "#transfer-log", f"[red]{exc}[/red]")
            return
        self.call_from_thread(
            self._finish, "#transfer-log", outcome,
            "Restore complete — patterns load from EEPROM on the next bank change",
        )

    # -------------------------------------------------------------- firmware

    @on(Button.Pressed, "#do-inspect")
    def _inspect_firmware(self) -> None:
        path = self.query_one("#firmware-file", Input).value.strip()
        log = self.query_one("#firmware-log", RichLog)
        if not path:
            log.write("[red]No file given.[/red]")
            return
        try:
            syx = library.load(path)
        except OSError as exc:
            log.write(f"[red]{exc}[/red]")
            return
        if syx.kind != library.KIND_FIRMWARE:
            log.write(f"[red]{syx.name} is a {syx.kind} file, not firmware.[/red]")
            return
        log.write(
            f"{syx.name}: {syx.flash_bytes} bytes of flash in {syx.pages} pages "
            f"(~{syx.pages * DEFAULT_FLASH_DELAY_MS / 1000:.0f}s to send)"
        )

    @on(Button.Pressed, "#do-flash")
    def _flash_pressed(self) -> None:
        self._start_flash()

    @work(group="ui")
    async def _start_flash(self) -> None:
        if not self._ports_ready(need_input=False, log_id="#firmware-log"):
            return
        path = self.query_one("#firmware-file", Input).value.strip()
        log = self.query_one("#firmware-log", RichLog)
        if not path:
            log.write("[red]No file given.[/red]")
            return
        try:
            syx = library.load(path)
        except OSError as exc:
            log.write(f"[red]{exc}[/red]")
            return
        if syx.kind != library.KIND_FIRMWARE:
            log.write(
                f"[red]{syx.name} is a {syx.kind} file. "
                "Flashing a backup would brick the unit.[/red]"
            )
            return

        with open(path, "rb") as handle:
            messages = protocol.split_messages(handle.read())

        seconds = len(messages) * DEFAULT_FLASH_DELAY_MS / 1000
        confirmed = await self.push_screen_wait(
            ConfirmScreen(
                "Replace the firmware on the Nava?",
                f"{syx.name}\n\n{syx.flash_bytes} bytes in {syx.pages} pages, "
                f"about {seconds:.0f}s.\n\n"
                "The unit must already be in bootloader mode. Interrupting this "
                "leaves it with a partial image and it will need flashing again "
                "before it will run.\n\n"
                "Back up your patterns first if you have not — flashing does not "
                "erase them, but a failed recovery might.",
                confirm_label="Flash",
            )
        )
        if not confirmed:
            return

        self.settings["firmware"] = path
        settings_store.save(self.settings)
        self._cancel = False
        log.write(f"[b]Flashing {syx.name} — {len(messages)} messages[/b]")
        self._run_flash(messages)

    @work(thread=True, exclusive=True, group="midi")
    def _run_flash(self, messages: list[bytes]) -> None:
        worker = get_current_worker()
        try:
            with midiio.open_ports(out_spec=self.settings["output_port"]) as ports:
                outcome = transfer.flash(
                    ports, messages, DEFAULT_FLASH_DELAY_MS,
                    progress=self._progress("#firmware-progress", "#firmware-log"),
                    should_stop=lambda: self._cancel or worker.is_cancelled,
                )
        except midiio.MidiError as exc:
            self.call_from_thread(self._write, "#firmware-log", f"[red]{exc}[/red]")
            return
        self.call_from_thread(
            self._finish, "#firmware-log", outcome,
            "Sent. The unit restarts on its own.",
        )


def run(directory: str | None = None) -> int:
    NavaApp(directory=directory).run()
    return 0
