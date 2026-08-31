/* The site is a folder of static files with no build step, so nothing checks
 * that it hangs together until a browser loads it and a panel silently does
 * nothing. These are the checks a bundler would have done.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const html = readFileSync(join(WEB, 'index.html'), 'utf8');

const scripts = readdirSync(join(WEB, 'js')).filter((n) => n.endsWith('.js'));

test('every module import resolves to a file that exists', () => {
  for (const name of scripts) {
    const path = join(WEB, 'js', name);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = resolve(dirname(path), match[1]);
      assert.ok(existsSync(target), `${name} imports ${match[1]}, which does not exist`);
    }
  }
});

test('the page loads the stylesheet and the entry module', () => {
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.match(html, /<script type="module" src="js\/app\.js"><\/script>/);
  assert.ok(existsSync(join(WEB, 'style.css')));
});

test('every element the app looks up by id exists in the page', () => {
  const source = readFileSync(join(WEB, 'js', 'app.js'), 'utf8');
  const ids = new Set([...source.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 20, 'the id scan found suspiciously little');
  for (const id of ids) {
    assert.match(html, new RegExp(`id="${id}"`), `no element with id="${id}"`);
  }
});

test('the stylesheet cannot un-hide a hidden element', () => {
  // Any rule setting `display` on a tag or class outranks the user agent's
  // `[hidden]` rule, so `el.hidden = true` stops working and the element renders
  // anyway. It has happened twice: `section` left every tab panel on screen at
  // once, and `.alert` left the unsupported-browser warning up in a browser that
  // is perfectly well supported. The global override is what makes `hidden`
  // mean hidden regardless of what any component rule does.
  const css = readFileSync(join(WEB, 'style.css'), 'utf8');
  assert.match(
    css,
    /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/,
    'style.css needs `[hidden] { display: none !important }` — without it any ' +
      'rule that sets display on a tag or class silently un-hides elements',
  );
});

test('every tab button points at a panel that exists', () => {
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
  // Two: flashing moved in with the ports it flashes through, then dump and
  // restore followed, leaving Device and Browse. The floor is only here to
  // catch the regex finding nothing; the real check is the panel lookup below.
  assert.ok(controls.length >= 2);
  for (const id of controls) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="tabpanel"`), `no panel ${id}`);
  }
});

test('nothing is loaded from a third party', () => {
  // The page has to work over a phone tether in a rehearsal room, and a tool
  // that flashes firmware should not hand a CDN the chance to change what it
  // runs. Every asset is same-origin; the only external URLs are links.
  for (const match of html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)) {
    const url = match[1];
    assert.ok(
      /^https:\/\/github\.com\//.test(url),
      `${url} is fetched from a third party`,
    );
  }
});

test('nothing the site publishes mentions the debug harness', () => {
  // web/ is what pages.yml uploads. The seeding harness lives in tools/debug/
  // and is injected by tools/devserver.py --debug as it writes the response, so
  // a reference to it in here is one that would ship and then 404 in
  // production - silently, since a module that fails to load says nothing.
  const skip = new Set(['firmware', 'samples']);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return skip.has(entry.name) ? [] : walk(join(dir, entry.name));
    return [join(dir, entry.name)];
  });
  const offenders = walk(WEB).filter((path) => readFileSync(path, 'utf8').includes('__debug__'));
  assert.deepEqual(offenders, [], 'debug references in the published directory');
});

test('the debug harness still has the app hook it seeds through', () => {
  // tools/debug/seed.js hands files over as a synthetic drop rather than
  // calling into app.js, so the only thing holding the two together is this
  // element and this listener. Renaming either seeds nothing, with no error.
  const harness = fileURLToPath(new URL('../../tools/debug/seed.js', import.meta.url));
  const seed = readFileSync(harness, 'utf8');
  for (const match of seed.matchAll(/getElementById\('([^']+)'\)/g)) {
    assert.match(html, new RegExp(`id="${match[1]}"`), `seed.js wants #${match[1]}`);
  }
  const app = readFileSync(join(WEB, 'js', 'app.js'), 'utf8');
  assert.match(app, /dropzone\.addEventListener\('drop'/,
    'seed.js dispatches a drop on #dropzone; app.js no longer listens for one');
});
