"""Fetching a published firmware build.

No network: urlopen is replaced throughout. What is worth pinning here is the
handling around the request rather than the request itself - picking the right
asset out of a release that carries several, refusing to leave a truncated file
where firmware should be, and turning GitHub's error codes into something a
person can act on.
"""

import http.client
import io
import json
import urllib.error

import pytest

from nava import releases


class FakeResponse(io.BytesIO):
    def __init__(self, payload: bytes, headers: dict | None = None):
        super().__init__(payload)
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def install_urlopen(monkeypatch, handler):
    """Route urlopen through `handler(url, request)`; record what was asked for."""
    seen: list[tuple[str, dict]] = []

    def fake(request, timeout=None):
        headers = {k.lower(): v for k, v in request.header_items()}
        seen.append((request.full_url, headers))
        return handler(request.full_url, headers)

    monkeypatch.setattr(releases.urllib.request, "urlopen", fake)
    return seen


RELEASE_JSON = {
    "tag_name": "0.91b",
    "name": "Nava 0.91b",
    "prerelease": False,
    "published_at": "2026-07-28T06:00:00Z",
    "assets": [
        {"name": "notes.txt", "url": "https://api/assets/1", "size": 12},
        {"name": "nava-0.91b.syx", "url": "https://api/assets/2", "size": 81962},
        {"name": "nava-0.91b-debug.syx", "url": "https://api/assets/3", "size": 90000},
    ],
}


def test_latest_uses_githubs_own_endpoint(monkeypatch):
    """'latest' must not be a client-side sort of the release list: GitHub's
    endpoint already excludes drafts and pre-releases, which is what a button
    that flashes a drum machine should default to."""
    seen = install_urlopen(
        monkeypatch, lambda url, h: FakeResponse(json.dumps(RELEASE_JSON).encode())
    )
    release = releases.fetch()
    assert seen[0][0].endswith("/releases/latest")
    assert release.tag == "0.91b"
    assert release.published == "2026-07-28"


def test_named_tag_is_requested_by_tag(monkeypatch):
    seen = install_urlopen(
        monkeypatch, lambda url, h: FakeResponse(json.dumps(RELEASE_JSON).encode())
    )
    releases.fetch("0.91b")
    assert seen[0][0].endswith("/releases/tags/0.91b")


def test_a_tag_with_a_space_is_encoded_not_pasted(monkeypatch):
    """http.client rejects a space in the path before sending anything, and the
    exception is neither HTTPError nor URLError - which took the TUI down with a
    traceback. The request has to be made, so it can 404 like any other miss."""
    seen = install_urlopen(
        monkeypatch, lambda url, h: FakeResponse(json.dumps(RELEASE_JSON).encode())
    )
    releases.fetch("Nava 0.91b")
    assert seen[0][0].endswith("/releases/tags/Nava%200.91b")


def test_a_release_title_resolves_to_its_tag(monkeypatch):
    """The releases page shows 'Nava 0.92' louder than it shows '0.92', so that
    is what gets copied into the field. One 404 on the tag, then the list."""

    def handler(url, headers):
        if "/releases/tags/" in url:
            raise urllib.error.HTTPError(url, 404, "no such tag", {}, None)
        return FakeResponse(json.dumps([RELEASE_JSON]).encode())

    seen = install_urlopen(monkeypatch, handler)
    assert releases.fetch("Nava 0.91b").tag == "0.91b"
    assert "/releases?per_page=" in seen[1][0]


def test_an_unknown_tag_names_what_was_typed(monkeypatch):
    def handler(url, headers):
        if "/releases/tags/" in url:
            raise urllib.error.HTTPError(url, 404, "no such tag", {}, None)
        return FakeResponse(json.dumps([RELEASE_JSON]).encode())

    install_urlopen(monkeypatch, handler)
    # The percent-encoded URL is no use to anyone reading the message.
    with pytest.raises(releases.ReleaseError, match="'nava 9.99'"):
        releases.fetch("nava 9.99")


def test_an_unusable_url_does_not_raise_out_of_band(monkeypatch):
    """NAVA_REPO reaches the path unencoded, so http.client.InvalidURL is still
    possible - and it is neither HTTPError nor URLError, so it has to be caught
    by name or it escapes as itself and kills the TUI's worker."""

    def handler(url, headers):
        raise http.client.InvalidURL("URL can't contain control characters")

    install_urlopen(monkeypatch, handler)
    with pytest.raises(releases.ReleaseError, match="not a usable GitHub URL"):
        releases.fetch(repo="someone/Nava Fork")


def test_firmware_asset_is_picked_by_extension_and_shortest_name(monkeypatch):
    install_urlopen(monkeypatch, lambda url, h: FakeResponse(json.dumps(RELEASE_JSON).encode()))
    asset = releases.fetch().firmware
    assert asset is not None
    # notes.txt is not flashable; the debug build is not the default one.
    assert asset.name == "nava-0.91b.syx"
    assert asset.size == 81962


def test_release_without_a_syx_reports_none(monkeypatch):
    payload = dict(RELEASE_JSON, assets=[{"name": "notes.txt", "url": "u", "size": 1}])
    install_urlopen(monkeypatch, lambda url, h: FakeResponse(json.dumps(payload).encode()))
    assert releases.fetch().firmware is None


def test_token_is_sent_when_present(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "s3cret")
    seen = install_urlopen(
        monkeypatch, lambda url, h: FakeResponse(json.dumps(RELEASE_JSON).encode())
    )
    releases.fetch()
    assert seen[0][1]["authorization"] == "Bearer s3cret"


def test_no_token_sends_no_authorization(monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    seen = install_urlopen(
        monkeypatch, lambda url, h: FakeResponse(json.dumps(RELEASE_JSON).encode())
    )
    releases.fetch()
    assert "authorization" not in seen[0][1]


@pytest.mark.parametrize(
    "code, expected",
    [(404, "not found"), (403, "rate limit"), (500, "GitHub returned 500")],
)
def test_http_errors_are_explained(monkeypatch, code, expected):
    def handler(url, headers):
        raise urllib.error.HTTPError(url, code, "boom", {}, None)

    install_urlopen(monkeypatch, handler)
    with pytest.raises(releases.ReleaseError, match=expected):
        releases.fetch()


def test_unreachable_github_is_explained(monkeypatch):
    def handler(url, headers):
        raise urllib.error.URLError("no route to host")

    install_urlopen(monkeypatch, handler)
    with pytest.raises(releases.ReleaseError, match="cannot reach GitHub"):
        releases.fetch()


def test_download_writes_the_file_and_reports_progress(monkeypatch, tmp_path):
    body = b"\xf0\x7d\x08" + bytes(300) + b"\xf7"
    install_urlopen(
        monkeypatch,
        lambda url, h: FakeResponse(body, {"Content-Length": str(len(body))}),
    )
    seen: list[tuple[int, int]] = []
    dest = str(tmp_path / "nava-0.91b.syx")

    path = releases.download(
        releases.Asset("nava-0.91b.syx", "https://api/assets/2", len(body)),
        dest,
        progress=lambda done, total, label: seen.append((done, total)),
    )
    assert path == dest
    assert (tmp_path / "nava-0.91b.syx").read_bytes() == body
    assert seen and seen[-1] == (len(body), len(body))


def test_download_requests_the_raw_asset(monkeypatch, tmp_path):
    """browser_download_url would do for a public repo; the API URL with an
    octet-stream Accept works for private ones too, given a token."""
    seen = install_urlopen(monkeypatch, lambda url, h: FakeResponse(b"x"))
    releases.download(
        releases.Asset("f.syx", "https://api/assets/2", 1), str(tmp_path / "f.syx")
    )
    assert seen[0][0] == "https://api/assets/2"
    assert seen[0][1]["accept"] == "application/octet-stream"


def test_interrupted_download_leaves_no_firmware_behind(monkeypatch, tmp_path):
    """A truncated image looks exactly like a good one to the flasher, and
    sending it leaves a unit that will not boot. The partial file must never be
    given the real name."""

    class Failing(FakeResponse):
        def read(self, size=-1):
            raise urllib.error.URLError("connection reset")

    install_urlopen(monkeypatch, lambda url, h: Failing(b"", {"Content-Length": "999"}))
    dest = tmp_path / "nava-0.91b.syx"
    with pytest.raises(releases.ReleaseError):
        releases.download(releases.Asset("f.syx", "https://api/assets/9", 999), str(dest))
    assert not dest.exists()


def test_repo_can_be_overridden_for_forks(monkeypatch):
    seen = install_urlopen(
        monkeypatch, lambda url, h: FakeResponse(json.dumps(RELEASE_JSON).encode())
    )
    releases.fetch(repo="someone/Nava-Fork")
    assert "someone/Nava-Fork" in seen[0][0]
