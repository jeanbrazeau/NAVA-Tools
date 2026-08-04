"""Interactive front end. Imported lazily by `nava tui` so the rest of the tool
works without textual installed."""

from .app import NavaApp, run

__all__ = ["NavaApp", "run"]
