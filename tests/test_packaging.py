"""Guards the packaging metadata.

app.tcss shipped missing from the wheel once already. An editable install cannot
reveal that - the file is still sitting in the source tree, so the TUI works
locally and dies only for someone who installed it properly. These check the
declaration instead of waiting for a bug report.
"""

import fnmatch
import os
import sys

import pytest

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - 3.10 has no tomllib
    tomllib = pytest.importorskip("tomli")

TOOLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE_DIR = os.path.join(TOOLS_DIR, "nava")


@pytest.fixture(scope="module")
def pyproject():
    with open(os.path.join(TOOLS_DIR, "pyproject.toml"), "rb") as handle:
        return tomllib.load(handle)


def non_python_assets() -> list[str]:
    """Every file inside the package that setuptools will not ship on its own."""
    out = []
    for root, dirs, files in os.walk(PACKAGE_DIR):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in files:
            if name.endswith((".py", ".pyc")):
                continue
            path = os.path.join(root, name)
            out.append(os.path.relpath(path, PACKAGE_DIR))
    return out


def test_every_package_asset_is_declared(pyproject):
    """Adding a new asset without declaring it is the exact mistake this catches."""
    assets = non_python_assets()
    # Reported as a missing declaration rather than a KeyError: dropping the whole
    # section is the likelier mistake, and the message has to say what to do.
    declared = pyproject.get("tool", {}).get("setuptools", {}).get("package-data")
    if declared is None:
        assert not assets, (
            "the package contains data files but pyproject.toml has no "
            f"[tool.setuptools.package-data] section, so they will be missing from "
            f"the wheel: {assets}"
        )
        return
    # Keys are package names ("nava.tui"); turn them into path prefixes.
    patterns = []
    for package, globs in declared.items():
        prefix = package.split(".", 1)[1].replace(".", os.sep) if "." in package else ""
        patterns += [os.path.join(prefix, g) if prefix else g for g in globs]

    for asset in assets:
        assert any(fnmatch.fnmatch(asset, pattern) for pattern in patterns), (
            f"{asset} is inside the package but no [tool.setuptools.package-data] "
            f"glob covers it, so it will be missing from the wheel. "
            f"Declared: {patterns}"
        )


def test_the_stylesheet_exists_where_the_app_expects_it():
    """CSS_PATH is resolved relative to the module, so the name must match."""
    from nava.tui.app import NavaApp

    assert NavaApp.CSS_PATH == "app.tcss"
    assert os.path.exists(os.path.join(PACKAGE_DIR, "tui", "app.tcss"))


def test_console_script_target_is_importable(pyproject):
    module, _, function = pyproject["project"]["scripts"]["nava"].partition(":")
    imported = __import__(module, fromlist=[function])
    assert callable(getattr(imported, function))


def test_tui_is_an_optional_extra(pyproject):
    """Everything except `nava tui` must work without textual installed, so
    textual must not be a hard dependency."""
    required = " ".join(pyproject["project"]["dependencies"])
    assert "textual" not in required
    assert any("textual" in dep for dep in pyproject["project"]["optional-dependencies"]["tui"])


def test_lockfile_is_committed():
    """uv sync is documented as reproducing the environment exactly."""
    assert os.path.exists(os.path.join(TOOLS_DIR, "uv.lock"))
