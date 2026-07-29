"""`nava` command line tool.

    nava ports                 list MIDI ports
    nava build                 compile the firmware and emit a .syx
    nava hex2syx FILE.hex      convert an existing .hex to a bootloader .syx
    nava flash FILE.syx        push firmware to a Nava in bootloader mode
    nava backup                read patterns/tracks/config off the Nava
    nava restore FILE.syx      write a backup back to the Nava
    nava inspect FILE.syx      describe a .syx without a device attached
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from collections import Counter

from . import bootloader, ihex, midiio, protocol, selection

DEFAULT_ENV = "nava_sysex"
DEFAULT_FLASH_DELAY_MS = 250.0
DEFAULT_TIMEOUT = 3.0
DEFAULT_RETRIES = 2


class CommandError(Exception):
    """A user-facing failure; reported without a traceback."""


def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ----------------------------------------------------------------------------- ports


def cmd_ports(args) -> int:
    inputs, outputs = midiio.list_ports()
    print("MIDI inputs:")
    print("\n".join(f"  {i}: {n}" for i, n in enumerate(inputs)) or "  (none)")
    print("MIDI outputs:")
    print("\n".join(f"  {i}: {n}" for i, n in enumerate(outputs)) or "  (none)")
    return 0


# ----------------------------------------------------------------------------- build


def find_pio() -> str:
    found = shutil.which("pio") or shutil.which("platformio")
    if found:
        return found
    fallback = os.path.expanduser("~/.platformio/penv/bin/pio")
    if os.path.exists(fallback):
        return fallback
    raise CommandError(
        "PlatformIO not found. Install it with:\n"
        "    pip install platformio\n"
        "or pass an already-built .hex to `nava hex2syx`."
    )


def cmd_build(args) -> int:
    root = repo_root()
    pio = find_pio()
    print(f"Building {args.env} with {pio}")
    result = subprocess.run([pio, "run", "-e", args.env], cwd=root)
    if result.returncode != 0:
        raise CommandError(
            f"PlatformIO build failed (exit {result.returncode}).\n"
            "On Apple Silicon a 'Bad CPU type in executable' error means the AVR "
            "toolchain needs Rosetta:\n"
            "    softwareupdate --install-rosetta --agree-to-license"
        )

    hex_path = os.path.join(root, ".pio", "build", args.env, "firmware.hex")
    if not os.path.exists(hex_path):
        raise CommandError(f"build reported success but {hex_path} is missing")
    syx_path = args.output or hex_path[: -len(".hex")] + ".syx"
    _convert(hex_path, syx_path, args.page_words)
    return 0


def cmd_hex2syx(args) -> int:
    _convert(args.hexfile, args.output or args.hexfile[: -len(".hex")] + ".syx", args.page_words)
    return 0


def _convert(hex_path: str, syx_path: str, page_words: int) -> None:
    try:
        image = ihex.load_file(hex_path)
    except OSError as exc:
        raise CommandError(f"cannot read {hex_path}: {exc}") from exc
    except ihex.HexFileError as exc:
        raise CommandError(f"{hex_path}: {exc}") from exc

    stream = bootloader.encode_firmware(image, page_words)
    pages = len(image + b"\x00" * (-len(image) % (page_words * 2))) // (page_words * 2)
    with open(syx_path, "wb") as handle:
        handle.write(stream)
    print(
        f"{syx_path}: {len(image)} bytes of flash in {pages} pages, "
        f"{len(stream)} bytes of SysEx"
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
        midiio.send_stream(ports, messages, args.delay_ms, progress=_progress("page"))
        print(f"\nSent in {time.monotonic() - started:.1f}s. The unit restarts on its own.")
    return 0


def _progress(unit: str):
    def report(done: int, total: int) -> None:
        print(f"\r  {unit} {done}/{total}", end="", flush=True)

    return report


# ----------------------------------------------------------------------------- backup


def _selected_items(args) -> list[tuple[int, int, int]]:
    """(request cmd, dump cmd, param) for everything the user asked for."""
    items: list[tuple[int, int, int]] = []
    want_all = args.all or not (args.patterns or args.tracks or args.config)

    if want_all or args.patterns:
        spec = args.patterns if args.patterns else "all"
        for number in selection.parse_patterns(spec):
            items.append((protocol.NAVA_PTRN_REQ, protocol.NAVA_PTRN_DMP, number))
    if want_all or args.tracks:
        spec = args.tracks if args.tracks else "all"
        for number in selection.parse_tracks(spec):
            items.append((protocol.NAVA_TRACK_REQ, protocol.NAVA_TRACK_DMP, number))
    if want_all or args.config:
        items.append((protocol.NAVA_CONFIG_REQ, protocol.NAVA_CONFIG_DMP, 0))
    return items


def cmd_backup(args) -> int:
    try:
        items = _selected_items(args)
    except ValueError as exc:
        raise CommandError(str(exc)) from exc

    print(
        "The Nava must be stopped and on the SysEx config page "
        "(SHIFT+TEMPO to it) so it is listening for requests."
    )
    collected = bytearray()
    failures: list[str] = []

    with midiio.open_ports(out_spec=args.out, in_spec=args.input) as ports:
        for index, (req_cmd, dump_cmd, param) in enumerate(items, start=1):
            label = _item_label(dump_cmd, param)
            print(f"\r  {index}/{len(items)}  {label}      ", end="", flush=True)
            try:
                message = midiio.request_dump(
                    ports, req_cmd, param, args.timeout, args.retries
                )
            except midiio.MidiError as exc:
                failures.append(f"{label}: {exc}")
                continue
            collected += protocol.encode(message.cmd, message.param, message.payload)
    print()

    # A partial backup is still written: 120 good patterns are worth keeping, and
    # silently discarding them because one timed out would be the worse failure.
    if collected:
        with open(args.output, "wb") as handle:
            handle.write(collected)
        print(f"{args.output}: {len(protocol.split_messages(bytes(collected)))} items, "
              f"{len(collected)} bytes")

    if failures:
        print(f"\n{len(failures)} item(s) failed:", file=sys.stderr)
        for failure in failures:
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

    with midiio.open_ports(out_spec=args.out, in_spec=args.input) as ports:
        for index, message in enumerate(dumps, start=1):
            label = _item_label(message.cmd, message.param)
            print(f"\r  {index}/{len(dumps)}  {label}      ", end="", flush=True)
            raw = protocol.encode(message.cmd, message.param, message.payload)
            try:
                midiio.send_dump(ports, raw, args.timeout, args.retries)
            except midiio.MidiError as exc:
                print()
                raise CommandError(f"{label}: {exc}") from exc
    print("\nDone. Patterns load from EEPROM on the next bank change.")
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

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (CommandError, midiio.MidiError, protocol.ProtocolError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except FileNotFoundError as exc:
        print(f"error: {exc.filename}: no such file", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
