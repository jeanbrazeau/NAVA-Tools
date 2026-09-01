# NAVA Tools

Tooling for use with the downtown-solutions firmware:
<https://jeanbrazeau.github.io/NAVA-Tools/>
[jeanbrazeau/Nava-Firmware](https://github.com/jeanbrazeau/Nava-Firmware)

Web tool for flashing firmware, backing up, editing, and restoring patterns on an e-licktronic NAVA 909. Requires a Chromium browser (Helium, Arc, Chrome, Edge, Brave, etc.) — Safari and Firefox are unsupported.

Allow MIDI access and you can dump patterns off the unit, restore all or part of a backup, flash firmware updates to a unit in bootloader mode, and drop `.syx` files on the Browse tab to view and edit patterns before saving them back out. Everything runs in the tab — nothing gets uploaded anywhere.

Files loaded or dumped stick around: drop a `.syx` on Browse, or dump one off the unit, and it's still there the next time you open the tab. That's kept in the browser itself — one browser, on one machine, gone the moment that browser's site data is cleared — not a backup. Save keeps edits there, and Save as… writes a `.syx` to disk as well — that file is the backup. Remove takes a file off the list and out of that storage without touching anything already saved to disk. The demo pattern Browse opens with is a stand-in for an empty Files list, so it only shows up when the browser has nothing else stored.

The `nava` CLI does the same jobs from a terminal, plus one thing the browser can't: `nava build` compiles the firmware with PlatformIO against a checkout of [jeanbrazeau/Nava-Firmware](https://github.com/jeanbrazeau/Nava-Firmware). Install it with `uv tool install "git+https://github.com/jeanbrazeau/nava-tools"` and run `nava --help`; the commands are `ports`, `build`, `hex2syx`, `flash`, `backup`, `restore`, `inspect` and `show`. Ports are picked by name substring (`nava flash fw.syx --out NAVA-909`). To flash, put the unit in bootloader mode by holding steps 1, 3 and 5 while powering on; to back up or restore, stop the sequencer and go to the SysEx config page (SHIFT + TEMPO). `--patterns` takes things like `A1`, `A1-A16`, `C`, or `A1,B3,C`, and `--dry-run` on restore shows what would be written.

To hack on it: `uv sync`, then `uv run pytest` for the Python side and `node --test "tests/web/*.test.js"` for the web app — no hardware needed, both suites run against a fake device. `uv run python tools/devserver.py` serves the site locally at <http://127.0.0.1:8000>, and `--debug` seeds it with sample `.syx` files so there's something to click on. Deployment is `.github/workflows/pages.yml`, which uploads `web/` to GitHub Pages as-is — no build step.
