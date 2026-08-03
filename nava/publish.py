"""Cutting a firmware release: bump the version, tag it, push.

The counterpart to releases.py, which consumes what this produces. Everything
after the push happens on GitHub - `.github/workflows/release.yml` builds the
tag, checks it against the version this wrote, and uploads the `.syx`. Nothing
here builds or publishes anything itself, which is what keeps the published
artifact traceable to a runner log rather than to whatever was in someone's
working tree.

The guards are the point. A release is a tag other people flash from, so this
refuses rather than improvises: no uncommitted changes, no unexpected branch, no
tag that already exists, no version the splash cannot display.
"""

from __future__ import annotations

import os
import re
import subprocess
from typing import Callable

from . import building

VERSION_FILE = os.path.join("downtown-solutions_firmware", "version.h")
VERSION_PATTERN = re.compile(r'(#define\s+FIRMWARE_VERSION\s+")([^"]*)(")')

# What the panel can show: " solutions " is 11 of the 16 columns.
MAX_VERSION_LEN = 5
# Deliberately narrow. A tag is a name other people type; allowing slashes or
# spaces here buys nothing and breaks the URL the TUI fetches by tag.
VALID_VERSION = re.compile(r"^[0-9]+\.[0-9]+[a-z]?$")

DEFAULT_REMOTE = "origin"
DEFAULT_BRANCH = "master"


class PublishError(Exception):
    """A user-facing failure cutting a release."""


def git(args: list[str], root: str, capture: bool = True) -> str:
    result = subprocess.run(
        ["git", *args], cwd=root, capture_output=capture, text=True
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip() if capture else ""
        raise PublishError(f"git {' '.join(args)} failed: {detail}")
    return (result.stdout or "").strip() if capture else ""


def version_path(root: str) -> str:
    return os.path.join(root, VERSION_FILE)


def read_version(root: str) -> str:
    try:
        with open(version_path(root), "r") as handle:
            text = handle.read()
    except OSError as exc:
        raise PublishError(f"cannot read {VERSION_FILE}: {exc}") from exc
    match = VERSION_PATTERN.search(text)
    if not match:
        raise PublishError(f"{VERSION_FILE} has no FIRMWARE_VERSION define")
    return match.group(2)


def write_version(root: str, version: str) -> None:
    """Rewrite the define in place, touching nothing else in the file.

    A regex substitution rather than a rewritten file: version.h carries the
    comments explaining why it exists, and a generator that flattened them would
    make the next person wonder whether editing it by hand is allowed.
    """
    path = version_path(root)
    with open(path, "r", newline="") as handle:
        text = handle.read()
    updated, count = VERSION_PATTERN.subn(rf"\g<1>{version}\g<3>", text, count=1)
    if count != 1:
        raise PublishError(f"{VERSION_FILE} has no FIRMWARE_VERSION define")
    with open(path, "w", newline="") as handle:
        handle.write(updated)


def check_version(version: str) -> None:
    if not VALID_VERSION.match(version):
        raise PublishError(
            f"'{version}' is not a version this releases under. "
            "Expected something like 0.92 or 0.92b: digits, one dot, an "
            "optional trailing letter."
        )
    if len(version) > MAX_VERSION_LEN:
        raise PublishError(
            f"'{version}' is {len(version)} characters; the splash line has room "
            f"for {MAX_VERSION_LEN}. version.h asserts this at compile time too."
        )


def check_clean(root: str, on_line: Callable[[str], None] = print) -> None:
    """Refuse on modified tracked files; only mention untracked ones.

    Untracked files cannot end up in the tag or in the build, so blocking on
    them stops releases for reasons that do not affect the artifact - and the
    repository always has some, since `.claude/` holds worktrees. Blocking on
    them also invites `git stash -u` as the fix, which would sweep those
    worktrees away.

    They are still worth naming: an untracked file is how a new source file
    that was never `git add`ed goes missing from a release.
    """
    if git(["status", "--porcelain", "--untracked-files=no"], root):
        raise PublishError(
            "the working tree has uncommitted changes to tracked files.\n"
            "A release tags what is committed; commit or stash first so the tag "
            "and the build agree."
        )
    untracked = [
        line[3:] for line in git(["status", "--porcelain"], root).splitlines()
        if line.startswith("?? ")
    ]
    if untracked:
        shown = ", ".join(untracked[:3])
        if len(untracked) > 3:
            shown += f", and {len(untracked) - 3} more"
        on_line(f"note: not in this release, untracked: {shown}")


def check_branch(root: str, branch: str) -> None:
    current = git(["rev-parse", "--abbrev-ref", "HEAD"], root)
    if current != branch:
        raise PublishError(
            f"on branch {current}, not {branch}.\n"
            f"Release from {branch}, or pass --branch {current} if that is "
            "deliberate."
        )


def check_tag_free(root: str, remote: str, version: str) -> None:
    if git(["tag", "--list", version], root):
        raise PublishError(f"tag {version} already exists locally")
    if git(["ls-remote", "--tags", remote, version], root):
        raise PublishError(
            f"tag {version} already exists on {remote}.\n"
            "Releases are not re-cut under the same number - people have "
            "already flashed it. Use the next one."
        )


def release(
    version: str,
    root: str | None = None,
    remote: str = DEFAULT_REMOTE,
    branch: str = DEFAULT_BRANCH,
    dry_run: bool = False,
    on_line: Callable[[str], None] = print,
) -> str:
    """Bump the version, commit, tag and push. Returns the tag.

    Ordered so that nothing is pushed until everything local has succeeded: a
    half-done release that tagged but did not bump would build an image whose
    splash disagrees with its own tag, which is the failure this whole
    arrangement exists to prevent. The workflow catches it anyway - belt and
    braces, because that check runs on a machine nobody is watching.
    """
    checkout = building.checkout_root(root)
    if checkout is None:
        raise PublishError(
            "no firmware checkout here - `nava release` runs from a clone of "
            "the repository, not from an installed copy."
        )
    check_version(version)

    current = read_version(checkout)
    if current == version:
        raise PublishError(
            f"version.h already says {version}. Either the bump is committed "
            "already - in which case push the tag yourself - or you meant a "
            "different number."
        )

    check_clean(checkout, on_line)
    check_branch(checkout, branch)
    check_tag_free(checkout, remote, version)

    on_line(f"{current} -> {version}")
    if dry_run:
        for step in (
            f"write {VERSION_FILE}",
            f"git commit -m 'Release {version}'",
            f"git tag -a {version}",
            f"git push {remote} {branch}",
            f"git push {remote} {version}",
        ):
            on_line(f"  would {step}")
        return version

    write_version(checkout, version)
    git(["add", VERSION_FILE], checkout)
    git(["commit", "-m", f"Release {version}"], checkout)
    git(["tag", "-a", version, "-m", f"Nava {version}"], checkout)
    on_line(f"committed and tagged {version}")

    # The branch goes first: a tag whose commit is not on the remote builds
    # from a commit nobody can see.
    git(["push", remote, f"HEAD:{branch}"], checkout)
    git(["push", remote, version], checkout)
    on_line(f"pushed {branch} and {version} to {remote}")
    return version


def remote_slug(root: str, remote: str = DEFAULT_REMOTE) -> str | None:
    """`owner/repo` for the remote, for printing URLs. None if it is not GitHub."""
    try:
        url = git(["remote", "get-url", remote], root)
    except PublishError:
        return None
    match = re.search(r"github\.com[:/](.+?)(?:\.git)?$", url)
    return match.group(1) if match else None
