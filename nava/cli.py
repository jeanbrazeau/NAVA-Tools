"""`nava` command line tool.

    nava ports                 list MIDI ports
    nava build                 compile the firmware and emit a .syx
    nava hex2syx FILE.hex      convert an existing .hex to a bootloader .syx
    nava flash FILE.syx        push firmware to a Nava in bootloader mode
    nava backup                read patterns/tracks/config off the Nava
    nava restore FILE.syx      write a backup back to the Nava
    nava inspect FILE.syx      describe a .syx without a device attached
    nava release 0.92          bump the firmware version, tag it and push
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections import Counter

from . import (
    bootloader,
    building,
    library,
    midiio,
    protocol,
    publish,
    records,
    releases,
    render,
    selection,
    transfer,
)

DEFAULT_ENV = "nava_sysex"
DEFAULT_FLASH_DELAY_MS = 250.0
DEFAULT_TIMEOUT = 3.0
DEFAULT_RETRIES = 2


class CommandError(Exception):
    """A user-facing failure; reported without a traceback."""


# Build support lives in building.py, shared with the TUI. Re-exported because
# both names were part of this module's surface before the split.
repo_root = building.repo_root
find_pio = building.find_pio


# ----------------------------------------------------------------------------- ports


def cmd_ports(args) -> int:
    inputs, outputs = midiio.list_ports()
    print("MIDI inputs:")
    print("\n".join(f"  {i}: {n}" for i, n in enumerate(inputs)) or "  (none)")
    print("MIDI outputs:")
    print("\n".join(f"  {i}: {n}" for i, n in enumerate(outputs)) or "  (none)")
    return 0


# ----------------------------------------------------------------------------- build


def cmd_build(args) -> int:
    print(f"Building {args.env}")
    built = building.build(args.env, args.output, args.page_words, on_line=print)
    _report(built)
    return 0


def cmd_hex2syx(args) -> int:
    _report(building.convert(
        args.hexfile,
        args.output or args.hexfile[: -len(".hex")] + ".syx",
        args.page_words,
    ))
    return 0


def _report(built: building.Built) -> None:
    print(
        f"{built.syx_path}: {built.flash_bytes} bytes of flash in {built.pages} "
        f"pages, {built.syx_bytes} bytes of SysEx"
    )


# ----------------------------------------------------------------------------- flash


def cmd_flash(args) -> int:
    with open(args.syxfile, "rb") as handle:
        stream = handle.read()

    try:
        image = bootloader.decode_firmware(stream, args.page_words)
    except ValueError as exc:
        raise CommandError(
            f"{args.syxfile} is not a Nava bootloader image: {exc}\n"
            "To send a pattern backup use `nava restore` instead."
        ) from exc

    messages = protocol.split_messages(stream)
    print(f"{args.syxfile}: {len(image)} bytes of flash in {len(messages) - 1} pages")
    print(
        "The Nava must already be in bootloader mode "
        "(stop the sequencer, SHIFT+TEMPO to the BOOTLOADER page, press the encoder)."
    )

    with midiio.open_ports(out_spec=args.out) as ports:
        started = time.monotonic()
        transfer.flash(ports, messages, args.delay_ms, progress=_progress)
        print(f"\nSent in {time.monotonic() - started:.1f}s. The unit restarts on its own.")
    return 0


def _progress(done: int, total: int, label: str) -> None:
    print(f"\r  {label}/{total}", end="", flush=True)


# ----------------------------------------------------------------------------- backup


def _selected_items(args) -> list[transfer.Selection]:
    """Everything the user asked for, as request/dump pairs."""
    want_all = args.all or not (args.patterns or args.tracks or args.config)
    patterns = selection.parse_patterns(
        args.patterns if args.patterns else "all"
    ) if (want_all or args.patterns) else []
    tracks = selection.parse_tracks(
        args.tracks if args.tracks else "all"
    ) if (want_all or args.tracks) else []
    return transfer.selections(patterns, tracks, config=want_all or args.config)


def cmd_backup(args) -> int:
    try:
        items = _selected_items(args)
    except ValueError as exc:
        raise CommandError(str(exc)) from exc

    print(
        "The Nava must be stopped and on the SysEx config page "
        "(SHIFT+TEMPO to it) so it is listening for requests."
    )

    def report(done: int, total: int, label: str) -> None:
        print(f"\r  {done}/{total}  {label}      ", end="", flush=True)

    with midiio.open_ports(out_spec=args.out, in_spec=args.input) as ports:
        outcome = transfer.backup(ports, items, args.timeout, args.retries, progress=report)
    print()

    if outcome.collected:
        with open(args.output, "wb") as handle:
            handle.write(outcome.collected)
        print(f"{args.output}: {len(protocol.split_messages(outcome.collected))} items, "
              f"{len(outcome.collected)} bytes")

    if outcome.failures:
        print(f"\n{len(outcome.failures)} item(s) failed:", file=sys.stderr)
        for failure in outcome.failures:
            print(f"  {failure}", file=sys.stderr)
        raise CommandError("backup is incomplete")
    return 0


def _item_label(dump_cmd: int, param: int) -> str:
    if dump_cmd == protocol.NAVA_PTRN_DMP:
        return f"pattern {protocol.pattern_label(param)}"
    if dump_cmd == protocol.NAVA_TRACK_DMP:
        return f"track {param + 1}"
    return "config"


# ----------------------------------------------------------------------------- restore


def cmd_restore(args) -> int:
    with open(args.file, "rb") as handle:
        stream = handle.read()

    try:
        messages = [protocol.decode(m) for m in protocol.split_messages(stream)]
    except protocol.ProtocolError as exc:
        raise CommandError(f"{args.file}: {exc}") from exc

    dumps = [m for m in messages if m.cmd in protocol.DUMP_PAYLOAD_SIZES]
    if not dumps:
        raise CommandError(f"{args.file} contains no pattern, track or config dumps")

    try:
        dumps = _filter_restore(dumps, args)
    except ValueError as exc:
        raise CommandError(str(exc)) from exc
    if not dumps:
        raise CommandError("the selection matched nothing in the file")

    if args.dry_run:
        for message in dumps:
            print(f"  would write {_item_label(message.cmd, message.param)}")
        print(f"{len(dumps)} item(s); nothing sent.")
        return 0

    print(
        f"Writing {len(dumps)} item(s) to the Nava. This overwrites the stored "
        "patterns it names."
    )
    print(
        "The Nava must be stopped and on the SysEx config page. "
        "Do not power it off mid-write."
    )

    def report(done: int, total: int, label: str) -> None:
        print(f"\r  {done}/{total}  {label}      ", end="", flush=True)

    with midiio.open_ports(out_spec=args.out, in_spec=args.input) as ports:
        outcome = transfer.restore(ports, dumps, args.timeout, args.retries, progress=report)
    print()

    if outcome.failures:
        raise CommandError("; ".join(outcome.failures))
    print("Done. Patterns load from EEPROM on the next bank change.")
    return 0


def _filter_restore(dumps, args):
    if not (args.patterns or args.tracks or args.config):
        return dumps
    wanted_patterns = set(selection.parse_patterns(args.patterns)) if args.patterns else set()
    wanted_tracks = set(selection.parse_tracks(args.tracks)) if args.tracks else set()
    out = []
    for message in dumps:
        if message.cmd == protocol.NAVA_PTRN_DMP and message.param in wanted_patterns:
            out.append(message)
        elif message.cmd == protocol.NAVA_TRACK_DMP and message.param in wanted_tracks:
            out.append(message)
        elif message.cmd == protocol.NAVA_CONFIG_DMP and args.config:
            out.append(message)
    return out


# ----------------------------------------------------------------------------- inspect


def cmd_inspect(args) -> int:
    with open(args.file, "rb") as handle:
        stream = handle.read()

    if stream.startswith(bytes([0xF0, 0x7D, 0x08])):
        image = bootloader.decode_firmware(stream, args.page_words)
        pages = len(protocol.split_messages(stream)) - 1
        print(f"{args.file}: firmware image, {len(image)} bytes of flash, {pages} pages")
        used = len(image.rstrip(b"\x00\xff"))
        print(f"  {used} bytes before the trailing padding")
        return 0

    messages = protocol.split_messages(stream)
    counts: Counter[str] = Counter()
    errors = 0
    patterns: list[int] = []
    for raw in messages:
        try:
            message = protocol.decode(raw)
        except protocol.ProtocolError as exc:
            errors += 1
            print(f"  corrupt message: {exc}", file=sys.stderr)
            continue
        counts[message.name] += 1
        if message.cmd == protocol.NAVA_PTRN_DMP:
            patterns.append(message.param)

    print(f"{args.file}: {len(messages)} message(s)")
    for name, count in sorted(counts.items()):
        print(f"  {count:4d}  {name}")
    if patterns:
        print(f"  patterns: {_summarise(patterns)}")
    if errors:
        raise CommandError(f"{errors} message(s) failed to decode")
    return 0


def cmd_show(args) -> int:
    """Print one decoded record from a backup, without a device attached."""
    syx = library.load(args.file)
    if syx.kind != library.KIND_BACKUP:
        raise CommandError(f"{args.file} is a {syx.kind} file, not a backup")

    wanted = args.item.strip().lower()
    if wanted == "config":
        item = next((i for i in syx.items if i.cmd == protocol.NAVA_CONFIG_DMP), None)
        if item is None:
            raise CommandError("this backup carries no config record")
        print("\n".join(render.config_lines(item.decoded())))
        return 0

    if wanted.startswith("track"):
        number = int(wanted.replace("track", "").strip() or 0) - 1
        item = next(
            (i for i in syx.items
             if i.cmd == protocol.NAVA_TRACK_DMP and i.param == number), None
        )
        if item is None:
            raise CommandError(f"this backup has no track {number + 1}")
        print("\n".join(render.track_lines(item.decoded(), number)))
        return 0

    try:
        number = protocol.parse_pattern_label(args.item)
    except ValueError as exc:
        raise CommandError(str(exc)) from exc
    item = next(
        (i for i in syx.items
         if i.cmd == protocol.NAVA_PTRN_DMP and i.param == number), None
    )
    if item is None:
        raise CommandError(
            f"this backup has no pattern {protocol.pattern_label(number)}"
        )

    print(
        render.pattern_text(
            item.decoded(),
            config=syx.config,
            title=f"{syx.name}  ›  {protocol.pattern_label(number)}",
        )
    )
    print()
    print(render.legend())
    return 0


def cmd_release(args) -> int:
    """Cut a release: bump the version, tag it, push. CI does the rest."""
    root = building.checkout_root()
    tag = publish.release(
        args.version,
        remote=args.remote,
        branch=args.branch,
        dry_run=args.dry_run,
    )
    if args.dry_run:
        print("nothing was changed (--dry-run)")
        return 0

    slug = publish.remote_slug(root, args.remote) if root else None
    if slug:
        print(f"\nThe release workflow is building it now:")
        print(f"  https://github.com/{slug}/actions")
        print(f"  https://github.com/{slug}/releases/tag/{tag}")
    print("`nava tui` can download it from the Firmware tab once the run finishes.")
    return 0


def cmd_tui(args) -> int:
    try:
        from .tui.app import run
    except ImportError as exc:
        raise CommandError(
            f"the TUI needs textual: pip install textual\n  ({exc})"
        ) from exc
    return run(directory=args.directory)


def _summarise(numbers: list[int]) -> str:
    """Contiguous runs as A1-A16, so a 128-pattern backup prints on one line."""
    runs = []
    start = previous = numbers[0]
    for number in sorted(numbers)[1:]:
        if number == previous + 1:
            previous = number
            continue
        runs.append((start, previous))
        start = previous = number
    runs.append((start, previous))
    return ", ".join(
        protocol.pattern_label(a) if a == b
        else f"{protocol.pattern_label(a)}-{protocol.pattern_label(b)}"
        for a, b in runs
    )


# ----------------------------------------------------------------------------- parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nava",
        description="Build, flash and back up the Nava TR-909 replica.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_page_words(target):
        target.add_argument(
            "--page-words",
            type=int,
            default=bootloader.DEFAULT_PAGE_WORDS,
            help="flash page size in words (default: %(default)s)",
        )

    def add_device(target, needs_input: bool):
        target.add_argument("--out", required=True, metavar="PORT",
                            help="MIDI output port: index, exact name or substring")
        if needs_input:
            target.add_argument("--in", dest="input", required=True, metavar="PORT",
                                help="MIDI input port carrying the Nava's replies")
            target.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                                help="seconds to wait per reply (default: %(default)s)")
            target.add_argument("--retries", type=int, default=DEFAULT_RETRIES,
                                help="retries per item (default: %(default)s)")

    p_ports = sub.add_parser("ports", help="list MIDI ports")
    p_ports.set_defaults(func=cmd_ports)

    p_build = sub.add_parser("build", help="compile the firmware and emit a .syx")
    p_build.add_argument("--env", default=DEFAULT_ENV, help="PlatformIO env (default: %(default)s)")
    p_build.add_argument("-o", "--output", help="write the .syx here")
    add_page_words(p_build)
    p_build.set_defaults(func=cmd_build)

    p_hex = sub.add_parser("hex2syx", help="convert a .hex to a bootloader .syx")
    p_hex.add_argument("hexfile")
    p_hex.add_argument("-o", "--output")
    add_page_words(p_hex)
    p_hex.set_defaults(func=cmd_hex2syx)

    p_flash = sub.add_parser("flash", help="send firmware to a Nava in bootloader mode")
    p_flash.add_argument("syxfile")
    add_device(p_flash, needs_input=False)
    p_flash.add_argument("--delay-ms", type=float, default=DEFAULT_FLASH_DELAY_MS,
                         help="pause between pages (default: %(default)s)")
    add_page_words(p_flash)
    p_flash.set_defaults(func=cmd_flash)

    p_backup = sub.add_parser("backup", help="read patterns, tracks and config off the Nava")
    add_device(p_backup, needs_input=True)
    p_backup.add_argument("-o", "--output", required=True, metavar="FILE")
    p_backup.add_argument("--patterns", metavar="SPEC",
                          help="e.g. all, A1, A1-A16, C, A1,B3 (default: all)")
    p_backup.add_argument("--tracks", metavar="SPEC", help="e.g. all, 1, 1-4")
    p_backup.add_argument("--config", action="store_true", help="include the setup record")
    p_backup.add_argument("--all", action="store_true", help="everything (the default)")
    p_backup.set_defaults(func=cmd_backup)

    p_restore = sub.add_parser("restore", help="write a backup back to the Nava")
    p_restore.add_argument("file")
    add_device(p_restore, needs_input=True)
    p_restore.add_argument("--patterns", metavar="SPEC", help="restore only these")
    p_restore.add_argument("--tracks", metavar="SPEC", help="restore only these")
    p_restore.add_argument("--config", action="store_true", help="restore the setup record")
    p_restore.add_argument("--dry-run", action="store_true",
                           help="list what would be written and send nothing")
    p_restore.set_defaults(func=cmd_restore)

    p_inspect = sub.add_parser("inspect", help="describe a .syx file")
    p_inspect.add_argument("file")
    add_page_words(p_inspect)
    p_inspect.set_defaults(func=cmd_inspect)

    p_show = sub.add_parser("show", help="print a decoded pattern, track or config")
    p_show.add_argument("file")
    p_show.add_argument("item", help="a pattern (A1), a track (track 3) or 'config'")
    p_show.set_defaults(func=cmd_show)

    p_release = sub.add_parser(
        "release", help="bump the firmware version, tag it and push; CI publishes"
    )
    p_release.add_argument("version", help="the new version, e.g. 0.92")
    p_release.add_argument("--remote", default=publish.DEFAULT_REMOTE,
                           help="git remote to push to (default: %(default)s)")
    p_release.add_argument("--branch", default=publish.DEFAULT_BRANCH,
                           help="branch the release is cut from (default: %(default)s)")
    p_release.add_argument("--dry-run", action="store_true",
                           help="show what would happen and change nothing")
    p_release.set_defaults(func=cmd_release)

    p_tui = sub.add_parser("tui", help="browse backups and drive the device interactively")
    p_tui.add_argument("-d", "--directory", help="directory of .syx files to browse")
    p_tui.set_defaults(func=cmd_tui)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (CommandError, building.BuildError, publish.PublishError,
            releases.ReleaseError, midiio.MidiError, protocol.ProtocolError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except FileNotFoundError as exc:
        print(f"error: {exc.filename}: no such file", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
