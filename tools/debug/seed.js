/* Debug harness: put generated .syx files into Browse on page load.
 *
 * Served at /__debug__/seed.js by tools/devserver.py --debug, and injected into
 * index.html by that server as it writes the response. It lives here rather
 * than under web/ so it cannot reach the Pages artifact - see the note at the
 * top of devserver.py.
 *
 * It imports nothing from web/js and calls nothing the app exports. The files
 * arrive through a synthetic drop on the dropzone, which is the same path a
 * dragged file takes: no debug branch in app.js, and seeding exercises the real
 * ingestion path rather than a shortcut around it. If the drop handler breaks,
 * this breaks with it, which is the point.
 */

const MANIFEST = '/__debug__/samples.json';
const SAMPLES = '/__debug__/samples/';

// GEM, but unmistakably not part of the app: black bar, inline styles only, so
// nothing debug-shaped ever enters web/style.css.
const BAR = {
  position: 'fixed', top: '0', left: '0', right: '0', zIndex: '999',
  display: 'flex', gap: '8px', alignItems: 'center',
  background: '#000', color: '#fff', padding: '3px 8px',
  font: '12px/1.4 ui-monospace, monospace',
};

function bar() {
  const el = document.createElement('div');
  Object.assign(el.style, BAR);
  const label = document.createElement('span');
  const button = document.createElement('button');
  button.textContent = 'reseed';
  Object.assign(button.style, {
    font: 'inherit', background: '#fff', color: '#000',
    border: '1px solid #fff', padding: '0 6px', cursor: 'pointer',
  });
  el.append(label, button);
  document.body.prepend(el);
  // The bar overlays the top of the page; push the page down by its height so
  // it does not sit on the title bar.
  document.body.style.paddingTop = `${el.offsetHeight}px`;
  return { say: (text) => { label.textContent = text; }, button };
}

async function fetchFile({ name }) {
  const response = await fetch(SAMPLES + encodeURIComponent(name));
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return new File([await response.blob()], name);
}

/** Hand the files to the app the way a drag does.
 *
 * One event carrying all of them, in reverse manifest order: addFile() puts
 * each new file at the top of the list and selects it, so the last one dropped
 * is the one left on screen - and that should be the first entry, the full
 * backup. */
function drop(files) {
  const dropzone = document.getElementById('dropzone');
  if (!dropzone) throw new Error('no #dropzone: has index.html changed?');
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  dropzone.dispatchEvent(new DragEvent('drop', {
    dataTransfer: data, bubbles: true, cancelable: true,
  }));
}

async function seed(say) {
  say('DEBUG · loading…');
  const response = await fetch(MANIFEST);
  if (!response.ok) throw new Error(`manifest: ${response.status}`);
  const { files } = await response.json();
  const loaded = await Promise.all(files.map(fetchFile));
  drop([...loaded].reverse());
  // Browsing is the reason to seed, so land there rather than on Device. The
  // app's own tab button, so the panel switch stays the app's business.
  document.getElementById('tab-browse')?.click();
  const bytes = loaded.reduce((sum, file) => sum + file.size, 0);
  say(`DEBUG · ${loaded.length} seeded files (${bytes.toLocaleString()} bytes) · not deployed`);
}

const ui = bar();
ui.button.addEventListener('click', () => run());

async function run() {
  try {
    await seed(ui.say);
  } catch (error) {
    // The app's own status line is for the app; a broken harness says so here.
    ui.say(`DEBUG · seeding failed: ${error.message ?? error}`);
    console.error('[debug] seeding failed', error);
  }
}

run();
