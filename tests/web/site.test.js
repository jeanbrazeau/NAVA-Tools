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

test('hiding a tab panel is not overridden by the section rule', () => {
  // `section { display: flex }` outranks the user agent's `[hidden]` rule, so
  // without an explicit override every panel renders at once and only the first
  // tab is reachable. That is what shipped the first time this page was opened.
  const css = readFileSync(join(WEB, 'style.css'), 'utf8');
  if (/(^|\})\s*section\s*\{[^}]*display\s*:/m.test(css)) {
    assert.match(
      css,
      /section\[hidden\]\s*\{[^}]*display\s*:\s*none/,
      'style.css sets display on `section` but never turns it off for [hidden]',
    );
  }
});

test('every tab button points at a panel that exists', () => {
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(controls.length >= 4);
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
