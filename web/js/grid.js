/* The pattern as the machine's own step chart.
 *
 * This is a second view of what render.js prints, not a replacement: the text
 * grid is pinned byte for byte against the Python renderer by
 * tests/fixtures/vectors.json and must not move. Nothing here feeds that
 * contract - it builds DOM from the same decoded Pattern and is free to look
 * like the panel instead of like a terminal.
 *
 * Two things are copied from the printed chart on the machine rather than
 * invented. The rows are fixed and always all present, in the panel's own
 * top-to-bottom order, so a voice is in the same place in every pattern - the
 * text renderer drops empty lanes because a terminal has no room, and a chart
 * does. And the rule between every fourth step is heavier, which is what makes
 * 16 cells countable without a ruler.
 *
 * INST. and EXT are separate views of the same 16 columns because they are two
 * different machines sharing a sequencer: one drives the analogue voices, the
 * other sends notes to whatever is on the ext channel. Stacking all 28 lanes
 * made a wall nobody could read, and the ext lanes are empty in most patterns.
 */

import {
  INSTRUMENT_NAMES,
  NBR_EXT_TRACK,
  NBR_STEP,
  TOTAL_ACC,
  decodePattern,
  noteName,
} from './records.js';
import * as edit from './edit.js';

// The trigger output. Index 0 in the record, programmed per step like a voice,
// but it fires a pulse at a jack rather than a sound - so it sits with ACCENT
// under the kit rather than in it.
const TRIG = 0;

// Instrument index -> the name printed on the machine, in the order the chart
// lists them. INSTRUMENT_NAMES holds the panel's abbreviations (CRH, HCL); the
// chart spells them out, and that is what this column is.
const CHART_ROWS = [
  [7, 'CRASH'],
  [6, 'RIDE'],
  [15, 'OPEN HAT'],
  [14, 'CLOSED HAT'],
  [4, 'HAND CLAP'],
  [3, 'RIM SHOT'],
  [2, 'HI TOM'],
  [11, 'MID TOM'],
  [10, 'LOW TOM'],
  [9, 'SNARE DRUM'],
  [8, 'BASS DRUM'],
];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The chart for one pattern: INST./EXT views over one 16-column grid, plus the
 *  step strip that shows whichever lane is picked.
 *
 * Pass `payload` - the record's raw bytes - to make the cells editable and to
 * turn on the LAST STEP playhead (see below). Each edit writes into those
 * bytes and the chart is redrawn from what they now say, rather than from
 * what the gesture was supposed to do: if an edit and the decoder ever
 * disagreed, the grid would show the disagreement instead of hiding it.
 * `onEdit` fires once per gesture, with the record's bytes as they stood
 * before it, so the caller can mark the file unsaved and push the gesture
 * onto an undo stack.
 *
 * `view` and `lane` seed which tab and which row are selected, and
 * `onViewChange(view, lane)` fires whenever that changes. Neither is needed to
 * survive a length drag - that redraws itself in place - but a caller that
 * rebuilds this chart from scratch (app.js does, after an undo) needs them to
 * avoid resetting to the INST. tab and BASS DRUM every time.
 *
 * There is no title here - app.js owns #detail-title, which sits above both
 * this chart and the plain-text detail view and carries undo/redo, so it has
 * to survive this chart being rebuilt rather than living inside it. */
export function patternChart(pattern, {
  config = null, payload = null, onEdit = null,
  view: initialView = null, lane: initialLane = null, onViewChange = null,
} = {}) {
  const root = el('div', 'chart');

  // Static for the life of the chart: which ext tracks are used does not
  // change with the pattern's length, so the tab needs no part in a rebuild.
  const extCount = pattern.activeExtTracks().length;

  const tabs = el('div', 'chart-tabs');
  const instTab = el('button', 'chart-tab', 'INST.');
  // The count is on the tab because the ext lanes are empty in most patterns,
  // and a tab that opens onto sixteen blank rows should say so first.
  const extTab = el('button', 'chart-tab', extCount ? `EXT (${extCount})` : 'EXT');
  instTab.type = 'button';
  extTab.type = 'button';
  tabs.append(instTab, extTab);
  root.appendChild(tabs);

  // Everything below is rebuilt whole by draw(), not patched cell by cell.
  // A length change moves which columns are struck through as "past the end"
  // across every lane at once, and - when the ext loop has no length of its
  // own; see extLength in records.js - can move the ext wrap markers with it.
  // Patching that in place would mean re-deriving the same "what changed"
  // logic draw() already has to have anyway.
  const body = el('div', 'chart-body');
  root.appendChild(body);

  // `current` is re-read from the record after every edit, so everything
  // below draws from the bytes as they now are rather than from what a click
  // or drag was supposed to do.
  let current = pattern;

  // One remembered lane per view, so switching tabs and back returns to what
  // was being looked at rather than resetting to the top.
  const active = pattern.activeVoices();
  const chosen = {
    inst: active.includes(8) ? 8 : (active[0] ?? 8),
    ext: pattern.activeExtTracks()[0] ?? 0,
  };
  let view = initialView === 'ext' ? 'ext' : 'inst';
  if (initialLane !== null && initialLane !== undefined && (initialView === 'inst' || initialView === 'ext')) {
    chosen[initialView] = initialLane;
  }

  // Reassigned by draw() on every rebuild; the closures below read the latest
  // value rather than the one that was current when they were defined.
  let steps = current.steps;
  let table;
  let instBody;
  let extBody;
  let rows;
  let cells;
  let owners;
  let strip;
  let numCells;
  let stroke = null;       // a cell-painting gesture in progress
  let lengthDrag = null;   // a LAST STEP drag in progress

  const key = (kind, index) => `${kind}:${index}`;

  /* Steps past the pattern's length are printed but struck out: the chart is
     always 16 wide, and a 12-step pattern has to look like a 12-step pattern
     rather than like four silent steps. */
  const paintCell = (cell, i, state, flam = false) => {
    cell.classList.remove('loud', 'soft', 'flam', 'past');
    if (i >= steps) {
      cell.classList.add('past');
      return;
    }
    if (state !== 'off') cell.classList.add(state === 'accent' ? 'loud' : 'soft');
    if (flam) cell.classList.add('flam');
  };

  const cellFor = (i, state, flam = false) => {
    const cell = el('td', 'cell');
    cell.dataset.col = String(i);   // read back by the LAST STEP drag's hit test
    if (i % 4 === 0) cell.classList.add('beat');
    paintCell(cell, i, state, flam);
    return cell;
  };

  const addLane = (tbody, id, label, className, laneTitle, fill) => {
    const row = el('tr', className);
    row.tabIndex = 0;
    if (laneTitle) row.title = laneTitle;
    row.appendChild(el('th', 'chart-label', label));
    const own = [];
    for (let i = 0; i < NBR_STEP; i += 1) {
      const cell = fill(i);
      own.push(cell);
      row.appendChild(cell);
    }
    rows.set(id, row);
    cells.set(id, own);
    tbody.appendChild(row);
    return row;
  };

  /** Redraw one lane from the record, after an ordinary step/accent/flam edit.
   *  That kind of edit never moves which columns are past the end - only a
   *  length change does that, and it goes through draw() instead of here. */
  const repaint = (kind, index) => {
    const own = cells.get(key(kind, index));
    for (let i = 0; i < NBR_STEP; i += 1) {
      if (kind === 'ext') {
        paintCell(own[i], i, i < steps ? current.extStep(index, i % current.extSteps) : 'off');
      } else if (kind === 'acc') {
        paintCell(own[i], i, (current.inst[TOTAL_ACC] >> i) & 1 ? 'accent' : 'off');
      } else {
        const step = i < steps ? current.step(index, i) : null;
        paintCell(
          own[i], i,
          step && step.on ? current.level(index, i) : 'off',
          Boolean(step?.flam && step.on),
        );
      }
    }
  };

  const paint = () => {
    instTab.setAttribute('aria-selected', String(view === 'inst'));
    extTab.setAttribute('aria-selected', String(view === 'ext'));
    instBody.hidden = view !== 'inst';
    extBody.hidden = view === 'inst';
    for (const [id, row] of rows) {
      row.setAttribute('aria-selected', String(id === key(view, chosen[view])));
    }
    drawStrip(strip, current, view, chosen[view], config);
  };

  const pick = (kind, index) => {
    // ACCENT is editable but not a lane the step strip can show - it is not an
    // instrument - so clicking it does not move the selection.
    if (kind === 'acc') return;
    view = kind;
    chosen[kind] = index;
    paint();
    onViewChange?.(view, chosen[view]);
  };

  /** Which length a drag position corresponds to: the column boundary nearest
   *  the pointer, clamped to 1..16.
   *
   *  elementFromPoint first, same reason as the cell-paint drag below - a
   *  touch pointer is captured by the element it went down on and never fires
   *  pointerenter anywhere else, so the element actually under the point has
   *  to be looked up explicitly. The header row's own cells are the fallback,
   *  for wherever that lands outside a numbered column: the label cells, the
   *  playhead's own handle, or off the grid altogether. */
  const stepAt = (clientX, clientY) => {
    const hit = document.elementFromPoint(clientX, clientY)?.closest?.('[data-col]');
    if (hit && table.contains(hit)) {
      const col = Number(hit.dataset.col);
      const r = hit.getBoundingClientRect();
      return Math.max(1, Math.min(NBR_STEP, clientX < r.left + r.width / 2 ? col : col + 1));
    }
    const first = numCells[0].getBoundingClientRect();
    const last = numCells[NBR_STEP - 1].getBoundingClientRect();
    if (clientX < first.left + first.width / 2) return 1;
    if (clientX > last.right - last.width / 2) return NBR_STEP;
    return current.steps;
  };

  /** Build the table, the LAST STEP playhead, the readouts and the step strip
   *  from `current`, replacing whatever draw() built last time. Called once at
   *  the start and again after any edit that changes `steps` - the only kind
   *  that moves which columns are struck through. */
  const draw = () => {
    steps = current.steps;
    body.replaceChildren();

    table = el('table', 'chart-grid');
    const head = el('tr');
    head.appendChild(el('th', 'chart-corner', 'STEP'));
    numCells = [];
    for (let i = 0; i < NBR_STEP; i += 1) {
      const cell = el('th', 'chart-num', String(i + 1));
      cell.dataset.col = String(i);
      if (i % 4 === 0) cell.classList.add('beat');
      if (i >= steps) cell.classList.add('past');
      head.appendChild(cell);
      numCells.push(cell);
    }
    const thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    rows = new Map();
    cells = new Map();

    instBody = el('tbody');
    for (const [instrument, label] of CHART_ROWS) {
      addLane(
        instBody, key('inst', instrument), label, 'chart-row',
        `${label} (${INSTRUMENT_NAMES[instrument]})`,
        (i) => {
          const step = i < steps ? current.step(instrument, i) : null;
          return cellFor(i, step && step.on ? current.level(instrument, i) : 'off', step?.flam && step.on);
        },
      );
    }

    // TRIG and ACCENT are the two lanes that are not voices: one pulses the
    // trigger output, the other accents whatever the voices are doing. They
    // are programmed per step like everything else, so they belong on the
    // chart - below the kit, marked as not being part of it.
    addLane(
      instBody, key('inst', TRIG), 'TRIG', 'chart-row chart-utility',
      `TRIG output (${INSTRUMENT_NAMES[TRIG]})`,
      (i) => {
        const step = i < steps ? current.step(TRIG, i) : null;
        return cellFor(i, step && step.on ? current.level(TRIG, i) : 'off');
      },
    );
    addLane(
      instBody, key('acc', TOTAL_ACC), 'ACCENT', 'chart-row chart-utility',
      'total accent - accents every voice on that step',
      (i) => cellFor(i, (current.inst[TOTAL_ACC] >> i) & 1 ? 'accent' : 'off'),
    );

    // All sixteen ext lanes, not just the used ones, for the same reason the
    // voices are all present: T7 should be in the same place in every pattern.
    extBody = el('tbody');
    for (let track = 0; track < NBR_EXT_TRACK; track += 1) {
      const note = config ? noteName(config.extNotes[track]) : null;
      addLane(
        extBody, key('ext', track), `T${track + 1}${note ? `  ${note}` : ''}`, 'chart-row chart-ext',
        note ? `ext track ${track + 1}, note ${note}` : `ext track ${track + 1}`,
        // The ext layer wraps on its own length, so a shorter ext loop repeats
        // against the kit rather than leaving the tail blank.
        (i) => {
          const cell = cellFor(i, i < steps ? current.extStep(track, i % current.extSteps) : 'off');
          // A dashed rule where the loop starts over. Without it, editing one
          // column and watching three change looks like a fault rather than
          // the repeat it is.
          if (i > 0 && i < steps && i % current.extSteps === 0) cell.classList.add('wrap');
          return cell;
        },
      );
    }

    table.append(instBody, extBody);

    // The LAST STEP playhead: a hard rule the full height of whichever view is
    // showing, at the same column math table-layout: fixed already uses for
    // the grid itself (the corner's own width via --corner, then the rest
    // split sixteen ways) - not measured from the table, because on the very
    // first draw() this chart is not in the document yet and would measure as
    // nothing.
    const gridWrap = el('div', 'chart-grid-wrap');
    gridWrap.appendChild(table);
    const boundary = `calc(var(--corner) + (100% - var(--corner)) * ${steps} / 16)`;
    const playhead = el('div', 'playhead');
    playhead.style.left = boundary;
    gridWrap.appendChild(playhead);
    if (payload) {
      // The draggable affordance. Only present when the chart is editable -
      // there is nothing to drag to on a read-only chart.
      // The glyph rather than a CSS triangle: a shape built out of borders
      // reads as a pennant hanging off the rule at this size, and the point of
      // the marker is that it unmistakably points back along the loop.
      const handle = el('div', 'playhead-handle', '\u25C0');
      handle.style.left = boundary;
      handle.style.touchAction = 'none';   // a drag here changes length, not scroll
      handle.title = `LAST STEP ${steps} — drag to change the pattern's length`;
      gridWrap.appendChild(handle);
    }
    body.appendChild(gridWrap);

    // LAST STEP stays as its own readout too, alongside the playhead rather
    // than folded into it: the playhead answers "where does it loop" at a
    // glance across the whole grid, but a drag is not pixel-precise, and the
    // readout is where a glance confirms the exact number landed on.
    body.appendChild(readouts(current));

    strip = el('div', 'step-strip');
    body.appendChild(strip);

    if (payload) {
      root.classList.add('editable');
      owners = new Map();   // cell element -> which lane and step it is
      for (const [id, own] of cells) {
        const [kind, raw] = id.split(':');
        const index = Number(raw);
        own.forEach((cell, i) => {
          // Past the last step there is nothing to edit: the machine will
          // never play it, so a click there would write a step that does not
          // exist.
          if (i >= steps) return;
          cell.classList.add('editable');
          cell.style.touchAction = 'none';   // a drag here is painting, not scrolling
          owners.set(cell, { lane: id, kind, index, step: i });
        });
      }
    }

    for (const [id, row] of rows) {
      const [kind, index] = id.split(':');
      const number = Number(index);
      row.addEventListener('click', () => pick(kind, number));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          pick(kind, number);
        }
      });
    }

    paint();
  };

  draw();

  if (payload) {
    /* Click and drag lays one value across a run of steps.
     *
     * The cell the gesture starts on decides that value - it cycles, as a
     * single click always did - and every cell the pointer then crosses is set
     * to the same thing. Cycling each cell as it is crossed would make the
     * result depend on what every step happened to hold already, which is not
     * something anyone can aim; laying down a run of hats is the whole point.
     *
     * The drag is confined to the lane it began in. Smearing across lanes is
     * never what was meant, and on a grid this dense it would be easy to do by
     * accident. */
    const paintStep = (step) => {
      if (!stroke || stroke.done.has(step)) return;
      stroke.done.add(step);
      stroke.write(step);
      current = decodePattern(payload);
      repaint(stroke.kind, stroke.index);
      stroke.changed = true;
    };

    const extend = (event) => {
      if (!stroke) return;
      // elementFromPoint rather than pointerenter, because a touch pointer is
      // captured by the element it started on and never enters another.
      const at = owners.get(
        document.elementFromPoint(event.clientX, event.clientY)?.closest?.('td.cell'),
      );
      if (at && at.lane === stroke.lane) paintStep(at.step);
    };

    const beginStroke = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const at = owners.get(event.target.closest?.('td.cell'));
      if (!at) return;
      event.preventDefault();

      const { kind, index, step } = at;
      let write;
      if (event.shiftKey && kind === 'inst') {
        // Shift paints the flam flag, which the level cycle has nowhere to put.
        const wanted = !edit.flamState(payload, index, step);
        write = (s) => edit.setFlam(payload, index, s, wanted);
      } else if (kind === 'ext') {
        // A column past the end of the ext loop is a repeat of a step inside
        // it, so it edits that step - the same one the column is drawing.
        const wrapAt = (column) => edit.extStepIndex(column, current.extSteps);
        const from = edit.extState(payload, index, wrapAt(step));
        const wanted = from === 'off' ? 'normal' : from === 'normal' ? 'accent' : 'off';
        write = (s) => edit.setExtStep(payload, index, wrapAt(s), wanted);
      } else if (kind === 'acc') {
        const wanted = edit.accentState(payload, step) === 'off' ? 'accent' : 'off';
        write = (s) => edit.setAccent(payload, s, wanted);
      } else {
        const wanted = edit.nextState(index, edit.stepState(payload, index, step));
        write = (s) => edit.setStep(payload, index, s, wanted);
      }

      // Snapshotted before the first write of the gesture, so undo has the
      // record exactly as it stood when the pointer went down - not as it
      // stood after whatever the first cell of the drag did to it.
      stroke = {
        lane: at.lane, kind, index, write, done: new Set(), changed: false,
        before: payload.slice(),
      };
      if (kind !== 'acc') pick(kind, index);
      paintStep(step);
      root.classList.add('painting');
      // Bound only for the life of the stroke. A chart is rebuilt every time a
      // different pattern is selected, so listeners left on the document would
      // accumulate one set per pattern ever looked at.
      document.addEventListener('pointermove', extend);
      document.addEventListener('pointerup', endStroke);
      document.addEventListener('pointercancel', endStroke);
    };

    function endStroke() {
      if (!stroke) return;
      const { changed, before } = stroke;
      stroke = null;
      root.classList.remove('painting');
      document.removeEventListener('pointermove', extend);
      document.removeEventListener('pointerup', endStroke);
      document.removeEventListener('pointercancel', endStroke);
      // Once per gesture, not once per cell: a sixteen-step drag should mark
      // the file unsaved once, not rebuild the file list sixteen times - and
      // should undo as the one action it looked like, not sixteen of them.
      if (changed && onEdit) onEdit(before);
    }

    /* Dragging the LAST STEP playhead: the same one-entry-per-gesture shape as
     * a cell-painting stroke, but it owns its own pointer lifecycle rather
     * than sharing `stroke` - the two gestures start on different elements and
     * never overlap, and keeping them apart means neither has to know the
     * other exists. Every step the pointer crosses redraws the whole grid
     * (draw(), not repaint()): which columns are struck through as past the
     * end changes on every lane at once, and the ext wrap markers can move
     * with it. */
    const moveLength = (event) => {
      if (!lengthDrag) return;
      const wanted = stepAt(event.clientX, event.clientY);
      if (wanted === current.steps) return;
      edit.setLength(payload, wanted);
      current = decodePattern(payload);
      lengthDrag.changed = true;
      draw();
    };

    const endLength = () => {
      if (!lengthDrag) return;
      const { changed, before } = lengthDrag;
      lengthDrag = null;
      document.removeEventListener('pointermove', moveLength);
      document.removeEventListener('pointerup', endLength);
      document.removeEventListener('pointercancel', endLength);
      if (changed && onEdit) onEdit(before);
    };

    const beginLength = (event) => {
      if (!event.target.closest?.('.playhead-handle')) return;
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      lengthDrag = { before: payload.slice(), changed: false };
      document.addEventListener('pointermove', moveLength);
      document.addEventListener('pointerup', endLength);
      document.addEventListener('pointercancel', endLength);
    };

    root.addEventListener('pointerdown', beginStroke);
    root.addEventListener('pointerdown', beginLength);
  }

  instTab.addEventListener('click', () => {
    view = 'inst';
    paint();
    onViewChange?.(view, chosen.inst);
  });
  extTab.addEventListener('click', () => {
    view = 'ext';
    paint();
    onViewChange?.(view, chosen.ext);
  });

  return root;
}

/** The boxes under the grid, where the panel prints TRACK and MODE. */
function readouts(pattern) {
  const wrap = el('div', 'chart-readouts');
  const pairs = [
    ['LAST STEP', String(pattern.steps)],
    ['SCALE', pattern.scaleName],
    ['SHUFFLE', String(pattern.shuffle)],
    ['FLAM', String(pattern.flam)],
  ];
  if (pattern.extLength !== pattern.length) pairs.push(['EXT STEPS', String(pattern.extSteps)]);
  if (pattern.groupLength) {
    pairs.push(['GROUP', `${pattern.groupPos + 1}/${pattern.groupLength}`]);
  }
  for (const [label, value] of pairs) {
    const box = el('div', 'readout');
    box.appendChild(el('span', 'readout-label', label));
    box.appendChild(el('span', 'readout-value', value));
    wrap.appendChild(box);
  }
  return wrap;
}

/* The row of 16 keys under the panel, showing one lane at a time - which is all
 * the machine can show, because INSTRUMENT SELECT picks one. */
function drawStrip(strip, pattern, view, index, config) {
  strip.replaceChildren();

  const name = el('div', 'strip-name');
  name.appendChild(el('span', 'strip-caption', view === 'inst' ? 'INSTRUMENT' : 'EXT TRACK'));
  name.appendChild(el('span', 'strip-value', laneName(view, index, config)));
  strip.appendChild(name);

  const keys = el('div', 'strip-keys');
  for (let i = 0; i < NBR_STEP; i += 1) {
    const cell = el('div', 'key');
    if (i % 4 === 0) cell.classList.add('group');
    cell.appendChild(el('span', 'key-num', String(i + 1)));
    const lamp = el('span', 'lamp');
    if (i < pattern.steps) {
      if (view === 'inst') {
        const step = pattern.step(index, i);
        if (step.on) {
          lamp.classList.add(pattern.level(index, i) === 'accent' ? 'loud' : 'soft');
          if (step.flam) cell.classList.add('flam');
        }
      } else {
        const state = pattern.extStep(index, i % pattern.extSteps);
        if (state !== 'off') lamp.classList.add(state === 'accent' ? 'loud' : 'soft');
      }
    } else {
      cell.classList.add('past');
    }
    cell.appendChild(lamp);
    keys.appendChild(cell);
  }
  strip.appendChild(keys);
}

function laneName(view, index, config) {
  if (view === 'ext') {
    const note = config ? `  ${noteName(config.extNotes[index])}` : '';
    return `T${index + 1}${note}`;
  }
  if (index === TRIG) return 'TRIG';
  const found = CHART_ROWS.find(([i]) => i === index);
  return found ? found[1] : INSTRUMENT_NAMES[index];
}

export function chartLegend(editable = false) {
  const marks = 'loud  ■    soft  ▒    flam  ◤    beyond last step  ╱';
  if (!editable) return marks;
  return `${marks}\nclick cycles a step  ·  drag along a lane to lay down a run  ·  shift for flam  ·  drag LAST STEP to change the pattern's length`;
}
