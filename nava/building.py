"""Compiling the firmware and turning the result into a bootloader `.syx`.

Shared by `nava build` and the TUI's Firmware tab so the two cannot drift: the
same environment, the same `.hex` -> `.syx` conversion, the same diagnosis when
PlatformIO is missing.

Building needs two things an installed `nava` does not have: a source checkout
with `platformio.ini` in it, and PlatformIO itself. `checkout_root()` reports
the first as None rather than raising, so a front end can say why the option is
unavailable before the user presses anything - `uv tool install` puts this
package under site-packages, where there is no firmware to compile and never
will be. That is the case the release download exists to serve.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable

from . import bootloader, ihex

DEFAULT_ENV = "nava_sysex"


class BuildError(Exception):
    """A user-facing build failure; reported without a traceback."""


def repo_root() -> str:
    """Where the package sits relative to the repository, if it is in one."""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def checkout_root(root: str | None = None) -> str | None:
    """The repository root when there is firmware to build, else None.

    Keyed on platformio.ini rather than on `.git`: what a build needs is the
    project file, and a source archive without git history builds perfectly
    well.
    """
    candidate = root or repo_root()
    return candidate if os.path.exists(os.path.join(candidate, "platformio.ini")) else None


def find_pio() -> str:
    found = shutil.which("pio") or shutil.which("platformio")
    if found:
        return found
    fallback = os.path.expanduser("~/.platformio/penv/bin/pio")
    if os.path.exists(fallback):
        return fallback
    raise BuildError(
        "PlatformIO not found. Install it with:\n"
        "    pip install platformio\n"
        "or pass an already-built .hex to `nava hex2syx`."
    )


@dataclass
class Built:
    syx_path: str
    hex_path: str
    flash_bytes: int
    pages: int
    syx_bytes: int


def convert(hex_path: str, syx_path: str, page_words: int = bootloader.DEFAULT_PAGE_WORDS) -> Built:
    """Encode a compiled `.hex` as the nibblized page stream the bootloader takes."""
    try:
        image = ihex.load_file(hex_path)
    except OSError as exc:
        raise BuildError(f"cannot read {hex_path}: {exc}") from exc
    except ihex.HexFileError as exc:
        raise BuildError(f"{hex_path}: {exc}") from exc

    stream = bootloader.encode_firmware(image, page_words)
    page_size = page_words * 2
    pages = len(image + b"\x00" * (-len(image) % page_size)) // page_size
    try:
        with open(syx_path, "wb") as handle:
            handle.write(stream)
    except OSError as exc:
        raise BuildError(f"cannot write {syx_path}: {exc}") from exc
    return Built(syx_path, hex_path, len(image), pages, len(stream))


def build(
    env: str = DEFAULT_ENV,
    output: str | None = None,
    page_words: int = bootloader.DEFAULT_PAGE_WORDS,
    root: str | None = None,
    on_line: Callable[[str], None] | None = None,
) -> Built:
    """Compile `env` with PlatformIO and emit a `.syx` beside the `.hex`.

    Output is streamed to `on_line` as it arrives rather than collected: a cold
    build takes tens of seconds and a front end that shows nothing until the end
    looks hung.
    """
    checkout = checkout_root(root)
    if checkout is None:
        raise BuildError(
            "No firmware source here - platformio.ini is not next to this "
            "install of nava.\n"
            "Building compiles the firmware from a clone of the repository:\n"
            "    git clone https://github.com/jeanbrazeau/Nava-Firmware\n"
            "    uv run --project tools nava build\n"
            "Otherwise download a released build instead of compiling one."
        )
    pio = find_pio()
    if on_line:
        on_line(f"{pio} run -e {env}")

    process = subprocess.Popen(
        [pio, "run", "-e", env],
        cwd=checkout,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    for line in process.stdout:
        if on_line:
            on_line(line.rstrip())
    code = process.wait()
    if code != 0:
        raise BuildError(
            f"PlatformIO build failed (exit {code}).\n"
            "On Apple Silicon a 'Bad CPU type in executable' error means the AVR "
            "toolchain needs Rosetta:\n"
            "    softwareupdate --install-rosetta --agree-to-license"
        )

    hex_path = os.path.join(checkout, ".pio", "build", env, "firmware.hex")
    if not os.path.exists(hex_path):
        raise BuildError(f"build reported success but {hex_path} is missing")
    return convert(hex_path, output or hex_path[: -len(".hex")] + ".syx", page_words)
