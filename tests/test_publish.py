"""Cutting a release.

Every test runs against a throwaway git repository with a throwaway remote, so
the push path is exercised for real rather than stubbed - what this code gets
wrong would be the ordering and the guards, and a mocked `git` proves neither.

The guards get most of the attention on purpose. A release is a tag other people
flash from: it cannot be re-cut, and a wrong one is discovered by someone
standing in front of a drum machine.
"""

import os
import subprocess

import pytest

from nava import publish

VERSION_H = """\
#ifndef NAVA_VERSION_H
#define NAVA_VERSION_H

#define FIRMWARE_VERSION "0.91b"

#endif
"""


def git(root, *args):
    return subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.fixture
def checkout(tmp_path):
    """A clone with an upstream, positioned exactly as a release would find it."""
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--bare", "-b", "master", str(origin)], check=True,
                   capture_output=True)

    root = tmp_path / "work"
    root.mkdir()
    git(root, "init", "-b", "master")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    (root / "platformio.ini").write_text("[env:nava_sysex]\n")
    firmware = root / "downtown-solutions_firmware"
    firmware.mkdir()
    (firmware / "version.h").write_text(VERSION_H)
    git(root, "add", "-A")
    git(root, "commit", "-m", "initial")
    git(root, "remote", "add", "origin", str(origin))
    git(root, "push", "-u", "origin", "master")
    return root


def test_release_bumps_commits_tags_and_pushes(checkout):
    publish.release("0.92", root=str(checkout), on_line=lambda _: None)

    assert publish.read_version(str(checkout)) == "0.92"
    assert git(checkout, "log", "-1", "--pretty=%s") == "Release 0.92"
    assert git(checkout, "tag", "--list") == "0.92"
    # The remote has to have both, and the tag has to point at the bump.
    assert "0.92" in git(checkout, "ls-remote", "--tags", "origin")
    remote_head = git(checkout, "rev-parse", "origin/master")
    assert remote_head == git(checkout, "rev-parse", "HEAD")


def test_only_the_define_line_changes(checkout):
    """version.h carries the comments explaining why it exists; a release must
    not flatten them."""
    before = (checkout / "downtown-solutions_firmware" / "version.h").read_text()
    publish.release("0.92", root=str(checkout), on_line=lambda _: None)
    after = (checkout / "downtown-solutions_firmware" / "version.h").read_text()
    assert after == before.replace('"0.91b"', '"0.92"')


def test_dry_run_changes_nothing(checkout):
    lines: list[str] = []
    publish.release("0.92", root=str(checkout), dry_run=True, on_line=lines.append)

    assert publish.read_version(str(checkout)) == "0.91b"
    assert git(checkout, "tag", "--list") == ""
    assert git(checkout, "log", "-1", "--pretty=%s") == "initial"
    assert any("would git tag" in line for line in lines)


def test_dirty_tree_is_refused(checkout):
    """The tag would name a commit that does not contain the work in front of
    you, and the build would come from the commit, not the tree."""
    (checkout / "downtown-solutions_firmware" / "Seq.ino").write_text("// wip\n")
    with pytest.raises(publish.PublishError, match="uncommitted changes"):
        publish.release("0.92", root=str(checkout), on_line=lambda _: None)
    assert publish.read_version(str(checkout)) == "0.91b"


def test_wrong_branch_is_refused(checkout):
    git(checkout, "checkout", "-q", "-b", "experiment")
    with pytest.raises(publish.PublishError, match="not master"):
        publish.release("0.92", root=str(checkout), on_line=lambda _: None)


def test_named_branch_is_allowed(checkout):
    git(checkout, "checkout", "-q", "-b", "maintenance")
    publish.release(
        "0.92", root=str(checkout), branch="maintenance", on_line=lambda _: None
    )
    assert git(checkout, "tag", "--list") == "0.92"


def test_existing_local_tag_is_refused(checkout):
    git(checkout, "tag", "0.92")
    with pytest.raises(publish.PublishError, match="already exists locally"):
        publish.release("0.92", root=str(checkout), on_line=lambda _: None)


def test_existing_remote_tag_is_refused(checkout):
    """Re-cutting a published number is the one mistake that cannot be undone:
    people have already flashed it."""
    git(checkout, "tag", "0.92")
    git(checkout, "push", "origin", "0.92")
    git(checkout, "tag", "-d", "0.92")
    with pytest.raises(publish.PublishError, match="already exists on origin"):
        publish.release("0.92", root=str(checkout), on_line=lambda _: None)


def test_releasing_the_current_version_is_refused(checkout):
    with pytest.raises(publish.PublishError, match="already says 0.91b"):
        publish.release("0.91b", root=str(checkout), on_line=lambda _: None)


@pytest.mark.parametrize("version", ["v0.92", "0.92.1", "1", "0.9 2", "next", "0.92B"])
def test_implausible_versions_are_refused(checkout, version):
    with pytest.raises(publish.PublishError, match="not a version"):
        publish.release(version, root=str(checkout), on_line=lambda _: None)


def test_version_too_long_for_the_splash_is_refused(checkout):
    """version.h asserts this at compile time; catching it here means finding
    out before the tag is pushed rather than after CI fails."""
    with pytest.raises(publish.PublishError, match="splash line has room"):
        publish.release("0.9999", root=str(checkout), on_line=lambda _: None)


def test_no_checkout_is_refused(tmp_path):
    with pytest.raises(publish.PublishError, match="no firmware checkout"):
        publish.release("0.92", root=str(tmp_path), on_line=lambda _: None)


def test_nothing_is_pushed_when_a_guard_trips(checkout):
    """Guards run before anything is written, so a refusal leaves no orphan
    commit or local tag to clean up."""
    git(checkout, "tag", "0.92")
    before = git(checkout, "rev-parse", "HEAD")
    with pytest.raises(publish.PublishError):
        publish.release("0.92", root=str(checkout), on_line=lambda _: None)
    assert git(checkout, "rev-parse", "HEAD") == before
    assert git(checkout, "status", "--porcelain") == ""


def test_remote_slug_is_read_for_github_urls(checkout):
    git(checkout, "remote", "set-url", "origin",
        "https://github.com/jeanbrazeau/Nava-Firmware.git")
    assert publish.remote_slug(str(checkout)) == "jeanbrazeau/Nava-Firmware"

    git(checkout, "remote", "set-url", "origin",
        "git@github.com:jeanbrazeau/Nava-Firmware.git")
    assert publish.remote_slug(str(checkout)) == "jeanbrazeau/Nava-Firmware"


def test_remote_slug_is_none_for_a_local_remote(checkout):
    assert publish.remote_slug(str(checkout)) is None


def test_version_file_matches_the_firmware(checkout):
    """The path publish.py rewrites has to be the file the firmware includes.
    Renaming one without the other would leave a release that bumps nothing."""
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    real = os.path.join(repo_root, publish.VERSION_FILE)
    if not os.path.exists(real):
        pytest.skip("not running from a checkout")
    with open(real) as handle:
        assert "FIRMWARE_VERSION" in handle.read()
