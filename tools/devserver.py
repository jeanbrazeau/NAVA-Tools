"""Serve web/ for development, with an optional debug mode that seeds files.

    uv run python tools/devserver.py              # exactly what Pages serves
    uv run python tools/devserver.py --debug      # ...plus seeded .syx files

Without --debug this is `python3 -m http.server -d web` with nicer MIME types:
every byte it sends is a byte that is committed under web/, so what you are
looking at is what the site would serve.

--debug is the whole point of this file. It generates the sample set from
tests/make_samples.py, serves it under /__debug__/, and injects one script tag
into index.html on the way out, so the Browse panel comes up already holding a
full backup, a single bank, the edge cases and a firmware image. No Nava on the
desk, no dragging eight files in after every reload.

None of that can reach production, and the reason is structural rather than a
flag someone has to remember:

  * The debug JavaScript lives in tools/debug/, not in web/. pages.yml uploads
    `path: web`, so a file outside that directory has no way into the artifact.
  * index.html on disk has no reference to it. The script tag exists only in the
    bytes this server writes to a socket, and only when --debug was passed - it
    is never written back to the file.
  * Serving /__debug__/ at all is refused unless --debug was passed, so even
    running this server in front of a deployment cannot expose the harness.

tests/test_devserver.py holds each of those to its word, and site.test.js fails
if anything under web/ ever mentions the harness.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
SEED_JS = os.path.join(ROOT, "tools", "debug", "seed.js")

PREFIX = "/__debug__/"
SCRIPT_TAG = '<script type="module" src="/__debug__/seed.js"></script>'


def generate_samples(out: str) -> list[str]:
    """Write the sample set into `out` and return the filenames, in write order.

    tests/ is a directory of scripts rather than a package, so it goes on the
    path here rather than being imported as `tests.make_samples`.
    """
    for path in (ROOT, os.path.join(ROOT, "tests")):
        if path not in sys.path:
            sys.path.insert(0, path)
    import make_samples

    return make_samples.build(out)


class Handler(http.server.SimpleHTTPRequestHandler):
    """web/ as a static directory, plus /__debug__/ when debug is on."""

    # Bound per-server by make_server(); the class defaults keep a directly
    # constructed handler usable, and debug-free.
    debug = False
    samples_dir = ""
    samples: tuple[str, ...] = ()

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".syx": "application/octet-stream",
        ".hex": "text/plain",
        ".js": "text/javascript",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB, **kwargs)

    def do_GET(self):
        self.dispatch(body=True)

    def do_HEAD(self):
        # Same routing as GET, or a HEAD of / in debug mode would advertise the
        # length of the uninjected file.
        self.dispatch(body=False)

    def dispatch(self, *, body: bool) -> None:
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path.startswith(PREFIX):
            if not self.debug:
                # 404, not 403: without --debug this route does not exist, and
                # saying "forbidden" would advertise that it sometimes does.
                self.send_error(404, "Not Found")
                return
            self.serve_debug(path[len(PREFIX):], body=body)
            return
        if self.debug and path in ("/", "/index.html"):
            self.serve_index(body=body)
            return
        if body:
            super().do_GET()
        else:
            super().do_HEAD()

    def serve_index(self, *, body: bool) -> None:
        with open(os.path.join(WEB, "index.html"), "rb") as handle:
            page = handle.read()
        # Last thing before </body>, so the app's own module has already run and
        # the dropzone it listens on exists.
        marker = b"</body>"
        tag = SCRIPT_TAG.encode() + b"\n"
        page = page.replace(marker, tag + marker, 1) if marker in page else page + tag
        self.respond(200, "text/html; charset=utf-8", page, body=body)

    def serve_debug(self, rest: str, *, body: bool) -> None:
        if rest == "seed.js":
            with open(SEED_JS, "rb") as handle:
                self.respond(200, "text/javascript", handle.read(), body=body)
            return

        if rest == "samples.json":
            manifest = [
                {"name": name, "size": os.path.getsize(os.path.join(self.samples_dir, name))}
                for name in self.samples
            ]
            payload = json.dumps({"files": manifest}, indent=2).encode()
            self.respond(200, "application/json", payload, body=body)
            return

        if rest.startswith("samples/"):
            name = rest[len("samples/"):]
            # Membership in the generated set is the path check: a name that is
            # not one this server wrote never reaches the filesystem, so `..`
            # and absolute paths are refused by not matching rather than by
            # being sanitised.
            if name not in self.samples:
                self.send_error(404, "Not Found")
                return
            with open(os.path.join(self.samples_dir, name), "rb") as handle:
                data = handle.read()
            kind = "text/plain" if name.endswith(".hex") else "application/octet-stream"
            self.respond(200, kind, data, body=body)
            return

        self.send_error(404, "Not Found")

    def respond(self, code: int, content_type: str, payload: bytes, *, body: bool) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        # Debug bytes are regenerated per run and the page is rewritten per
        # request; a cached copy of either is a confusing morning.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(payload)

    def log_message(self, fmt, *args):  # quieter than the default
        sys.stderr.write("  %s\n" % (fmt % args))


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(port: int, *, debug: bool, samples_dir: str, host: str = "127.0.0.1") -> Server:
    samples: tuple[str, ...] = ()
    if debug:
        os.makedirs(samples_dir, exist_ok=True)
        samples = tuple(generate_samples(samples_dir))
    handler = type("BoundHandler", (Handler,), {
        "debug": debug,
        "samples_dir": samples_dir,
        "samples": samples,
    })
    return Server((host, port), handler)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--debug", action="store_true",
                        help="seed the Browse panel with generated .syx files")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1",
                        help="127.0.0.1 by default; the debug harness is not "
                             "something to expose on a LAN")
    parser.add_argument("--samples", default=os.path.join(ROOT, "samples"),
                        help="where --debug writes the generated files")
    args = parser.parse_args()

    try:
        server = make_server(args.port, debug=args.debug,
                             samples_dir=args.samples, host=args.host)
    except OSError as error:
        print(f"cannot serve on {args.host}:{args.port}: {error}", file=sys.stderr)
        return 1

    where = f"http://{args.host}:{server.server_address[1]}/"
    print(f"serving {WEB} at {where}")
    if args.debug:
        print(f"debug: seeding {len(server.RequestHandlerClass.samples)} files "
              f"from {args.samples}")
    else:
        print("debug off: serving web/ exactly as Pages would")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
