# `nava` — build, flash and back up the Nava

One command line tool for the three things that need a computer: turning a build
into something the bootloader accepts, pushing it over MIDI, and getting the
patterns off the machine before doing either.

## Install

With [uv](https://docs.astral.sh/uv/), from anywhere — no clone needed:

```bash
uv tool install "git+https://github.com/jeanbrazeau/nava-tools[tui]"
nava --help
```

That puts `nava` on your PATH in its own isolated environment. Drop `[tui]` if you
only want the command line.

A bare URL resolves to the repository's **default branch**. To install from a
branch or tag that has not been merged, name it:

```bash
uv tool install "git+https://github.com/jeanbrazeau/nava-tools@BRANCH[tui]"
```

To update or remove it:

```bash
uv tool upgrade nava-tools
uv tool uninstall nava-tools
```

Run it once without installing anything:

```bash
uvx --from "git+https://github.com/jeanbrazeau/nava-tools[tui]" nava tui
```

From a clone, working on the tools themselves:

```bash
uv sync                              # creates .venv from uv.lock
uv run nava tui
uv run pytest
```

`uv sync` installs the `dev` dependency group automatically, so the tests are
ready without naming an extra.

With pip instead:

```bash
pip install -e ".[tui]"
pip install -e . --group dev         # tests; needs pip >= 25.1
```

`nava hex2syx`, `nava inspect` and `nava show` work with no MIDI backend
installed; the commands that touch a port need `mido` and `python-rtmidi`, and
`nava tui` needs `textual` (the `tui` extra).

## Commands

| | |
|---|---|
| `nava tui` | interactive: browse backups, pick ports, dump, restore, download or build firmware, flash |
| `nava ports` | list MIDI inputs and outputs |
| `nava build` | compile with PlatformIO and emit a `.syx` |
| `nava hex2syx FILE.hex` | convert an existing `.hex` |
| `nava flash FILE.syx` | send firmware to a unit in bootloader mode |
| `nava backup` | read patterns, tracks and setup off the unit |
| `nava restore FILE.syx` | write a backup back |
| `nava inspect FILE.syx` | describe a file without a device attached |
| `nava show FILE.syx A1` | print one decoded pattern, track or the config |

## The TUI

```bash
nava tui                 # browses the current directory
nava tui -d ~/nava-backups
```

Four tabs, in the order the work usually happens.

**Device** picks the MIDI in and out ports. They are remembered by name in
`~/.config/nava/tui.json`, not by index — an index moves whenever a USB device is
added or removed, and a remembered index would silently point at a different
device.

**Browse** lists the `.syx` files in a directory, what each one holds, and decodes
whatever you select. Patterns render as a step grid:

```
backup-2026-07-29.syx  ›  C3

len 16  scale 1/16  shuffle 2  flam 0

        1 · · · 2 · · · 3 · · · 4 · · ·
BD      # . . . # . . . # . . . # . . .
SD      . . . . o . . . . . . . o . . .
CH      o o o o o o o o o o o o o o o o

ext MIDI  (16 steps)
T1 C3   # . . . . . . . # . . . . . . .

#  loud    o  soft    .  off    f  flam
```

Loud and soft are compared against each instrument's own two levels, not a global
threshold — the 909's table is not uniform, and CH at 80 is soft while BD at 50 is
loud. Ext lanes are labelled with note names when the backup carries a config
record to read the note map from. An ext layer shorter than the pattern is shown
repeating against the kit, which is what `extStepCount` does on the hardware.

Tracks show their pattern sequence; the config record shows tempo, sync, channels,
velocities and the ext note map.

**Transfer** dumps and restores.

**Firmware** gets an image and sends it. Two ways to get one, because most
installs can only use the first:

- **Download** fetches a published build from the
  [releases page](https://github.com/jeanbrazeau/Nava-Firmware/releases). The tag
  box takes `latest`, a tag such as `0.91b`, or the release title as the page
  shows it (`Nava 0.91b`) — that is what gets copied, so it is matched against
  the release titles when no tag matches. The file lands in the
  browse directory named for the release — `nava-0.91b.syx` — so two releases
  cannot overwrite each other, and it shows up under Browse afterwards.
- **Build** compiles the checkout with PlatformIO and converts the result. This
  needs `platformio.ini` next to the package, so it only works when `nava` is run
  from a clone; an installed copy says so instead of offering it. PlatformIO's
  output is streamed into the log as it compiles.

Either one fills in the file box, so the flow is Download (or Build) → Inspect →
Flash without typing a path.

Transfer and Firmware both name what they are about to overwrite and ask first —
neither is reversible, and the unit gives no confirmation of its own. A firmware
image and a backup are told apart by their SysEx header, so the TUI refuses to
flash a backup or restore a firmware image.

`esc` stops a transfer between items, never mid-item, so a cancel cannot leave a
half-written record on the device.

## Where the firmware lives

This repository is the host side only. The firmware itself, its simulator tests
and its release machinery are in
[jeanbrazeau/Nava-Firmware](https://github.com/jeanbrazeau/Nava-Firmware): the
version number lives in one file there (`downtown-solutions_firmware/version.h`),
`scripts/release.py` in that repository cuts a tag from it, and that repository's
CI builds the `.syx` this tool downloads and flashes.

Two commands here still want a firmware checkout, and say so rather than failing
obscurely when there is none: `nava build` shells out to PlatformIO against a
`platformio.ini`, and the TUI's Build button is offered only when it finds one.
Everything else — flash, backup, restore, inspect, show — needs no source at all.

### Finding the port

Names are not unique — an interface can present both `909/MPC` and `NAVA-909` —
so `nava` refuses an ambiguous substring rather than picking the first match.
Resolve by name, not by index: indices move whenever a USB device is added.

```bash
nava ports
nava flash firmware.syx --out NAVA-909
```

### Flashing

```bash
nava build                                     # .pio/build/nava_sysex/firmware.syx
nava flash .pio/build/nava_sysex/firmware.syx --out NAVA-909
```

Put the unit in bootloader mode first: stop the sequencer, **SHIFT + TEMPO** to
the `BOOTLOADER` page, then **SHIFT + encoder**. It saves everything to EEPROM and
silences the transport before jumping. The panel does not react afterwards —
it is no longer running the firmware — and the unit restarts on its own when the
transfer finishes.

The 250 ms default between pages is not politeness. The bootloader commits a
flash page per message and does not buffer a second one while erasing, so
pushing faster drops pages and reports nothing either way.

### Backup and restore

```bash
nava backup --out NAVA-909 --in NAVA-909 -o nava-backup.syx      # everything
nava backup --out NAVA-909 --in NAVA-909 -o bankC.syx --patterns C
nava restore nava-backup.syx --out NAVA-909 --in NAVA-909
nava restore nava-backup.syx --out NAVA-909 --in NAVA-909 --dry-run
```

Both need the unit **stopped and on the SysEx config page** (SHIFT + TEMPO to
`type / select`). That is where the firmware listens; anywhere else, requests are
ignored.

A backup is a plain `.syx` of dump messages, so `nava inspect` will describe one
and any SysEx utility can replay it. Restores are acknowledged per item and
retried, so a dropped message is not a silently missing pattern.

`--patterns` takes `all`, a bank letter (`C` = C1–C16), single patterns (`A1`),
ranges (`A1-A16`) and lists (`A1,B3,C`). `--tracks` takes `all`, `1`, `1-4`.

Entering the SysEx page flushes pending edits to EEPROM, and leaving it reloads
the current bank, so a restore takes effect without a power cycle.

## Protocol

Application messages are distinct from the bootloader's, so neither can be
mistaken for the other:

```
bootloader   F0 7D 08 08 02 <cmd> 00 <nibblized page + checksum> F7
application  F0 7D 07 1A <cmd> <param> <7-in-8 packed payload> <checksum> F7
```

| command | direction | payload |
|---|---|---|
| `0x41` pattern request | host → Nava | — (param = pattern 0–127) |
| `0x42` track request | host → Nava | — (param = track 0–15) |
| `0x43` config request | host → Nava | — |
| `0x40` bank request | host → Nava | — (param = bank 0–7; replies with 16 pattern dumps) |
| `0x45` full request | host → Nava | — (128 patterns, 16 tracks, config) |
| `0x01` pattern dump | either | 448 bytes |
| `0x02` track dump | either | 1024 bytes |
| `0x03` config dump | either | 64 bytes |
| `0x48` ack | Nava → host | — (param = status) |

Payloads are the EEPROM records verbatim, so a backup round-trips through any
firmware revision that adds fields inside the padding those records already
reserve. They are 7-in-8 packed (7 raw bytes → 8 MIDI bytes, the first holding
their high bits) rather than nibblized, which keeps a 1KB track record inside
one message the firmware can still reassemble in RAM. The checksum is over the
raw bytes, so mis-unpacking fails rather than storing garbage.

Ack status: `0` ok, `1` bad checksum, `2` wrong length, `3` bad parameter,
`4` busy. The device checksums an incoming record before writing any of it — a
rejected write leaves the old pattern intact rather than half-replaced.

## Tests

```bash
uv run pytest
```

Verified on CPython 3.10, 3.11 and 3.13.

No hardware needed. `tests/fakenava.py` models the device, and the round-trip
test backs up 145 items, wipes the model and restores it byte for byte.
`test_bootloader.py` reproduces the released `Nava0tone_0.90b.syx` exactly, which
is what pins the encoder to what the bootloader in flash actually decodes.
`test_records.py` decodes
hand-built byte images rather than round-tripping through an encoder — a decoder
checked against its own inverse proves nothing about whether either matches
`EEprom.ino`. `test_tui.py` drives the interface through Textual's test pilot,
including the confirmation gates.

What is NOT tested here is that `protocol.py` still agrees with the firmware —
that check needs the firmware headers, so it lives in the firmware repository
(`scripts/tests/`), which installs this package and compares the two. It fails on
the side that would have to change.
