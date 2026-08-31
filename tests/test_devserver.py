"""The dev server, and the reasons its debug mode cannot be deployed.

The seeding half is easy to check by hand and easy to forget to check at all;
the half that matters is the containment, so most of this file is about what the
server does NOT serve and what web/ does NOT contain.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import devserver  # noqa: E402


def serve(tmp_path, *, debug: bool):
    """Run the server on an ephemeral port for the life of one test."""
    server = devserver.make_server(0, debug=debug, samples_dir=str(tmp_path))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def get(url: str) -> tuple[int, bytes, str]:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers.get("Content-Type", "")


@pytest.fixture
def plain(tmp_path):
    server, base = serve(tmp_path, debug=False)
    yield base
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="module")
def debug_server(tmp_path_factory):
    # Module-scoped: generating the samples writes 128 patterns and a firmware
    # image, and every test here wants the same set.
    server, base = serve(tmp_path_factory.mktemp("samples"), debug=True)
    yield base
    server.shutdown()
    server.server_close()


# ---------- without --debug, the harness does not exist ----------

def test_plain_serves_the_committed_page_byte_for_byte(plain):
    status, body, _ = get(f"{plain}/")
    assert status == 200
    with open(os.path.join(ROOT, "web", "index.html"), "rb") as handle:
        assert body == handle.read()


@pytest.mark.parametrize("path", ["/__debug__/seed.js", "/__debug__/samples.json",
                                  "/__debug__/samples/full-backup.syx"])
def test_plain_refuses_every_debug_route(plain, path):
    status, _, _ = get(plain + path)
    assert status == 404


@pytest.mark.parametrize("path", ["/", "/js/app.js", "/style.css"])
def test_nothing_is_cacheable(plain, path):
    """A stale js module in the browser's cache reads as an edit that did not
    take, so every response says no-store - static files included."""
    with urllib.request.urlopen(plain + path, timeout=5) as response:
        assert response.headers.get("Cache-Control") == "no-store"


def test_plain_still_serves_the_app(plain):
    status, body, kind = get(f"{plain}/js/app.js")
    assert status == 200
    assert b"addFile" in body
    assert "javascript" in kind


# ---------- with --debug, the page is seeded ----------

def test_debug_injects_exactly_one_script_tag(debug_server):
    status, body, _ = get(f"{debug_server}/")
    assert status == 200
    assert body.count(devserver.SCRIPT_TAG.encode()) == 1
    # Before </body>, or the app's module would not have run yet.
    assert body.index(devserver.SCRIPT_TAG.encode()) < body.index(b"</body>")


def test_debug_never_writes_the_tag_back_to_the_file(debug_server):
    get(f"{debug_server}/")
    with open(os.path.join(ROOT, "web", "index.html"), "rb") as handle:
        assert b"__debug__" not in handle.read()


def test_debug_serves_the_harness(debug_server):
    status, body, kind = get(f"{debug_server}/__debug__/seed.js")
    assert status == 200
    assert "javascript" in kind
    assert b"dropzone" in body


def test_debug_manifest_lists_files_that_all_fetch(debug_server):
    status, body, _ = get(f"{debug_server}/__debug__/samples.json")
    assert status == 200
    files = json.loads(body)["files"]
    assert len(files) >= 6
    # The full backup first: it is what the page settles on once seeded.
    assert files[0]["name"] == "full-backup.syx"
    for entry in files:
        code, data, _ = get(f"{debug_server}/__debug__/samples/{entry['name']}")
        assert code == 200, entry["name"]
        assert len(data) == entry["size"], entry["name"]


def test_seeded_backup_is_a_file_the_app_can_read(debug_server, tmp_path):
    """Served bytes, not generated ones: this is what the browser would parse."""
    from nava import library

    _, data, _ = get(f"{debug_server}/__debug__/samples/full-backup.syx")
    path = tmp_path / "full-backup.syx"
    path.write_bytes(data)
    loaded = library.load(str(path))
    assert loaded.kind == library.KIND_BACKUP
    assert not loaded.errors
    assert len(loaded.items) > 100


@pytest.mark.parametrize("name", [
    "../../../etc/passwd",
    "..%2f..%2fpyproject.toml",
    "/etc/passwd",
    "nonesuch.syx",
])
def test_debug_serves_nothing_but_the_files_it_generated(debug_server, name):
    status, _, _ = get(f"{debug_server}/__debug__/samples/{name}")
    assert status == 404


# ---------- the containment, stated as tests ----------

def test_the_harness_lives_outside_the_published_directory():
    assert os.path.exists(os.path.join(ROOT, "tools", "debug", "seed.js"))
    assert not os.path.exists(os.path.join(ROOT, "web", "debug"))


def test_nothing_committed_under_web_mentions_the_harness():
    """The one check that fails if someone later moves debug code into web/.

    web/ is what pages.yml uploads, so a reference to /__debug__/ in there is a
    reference that would ship - and would 404 in production, silently, since the
    page swallows a failed module load.
    """
    offenders = []
    for base, dirs, names in os.walk(os.path.join(ROOT, "web")):
        dirs[:] = [d for d in dirs if d not in {"firmware", "samples"}]
        for name in names:
            path = os.path.join(base, name)
            with open(path, "rb") as handle:
                if b"__debug__" in handle.read():
                    offenders.append(os.path.relpath(path, ROOT))
    assert not offenders, f"debug references in the published directory: {offenders}"


def test_pages_uploads_only_the_web_directory():
    """The invariant the containment rests on.

    Everything above is worth nothing if the artifact path widens to the
    repository root, which would sweep tools/ in with it.
    """
    with open(os.path.join(ROOT, ".github", "workflows", "pages.yml")) as handle:
        workflow = handle.read()
    paths = re.findall(r"^\s*path:\s*(\S+)\s*$", workflow, re.MULTILINE)
    assert paths == ["web"], f"pages.yml uploads {paths}, not just web/"
