# `nava` — build, flash and back up the Nava

Two front ends over one protocol: a **web app** that needs nothing installed, and
a command line tool for the parts a browser cannot do.

Open it, allow MIDI, and back up your patterns, restore them, or flash firmware.
Nothing is uploaded: the page reads the `.syx` in the tab and talks to the unit
over Web MIDI.

> **Not published yet.** The site is built and tested but deliberately not
> deployed — see [Deploying the site](#deploying-the-site). To try it now, serve
> `web/` locally:
>
> ```bash
> uv run python tools/devserver.py        # http://127.0.0.1:8000
> ```

It needs a **Chromium-based browser** — Chrome, Edge, Opera, Brave, Arc, Helium,
Vivaldi. Web MIDI is a Chromium API; Safari and Firefox have no implementation,
so ports never appear there. The page feature-detects rather than sniffing the
user agent, so it says so plainly in whatever you open it in, and browsing and
decoding a backup works either way.

## The web app

Four panels, in the order the work usually happens.

**Device** picks the MIDI in and out ports. They are remembered by name in the
browser, not by index — an index moves whenever a USB device is added or
removed, and a remembered index would silently point at a different device.

**Browse** takes `.syx` files dropped on it and draws a pattern as the chart
printed on the machine: the voices down the left in the panel's own order, the
sixteen steps across, a heavier rule every fourth step.

A pattern is chosen the way the machine chooses one — a **BANK** selector and a
column of **PATTERN** buttons 1–16. Only the banks a file actually holds appear,
so a full backup offers A–H and a single-bank file offers one; a pattern slot the
file has nothing in is disabled rather than hidden, so the numbering never
shifts under you.

**INST.** and **EXT** are two views of the same sixteen columns, because they are
two machines sharing a sequencer: one drives the analogue voices, the other sends
notes on the ext channel. EXT lists all sixteen lanes, so T7 is in the same place
in every pattern, labelled with note names when the backup carries a config
record to read the note map from. They count up the page — T1 at the bottom, T16
at the top — which is the direction the kit next door is stacked in, BASS DRUM at
the foot and CRASH over everything. An ext loop shorter than the pattern repeats
against the kit — what `extStepCount` does on the hardware — with a dashed rule
marking where it starts over.

Loud and soft are compared against each instrument's own two levels, not a global
threshold: the 909's table is not uniform, and CH at 80 is soft while BD at 50 is
loud.

**Config / setup** is its own window showing tempo, sync, channels, velocities
and the ext note map. It shows itself rather than waiting to be picked: there
is exactly one config record per backup and it is what the patterns are played
through, so there is nothing to choose between and no reason for reading it to
cost the chart its place on screen — which is what it used to do, as a row
under the file list that swapped the Detail pane over. A file carrying no
config record gets no window at all rather than an empty one. Wide, it sits
under Files in the narrow column, beside the chart; stacked, it goes to the
bottom under the pattern editor, because on one column the editor is what you
came for and a wall of setup text above it is a wall to scroll past.
Track records are not viewable here — they are read, restored and saved like
everything else, but `nava show FILE.syx "track 3"` is what prints one.

A `.hex` dropped here is converted to a bootloader `.syx` on the way in, which is
`nava hex2syx` without the install.

**Editing.** Clicking a cell cycles it the way the panel does — off, soft, loud,
off — and shift-clicking sets the flam flag, which the level cycle has nowhere
to put. Steps past the last one are not editable: the machine will never play
them.

Click and drag along a lane to lay down a run. The cell the drag starts on
decides the value — it cycles, as a single click always did — and every cell the
pointer then crosses is set to that same thing. Cycling each cell as it is
crossed would make the result depend on whatever every step happened to hold
already, which is not something anyone can aim, and laying down a run of hats is
the whole point. The drag stays in the lane it began in; smearing across lanes
is never what was meant, and on a grid this dense it would be easy to do by
accident.

Edits write into the record's own bytes and touch nothing else. That is the
whole design, not tidiness: a backup round-trips through firmware revisions only
because records are carried verbatim, padding included, so rebuilding one from a
decoded pattern would silently zero every field this decoder does not know
about. `tests/web/edit.test.js` asserts it byte for byte — that the decoder
reads back what was clicked, and that the reserved regions never move.

**Where the loop ends** is a rule through the whole grid with a ◀ handle on it,
dragged to set the pattern's length. That is the one thing about a pattern you
want to see against the steps rather than read off a number beside them; the
LAST STEP readout stays, because a drag is not pixel-precise and the number is
where you confirm what you landed on. The grid reshapes under the pointer —
columns past the end are struck through and stop being editable, and the ext
wrap markers move too, since a record whose own ext-length byte is 0 takes its
ext loop length from the pattern length. The LAST STEP readout sits last in the
row under the grid, hard right: it reports the handle, and the handle is at the
right-hand end of the same rectangle.

**SHUFFLE and FLAM** are eight indicator circles apiece rather than a number.
They are detents on a rotary, not quantities — nothing scales them and no other
field reads them — so "5" says nothing about how far round that is where eight
circles with one filled says it at a glance.

The whole strip is the control, not the eight circles on it: press anywhere
along it, gaps and the slack above and below included, and the dial goes to
whichever circle the pointer is nearest and follows it until it lifts. An 8px
circle is a hard thing to hit and a harder thing to hit eight times while
comparing them, and the gesture a knob wants is a sweep. One sweep is one undo
entry, the same as a paint stroke or a length drag. The arrow keys, Home and
End turn it from the keyboard, which is what a radio group is expected to
answer to.

Landing on the position it is already in writes nothing. That matters more than
it sounds: a drag crosses the filled circle constantly, and each crossing would
otherwise rewrite the same byte and mark a clean file unsaved for an edit that
did nothing. A byte past the eighth position can only come from a record the
machine never wrote, and a blank 0xFF slot decodes that way: it fills no circle
and prints the raw number, instead of quietly showing position 0.

**SCALE** sits between FLAM and LAST STEP and can be picked rather than only
read: all four of the divisions the switch on the machine has are on show —
1/16, 1/32, 1/16t, 1/8t, in that order, which is neither the order of
resolution nor the order a JS object hands back integer keys, so
`records.SCALE_ORDER` writes it down. Not a dial, though it sits beside two:
these are four names, not detents you sweep past, so they are named buttons and
the chosen one is an invert. Anything but those four PPQN values is refused
rather than clamped; there is no nearest sensible division, and an arbitrary
one would make a pattern the panel cannot show. SHUFFLE, FLAM and SCALE are the
three things about a pattern you set rather than read, which is why they are
together and why LAST STEP is across the row from them.

**↶ and ↷** in the corner of the Detail pane undo and redo, as do <kbd>Cmd</kbd>
or <kbd>Ctrl</kbd> + <kbd>Z</kbd> and <kbd>Shift</kbd> + that. One entry per
gesture: a drag across sixteen cells undoes as the one action it looked like,
and so does a length drag. Whole-record snapshots rather than inverted edits —
448 bytes is nothing, and an inverse that was wrong for one cycle would corrupt
a record nothing downstream would question until it reached a machine.

The history is one timeline across every file, which is what a single pair of
arrows implies, so an undo can land on a pattern that is not on screen. It
selects that pattern before redrawing: an undo you cannot see is
indistinguishable from one that did nothing.

Nothing is written to the file it came from. "Edited" means the bytes differ
from how the file was loaded, compared byte for byte rather than remembering
that a click happened — so undoing back to the start clears the marker, and
saving moves the baseline. Save… writes the file out, and the tab asks before
closing on top of unsaved work.

**Transfer** dumps and restores. A dump asks where to save before it starts —
a full backup takes minutes, and the browser will not open a file dialog that
late.

**Firmware** gets a published build and sends it. The tag box takes `latest`, a
tag such as `0.91b`, or the release title as the page shows it (`Nava 0.91b`) —
that is what gets copied, so it is matched against the release titles when no
tag matches. Add `?repo=owner/name` to the URL to point it at a fork; that is
the browser's `NAVA_REPO`, and a link carries it.

Getting the image works two ways, and the reason is worth stating because it
looks like a bug otherwise. **A browser cannot read a GitHub release asset.**
`api.github.com` answers with `access-control-allow-origin: *`, so looking a
release up works; the asset itself — the redirect from `github.com` and the
`release-assets.githubusercontent.com` response behind it — sends no such
header, so `fetch` on it fails in every browser. There is no header to ask for
and no endpoint that behaves differently, and a CORS proxy is the wrong answer
for a page that flashes firmware. So:

- **`latest` uses the copy committed beside the page.** The firmware
  repository's release workflow pushes each published `.syx` into
  `web/firmware/` with an `index.json` naming it, so the image is in the
  checkout itself — served the same by GitHub Pages and by a local server.
  (The Pages workflow still downloads one at deploy time as a fallback if
  nothing is committed.) One click, same origin, no third party in the path at
  all. If a newer release has been published since, the log says so and names
  the tag.
- **Any other tag hands off to the browser's own downloader** and asks for the
  file back by drag and drop. Two steps instead of one, which is the price of
  the paragraph above.

Transfer and Firmware both name what they are about to overwrite and ask first —
neither is reversible, and the unit gives no confirmation of its own. A firmware
image and a backup are told apart by their SysEx header, so the page refuses to
flash a backup or restore a firmware image.

There is no way to stop a transfer once it starts — the Stop button is gone, so
a dump, restore or flash runs to the end. The loops still poll a `shouldStop`
between items, which is where a control would reattach; nothing sets it. A flash
is paced by scheduled MIDI timestamps rather than by a timer, so switching tabs
mid-flash does not stall it.

The readouts give way in stages as the column narrows. At 900 the word SCALE
goes — the row has 46px of slack left at that point and the label and its gap
are 37 of them, and four buttons reading 1/16, 1/32, 1/16t and 1/8t do not need
telling what they are. It stays gone below that rather than coming back, since
a label that vanished at 900 and reappeared at 850 would draw more attention
than the label does; the strip keeps its aria-label, so a screen reader is not
affected.

Where the readouts stop fitting on one line they fold into a square rather than
wrapping wherever they run out — SHUFFLE and LAST STEP on the top line, FLAM and
SCALE under them, each pair keeping the edge it had. Nothing moves sideways on
the way from one line to two; the row only doubles up.

That happens twice, because the panel gets a second wind in between. From 761 to
850 the Detail column is at its narrowest — two columns still, with the file
list taking its 15rem. Below 760 the panel goes to one column and Detail takes
the whole window, so the row fits again, until 612 brings the square back.

The status bar is pinned to the bottom of the window and carries the connection
state in its left corner — whether the ports are open is not something to scroll
looking for, and it was competing with the panel tabs up in the header.

## The command line tool

What the browser cannot do is compile: `nava build` shells out to PlatformIO
against a firmware checkout. Everything else the web app does, the CLI also does,
for scripting or for a machine where opening a browser is not the point.

With [uv](https://docs.astral.sh/uv/), from anywhere — no clone needed:

```bash
uv tool install "git+https://github.com/jeanbrazeau/nava-tools"
nava --help
```

That puts `nava` on your PATH in its own isolated environment. A bare URL resolves
to the repository's **default branch**; to install from a branch or tag that has
not been merged, name it:

```bash
uv tool install "git+https://github.com/jeanbrazeau/nava-tools@BRANCH"
uv tool upgrade nava-tools
uv tool uninstall nava-tools
```

Run it once without installing anything:

```bash
uvx --from "git+https://github.com/jeanbrazeau/nava-tools" nava ports
```

From a clone, working on the tools themselves:

```bash
uv sync                              # creates .venv from uv.lock
uv run nava ports
uv run pytest
node --test "tests/web/*.test.js"    # the web app's suite; no install needed
```

`uv sync` installs the `dev` dependency group automatically, so the tests are
ready without naming an extra. With pip instead:

```bash
pip install -e .
pip install -e . --group dev         # tests; needs pip >= 25.1
```

`nava hex2syx`, `nava inspect` and `nava show` work with no MIDI backend
installed; the commands that touch a port need `mido` and `python-rtmidi`.

| | |
|---|---|
| `nava ports` | list MIDI inputs and outputs |
| `nava build` | compile with PlatformIO and emit a `.syx` |
| `nava hex2syx FILE.hex` | convert an existing `.hex` |
| `nava flash FILE.syx` | send firmware to a unit in bootloader mode |
| `nava backup` | read patterns, tracks and setup off the unit |
| `nava restore FILE.syx` | write a backup back |
| `nava inspect FILE.syx` | describe a `.syx` without a device attached |
| `nava show FILE.syx A1` | print one decoded pattern, track or the config |

`nava show` prints the same pattern the web app draws, as text — and unlike the
web app it will print a track record too:

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

Empty lanes are dropped here because a terminal has no room for sixteen of them;
the chart keeps every row, so a voice sits in the same place in every pattern.
The two renderers are pinned to each other — see [Keeping the two
implementations honest](#keeping-the-two-implementations-honest).

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

Put the unit in bootloader mode first: **hold steps 1, 3 and 5 while powering it
on**. The panel does not react afterwards — it is no longer running the firmware
— and the unit restarts on its own when the transfer finishes.

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

## Where the firmware lives

This repository is the host side only. The firmware itself, its simulator tests
and its release machinery are in
[jeanbrazeau/Nava-Firmware](https://github.com/jeanbrazeau/Nava-Firmware): the
version number lives in one file there (`downtown-solutions_firmware/version.h`),
`scripts/release.py` in that repository cuts a tag from it, and that repository's
CI builds the `.syx` this tool downloads and flashes.

`nava build` is the one command here that wants a firmware checkout, and says so
rather than failing obscurely when there is none. Everything else — flash,
backup, restore, inspect, show — needs no source at all.

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
uv run pytest                        # the Python package
node --test "tests/web/*.test.js"    # the web app
```

Verified on CPython 3.10 and 3.13, and on Node 22. No hardware needed:
`tests/fakenava.py` and `tests/web/fakenava.js` model the device, and each
suite's round-trip test backs up the model, wipes it and restores it byte for
byte. `test_bootloader.py` reproduces the released `Nava0tone_0.90b.syx`
exactly, which is what pins the encoder to what the bootloader in flash actually
decodes. `test_records.py` decodes hand-built byte images rather than
round-tripping through an encoder — a decoder checked against its own inverse
proves nothing about whether either matches `EEprom.ino`.

### Keeping the two implementations honest

The web app is a second implementation of the same protocol and the same EEPROM
layouts, in a language the firmware repository's tests cannot reach. Two
implementations of one spec drift, and the drift would only show up against
hardware, so they are pinned to each other:

`tests/fixtures/vectors.json` holds byte images and the exact strings the Python
code produces from them. `tests/test_vectors.py` asserts Python still reproduces
that file; `tests/web/vectors.test.js` asserts JavaScript produces the same
bytes and the same strings from the same images, down to the spaces in the step
grid. Changing one side alone fails one of them.

A deliberate change means regenerating and then following it through:

```bash
uv run python tests/make_vectors.py
node --test "tests/web/*.test.js"    # now fix web/js until this passes
```

What is NOT tested here is that `protocol.py` still agrees with the firmware —
that check needs the firmware headers, so it lives in the firmware repository
(`scripts/tests/`), which installs this package and compares the two. It fails on
the side that would have to change.

## Deploying the site

`web/` is plain ES modules and one stylesheet: no build step, no dependencies,
nothing fetched from a CDN. `.github/workflows/pages.yml` uploads that directory
to GitHub Pages. The current firmware release lives in `web/firmware/`,
committed there by the firmware repository's release workflow so the Firmware
panel is one click (see above for why the page cannot fetch it itself); the
Pages workflow downloads one at deploy time only when nothing is committed.

**Nothing is published today, on purpose.** Two things stand between this
repository and a live site:

1. The workflow is `workflow_dispatch` only — it runs when someone presses "Run
   workflow" on the Actions tab, so merging to `master` deploys nothing. To
   publish on every green `master` build instead, uncomment the `workflow_run`
   trigger at the top of the file.
2. GitHub Pages has to be told to serve what Actions uploads: **Settings → Pages
   → Source → GitHub Actions**. Under the default branch-based source the
   workflow runs and the deploy step fails, because that source ignores
   artifacts entirely.

To work on it locally, serve the directory — ES modules will not load over
`file://`, and Web MIDI needs a secure context, which `localhost` counts as:

```bash
uv run python tools/devserver.py            # what Pages would serve, byte for byte
uv run python tools/devserver.py --debug    # ...plus seeded .syx files
```

Locally `web/firmware/` is served straight from the checkout, so `latest` works
offline. Any tag other than the committed one takes the hand-off path, which is
the one worth testing by hand.

### Debug mode

`--debug` generates the `tests/make_samples.py` set, serves it under
`/__debug__/`, and injects one script tag into `index.html` as it writes the
response. The page comes up on **Browse** already holding a full backup, a
single bank, the edge cases, a corrupt file and a firmware image, so the panel
can be worked on without a Nava on the desk and without dragging eight files in
after every reload. A black bar across the top says how many were seeded and
offers a **reseed** button; it is the only thing on screen that is not the app.

Files arrive through a synthetic drop on the dropzone rather than a back door
into `app.js`: there is no debug branch in the shipped code, and seeding
exercises the same ingestion path a dragged file takes.

**It cannot be deployed**, and not because of a flag someone has to remember:

- The harness is `tools/debug/seed.js`. `pages.yml` uploads `path: web`, so a
  file outside that directory has no route into the artifact.
- `web/index.html` on disk never mentions it. The script tag exists only in the
  bytes the server writes to a socket, and only when `--debug` was passed.
- Without `--debug` the server 404s every `/__debug__/` path, so running it in
  front of a deployment still exposes nothing.

`tests/test_devserver.py` holds each of those to its word — including that
`pages.yml` still uploads only `web/` — and `tests/web/site.test.js` fails if
anything under `web/` ever mentions the harness.
