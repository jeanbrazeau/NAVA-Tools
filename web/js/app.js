/* The page. Four panels in the order the work usually happens: pick a port,
 * look at what you have, move data, flash firmware.
 *
 * Everything a MIDI operation touches is async, so "busy" is a single flag
 * rather than a worker thread: the transfer loops await, the UI keeps painting,
 * and the Stop button is polled between items.
 *
 * The two destructive actions go through a confirmation naming what is about to
 * be overwritten. Both write to a device that gives no confirmation of its own,
 * and neither can be undone.
 */

import * as protocol from './protocol.js';
import * as bootloader from './bootloader.js';
import * as grid from './grid.js';
import { History } from './history.js';
import * as ihex from './ihex.js';
import * as library from './library.js';
import * as midi from './midi.js';
import * as releases from './releases.js';
import * as render from './render.js';
import * as selection from './selection.js';
import * as store from './store.js';
import * as transfer from './transfer.js';

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_RETRIES = 2;
const DEFAULT_FLASH_DELAY_MS = 250;

const SYSEX_PAGE_HINT =
  'Stop the sequencer and press SHIFT+TEMPO to the SysEx page ("type / select") first.';

const $ = (id) => document.getElementById(id);

const state = {
  access: null,
  ports: null,
  files: [],
  selectedFile: null,
  selectedItem: null,
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

// Which tab and which lane the chart was showing, so rebuilding it - which
// undo does, via refreshItems() - reopens on the same view instead of
// resetting to INST./BASS DRUM. Keyed by item rather than kept as one value,
// so switching to a different pattern and back does not carry the wrong
// pattern's selection with it; switching items on purpose is exactly the case
// that should NOT preserve the old view.
const chartViews = new WeakMap();

/* ---------- small helpers ---------- */

function status(text) {
  $('status').textContent = text;
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
  $('cancel').disabled = !busy;
  for (const id of ['do-dump', 'do-restore', 'do-download', 'do-flash', 'do-inspect']) {
    $(id).disabled = busy;
  }
}

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

function addFile(name, bytes) {
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
  for (const item of file.items) loadedSnapshots.set(item, item.payload.slice());
  state.files = [file, ...state.files.filter((f) => f.name !== label)];
  refreshFiles();
  selectFile(file);
  return file;
}

function refreshFiles() {
  const list = $('files');
  list.replaceChildren();
  if (!state.files.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no files loaded';
    list.appendChild(empty);
  }
  for (const file of state.files) {
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
    item.addEventListener('click', () => selectFile(file));
    list.appendChild(item);
  }

  fillSelect($('restore-file'), state.files.filter((f) => f.kind === library.KIND_BACKUP),
    '— load a .syx under Browse —');
  fillSelect($('firmware-file'), state.files.filter((f) => f.kind === library.KIND_FIRMWARE),
    '— download one, or drop a .syx —');
}

function fillSelect(element, files, placeholder) {
  const previous = element.value;
  element.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = placeholder;
  element.appendChild(blank);
  for (const file of files) {
    const option = document.createElement('option');
    option.value = file.name;
    option.textContent = `${file.name} — ${file.summary()}`;
    element.appendChild(option);
  }
  element.value = files.some((f) => f.name === previous) ? previous : (files[0]?.name ?? '');
}

function fileByName(name) {
  return state.files.find((f) => f.name === name) ?? null;
}

function selectFile(file) {
  state.selectedFile = file;
  state.selectedItem = null;
  refreshFiles();
  refreshItems();
}

function refreshItems() {
  const list = $('items');
  list.replaceChildren();
  $('legend').textContent = '';
  const file = state.selectedFile;
  if (!file) {
    showDetail('Load a .syx to see what is in it.');
    return;
  }

  if (file.kind !== library.KIND_BACKUP) {
    const item = document.createElement('li');
    item.className = 'empty';
    item.textContent = file.kind === library.KIND_FIRMWARE ? 'firmware image' : 'unrecognised';
    list.appendChild(item);
    showDetail(describeFile(file), detailTitle(file));
    return;
  }

  for (const entry of file.items) {
    const item = document.createElement('li');
    item.setAttribute('aria-selected', String(entry === state.selectedItem));
    const summary = summariseItem(entry);
    item.title = `${entry.label} — ${summary}`;
    const name = document.createElement('span');
    name.textContent = entry.label;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = summary;
    item.append(name, sub);
    item.addEventListener('click', () => {
      state.selectedItem = entry;
      refreshItems();
    });
    list.appendChild(item);
  }

  const chosen = state.selectedItem;
  if (chosen?.cmd === protocol.NAVA_PTRN_DMP) {
    showChart(file, chosen);
  } else {
    $('legend').textContent = '';
    showDetail(chosen ? describeItem(file, chosen) : describeFile(file), detailTitle(file, chosen));
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
  const remembered = chartViews.get(item);
  $('detail-title').textContent = detailTitle(file, item);
  const chart = $('chart');
  chart.replaceChildren(
    grid.patternChart(pattern, {
      config: file.config,
      // The record's own bytes, edited in place. Everything downstream -
      // Restore, Save - reads the items, so an edit is live the moment it lands.
      payload: item.payload,
      onEdit: (before) => recordEdit(file, item, before),
      view: remembered?.view ?? null,
      lane: remembered?.lane ?? null,
      onViewChange: (view, lane) => chartViews.set(item, { view, lane }),
    }),
  );
  chart.hidden = false;
  $('detail').hidden = true;
  $('legend').textContent = grid.chartLegend(true);
}

function summariseItem(item) {
  try {
    const decoded = item.decoded();
    if (item.cmd === protocol.NAVA_PTRN_DMP) return render.summarisePattern(decoded);
    if (item.cmd === protocol.NAVA_TRACK_DMP) return `${decoded.used.length} pattern(s)`;
    return 'setup';
  } catch (error) {
    return 'undecodable';
  }
}

function describeFile(file) {
  const lines = [`${file.name}`, `${file.size} bytes — ${file.summary()}`];
  if (file.kind === library.KIND_FIRMWARE) {
    lines.push('', `${file.flashBytes} bytes of flash in ${file.pages} pages`);
    lines.push(`about ${Math.ceil((file.pages * DEFAULT_FLASH_DELAY_MS) / 1000)}s to send`);
  }
  if (file.errors.length) {
    lines.push('', ...file.errors.map((e) => `bad: ${e}`));
  }
  if (file.kind === library.KIND_BACKUP) lines.push('', 'Pick an item on the left.');
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
 *  `onEdit` once per drag, with the bytes as they stood before it. */
function recordEdit(file, item, before) {
  history.push({ file, item, before, after: item.payload.slice() });
  syncEditedFlag(file);
  refreshUndoButtons();
  announceEditState(file);
}

/** Show whatever the undo/redo just changed, then redraw it.
 *
 * The history is one chronological stack across every file, so an undo can
 * land on a pattern that is not the one on screen. It selects that pattern
 * rather than changing it quietly: an edit you cannot see undone is
 * indistinguishable from an undo that did nothing, and the next thing the user
 * does would be to press it again.
 */
function afterHistoryChange(file, item) {
  syncEditedFlag(file);
  state.selectedFile = file;
  state.selectedItem = item;
  refreshFiles();
  refreshItems();          // redraws the chart from the record as it now reads
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
    addFile(file.name, new Uint8Array(await file.arrayBuffer()));
  }
});
$('pick-files').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (event) => {
  for (const file of event.target.files) {
    addFile(file.name, new Uint8Array(await file.arrayBuffer()));
  }
  event.target.value = '';
});

/* ---------- transfer ---------- */

$('do-dump').addEventListener('click', async () => {
  if (!portsReady(true, 'transfer-log')) return;

  let items;
  try {
    items = transfer.selections({
      patterns: $('dump-patterns').value.trim() ? selection.parsePatterns($('dump-patterns').value) : [],
      tracks: $('dump-tracks').value.trim() ? selection.parseTracks($('dump-tracks').value) : [],
      config: $('dump-config').checked,
    });
  } catch (error) {
    log('transfer-log', error.message, true);
    return;
  }
  if (!items.length) {
    log('transfer-log', 'nothing selected', true);
    return;
  }

  const target = await pickSaveFile(`nava-backup-${today()}.syx`);
  if (!target) return;

  setBusy(true);
  log('transfer-log', `dumping ${items.length} item(s). ${SYSEX_PAGE_HINT}`);
  const outcome = await transfer.backup(state.ports, items, DEFAULT_TIMEOUT, DEFAULT_RETRIES, {
    progress: (done, total, label) => {
      setProgress('transfer-progress', done, total);
      status(`${done}/${total}  ${label}`);
    },
    shouldStop,
  });

  for (const failure of outcome.failures) log('transfer-log', failure, true);
  if (outcome.collected.length) {
    await writeFile(target, outcome.collected);
    addFile(target.name, outcome.collected);
    log('transfer-log', `wrote ${target.name} (${outcome.collected.length} bytes)`);
  } else {
    log('transfer-log', 'nothing came back; the file was not written', true);
  }
  setBusy(false);
});

$('do-restore').addEventListener('click', async () => {
  if (!portsReady(true, 'transfer-log')) return;
  const file = fileByName($('restore-file').value);
  if (!file) {
    log('transfer-log', 'no backup selected', true);
    return;
  }
  if (file.kind !== library.KIND_BACKUP) {
    log('transfer-log', `${file.name} is not a backup — refusing to send it`, true);
    return;
  }

  const counts = file.summary();
  const ok = await confirmDialog(
    'Overwrite the unit?',
    `${file.name} holds ${counts}. Restoring writes every one of them over what ` +
      'is on the unit now. This cannot be undone.',
    'Restore',
  );
  if (!ok) return;

  const dumps = file.items.map((i) => new protocol.NavaMessage(i.cmd, i.param, i.payload));
  setBusy(true);
  log('transfer-log', `restoring ${dumps.length} item(s). ${SYSEX_PAGE_HINT}`);
  const outcome = await transfer.restore(state.ports, dumps, DEFAULT_TIMEOUT, DEFAULT_RETRIES, {
    progress: (done, total, label) => {
      setProgress('transfer-progress', done, total);
      status(`${done}/${total}  ${label}`);
    },
    shouldStop,
  });
  for (const failure of outcome.failures) log('transfer-log', failure, true);
  if (outcome.ok) log('transfer-log', 'restore complete');
  setBusy(false);
});

/* ---------- firmware ---------- */

$('do-download').addEventListener('click', async () => {
  const tag = $('release-tag').value.trim() || 'latest';
  const repo = state.repo;
  setBusy(true);
  try {
    const manifest = await releases.bundled();
    const wantsLatest = tag === 'latest';
    const usable =
      manifest &&
      manifest.repo === repo &&
      (wantsLatest || matchesTag(manifest, tag));

    if (usable) {
      await useBundled(manifest, repo, wantsLatest);
    } else {
      await handOff(tag, repo, manifest);
    }
    state.settings.releaseTag = tag;
    store.save(state.settings);
  } catch (error) {
    log('firmware-log', error.message ?? String(error), true);
  }
  setBusy(false);
});

function matchesTag(manifest, tag) {
  const key = tag.replace(/\s+/g, '').toLowerCase();
  return [manifest.tag, manifest.name].some(
    (value) => (value ?? '').replace(/\s+/g, '').toLowerCase() === key,
  );
}

/** The copy deployed beside this page: one click, same origin, no CORS. */
async function useBundled(manifest, repo, wantsLatest) {
  log('firmware-log', `${manifest.tag}  ${manifest.published}  ${manifest.file} (deployed with this page)`);
  const bytes = await releases.downloadBundled(manifest, (done, total) => {
    setProgress('firmware-progress', done, total);
    status(`${done}/${total} bytes`);
  });
  offer(manifest.file, bytes);

  // Only worth a request when the user asked for "latest": the deployed copy is
  // as new as the last time this site was built, and someone about to flash
  // should know if the firmware has moved on since.
  if (!wantsLatest) return;
  try {
    const newest = await releases.fetchRelease('latest', repo);
    if (newest.tag && newest.tag !== manifest.tag) {
      log(
        'firmware-log',
        `note: ${newest.tag} has been published since this page was built. ` +
          `Type ${newest.tag} above to fetch it.`,
      );
    }
  } catch {
    // Offline, or rate limited. The image in hand is still good.
  }
}

/* No deployed copy to use, so the browser downloads it and the file comes back
 * by drag and drop. Two steps rather than one, and the only alternative to a
 * CORS proxy - see the note at the top of releases.js. */
async function handOff(tag, repo, manifest) {
  log('firmware-log', `looking up ${tag} in ${repo}…`);
  const release = await releases.fetchRelease(tag, repo);
  const asset = release.firmware;
  if (!asset) throw new releases.ReleaseError(`${release.label} publishes no .syx`);
  log('firmware-log', `${release.label}  ${release.published}  ${asset.name} (${asset.size} bytes)`);

  if (manifest) {
    log('firmware-log', `(this page was deployed with ${manifest.tag}, so ${release.tag} has to come from GitHub)`);
  }
  releases.handOffToBrowser(asset);
  log(
    'firmware-log',
    `${asset.name} is downloading in the browser — GitHub does not let a page read ` +
      'a release asset directly. Drop the file on this page when it lands, and it ' +
      'will appear in the list below.',
  );
}

function offer(name, bytes) {
  const file = addFile(name, bytes);
  if (!file || file.kind !== library.KIND_FIRMWARE) {
    log('firmware-log', `${name} is not a bootloader image — refusing to offer it`, true);
    return;
  }
  $('firmware-file').value = name;
  log('firmware-log', `${name} ready: ${file.summary()}`);
}

$('do-inspect').addEventListener('click', () => {
  const file = fileByName($('firmware-file').value);
  if (!file) {
    log('firmware-log', 'no image selected', true);
    return;
  }
  for (const line of describeFile(file).split('\n')) log('firmware-log', line);
});

$('do-flash').addEventListener('click', async () => {
  if (!portsReady(false, 'firmware-log')) return;
  const file = fileByName($('firmware-file').value);
  if (!file) {
    log('firmware-log', 'no image selected', true);
    return;
  }
  // The header check is the whole reason library.classify exists: a backup and
  // a firmware image are both .syx, and sending the wrong one to a bootloader
  // is not a recoverable mistake.
  if (file.kind !== library.KIND_FIRMWARE) {
    log('firmware-log', `${file.name} is not a firmware image — refusing to flash it`, true);
    return;
  }

  const seconds = Math.ceil((file.pages * DEFAULT_FLASH_DELAY_MS) / 1000);
  const ok = await confirmDialog(
    'Overwrite the firmware?',
    `${file.name}: ${file.pages} pages, about ${seconds}s. The unit must already ` +
      'be in bootloader mode. Interrupting this leaves it unable to boot until ' +
      'another image is flashed.',
    'Flash',
  );
  if (!ok) return;

  // The file's own messages, not a re-encode of its decoded image: library.load
  // already proved they decode, and sending them verbatim means a released .syx
  // reaches the bootloader byte for byte as it was published.
  let messages;
  try {
    messages = protocol.splitMessages(file.bytes);
  } catch (error) {
    log('firmware-log', `cannot read ${file.name}: ${error.message ?? error}`, true);
    return;
  }

  setBusy(true);
  log('firmware-log', `flashing ${messages.length} messages at ${DEFAULT_FLASH_DELAY_MS}ms…`);
  const outcome = await transfer.flash(state.ports, messages, DEFAULT_FLASH_DELAY_MS, {
    progress: (done, total, label) => {
      setProgress('firmware-progress', done, total);
      status(`${done}/${total}  ${label}`);
    },
    shouldStop,
  });
  for (const failure of outcome.failures) log('firmware-log', failure, true);
  if (outcome.ok) log('firmware-log', 'sent. The unit restarts on its own.');
  setBusy(false);
});

/* ---------- wiring ---------- */

$('enable-midi').addEventListener('click', enableMidi);
$('cancel').addEventListener('click', () => {
  state.stopRequested = true;
  status('stopping after the current item…');
});

// Leaving mid-transfer means an interrupted flash or a half-written restore, so
// the tab asks - it is the one case where the browser's generic warning is the
// right one.
window.addEventListener('beforeunload', (event) => {
  if (!state.busy && !unsavedEdits()) return;
  event.preventDefault();
  event.returnValue = '';
});

$('release-tag').value = state.settings.releaseTag ?? 'latest';
$('releases-link').href = `https://github.com/${state.repo}/releases`;
$('releases-link').textContent = `${state.repo} releases`;
if (!midi.isSupported()) $('unsupported').hidden = false;
refreshPorts();
refreshFiles();
refreshUndoButtons();
updateConnection();
