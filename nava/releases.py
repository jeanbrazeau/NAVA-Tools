"""Firmware builds published on the repository's releases page.

The other way to get a `.syx`: no clone, no PlatformIO, no AVR toolchain. An
installed `nava` cannot compile anything (see building.checkout_root), so for
most people this is the only way the Firmware tab produces an image to flash.

Stdlib urllib on purpose. Adding `requests` to reach two JSON endpoints would
put a dependency in front of `nava flash` for every user, including the ones who
never download a thing.

Unauthenticated requests are what this makes: the releases of a public
repository need no token, and GitHub's 60/hour limit is not a constraint for a
tool a person drives by hand. GITHUB_TOKEN is used when it happens to be set,
which is what makes this usable from CI.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

DEFAULT_REPO = os.environ.get("NAVA_REPO", "jeanbrazeau/Nava-Firmware")
API = "https://api.github.com"
USER_AGENT = "nava-tools"
TIMEOUT = 30.0


class ReleaseError(Exception):
    """A user-facing failure fetching or downloading a release."""


@dataclass
class Asset:
    name: str
    url: str
    size: int


@dataclass
class Release:
    tag: str
    name: str
    prerelease: bool
    published: str
    assets: list[Asset]

    @property
    def firmware(self) -> Asset | None:
        """The image to flash.

        A release can carry several files - a backup, a hex, notes - so the
        `.syx` is picked by extension rather than by position. Where there is
        more than one, the shortest name wins: `firmware.syx` over
        `firmware-debug.syx`, which is the convention this repository publishes
        under.
        """
        candidates = [a for a in self.assets if a.name.lower().endswith(".syx")]
        if not candidates:
            return None
        return sorted(candidates, key=lambda a: (len(a.name), a.name))[0]

    @property
    def label(self) -> str:
        suffix = "  (pre-release)" if self.prerelease else ""
        return f"{self.tag}{suffix}"


def _request(url: str, accept: str) -> urllib.request.Request:
    request = urllib.request.Request(url)
    request.add_header("Accept", accept)
    request.add_header("User-Agent", USER_AGENT)
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return request


def _get_json(url: str):
    try:
        with urllib.request.urlopen(_request(url, "application/vnd.github+json"), timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ReleaseError(f"not found: {url}") from exc
        if exc.code == 403:
            raise ReleaseError(
                "GitHub refused the request (403). This is usually the "
                "unauthenticated rate limit - wait, or set GITHUB_TOKEN."
            ) from exc
        raise ReleaseError(f"GitHub returned {exc.code} for {url}") from exc
    except urllib.error.URLError as exc:
        raise ReleaseError(f"cannot reach GitHub: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise ReleaseError(f"GitHub returned something that is not JSON: {exc}") from exc


def _parse(payload: dict) -> Release:
    return Release(
        tag=payload.get("tag_name") or "",
        name=payload.get("name") or payload.get("tag_name") or "",
        prerelease=bool(payload.get("prerelease")),
        published=(payload.get("published_at") or "")[:10],
        assets=[
            Asset(a.get("name") or "", a.get("url") or "", int(a.get("size") or 0))
            for a in payload.get("assets") or []
        ],
    )


def list_releases(repo: str = DEFAULT_REPO, limit: int = 20) -> list[Release]:
    payload = _get_json(f"{API}/repos/{repo}/releases?per_page={int(limit)}")
    if not isinstance(payload, list):
        raise ReleaseError(f"unexpected response listing releases of {repo}")
    return [_parse(item) for item in payload]


def fetch(tag: str | None = None, repo: str = DEFAULT_REPO) -> Release:
    """One release: the newest published, or the one carrying `tag`.

    "latest" is GitHub's own endpoint, which skips pre-releases and drafts - the
    right default for a button that flashes a drum machine.
    """
    if not tag or tag == "latest":
        return _parse(_get_json(f"{API}/repos/{repo}/releases/latest"))
    payload = _get_json(f"{API}/repos/{repo}/releases/tags/{tag}")
    return _parse(payload)


def download(
    asset: Asset,
    dest: str,
    progress: Callable[[int, int, str], None] | None = None,
) -> str:
    """Fetch `asset` to `dest`, reporting bytes as they arrive.

    Written to a neighbouring `.part` and renamed at the end: a download
    interrupted half way would otherwise leave a file that looks like firmware,
    and flashing a truncated image leaves a unit that will not boot.

    The API asset URL with `Accept: application/octet-stream` is used rather
    than `browser_download_url` because the former works for private
    repositories too, given a token.
    """
    partial = dest + ".part"
    try:
        with urllib.request.urlopen(_request(asset.url, "application/octet-stream"), timeout=TIMEOUT) as response:
            total = int(response.headers.get("Content-Length") or asset.size or 0)
            done = 0
            with open(partial, "wb") as handle:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    if progress:
                        progress(done, total or done, asset.name)
    except urllib.error.HTTPError as exc:
        raise ReleaseError(f"GitHub returned {exc.code} downloading {asset.name}") from exc
    except urllib.error.URLError as exc:
        raise ReleaseError(f"cannot reach GitHub: {exc.reason}") from exc
    except OSError as exc:
        raise ReleaseError(f"cannot write {partial}: {exc}") from exc

    try:
        os.replace(partial, dest)
    except OSError as exc:
        raise ReleaseError(f"cannot write {dest}: {exc}") from exc
    return dest
