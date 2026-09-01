/* The page. Three panels in the order the work usually happens: pick the ports
 * and flash if you are flashing, move the data, then look at what came back.
 *
 * Everything a MIDI operation touches is async, so "busy" is a single flag
 * rather than a worker thread: the transfer loops await and the UI keeps
 * painting. They also poll a shouldStop between items; the Flash button, turned
 * into Stop for the duration, is what sets it - see the note on shouldStop.
 *
 * Restore goes through a confirmation naming what is about to be overwritten:
 * it writes to a device that gives no confirmation of its own, and cannot be
 * undone. Flash does not - the unit has to be put into bootloader mode by hand
 * first, which is its own deliberate step.
 */

import * as protocol from './protocol.js';
import * as bootloader from './bootloader.js';
import * as edit from './edit.js';
import * as grid from './grid.js';
import { History } from './history.js';
import * as ihex from './ihex.js';
import * as library from './library.js';
import * as midi from './midi.js';
import * as releases from './releases.js';
import * as render from './render.js';
import * as store from './store.js';
import * as transfer from './transfer.js';

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_RETRIES = 2;
const DEFAULT_FLASH_DELAY_MS = 250;

// The image list's last entry, which opens a file picker rather than naming a
// file. Only .syx names reach that list, so this cannot be one of them.
const FIRMWARE_OTHER = '__other__';

const SYSEX_PAGE_HINT =
  'Stop the sequencer and press SHIFT+TEMPO to the SysEx page ("type / select") first.';

const $ = (id) => document.getElementById(id);

const state = {
  access: null,
  ports: null,
  files: [],
  selectedFile: null,
  // Where Detail is looking within the selected backup: `bank` and `pattern`
  // are the BANK/PATTERN pickers' own selection (pattern is the Item, or null
  // once a file has none), `view` is INST./EXT - a panel-level control, so it
  // is not reset by picking a different bank or pattern. `detailItem` is
  // whichever Item Detail is actually showing, which is the pattern - the
  // setup record used to be able to take the pane over, and now has a window
  // of its own beside it instead.
  bank: null,
  pattern: null,
  view: 'inst',
  detailItem: null,
  busy: false,
  stopRequested: false,
  settings: store.load(),
  // ?repo=owner/name, the browser's answer to the CLI's NAVA_REPO. A query
  // string rather than a remembered setting: it points the Firmware panel at a
  // fork for as long as that link is open, and a shared link carries it.
  repo: new URLSearchParams(location.search).get('repo') || releases.DEFAULT_REPO,
};

// Undo/redo for pattern edits. Session-lived and in memory, like the rest of
// `state` - it does not need to survive a reload, and the History class
// itself has no idea what a file or an item is, so it lives outside `state`.
const history = new History();

// A copy of each item's payload as it stood when its file was loaded (or last
// saved), so an edited file can tell whether undoing has brought it back to
// that state without having to remember every edit that happened in between.
const loadedSnapshots = new WeakMap();

// Which lane the chart was showing in each view, so rebuilding it - a bank,
// pattern or view change does this, and so does undo - reopens on the same
// row instead of resetting to BASS DRUM. Keyed by item and then by view
// ('inst'/'ext') rather than kept as one value, so switching to a different
// pattern and back does not carry the wrong pattern's lane with it; switching
// patterns on purpose is exactly the case that should NOT preserve it.
const chartLanes = new WeakMap();

/* ---------- small helpers ---------- */

function status(text) {
  $('status').textContent = text;
}

function clearLog(id) {
  $(id).replaceChildren();
}

function log(id, text, bad = false) {
  const pre = $(id);
  const line = document.createElement('span');
  line.textContent = `${text}\n`;
  if (bad) line.className = 'bad';
  pre.appendChild(line);
  pre.scrollTop = pre.scrollHeight;
}

function setProgress(id, done, total) {
  const bar = $(id);
  bar.max = total || 1;
  bar.value = done;
}

function setBusy(busy) {
  state.busy = busy;
  state.stopRequested = false;
  for (const id of ['do-dump', 'do-restore', 'do-flash']) {
    $(id).disabled = busy;
  }
}

/* Set by pressing the Flash button while a flash is running (it reads Stop for
 * the duration). The transfer loops poll this between items, so a stop lands
 * cleanly at a message boundary; dump and restore still take the same callback
 * but keep their buttons disabled while busy, so only flash can trip it. */
const shouldStop = () => state.stopRequested;

/** A yes/no gate for something that cannot be undone. */
function confirmDialog(title, body, confirmLabel = 'Continue') {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = confirmLabel;
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.close();
      $('confirm-ok').removeEventListener('click', ok);
      $('confirm-cancel').removeEventListener('click', cancel);
      resolve(value);
    };
    const ok = () => finish(true);
    const cancel = () => finish(false);
    $('confirm-ok').addEventListener('click', ok);
    $('confirm-cancel').addEventListener('click', cancel);
  });
}

/* Ask for the destination BEFORE the transfer starts, while the click that
 * began it still counts as a user gesture: showSaveFilePicker refuses to open
 * minutes later, and a full backup takes minutes. */
async function pickSaveFile(suggestedName) {
  if (!window.showSaveFilePicker) return { name: suggestedName, handle: null };
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'SysEx', accept: { 'application/octet-stream': ['.syx'] } }],
    });
    return { name: handle.name, handle };
  } catch (error) {
    if (error.name === 'AbortError') return null;
    return { name: suggestedName, handle: null };
  }
}

async function writeFile(target, bytes) {
  if (target.handle) {
    const writable = await target.handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = target.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** What the Save as box starts on: the date first, so a folder of these sorts
 *  into the order they were taken. */
const defaultDumpName = () => `${today()} NAVA Backup`;

/** The name the save dialog opens on. `.syx` is appended rather than shown in
 *  the box: it is not a choice, and an extension in an editable field is
 *  something to accidentally delete. A box emptied entirely falls back to the
 *  default rather than saving a file called nothing. */
function dumpFileName() {
  const typed = $('dump-name').value.trim();
  const base = (typed || defaultDumpName()).replace(/\.syx$/i, '');
  return `${base}.syx`;
}

/* ---------- tabs ---------- */

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[role="tab"]')) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      $(other.getAttribute('aria-controls')).hidden = !selected;
    }
  });
}

/* ---------- MIDI ---------- */

function connectionPill(text, kind) {
  const pill = $('connection');
  pill.textContent = text;
  pill.className = `pill pill-${kind}`;
}

async function enableMidi() {
  try {
    state.access = await midi.requestAccess();
  } catch (error) {
    connectionPill('MIDI unavailable', 'warn');
    $('unsupported').hidden = false;
    status(error.message);
    return;
  }
  $('enable-midi').disabled = true;
  $('enable-midi').textContent = 'MIDI enabled';
  state.access.onstatechange = () => {
    refreshPorts();
    openPorts();
  };
  refreshPorts();
  await openPorts();
}

function portList(element, ports, selectedName, onPick) {
  element.replaceChildren();
  if (!ports.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = state.access ? 'no ports' : 'enable MIDI to see ports';
    element.appendChild(empty);
    return;
  }
  for (const port of ports) {
    const item = document.createElement('li');
    item.setAttribute('aria-selected', String(port.name === selectedName));
    item.title = port.manufacturer ? `${port.name} — ${port.manufacturer}` : port.name;
    const name = document.createElement('span');
    name.textContent = port.name;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = port.manufacturer || '';
    item.append(name, sub);
    item.addEventListener('click', () => onPick(port.name));
    element.appendChild(item);
  }
}

function refreshPorts() {
  const { inputs, outputs } = state.access
    ? midi.listPorts(state.access)
    : { inputs: [], outputs: [] };
  portList($('out-ports'), outputs, state.settings.outputPort, (name) => {
    state.settings.outputPort = name;
    store.save(state.settings);
    refreshPorts();
    openPorts();
  });
  portList($('in-ports'), inputs, state.settings.inputPort, (name) => {
    state.settings.inputPort = name;
    store.save(state.settings);
    refreshPorts();
    openPorts();
  });
}

async function openPorts() {
  if (!state.access) return;
  if (state.ports) state.ports.close();
  const { inputs, outputs } = midi.listPorts(state.access);
  const output = outputs.find((p) => p.name === state.settings.outputPort) ?? null;
  const input = inputs.find((p) => p.name === state.settings.inputPort) ?? null;
  // open() is explicit rather than left to the implicit open on first send: a
  // port another application holds exclusively fails here, with a name, instead
  // of swallowing the first message sent to it.
  for (const port of [output, input]) {
    if (!port) continue;
    try {
      await port.open();
    } catch (error) {
      status(`cannot open ${port.name}: ${error.message ?? error}`);
    }
  }
  state.ports = new midi.Ports(input, output);
  updateConnection();
}

function updateConnection() {
  const out = state.ports?.output?.name;
  const input = state.ports?.input?.name;
  if (!state.access) {
    connectionPill('MIDI not enabled', 'idle');
  } else if (out && input) {
    connectionPill('ports ready', 'ok');
  } else if (out || input) {
    connectionPill(out ? 'output only' : 'input only', 'warn');
  } else {
    connectionPill('no ports chosen', 'warn');
  }
  status(`out: ${out ?? '—'}   in: ${input ?? '—'}`);
}

function portsReady(needInput, logId) {
  if (!state.access) {
    log(logId, 'MIDI is not enabled. Press "Enable MIDI" and allow SysEx.', true);
    return false;
  }
  if (!state.ports?.output) {
    log(logId, 'No output port chosen — pick one under Device.', true);
    return false;
  }
  if (needInput && !state.ports.input) {
    log(logId, 'No input port chosen — pick one under Device.', true);
    return false;
  }
  return true;
}

/* ---------- files ---------- */

/** `dated` is when the image was made, as well as anyone here can know it.
 *
 * The .syx carries no build stamp - nothing in the bootloader format has a
 * place to put one - so this is the best available fact rather than a compile
 * time read out of the file: the release date from firmware/index.json for the
 * deployed image, and the file's own modified time for one off a disk. Absent
 * is a legitimate answer and prints nothing. */
function addFile(name, bytes, dated = null) {
  // A .hex is converted on the way in rather than offered as a third kind of
  // file: what the bootloader accepts is the .syx, and every path downstream
  // takes bytes that are already encoded.
  let data = bytes;
  let label = name;
  if (/\.hex$/i.test(name)) {
    try {
      data = bootloader.encodeFirmware(ihex.load(new TextDecoder().decode(bytes)));
      label = name.replace(/\.hex$/i, '.syx');
      status(`${name}: converted to ${label}`);
    } catch (error) {
      status(`${name}: ${error.message ?? error}`);
      return null;
    }
  }
  const file = library.load(label, data);
  if (dated) {
    file.dated = dated;
  }
  for (const item of file.items) loadedSnapshots.set(item, item.payload.slice());
  state.files = [file, ...state.files.filter((f) => f.name !== label)];
  // Firmware never shows under Patterns - it lands in the Device tab's image
  // picker, and the status line is the only trace the drop leaves here. If it
  // replaced a listed file of the same name, the selection has to let go too.
  if (file.kind === library.KIND_FIRMWARE) {
    if (state.selectedFile?.name === label) selectFile(null);
    else refreshFiles();
    status(`${label}: firmware image — pick it under Device`);
  } else {
    selectFile(file);
  }
  return file;
}

/* The second click of a double click, rather than a dblclick event - because
 * there is no dblclick event to listen for.
 *
 * The first click selects the file, and selecting rebuilds the list, so the
 * element under the pointer is not the same one the first click landed on.
 * Chrome does not fire dblclick when that happens: instrumented, a double
 * click on a row produces two clicks with detail 1 and 2 and nothing else at
 * all. A dblclick handler on the row, on the list, or on the document would
 * each have waited forever. `detail` is the click count the browser is already
 * keeping, and it survives the row being replaced underneath it.
 *
 * Bound to the list rather than the rows for the same reason: the row this
 * started on is gone by now. The one under the pointer is the one meant. */
let renameTarget = null;

/* Which row the gesture started on, taken before anything moves.
 *
 * The first click selects the file, and that rebuilds Detail above this list -
 * a different file is a different chart, a different height, and the list
 * slides up or down under a pointer that has not moved. Asking what is under
 * the pointer on the second click therefore answers with a different row than
 * the one that was double-clicked, and renames the wrong file. mousedown runs
 * before any of that. */
$('files').addEventListener('mousedown', (event) => {
  if (event.detail !== 1) return;
  renameTarget = event.target.closest?.('li[data-name]')?.dataset.name ?? null;
}, true);

$('files').addEventListener('click', (event) => {
  if (event.detail < 2 || !renameTarget) return;
  const file = fileByName(renameTarget);
  // By name, not by position: the row element is a new one after the rebuild.
  const row = [...$('files').children].find((li) => li.dataset.name === renameTarget);
  if (file && row) renameInPlace(row, file);
});

/** Rename a file by double-clicking its row.
 *
 * In place rather than through a dialog: the name is already on screen and the
 * row is already the right shape to type in. Enter or clicking away keeps it,
 * Escape puts it back.
 *
 * The name is the key everything downstream looks the file up by - the Restore
 * and Image pickers, Save…, and addFile's own replace-by-name - so two files
 * cannot share one, and an empty name is not a name. Either is refused and the
 * old one stays, said in the status line rather than in a dialog, because a
 * rejected rename is not worth a modal.
 *
 * A name typed without an extension keeps the one it had. `.syx` is what makes
 * the file mean anything to the next thing that opens it, and losing it to a
 * rename is not something anyone intends. */
function renameInPlace(row, file) {
  if (row.querySelector('input')) return;
  const box = document.createElement('input');
  box.className = 'rename';
  box.value = file.name;
  box.spellcheck = false;
  row.replaceChildren(box);
  box.focus();
  // The extension is selected out of the way rather than included: the stem is
  // what a rename is usually about.
  const dot = file.name.lastIndexOf('.');
  box.setSelectionRange(0, dot > 0 ? dot : file.name.length);

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) commitRename(file, box.value);
    refreshFiles();
    refreshBrowse();
  };
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
    else return;
    event.preventDefault();
  });
  box.addEventListener('blur', () => finish(true));
  // The row's own click selects the file; a click inside the box is not that.
  box.addEventListener('click', (event) => event.stopPropagation());
  box.addEventListener('dblclick', (event) => event.stopPropagation());
}

/** The extension is not the user's to delete: it is stripped off whatever was
 *  typed and put back. `.syx` is what makes the file mean anything to the next
 *  thing that opens it - a restore, another copy of this page, the CLI - and a
 *  rename is about the name, not about what kind of file it is. */
function commitRename(file, typed) {
  const dot = file.name.lastIndexOf('.');
  const extension = dot > 0 ? file.name.slice(dot) : '';
  const stem = typed.trim().replace(new RegExp(`${extension}$`, 'i'), '').trim();
  if (!stem) return;
  const named = stem + extension;
  if (named === file.name) return;
  if (state.files.some((f) => f !== file && f.name === named)) {
    status(`${named} is already loaded — not renamed`);
    return;
  }
  file.name = named;
  status(`renamed to ${named}`);
}

function refreshFiles() {
  const list = $('files');
  list.replaceChildren();
  // Only what Patterns is for: backups, and anything unrecognised so a broken
  // file is at least visible. Firmware stays in state.files - the Device tab's
  // image picker below is fed from there - but has no row here.
  const listed = state.files.filter((f) => f.kind !== library.KIND_FIRMWARE);
  if (!listed.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no files loaded';
    list.appendChild(empty);
  }
  for (const file of listed) {
    const item = document.createElement('li');
    item.setAttribute('aria-selected', String(file === state.selectedFile));
    // Filename only. A backup summary is a dozen words - putting it beside a
    // 25-character filename in a list box leaves room for neither, and it is
    // already on the row's title and in the Detail pane.
    item.title = `${file.name} — ${file.summary()}`;
    const name = document.createElement('span');
    // A leading bullet is the whole marker: it survives the row inverting,
    // which a colour would not.
    name.textContent = file.edited ? `\u2022 ${file.name}` : file.name;
    item.append(name);
    // Which row this is, for the rename delegated to the list below.
    item.dataset.name = file.name;
    item.addEventListener('click', () => selectFile(file));
    list.appendChild(item);
  }

  fillSelect($('restore-file'), state.files.filter((f) => f.kind === library.KIND_BACKUP),
    '— load a .syx under Patterns —');
  // Filling the list can change which file is selected - a dropped backup
  // becomes the chosen one - and the grid under it has to follow, since
  // fillSelect assigns .value in script and that fires no change event.
  syncRestoreMatrix();
  // Names only for the image picker: picking one prints its size, pages and
  // date into the log underneath, so repeating them in the option is the same
  // sentence twice and a very wide select. The backup picker keeps its summary
  // - there is nothing under it that says what is in the file.
  const images = $('firmware-file');
  fillSelect(images, state.files.filter((f) => f.kind === library.KIND_FIRMWARE), null, false);
  // Last in the list, because it is not an image: it is the way to reach one
  // that was never published - a local build, a test image - without going to
  // Patterns and coming back.
  const other = document.createElement('option');
  other.value = FIRMWARE_OTHER;
  other.textContent = 'Other…';
  images.appendChild(other);
  // fillSelect leaves an empty value when there are no images at all, which
  // would render the select blank. Other… is then the only thing it can say.
  if (!images.value) images.value = FIRMWARE_OTHER;
}

/** `placeholder` null leaves the list with no blank entry at all - for the
 *  image picker, which has an Other… of its own to offer instead. */
function fillSelect(element, files, placeholder, withSummary = true) {
  const previous = element.value;
  element.replaceChildren();
  if (placeholder !== null) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = placeholder;
    element.appendChild(blank);
  }
  for (const file of files) {
    const option = document.createElement('option');
    option.value = file.name;
    option.textContent = withSummary ? `${file.name} — ${file.summary()}` : file.name;
    element.appendChild(option);
  }
  element.value = files.some((f) => f.name === previous) ? previous : (files[0]?.name ?? '');
}

function fileByName(name) {
  return state.files.find((f) => f.name === name) ?? null;
}

/* ---------- browse: banks and patterns ----------
 *
 * The Contents list used to let you click any item. In its place, Detail
 * itself is the picker: BANK narrows to one 16-pattern block and PATTERN
 * narrows to one slot in it. The file's config record is not picked at all -
 * there is only ever one, so it shows itself in its own window rather than
 * competing with the chart for the pane.
 */

const patternBank = (item) => Math.floor(item.param / protocol.PTRN_PER_BANK);
const patternSlot = (item) => item.param % protocol.PTRN_PER_BANK;

/** The bank letter a bank index prints as, via the same mapping the firmware
 *  and the CLI use - not re-derived by hand, and not assumed to stop at four
 *  banks: MAX_BANK is 8, and a full backup uses all of them. */
const bankLetter = (bank) => protocol.patternLabel(bank * protocol.PTRN_PER_BANK).charAt(0);

/** bank index -> Map(slot 0..15 -> Item), built from whichever pattern items
 *  the file actually has. Only a backup has any; everything else reads as no
 *  banks at all, which is what leaves BANK and PATTERN empty. */
function patternsByBank(file) {
  const banks = new Map();
  if (!file || file.kind !== library.KIND_BACKUP) return banks;
  for (const item of file.items) {
    if (item.cmd !== protocol.NAVA_PTRN_DMP) continue;
    const bank = patternBank(item);
    if (!banks.has(bank)) banks.set(bank, new Map());
    banks.get(bank).set(patternSlot(item), item);
  }
  return banks;
}

/** The lowest-numbered pattern a bank has, or null - what BANK lands on when
 *  there is nothing already selected worth keeping. */
function firstPattern(slots) {
  for (let slot = 0; slot < protocol.PTRN_PER_BANK; slot += 1) {
    if (slots.has(slot)) return slots.get(slot);
  }
  return null;
}

function fileConfigItem(file) {
  if (!file || file.kind !== library.KIND_BACKUP) return null;
  return file.items.find((i) => i.cmd === protocol.NAVA_CONFIG_DMP) ?? null;
}

function selectFile(file) {
  state.selectedFile = file;
  const banks = patternsByBank(file);
  const bankKeys = [...banks.keys()].sort((a, b) => a - b);
  state.bank = bankKeys[0] ?? null;
  state.pattern = state.bank !== null ? firstPattern(banks.get(state.bank)) : null;
  state.detailItem = state.pattern;
  refreshFiles();
  refreshBrowse();
}

function selectBank(bank) {
  state.bank = bank;
  const slots = patternsByBank(state.selectedFile).get(bank) ?? new Map();
  // Stay on the same slot if this bank still has it - PATTERN 3 in bank A and
  // PATTERN 3 in bank B are different patterns, but landing on the same slot
  // number is less surprising than jumping to slot 1 for no reason.
  const kept = state.pattern && slots.get(patternSlot(state.pattern)) === state.pattern;
  selectPattern(kept ? state.pattern : firstPattern(slots));
}

function selectPattern(item) {
  state.pattern = item;
  state.detailItem = item;
  refreshBrowse();
}

function selectView(view) {
  if (state.view === view) return;
  state.view = view;
  refreshBrowse();
}

function refreshBankButtons() {
  const wrap = $('bank-buttons');
  wrap.replaceChildren();
  const banks = patternsByBank(state.selectedFile);
  for (const bank of [...banks.keys()].sort((a, b) => a - b)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chart-tab bank-btn';
    button.textContent = bankLetter(bank);
    button.setAttribute('aria-selected', String(bank === state.bank));
    button.addEventListener('click', () => selectBank(bank));
    wrap.appendChild(button);
  }
}

function refreshPatternButtons() {
  const wrap = $('pattern-buttons');
  wrap.replaceChildren();
  const slots = (state.bank !== null && patternsByBank(state.selectedFile).get(state.bank)) || new Map();
  for (let slot = 0; slot < protocol.PTRN_PER_BANK; slot += 1) {
    const item = slots.get(slot) ?? null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn pattern-btn';
    button.textContent = String(slot + 1);
    button.disabled = !item;
    button.setAttribute('aria-selected', String(item !== null && item === state.pattern));
    if (item) button.addEventListener('click', () => selectPattern(item));
    wrap.appendChild(button);
  }
}

/** The count on the EXT button, so a tab that opens onto sixteen blank rows
 *  says so first - moved here from grid.js along with the tabs themselves. */
function extTrackCount(item) {
  if (!item) return 0;
  try {
    return item.decoded().activeExtTracks().length;
  } catch {
    return 0;
  }
}

function refreshViewButtons() {
  const instButton = $('view-inst');
  const extButton = $('view-ext');
  const item = state.pattern;
  const count = extTrackCount(item);
  extButton.textContent = count ? `EXT (${count})` : 'EXT';
  instButton.disabled = !item;
  extButton.disabled = !item;
  instButton.setAttribute('aria-selected', String(state.view === 'inst'));
  extButton.setAttribute('aria-selected', String(state.view === 'ext'));
}

/** The setup record's lines, less the ext note map.
 *
 * Those sixteen notes are already on the chart: every lane in the EXT view is
 * labelled with its own note, which is where you want to read them - against
 * the steps that play them. A second copy here is four more lines to keep in
 * your head, in a column fifteen rem wide that they do not fit.
 *
 * Trimmed here rather than in render.configLines, which is pinned byte for
 * byte against the Python renderer by tests/fixtures/vectors.json and is what
 * `nava show` prints - a terminal has the width for the table and no EXT view
 * to read it off instead.
 *
 * The one thing the table said that the lane labels cannot is whether the
 * backup stores a note map at all or these are the power-on defaults standing
 * in, so that survives on its own line. */
function configPanelLines(config) {
  const lines = render.configLines(config);
  const at = lines.findIndex((line) => line.startsWith('ext track notes'));
  // Renderer changed shape: show everything rather than silently trimming the
  // wrong end of it.
  if (at < 0) return lines;
  const kept = lines.slice(0, at);
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  if (!config.extNotesStored) kept.push('', 'ext notes      defaults, none stored');
  return kept;
}

/** The setup record's own window, under Files when there is room beside the
 *  chart and under the chart when there is not - see .browse-row.
 *
 *  It shows itself rather than waiting to be picked. There is exactly one
 *  config record per backup and it is what the patterns are played through, so
 *  there is nothing to choose between and no reason to make reading it cost
 *  the chart its place on screen. A file that carries none has no window at
 *  all, rather than an empty one asking to be explained. */
function refreshConfigPanel() {
  const group = $('config-group');
  const item = fileConfigItem(state.selectedFile);
  if (!item) {
    group.hidden = true;
    $('config-view').textContent = '';
    return;
  }
  group.hidden = false;
  let text;
  try {
    text = configPanelLines(item.decoded()).join('\n');
  } catch (error) {
    // A backup can be truncated mid-record; the file list already says so, and
    // this says which record rather than rendering half of one.
    text = `config / setup: ${error.message ?? error}`;
  }
  $('config-view').textContent = text;
}

function refreshBrowse() {
  refreshBankButtons();
  refreshPatternButtons();
  refreshViewButtons();
  refreshConfigPanel();

  const file = state.selectedFile;
  $('legend').textContent = '';
  if (!file || file.kind !== library.KIND_BACKUP || !state.detailItem) {
    showDetail(file ? describeFile(file) : 'Load a .syx to see what is in it.', detailTitle(file));
    return;
  }

  const item = state.detailItem;
  if (item.cmd === protocol.NAVA_PTRN_DMP) {
    showChart(file, item);
  } else {
    showDetail(describeItem(file, item), detailTitle(file, item));
  }
}

/** What #detail-title reads: the file alone, or the file and the item once one
 *  is picked. Shared by the chart and the plain-text views so the header reads
 *  the same regardless of which one is showing. */
function detailTitle(file, item = null) {
  if (!file) return '';
  return item ? `${file.name}  ›  ${item.label}` : file.name;
}

/* A pattern gets the machine's step chart; everything else is text. The two
 * views swap rather than stack, so the pane is never both - but the header
 * above them (#detail-title, undo, redo) is neither's own, so it is set here
 * rather than by grid.js, and survives a chart rebuild untouched. */
function showChart(file, item) {
  let pattern;
  try {
    pattern = item.decoded();
  } catch (error) {
    showDetail(`${item.label}: ${error.message ?? error}`, detailTitle(file, item));
    return;
  }
  // Per view, not per file-wide state: the same pattern can be looked at in
  // INST. or EXT, and each remembers its own lane independently.
  const lanes = chartLanes.get(item) ?? {};
  $('detail-title').textContent = detailTitle(file, item);
  const chart = $('chart');
  chart.replaceChildren(
    grid.patternChart(pattern, {
      config: file.config,
      // The record's own bytes, edited in place. Everything downstream -
      // Restore, Save - reads the items, so an edit is live the moment it lands.
      payload: item.payload,
      onEdit: (before) => recordEdit(file, item, before),
      view: state.view,
      lane: lanes[state.view] ?? null,
      onViewChange: (view, lane) => chartLanes.set(item, { ...lanes, [view]: lane }),
    }),
  );
  chart.hidden = false;
  $('detail').hidden = true;
  $('legend').textContent = grid.chartLegend(true);
}

/** An image, in the order you want to know it: what it is, when it was made,
 *  how big, how long to send. Null for anything that is not firmware.
 *
 *  Its own shape rather than the generic two-line header plus extras, which
 *  said the size twice - once as "N bytes - firmware, M bytes, P pages" and
 *  again as "M bytes of flash in P pages" - for a reader who only ever wanted
 *  it once. */
function firmwareLines(file) {
  if (file.kind !== library.KIND_FIRMWARE) return null;
  const lines = [file.name];
  if (file.dated) lines.push(`compilation date ${file.dated}`);
  lines.push(`${file.size} bytes: ${file.flashBytes} bytes, ${file.pages} pages`);
  lines.push(`about ${Math.ceil((file.pages * DEFAULT_FLASH_DELAY_MS) / 1000)}s to send`);
  return lines;
}

function describeFile(file) {
  const lines = firmwareLines(file) ?? [`${file.name}`, `${file.size} bytes — ${file.summary()}`];
  if (file.errors.length) {
    lines.push('', ...file.errors.map((e) => `bad: ${e}`));
  }
  if (file.kind === library.KIND_BACKUP) lines.push('', 'Pick a bank and pattern above.');
  return lines.join('\n');
}

function describeItem(file, item) {
  let decoded;
  try {
    decoded = item.decoded();
  } catch (error) {
    return `${item.label}: ${error.message ?? error}`;
  }
  // Patterns never reach here - they get the chart in showChart.
  if (item.cmd === protocol.NAVA_TRACK_DMP) {
    return render.trackLines(decoded, item.param).join('\n');
  }
  return render.configLines(decoded).join('\n');
}

function showDetail(text, title = '') {
  $('detail-title').textContent = title;
  $('detail').textContent = text;
  $('detail').hidden = false;
  $('chart').hidden = true;
}

/* ---------- editing ---------- */

/* An edit changes the record in memory, never the file it came from. The list
 * marks the file so it is obvious there is something to save, and the tab asks
 * before closing on top of it. */

const sameBytes = (a, b) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Whether every item in the file still reads exactly as it did when the file
 *  was loaded (or last saved) - which is the file's own definition of "not
 *  edited", not just "an edit happened at some point". Undoing back to that
 *  state has to clear the marker, not just leave it set because a click once
 *  fired. */
function bytesMatchLoaded(file) {
  return file.items.every((item) => sameBytes(item.payload, loadedSnapshots.get(item) ?? item.payload));
}

function syncEditedFlag(file) {
  file.edited = !bytesMatchLoaded(file);
  refreshFiles();
}

function announceEditState(file) {
  status(file.edited ? `${file.name}: edited, not saved` : `${file.name}: back to as loaded`);
}

function unsavedEdits() {
  return state.files.some((f) => f.edited);
}

/* ---------- undo/redo ---------- */

function refreshUndoButtons() {
  $('undo-edit').disabled = !history.canUndo();
  $('redo-edit').disabled = !history.canRedo();
}

/** One history entry per gesture, not per cell - grid.js already fires
 *  `onEdit` once per drag, with the bytes as they stood before it. Nothing
 *  here touches the chart itself: it is mid-gesture, redrawing itself as
 *  grid.js's own draw()/repaint() see fit, and does not need refreshBrowse()
 *  rebuilding it out from under the pointer. */
function recordEdit(file, item, before) {
  history.push({ file, item, before, after: item.payload.slice() });
  syncEditedFlag(file);
  refreshUndoButtons();
  announceEditState(file);
}

/** Show whatever the undo/redo just changed, then redraw it.
 *
 * The history is one chronological stack across every file, so an undo can
 * land on a pattern in a different bank, or a different file, than the one on
 * screen. It selects that bank and pattern rather than changing them quietly:
 * an edit you cannot see undone is indistinguishable from an undo that did
 * nothing, and the next thing the user does would be to press it again.
 */
function afterHistoryChange(file, item) {
  syncEditedFlag(file);
  state.selectedFile = file;
  state.bank = patternBank(item);
  state.pattern = item;
  state.detailItem = item;
  refreshFiles();
  refreshBrowse();          // redraws the chart from the record as it now reads
  if ($('panel-browse').hidden) $('tab-browse').click();
  refreshUndoButtons();
  announceEditState(file);
}

function undoEdit() {
  const entry = history.undo();
  if (!entry) return;
  // set(), not a new array: item.payload is the same reference the chart was
  // built on, and everything downstream reads that reference rather than a
  // copy of it.
  entry.item.payload.set(entry.before);
  afterHistoryChange(entry.file, entry.item);
}

function redoEdit() {
  const entry = history.redo();
  if (!entry) return;
  entry.item.payload.set(entry.after);
  afterHistoryChange(entry.file, entry.item);
}

$('undo-edit').addEventListener('click', undoEdit);
$('redo-edit').addEventListener('click', redoEdit);
$('view-inst').addEventListener('click', () => selectView('inst'));
$('view-ext').addEventListener('click', () => selectView('ext'));

// Cmd+Z / Ctrl+Z to undo, Cmd+Shift+Z or Ctrl+Y to redo - but not while the
// Transfer and Firmware panels' text fields have focus, where Z and Y are
// just letters being typed.
window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  const isUndo = key === 'z' && !event.shiftKey;
  const isRedo = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey);
  if (!isUndo && !isRedo) return;
  const target = document.activeElement;
  if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
  event.preventDefault();
  if (isUndo) undoEdit();
  else redoEdit();
});

$('save-file').addEventListener('click', async () => {
  const file = state.selectedFile;
  if (!file || file.kind !== library.KIND_BACKUP) {
    status('pick a backup under Files to save');
    return;
  }
  // Rebuilt from the items rather than from the bytes the file arrived as:
  // the items are what the edits went into, and what a Restore would send.
  const bytes = protocol.joinMessages(
    file.items.map((i) => protocol.encode(i.cmd, i.param, i.payload)),
  );
  const target = await pickSaveFile(file.name);
  if (!target) return;
  await writeFile(target, bytes);
  file.edited = false;
  file.bytes = bytes;
  // The saved state is now what "not edited" means for this file - undoing
  // past this point should mark it edited again, not leave the marker
  // pointing at bytes that were true before the save.
  for (const item of file.items) loadedSnapshots.set(item, item.payload.slice());
  refreshFiles();
  status(`wrote ${target.name} (${bytes.length} bytes)`);
});

/* ---------- demo pattern ---------- */

/** One pattern seeded into Files on startup, so Patterns opens on a working
 *  chart - the detail view demonstrating itself - rather than an empty pane
 *  asking for a file.
 *
 *  A four-on-the-floor 909 groove, written through edit.js exactly as clicks
 *  would write it and encoded exactly as Save… would encode it, so the seed is
 *  a real backup: everything downstream - the chart, editing, undo, Save…,
 *  even Restore - treats it as one, because it is one. */
function seedDemoPattern() {
  const payload = new Uint8Array(protocol.PATTERN_BYTES);
  edit.setLength(payload, 16);
  edit.setScale(payload, 24); // 1/16
  // [instrument, normal steps, accent steps] - BD, SD, CH, OH. The closed hat
  // sits out the open hat's steps, the way a player would choke it.
  const groove = [
    [8, [4, 12], [0, 8]],
    [9, [], [4, 12]],
    [14, [1, 3, 5, 7, 9, 11, 13, 15], [0, 4, 8, 12]],
    [15, [2, 6, 10, 14], []],
  ];
  for (const [instrument, normal, accent] of groove) {
    for (const step of normal) edit.setStep(payload, instrument, step, 'normal');
    for (const step of accent) edit.setStep(payload, instrument, step, 'accent');
  }
  addFile('Demo Pattern.syx', protocol.encode(protocol.NAVA_PTRN_DMP, 0, payload));
}

/* ---------- drop / pick ---------- */

const dropzone = $('dropzone');
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
}
dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  for (const file of event.dataTransfer.files) {
    addFile(file.name, new Uint8Array(await file.arrayBuffer()), fileDate(file));
  }
});
$('pick-files').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (event) => {
  for (const file of event.target.files) {
    addFile(file.name, new Uint8Array(await file.arrayBuffer()), fileDate(file));
  }
  event.target.value = '';
});

/** A dropped file's own modified time, as a plain date. Browsers report 0 for a
 *  file with no timestamp, which is 1970 and worse than saying nothing. */
function fileDate(file) {
  if (!file.lastModified) return null;
  return new Date(file.lastModified).toISOString().slice(0, 10);
}

/* ---------- what to dump ----------
 *
 * The same idea as the pattern chart on Patterns: a grid you read the answer off
 * rather than a box you describe it in. Banks across the top, the sixteen
 * slots down the side, so a cell is where its label says it is - B7 is the
 * seventh row of the second column - and what is selected is visible without
 * parsing a range expression back into positions.
 *
 * selection.js still exists and is still tested: it is the browser half of the
 * CLI's range parsing, and `nava dump --patterns A1-A4` needs it. Only this
 * panel stopped needing it, having no text to parse.
 */

/** Toggle one cell, or set it. `on` omitted flips it. A disabled cell is one
 *  the file has nothing in, and stays where it is. */
function setCell(cell, on = null) {
  if (cell.disabled) return;
  const now = on === null ? !cell.classList.contains('on') : on;
  cell.classList.toggle('on', now);
  cell.setAttribute('aria-pressed', String(now));
}

const cellsIn = (id) => [...$(id).querySelectorAll('.matrix-cell')];

/** The numbers a matrix has chosen, ascending - which for the pattern grids is
 *  bank-then-slot, the order the panel is laid out in. */
const chosenOf = (cells) => cells
  .filter((c) => c.classList.contains('on') && !c.disabled)
  .map((c) => Number(c.dataset.n))
  .sort((a, b) => a - b);

/** One grid, banks down the side and the sixteen slots across the top, with the
 *  tracks as a last row of the same columns.
 *
 *  Banks vertical because there are eight of them and sixteen slots: the grid
 *  comes out wider than tall, which is the shape of the panel it sits in. And
 *  one table rather than two, because tracks are numbered 1-16 as well - they
 *  line up under the pattern columns exactly, and a second table would only
 *  have repeated the same sixteen headings underneath.
 *
 *  Built rather than written out: 144 cells is not something to keep in an HTML
 *  file, and the labels come from the same protocol helper the rest of the app
 *  reads them from. */
function buildMatrix(id) {
  const table = document.createElement('table');
  table.className = 'matrix-grid';

  const head = document.createElement('tr');
  head.appendChild(document.createElement('th')).className = 'matrix-corner';
  for (let slot = 0; slot < protocol.PTRN_PER_BANK; slot += 1) {
    const th = document.createElement('th');
    th.className = 'matrix-head';
    th.textContent = String(slot + 1);
    th.title = `slot ${slot + 1} in every bank — click to select or clear the column`;
    th.addEventListener('click', () => toggleGroup(columnCells(id, slot)));
    head.appendChild(th);
  }
  head.appendChild(document.createElement('th')).className = 'matrix-gutter';
  const thead = document.createElement('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  const body = document.createElement('tbody');
  for (let bank = 0; bank < protocol.MAX_BANK; bank += 1) {
    const row = document.createElement('tr');
    const label = document.createElement('th');
    label.className = 'matrix-head matrix-row-head';
    label.textContent = bankLetter(bank);
    label.title = `bank ${bankLetter(bank)} — click to select or clear the row`;
    // A whole bank is the unit anyone actually thinks in, and sixteen clicks
    // to get one is not a control. Same for a slot across every bank.
    label.addEventListener('click', () => toggleGroup(rowCells(id, bank)));
    row.appendChild(label);
    for (let slot = 0; slot < protocol.PTRN_PER_BANK; slot += 1) {
      const n = bank * protocol.PTRN_PER_BANK + slot;
      row.appendChild(matrixCell(n, protocol.patternLabel(n), 'pattern'));
    }
    row.appendChild(document.createElement('td')).className = 'matrix-gutter';
    body.appendChild(row);
  }

  const tracks = document.createElement('tr');
  tracks.className = 'matrix-tracks';
  const label = document.createElement('th');
  label.className = 'matrix-head matrix-row-head';
  label.textContent = 'TRK';
  label.title = 'every track — click to select or clear the row';
  label.addEventListener('click', () => toggleGroup(trackCells(id)));
  tracks.appendChild(label);
  for (let track = 0; track < protocol.MAX_TRACK; track += 1) {
    tracks.appendChild(matrixCell(track, `track ${track + 1}`, 'track'));
  }
  tracks.appendChild(document.createElement('td')).className = 'matrix-gutter';
  body.appendChild(tracks);

  table.appendChild(body);
  $(id).replaceChildren(table);
}

function matrixCell(n, title, kind) {
  const cell = document.createElement('td');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'matrix-cell on';
  button.dataset.n = String(n);
  button.dataset.kind = kind;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.setAttribute('aria-pressed', 'true');
  button.addEventListener('click', () => setCell(button));
  cell.appendChild(button);
  return cell;
}

// A column is one slot number - the patterns in it, and the track under them,
// since track 7 sits beneath slot 7 in every bank.
const columnCells = (id, slot) => cellsIn(id).filter((c) => (c.dataset.kind === 'track'
  ? Number(c.dataset.n) === slot
  : Number(c.dataset.n) % protocol.PTRN_PER_BANK === slot));
const rowCells = (id, bank) => patternCells(id)
  .filter((c) => Math.floor(Number(c.dataset.n) / protocol.PTRN_PER_BANK) === bank);
const patternCells = (id) => cellsIn(id).filter((c) => c.dataset.kind === 'pattern');
const trackCells = (id) => cellsIn(id).filter((c) => c.dataset.kind === 'track');

/** All on unless they already all are, in which case all off - so a header is
 *  one control rather than two, and pressing it twice returns what was there.
 *  Cells the file has nothing in do not count either way. */
function toggleGroup(cells) {
  const live = cells.filter((c) => !c.disabled);
  const wanted = !live.every((c) => c.classList.contains('on'));
  for (const cell of live) setCell(cell, wanted);
}

function setAll(id, on, checkbox) {
  for (const cell of cellsIn(id)) setCell(cell, on);
  $(checkbox).checked = on;
}

/** Grey out everything the chosen backup does not carry, and select the rest.
 *
 * Restore can only send what is in the file, so a cell for a pattern the file
 * has nothing in is not a choice - it is disabled rather than hidden, the same
 * way the PATTERN buttons on Patterns are, so the numbering never shifts and A5
 * is in the same place whichever file is loaded. */
function syncRestoreMatrix() {
  const file = fileByName($('restore-file').value);
  const items = file && file.kind === library.KIND_BACKUP ? file.items : [];
  const has = (cmd) => new Set(items.filter((i) => i.cmd === cmd).map((i) => i.param));
  const patterns = has(protocol.NAVA_PTRN_DMP);
  const tracks = has(protocol.NAVA_TRACK_DMP);
  const config = items.some((i) => i.cmd === protocol.NAVA_CONFIG_DMP);

  for (const cell of cellsIn('restore-matrix')) {
    {
      const held = cell.dataset.kind === 'track' ? tracks : patterns;
      const there = held.has(Number(cell.dataset.n));
      cell.disabled = !there;
      cell.classList.toggle('absent', !there);
      cell.classList.toggle('on', there);
      cell.setAttribute('aria-pressed', String(there));
    }
  }
  $('restore-config').disabled = !config;
  $('restore-config').checked = config;
}

buildMatrix('dump-matrix');
buildMatrix('restore-matrix');
$('dump-all').addEventListener('click', () => setAll('dump-matrix', true, 'dump-config'));
$('dump-none').addEventListener('click', () => setAll('dump-matrix', false, 'dump-config'));
$('restore-all').addEventListener('click', () => setAll('restore-matrix', true, 'restore-config'));
$('restore-none').addEventListener('click', () => setAll('restore-matrix', false, 'restore-config'));
$('restore-file').addEventListener('change', syncRestoreMatrix);

/* ---------- transfer ---------- */

$('do-dump').addEventListener('click', async () => {
  if (!portsReady(true, 'progress-log')) return;

  let items;
  try {
    items = transfer.selections({
      patterns: chosenOf(patternCells('dump-matrix')),
      tracks: chosenOf(trackCells('dump-matrix')),
      config: $('dump-config').checked,
    });
  } catch (error) {
    log('progress-log', error.message, true);
    return;
  }
  if (!items.length) {
    log('progress-log', 'nothing selected', true);
    return;
  }

  const target = await pickSaveFile(dumpFileName());
  if (!target) return;

  setBusy(true);
  log('progress-log', `dumping ${items.length} item(s). ${SYSEX_PAGE_HINT}`);
  const outcome = await transfer.backup(state.ports, items, DEFAULT_TIMEOUT, DEFAULT_RETRIES, {
    progress: (done, total, label) => {
      setProgress('progress-bar', done, total);
      status(`${done}/${total}  ${label}`);
    },
    shouldStop,
  });

  for (const failure of outcome.failures) log('progress-log', failure, true);
  if (outcome.collected.length) {
    await writeFile(target, outcome.collected);
    addFile(target.name, outcome.collected);
    log('progress-log', `wrote ${target.name} (${outcome.collected.length} bytes)`);
  } else {
    log('progress-log', 'nothing came back; the file was not written', true);
  }
  setBusy(false);
});

$('do-restore').addEventListener('click', async () => {
  if (!portsReady(true, 'progress-log')) return;
  const file = fileByName($('restore-file').value);
  if (!file) {
    log('progress-log', 'no backup selected', true);
    return;
  }
  if (file.kind !== library.KIND_BACKUP) {
    log('progress-log', `${file.name} is not a backup — refusing to send it`, true);
    return;
  }

  // Only what the grid has chosen, so a restore can put one bank back without
  // writing over the other seven.
  const patterns = new Set(chosenOf(patternCells('restore-matrix')));
  const tracks = new Set(chosenOf(trackCells('restore-matrix')));
  const wanted = file.items.filter((i) => {
    if (i.cmd === protocol.NAVA_PTRN_DMP) return patterns.has(i.param);
    if (i.cmd === protocol.NAVA_TRACK_DMP) return tracks.has(i.param);
    if (i.cmd === protocol.NAVA_CONFIG_DMP) return $('restore-config').checked;
    return false;
  });
  if (!wanted.length) {
    log('progress-log', 'nothing selected to restore', true);
    return;
  }

  const ok = await confirmDialog(
    'Overwrite the unit?',
    `Restoring ${wanted.length} of the ${file.items.length} record(s) in ${file.name}, ` +
      'over what is on the unit now. This cannot be undone.',
    'Restore',
  );
  if (!ok) return;

  const dumps = wanted.map((i) => new protocol.NavaMessage(i.cmd, i.param, i.payload));
  setBusy(true);
  log('progress-log', `restoring ${dumps.length} item(s). ${SYSEX_PAGE_HINT}`);
  const outcome = await transfer.restore(state.ports, dumps, DEFAULT_TIMEOUT, DEFAULT_RETRIES, {
    progress: (done, total, label) => {
      setProgress('progress-bar', done, total);
      status(`${done}/${total}  ${label}`);
    },
    shouldStop,
  });
  for (const failure of outcome.failures) log('progress-log', failure, true);
  if (outcome.ok) log('progress-log', 'restore complete');
  setBusy(false);
});

/* ---------- firmware ---------- */

/** Load the image deployed beside this page, on startup, with nothing to press.
 *
 * The firmware repository's release workflow commits the current build into
 * web/firmware/, so by the time anyone opens this there is exactly one image to
 * flash and no question to ask about it - which is what the "Get an image"
 * panel used to be for. Same origin, so it is a plain fetch with none of the
 * CORS trouble a release asset has (see the note at the top of releases.js).
 *
 * Quietly, and never fatally: a checkout without the folder, or a deploy that
 * did not get one, leaves the picker empty and everything else working. The
 * flash path takes a dropped .syx exactly as it always did, which is also the
 * way to reach an older tag or a fork now that there is no box to type one in.
 */
async function loadDeployedFirmware() {
  let manifest = null;
  try {
    manifest = await releases.bundled();
  } catch {
    // Nothing there, or nothing readable. Handled the same as absent.
  }
  if (!manifest) {
    log('progress-log', 'no image deployed with this page — drop a .syx on Patterns to flash one');
    return;
  }
  try {
    await useBundled(manifest, state.repo);
  } catch (error) {
    log('progress-log', error.message ?? String(error), true);
  }
  // The fetch drives the same bar the flash does, and leaving it full would
  // have the panel opening on what looks like a finished transfer.
  setProgress('progress-bar', 0, 1);
  status('');
}

/** The copy deployed beside this page: same origin, no CORS. */
async function useBundled(manifest, repo) {
  const bytes = await releases.downloadBundled(manifest, (done, total) => {
    setProgress('progress-bar', done, total);
    status(`${done}/${total} bytes`);
  });
  // offer() clears the log and writes the image's own details, so the release
  // it came from is logged after rather than before - it would be wiped.
  offer(manifest.file, bytes, manifest.published);
  log('progress-log', `${manifest.tag}, deployed with this page from ${repo}`);

  // The deployed copy is as new as the last time this site was built, and
  // someone about to flash should know if the firmware has moved on since.
  // Advisory only - there is no longer anywhere to type a tag, and the answer
  // is to redeploy or to drop the .syx by hand.
  try {
    const newest = await releases.fetchRelease('latest', repo);
    if (newest.tag && newest.tag !== manifest.tag) {
      log(
        'progress-log',
        `note: ${newest.tag} has been published since this page was built. ` +
          'Download it from the releases page and drop it on Patterns to flash it.',
      );
    }
  } catch {
    // Offline, or rate limited. The image in hand is still good.
  }
}

function offer(name, bytes, dated = null) {
  const file = addFile(name, bytes, dated);
  if (!file || file.kind !== library.KIND_FIRMWARE) {
    log('progress-log', `${name} is not a bootloader image — refusing to offer it`, true);
    return;
  }
  // Setting .value in script does not fire `change`, so the readout below is
  // asked for directly rather than left to the listener.
  $('firmware-file').value = name;
  showImageDetails();
}

/** What the picked image is, in the panel's log.
 *
 * This replaced an Inspect button. Inspecting was never a question anyone
 * answered no to - the numbers are the same every time for a given file, and
 * the only moment they change is the moment a different file is picked. So
 * picking one prints them, and the log holds the current selection and nothing
 * else: it is cleared first, so what is on screen always describes the image
 * the Flash button would send rather than a pile of everything looked at
 * since.
 *
 * That log is now the panel's only one, shared with dump and restore, so
 * picking an image also clears whatever a transfer left there. That is the
 * right way round: the clear is what keeps the readout describing the image in
 * hand, and a finished transfer's log is history the moment you go looking at
 * firmware instead.
 */
function showImageDetails() {
  clearLog('progress-log');
  const file = fileByName($('firmware-file').value);
  if (!file) {
    log('progress-log', 'no image selected');
    return;
  }
  for (const line of describeFile(file).split('\n')) log('progress-log', line);
}

/* Other… opens a file picker instead of naming an image.
 *
 * It is the way to reach a build that was never published - a local compile, a
 * test image - without going to Patterns to drop it and coming back. Whichever
 * image was chosen before is remembered, because Other… is not a selection:
 * cancelling the dialog has to leave the list on the image it was already on
 * rather than on a word that is not a file. */
let lastImage = '';

$('firmware-file').addEventListener('change', (event) => {
  if (event.target.value === FIRMWARE_OTHER) {
    $('firmware-input').click();
    return;
  }
  lastImage = event.target.value;
  showImageDetails();
});

/** Put the list back on the image it was showing before Other… was picked. */
function restoreImageChoice() {
  const images = $('firmware-file');
  images.value = [...images.options].some((o) => o.value === lastImage) ? lastImage : '';
  if (!images.value) images.value = FIRMWARE_OTHER;
}

$('firmware-input').addEventListener('cancel', restoreImageChoice);
$('firmware-input').addEventListener('change', async (event) => {
  const [chosen] = event.target.files;
  event.target.value = '';   // so picking the same file twice fires again
  if (!chosen) {
    restoreImageChoice();
    return;
  }
  // offer() refuses anything that is not a bootloader image and says so, and
  // leaves the selection alone when it does - so put it back.
  offer(chosen.name, new Uint8Array(await chosen.arrayBuffer()), fileDate(chosen));
  if ($('firmware-file').value === FIRMWARE_OTHER) restoreImageChoice();
  else lastImage = $('firmware-file').value;
});

$('do-flash').addEventListener('click', async () => {
  // While a flash is running this button reads Stop, and pressing it asks the
  // transfer loop to break between messages - see the note on shouldStop.
  if (state.busy) {
    state.stopRequested = true;
    $('do-flash').disabled = true; // one press is the whole request
    return;
  }
  if (!portsReady(false, 'progress-log')) return;
  const file = fileByName($('firmware-file').value);
  if (!file) {
    log('progress-log', 'no image selected', true);
    return;
  }
  // The header check is the whole reason library.classify exists: a backup and
  // a firmware image are both .syx, and sending the wrong one to a bootloader
  // is not a recoverable mistake.
  if (file.kind !== library.KIND_FIRMWARE) {
    log('progress-log', `${file.name} is not a firmware image — refusing to flash it`, true);
    return;
  }

  // The file's own messages, not a re-encode of its decoded image: library.load
  // already proved they decode, and sending them verbatim means a released .syx
  // reaches the bootloader byte for byte as it was published.
  let messages;
  try {
    messages = protocol.splitMessages(file.bytes);
  } catch (error) {
    log('progress-log', `cannot read ${file.name}: ${error.message ?? error}`, true);
    return;
  }

  setBusy(true);
  // setBusy disabled this button along with the others; hand it back as the
  // way out of the transfer it just started.
  $('do-flash').disabled = false;
  $('do-flash').textContent = 'Stop';
  log('progress-log', `flashing ${messages.length} messages at ${DEFAULT_FLASH_DELAY_MS}ms…`);
  const outcome = await transfer.flash(state.ports, messages, DEFAULT_FLASH_DELAY_MS, {
    progress: (done, total, label) => {
      setProgress('progress-bar', done, total);
      status(`${done}/${total}  ${label}`);
    },
    shouldStop,
  });
  for (const failure of outcome.failures) log('progress-log', failure, true);
  if (outcome.ok) log('progress-log', 'sent. The unit restarts on its own.');
  $('do-flash').textContent = 'Flash';
  setBusy(false);
});

/* ---------- wiring ---------- */

$('enable-midi').addEventListener('click', enableMidi);

// Leaving mid-transfer means an interrupted flash or a half-written restore, so
// the tab asks - it is the one case where the browser's generic warning is the
// right one.
window.addEventListener('beforeunload', (event) => {
  if (!state.busy && !unsavedEdits()) return;
  event.preventDefault();
  event.returnValue = '';
});

if (!midi.isSupported()) $('unsupported').hidden = false;
refreshPorts();
refreshFiles();
refreshBrowse();
refreshUndoButtons();
updateConnection();
seedDemoPattern();
// Last, and not awaited: it is one same-origin fetch that fills the Image
// picker, and nothing above it should wait on the network to finish painting.
loadDeployedFirmware();
$('dump-name').value = defaultDumpName();
