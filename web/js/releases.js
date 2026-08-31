/* Firmware builds published on the firmware repository's releases page - the
 * browser half of nava/releases.py.
 *
 * The browser cannot compile anything, so unlike the CLI this is not one of two
 * ways to get an image: it is the only one that does not involve the visitor
 * having a .syx already. `nava build` still exists for anyone with a firmware
 * checkout and PlatformIO.
 *
 * ONE THING THE CLI DOES NOT HAVE TO WORK AROUND: a release asset cannot be
 * fetched cross-origin. api.github.com answers with
 * `access-control-allow-origin: *`, so looking a release up works; the asset
 * itself - the 302 from github.com and the release-assets.githubusercontent.com
 * response it points at - carries no such header, so `fetch` on it fails with a
 * bare "Failed to fetch" in every browser. There is no header to ask for and no
 * endpoint that behaves differently; a CORS proxy is the usual answer and is
 * the wrong one for a page that flashes firmware.
 *
 * So there are two paths, in this order:
 *
 *   1. The copy deployed beside this page (`firmware/index.json`), which the
 *      Pages workflow downloads at deploy time where no CORS applies. Same
 *      origin, one click, no third party involved at all.
 *   2. Anything else - an older tag, a fork, a release cut since the last
 *      deploy - hands off to an ordinary browser download and asks for the file
 *      back. GitHub serves assets as `Content-Disposition: attachment`, so a
 *      plain navigation downloads it and leaves the page alone.
 *
 * Unauthenticated requests, deliberately: the releases of a public repository
 * need no token, and GitHub's 60-per-hour limit is not a constraint for a
 * button a person presses by hand. There is nowhere safe to put a token in a
 * static page anyway.
 */

export const DEFAULT_REPO = 'jeanbrazeau/Nava-Firmware';
export const API = 'https://api.github.com';

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

/** Nothing published under that name - as opposed to a request that failed.
 *
 * Its own class so `fetchRelease` can tell "GitHub says no such tag" from
 * "GitHub could not be reached": only the first is worth retrying as a title
 * lookup. */
export class ReleaseNotFound extends ReleaseError {
  constructor(message) {
    super(message);
    this.name = 'ReleaseNotFound';
  }
}

async function getJson(url) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (error) {
    throw new ReleaseError(`cannot reach GitHub: ${error.message ?? error}`);
  }
  if (response.status === 404) throw new ReleaseNotFound(`not found: ${url}`);
  if (response.status === 403) {
    throw new ReleaseError(
      'GitHub refused the request (403). This is usually the unauthenticated ' +
        'rate limit - wait an hour, or download the .syx from the releases page ' +
        'and drop it in.',
    );
  }
  if (!response.ok) throw new ReleaseError(`GitHub returned ${response.status} for ${url}`);
  try {
    return await response.json();
  } catch (error) {
    throw new ReleaseError(`GitHub returned something that is not JSON: ${error.message}`);
  }
}

function parse(payload) {
  const assets = (payload.assets ?? []).map((asset) => ({
    name: asset.name ?? '',
    url: asset.browser_download_url ?? '',
    size: Number(asset.size ?? 0),
  }));
  return {
    tag: payload.tag_name ?? '',
    name: payload.name ?? payload.tag_name ?? '',
    prerelease: Boolean(payload.prerelease),
    published: (payload.published_at ?? '').slice(0, 10),
    assets,
    /* The image to flash. A release can carry several files - a backup, a hex,
     * notes - so the .syx is picked by extension rather than by position. Where
     * there is more than one the shortest name wins: `firmware.syx` over
     * `firmware-debug.syx`, which is the convention this repository publishes
     * under. */
    get firmware() {
      const candidates = this.assets.filter((a) => a.name.toLowerCase().endsWith('.syx'));
      if (!candidates.length) return null;
      return candidates.sort((a, b) => a.name.length - b.name.length || (a.name < b.name ? -1 : 1))[0];
    },
    get label() {
      return this.tag + (this.prerelease ? '  (pre-release)' : '');
    },
  };
}

export async function listReleases(repo = DEFAULT_REPO, limit = 20) {
  const payload = await getJson(`${API}/repos/${repo}/releases?per_page=${limit}`);
  if (!Array.isArray(payload)) throw new ReleaseError(`unexpected response listing releases of ${repo}`);
  return payload.map(parse);
}

/** One release: the newest published, or the one carrying `tag`.
 *
 * "latest" is GitHub's own endpoint, which skips pre-releases and drafts - the
 * right default for a button that flashes a drum machine.
 *
 * What is typed is also matched against release TITLES when no tag matches,
 * because the releases page shows the title (`Nava 0.92`) more prominently than
 * the tag (`0.92`), and that is what gets copied.
 */
export async function fetchRelease(tag, repo = DEFAULT_REPO) {
  const wanted = (tag ?? '').trim();
  if (!wanted || wanted === 'latest') {
    return parse(await getJson(`${API}/repos/${repo}/releases/latest`));
  }
  try {
    return parse(await getJson(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(wanted)}`));
  } catch (error) {
    if (!(error instanceof ReleaseNotFound)) throw error;
    const found = await byTitle(wanted, repo);
    if (!found) {
      throw new ReleaseNotFound(`not found: no release tagged or titled '${wanted}' in ${repo}`);
    }
    return found;
  }
}

/** The release whose tag or title is `wanted`, ignoring case and spacing. Only
 *  reached when the tag lookup already 404'd, so the extra request costs nothing
 *  in the common case. */
async function byTitle(wanted, repo) {
  const key = wanted.replace(/\s+/g, '').toLowerCase();
  for (const release of await listReleases(repo)) {
    const tag = release.tag.replace(/\s+/g, '').toLowerCase();
    const name = release.name.replace(/\s+/g, '').toLowerCase();
    if (key === tag || key === name) return release;
  }
  return null;
}

/** What the Pages workflow deployed beside this page, or null if there is none.
 *
 * Absent on a local `python3 -m http.server`, and absent on the very first
 * deploy of a repository whose firmware has no releases yet, so a missing or
 * unparseable manifest is a plain "no bundled image" rather than an error. */
export async function bundled() {
  try {
    const response = await fetch('firmware/index.json', { cache: 'no-cache' });
    if (!response.ok) return null;
    const manifest = await response.json();
    return manifest && manifest.file && manifest.tag ? manifest : null;
  } catch {
    return null;
  }
}

/** The bundled image's bytes. Same origin, so this is an ordinary fetch. */
export async function downloadBundled(manifest, onProgress) {
  const response = await fetch(`firmware/${manifest.file}`);
  if (!response.ok) {
    throw new ReleaseError(`the deployed copy of ${manifest.file} is missing (${response.status})`);
  }
  return readBody(response, manifest.size ?? 0, manifest.file, onProgress);
}

async function readBody(response, expected, name, onProgress) {
  const total = Number(response.headers.get('Content-Length')) || expected || 0;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks = [];
  let done = 0;
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    chunks.push(value);
    done += value.length;
    if (onProgress) onProgress(done, total || done, name);
  }

  const out = new Uint8Array(done);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Hand an asset to the browser's own downloader.
 *
 * Not a fetch: see the CORS note at the top of this file. GitHub serves release
 * assets as `Content-Disposition: attachment`, so navigating to one downloads
 * it and leaves this page where it is - which is the whole reason this works
 * where reading the bytes does not.
 */
export function handOffToBrowser(asset) {
  const anchor = document.createElement('a');
  anchor.href = asset.url;
  anchor.rel = 'noopener';
  // `download` is ignored cross-origin, but naming it costs nothing and is
  // honoured if GitHub ever serves these same-origin.
  anchor.download = asset.name;
  anchor.click();
}
