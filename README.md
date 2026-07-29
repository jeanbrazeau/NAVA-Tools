# `nava` — build, flash and back up the Nava

One command line tool for the three things that need a computer: turning a build
into something the bootloader accepts, pushing it over MIDI, and getting the
patterns off the machine before doing either.

```
pip install -e tools          # or: pip install mido python-rtmidi
nava --help
```

`nava hex2syx` and `nava inspect` work with no MIDI backend installed; the
commands that touch a port need `mido` and `python-rtmidi`.

## Commands

| | |
|---|---|
| `nava ports` | list MIDI inputs and outputs |
| `nava build` | compile with PlatformIO and emit a `.syx` |
| `nava hex2syx FILE.hex` | convert an existing `.hex` |
| `nava flash FILE.syx` | send firmware to a unit in bootloader mode |
| `nava backup` | read patterns, tracks and setup off the unit |
| `nava restore FILE.syx` | write a backup back |
| `nava inspect FILE.syx` | describe a file without a device attached |

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
the `BOOTLOADER` page, press the encoder. The panel does not react afterwards —
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
pytest                      # from tools/
```

No hardware needed. `tests/fakenava.py` models the device, and the round-trip
test backs up 145 items, wipes the model and restores it byte for byte.
`test_bootloader.py` reproduces the released `Nava0tone_0.90b.syx` exactly, which
is what pins the encoder to what the bootloader in flash actually decodes.
`test_sysex_pack.py` compiles the firmware's own `sysex_pack.h` natively and
checks it against the host packer in both directions.
