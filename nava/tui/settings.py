"""Remembered TUI settings.

Only the port names and the last browsed directory. Ports are stored by NAME
rather than index, because indices move whenever a USB device is added or removed
and a remembered index would silently point at a different device.
"""

from __future__ import annotations

import json
import os

def app_dir() -> str:
    """Resolved per call, not at import, so a test (or a user with an unusual
    setup) can redirect it with XDG_CONFIG_HOME without reimporting."""
    return os.path.join(
        os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "nava"
    )


def settings_path() -> str:
    return os.path.join(app_dir(), "tui.json")


DEFAULTS = {
    "output_port": None,
    "input_port": None,
    "directory": None,
    "firmware": None,
}


def load() -> dict:
    settings = dict(DEFAULTS)
    try:
        with open(settings_path(), encoding="utf-8") as handle:
            stored = json.load(handle)
    except (OSError, ValueError):
        return settings
    if isinstance(stored, dict):
        for key in DEFAULTS:
            if key in stored:
                settings[key] = stored[key]
    return settings


def save(settings: dict) -> None:
    """Best effort. Losing a remembered port is not worth interrupting the app."""
    try:
        os.makedirs(app_dir(), exist_ok=True)
        with open(settings_path(), "w", encoding="utf-8") as handle:
            json.dump({k: settings.get(k) for k in DEFAULTS}, handle, indent=2)
    except OSError:
        pass
