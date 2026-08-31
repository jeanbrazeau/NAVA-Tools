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
 * The tabs that pick between them are app.js's, not this file's - see the
 * `view` option below - because which view is showing has to survive a bank
 * or pattern change, which throws this whole chart away and builds another.
 */

import {
  INSTRUMENT_NAMES,
  NBR_EXT_TRACK,
  NBR_STEP,
  SCALE_NAMES,
  SCALE_ORDER,
  TOTAL_ACC,
  decodePattern,
  noteName,
} from './records.js';
import * as edit from './edit.js';

// The trigger output. Index 0 in the record, programmed per step like a voice,
// but it fires a pulse at a jack rather than a sound - so it sits with ACCENT
// above the kit rather than in it.
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
 *  the loop-length playhead.
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
 * `view` and `lane` seed which of INST./EXT and which row are selected, and
 * `onViewChange(view, lane)` fires whenever a row click changes the lane.
 * Neither is needed to survive a length drag - that redraws itself in place -
 * but a caller that rebuilds this chart from scratch (app.js does, for a
 * bank, pattern or view change, and after an undo) needs them to avoid
 * resetting to INST. and BASS DRUM every time.
 *
 * There is no title here - app.js owns #detail-title, which sits above both
 * this chart and the plain-text detail view and carries undo/redo, so it has
 * to survive this chart being rebuilt rather than living inside it. The
 * INST./EXT tabs are app.js's too, for the same reason: they pick which view
 * this whole chart is asked to draw, so they have to outlive any one chart. */
export function patternChart(pattern, {
  config = null, payload = null, onEdit = null,
  view: initialView = null, lane: initialLane = null, onViewChange = null,
} = {}) {
  const root = el('div', 'chart');

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
  let numCells;
  let stroke = null;       // a cell-painting gesture in progress
  let lengthDrag = null;   // a LAST STEP drag in progress
  let dialDrag = null;     // a SHUFFLE or FLAM drag in progress
  let readoutBar = null;   // the readouts under the grid, replaced by draw()

  const key = (kind, index) => `${kind}:${index}`;

  const dialValue = (field) => (field === 'shuffle' ? current.shuffle : current.flam);

  /** Turn one dial to a position, and say whether that changed anything.
   *
   *  Landing on the position it is already in writes nothing. That matters
   *  more here than it looks: a drag crosses the lit circle constantly, and
   *  each crossing would otherwise rewrite the same byte and, at the end of
   *  the gesture, mark a clean file unsaved for an edit that did nothing. */
  const turnDial = (field, value) => {
    if (dialValue(field) === value) return false;
    if (field === 'shuffle') edit.setShuffle(payload, value);
    else edit.setFlamDepth(payload, value);
    current = decodePattern(payload);
    const wrap = readoutBar?.querySelector(`.dial[data-dial="${field}"]`);
    if (wrap) relightDial(wrap, field.toUpperCase(), dialValue(field));
    return true;
  };

  /** Set the pattern's SCALE, and say whether that changed anything.
   *
   *  Same shape as turnDial, and the same refusal: picking the division it is
   *  already on writes nothing rather than pushing an undo entry that undoes
   *  to itself. edit.setScale refuses a PPQN no division stands for, so a
   *  record holding junk cannot be nudged into holding different junk. */
  const pickScale = (ppqn) => {
    if (current.scale === ppqn) return false;
    if (edit.setScale(payload, ppqn) !== ppqn) return false;
    current = decodePattern(payload);
    const wrap = readoutBar?.querySelector('.seg[data-seg="scale"]');
    if (wrap) relightScale(wrap, current.scale);
    return true;
  };

  /* The readouts are rebuilt whole only by draw(), which is the only thing
     that changes what is in them - a dial turn or a scale pick relights its
     own control in place instead, so a drag or a focus ring is not thrown
     away mid-gesture. */
  const drawReadouts = () => {
    readoutBar = readouts(current, Boolean(payload));
    body.appendChild(readoutBar);
  };

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
    instBody.hidden = view !== 'inst';
    extBody.hidden = view === 'inst';
    for (const [id, row] of rows) {
      row.setAttribute('aria-selected', String(id === key(view, chosen[view])));
    }
  };

  const pick = (kind, index) => {
    // ACCENT is editable but is not a lane in the sense the rest of the chart
    // means - it accents the machine rather than playing - so clicking it does
    // not move the selection.
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

  /** Build the table, the LAST STEP playhead and the readouts from `current`,
   *  replacing whatever draw() built last time. Called once at
   *  the start and again after any edit that changes `steps` - the only kind
   *  that moves which columns are struck through. */
  const draw = () => {
    steps = current.steps;
    body.replaceChildren();

    table = el('table', 'chart-grid');
    const head = el('tr');
    head.appendChild(el('th', 'chart-corner'));
    numCells = [];
    for (let i = 0; i < NBR_STEP; i += 1) {
      // No number in it. The heavier rule every fourth step already makes the
      // columns countable, and the row still has to exist: it carries those
      // rules, it is what the playhead's hit-testing looks up by data-col, and
      // it is the gutter the handle sits in above the grid.
      const cell = el('th', 'chart-num');
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

    // ACCENT and TRIG are the two lanes that are not voices: one accents
    // whatever the voices are doing, the other pulses the trigger output.
    // They are programmed per step like everything else, so they belong on
    // the chart - above the kit, marked as not being part of it.
    addLane(
      instBody, key('acc', TOTAL_ACC), 'ACCENT', 'chart-row chart-utility',
      'total accent - accents every voice on that step',
      (i) => cellFor(i, (current.inst[TOTAL_ACC] >> i) & 1 ? 'accent' : 'off'),
    );
    addLane(
      instBody, key('inst', TRIG), 'TRIG', 'chart-row chart-utility',
      `TRIG output (${INSTRUMENT_NAMES[TRIG]})`,
      (i) => {
        const step = i < steps ? current.step(TRIG, i) : null;
        return cellFor(i, step && step.on ? current.level(TRIG, i) : 'off');
      },
    );

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

    // All sixteen ext lanes, not just the used ones, for the same reason the
    // voices are all present: T7 should be in the same place in every pattern.
    //
    // Counted up the page, T1 at the bottom and T16 at the top, which is the
    // direction the kit next door is stacked in - BASS DRUM at the foot,
    // CRASH over everything. A track list that started at the top and counted
    // down was the one thing on this chart reading the other way.
    extBody = el('tbody');
    for (let track = NBR_EXT_TRACK - 1; track >= 0; track -= 1) {
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
    // Clamped an inch inside the right edge. At LAST STEP 16 the boundary is
    // the grid's own right edge, and the rule straddles it - half of a 2px
    // line hanging outside the chart, which is all .chart's overflow-x needs
    // to grow a horizontal scrollbar over a pixel of nothing. One pixel in,
    // the rule still lands on the grid's own border, where it reads the same.
    const boundary = `min(calc(var(--corner) + (100% - var(--corner)) * ${steps} / 16), 100% - 1px)`;
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
    drawReadouts();

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

    /** Which step an x falls on within one lane's own cells.
     *
     * Past the last playing step it clamps rather than stopping: dragging off
     * the end of a short pattern should fill it to the end, not stall. */
    const columnAt = (own, clientX) => {
      for (let i = 0; i < steps; i += 1) {
        if (clientX < own[i].getBoundingClientRect().right) return i;
      }
      return steps - 1;
    };

    const extend = (event) => {
      if (!stroke) return;
      // The lane is fixed for the whole stroke, so only x is consulted - no
      // hit-test against whatever happens to be under the pointer. Drifting
      // above or below the row keeps filling the lane, which is what the hand
      // does when it sweeps across sixteen cells 17px tall.
      const own = cells.get(stroke.lane);
      if (!own) return;
      const step = columnAt(own, event.clientX);
      // Everything between the last step and this one, because a quick drag
      // covers several columns between two pointermove events and a run with
      // gaps in it is not what the gesture looked like.
      const from = stroke.last ?? step;
      for (let i = Math.min(from, step); i <= Math.max(from, step); i += 1) paintStep(i);
      stroke.last = step;
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
      stroke.last = step;
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

    /* Turning a SHUFFLE or FLAM dial: press anywhere along the strip and drag.
     *
     * The whole strip is the control, not the eight circles in it. An 8px
     * circle is a hard thing to hit and a harder thing to hit eight times
     * while comparing them, and the gesture the knob these stand in for wants
     * is a sweep - so the position is whichever circle the pointer is nearest,
     * gaps and both ends included, and it follows the pointer until it lifts.
     *
     * The circles' geometry is measured once, at pointerdown: they do not move
     * when the value changes (relightDial only repaints them), and re-reading
     * sixteen rects on every pointermove to learn the same eight numbers is
     * work for nothing. */
    const positionAt = (clientX) => {
      let best = 0;
      let bestGap = Infinity;
      dialDrag.bounds.forEach((centre, i) => {
        const gap = Math.abs(clientX - centre);
        if (gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      });
      return best;
    };

    const moveDial = (event) => {
      if (!dialDrag) return;
      if (turnDial(dialDrag.field, positionAt(event.clientX))) dialDrag.changed = true;
    };

    const endDial = () => {
      if (!dialDrag) return;
      const { changed, before } = dialDrag;
      dialDrag = null;
      root.classList.remove('turning');
      document.removeEventListener('pointermove', moveDial);
      document.removeEventListener('pointerup', endDial);
      document.removeEventListener('pointercancel', endDial);
      // One entry for the sweep, the same as a paint stroke or a length drag:
      // a drag from 0 to 7 undoes as the one turn it looked like.
      if (changed && onEdit) onEdit(before);
    };

    const beginDial = (event) => {
      const wrap = event.target.closest?.('.dial');
      if (!wrap || !root.contains(wrap)) return;
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const bounds = [...wrap.querySelectorAll('.lamp')].map((lamp) => {
        const r = lamp.getBoundingClientRect();
        return r.x + r.width / 2;
      });
      dialDrag = { field: wrap.dataset.dial, bounds, before: payload.slice(), changed: false };
      root.classList.add('turning');
      if (turnDial(dialDrag.field, positionAt(event.clientX))) dialDrag.changed = true;
      document.addEventListener('pointermove', moveDial);
      document.addEventListener('pointerup', endDial);
      document.addEventListener('pointercancel', endDial);
    };

    /* The same dial from the keyboard. The circles are radio buttons, so the
     * arrow keys are what a radio group is expected to answer to; Enter and
     * Space land on the focused one, which is what a button is expected to do.
     * Each keystroke is its own edit - there is no gesture to gather up. */
    const keyDial = (event) => {
      const wrap = event.target.closest?.('.dial');
      if (!wrap || !root.contains(wrap)) return;
      const field = wrap.dataset.dial;
      const here = dialValue(field);
      let wanted;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') wanted = here - 1;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') wanted = here + 1;
      else if (event.key === 'Home') wanted = 0;
      else if (event.key === 'End') wanted = edit.NBR_DIAL - 1;
      else if (event.key === 'Enter' || event.key === ' ') wanted = Number(event.target.dataset.pos);
      else return;
      event.preventDefault();
      // A dial holding a byte no position stands for has nowhere on the row to
      // move from, so the first key lands on the position the tab stop is
      // already sitting on rather than one past it - the same recovery the
      // SCALE picker makes from a PPQN no division names.
      const real = here >= 0 && here < edit.NBR_DIAL;
      const clamped = real ? Math.max(0, Math.min(edit.NBR_DIAL - 1, wanted)) : 0;
      const before = payload.slice();
      if (!turnDial(field, clamped)) return;
      wrap.querySelector('.lamp.on')?.focus();
      onEdit?.(before);
    };

    /* SCALE. A click, not a gesture: four named divisions are a list to pick
     * from, not a knob to sweep, so there is nothing to gather up and each
     * pick is its own edit. */
    const pickFrom = (button) => {
      const before = payload.slice();
      if (!pickScale(Number(button.dataset.ppqn))) return;
      onEdit?.(before);
    };

    const clickScale = (event) => {
      const button = event.target.closest?.('.seg-btn');
      if (!button || !root.contains(button)) return;
      pickFrom(button);
    };

    /* Arrow keys along the divisions, because this is a radio group too. They
     * move the selection rather than just the focus, which is what a radio
     * group does and what makes the four audible one after another. */
    const keyScale = (event) => {
      const wrap = event.target.closest?.('.seg[data-seg="scale"]');
      if (!wrap || !root.contains(wrap)) return;
      const at = SCALE_ORDER.indexOf(current.scale);
      let wanted;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') wanted = at - 1;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') wanted = at + 1;
      else if (event.key === 'Home') wanted = 0;
      else if (event.key === 'End') wanted = SCALE_ORDER.length - 1;
      else return;
      event.preventDefault();
      // A record holding a PPQN no division names has no place in the list to
      // move from, so the first arrow key lands on one rather than nowhere.
      const clamped = at < 0 ? 0 : Math.max(0, Math.min(SCALE_ORDER.length - 1, wanted));
      const before = payload.slice();
      if (!pickScale(SCALE_ORDER[clamped])) return;
      wrap.querySelector('.seg-btn.on')?.focus();
      onEdit?.(before);
    };

    root.addEventListener('pointerdown', beginStroke);
    root.addEventListener('pointerdown', beginLength);
    root.addEventListener('pointerdown', beginDial);
    root.addEventListener('keydown', keyDial);
    root.addEventListener('click', clickScale);
    root.addEventListener('keydown', keyScale);
  }

  return root;
}

/** One of the machine's two eight-position controls, as the row of indicator
 *  circles the panel carries rather than as a number.
 *
 *  A number is the wrong shape for what these are. SHUFFLE and FLAM are
 *  detents on a rotary, not quantities - nothing scales them and nothing else
 *  in the record reads them - and "5" says nothing about how far round that
 *  is. Eight circles with one filled says it at a glance, and it gives the
 *  edit somewhere to land: clicking a circle is turning the knob to it.
 *
 *  `onPick` absent means a read-only chart, and the circles are spans rather
 *  than buttons that do nothing. A value past the last position can only come
 *  from a record the machine never wrote - a blank 0xFF slot decodes that way
 *  - so it fills nothing and prints the raw byte beside the row instead of
 *  quietly showing position 0. */
function dial(field, name, value, editable) {
  const wrap = el('div', 'dial');
  // The whole strip is the control, and patternChart's gesture finds it by
  // this attribute rather than by which circle happened to be under the
  // pointer - see turnDial and beginDial.
  wrap.dataset.dial = field;
  wrap.setAttribute('role', editable ? 'radiogroup' : 'img');
  if (editable) {
    wrap.style.touchAction = 'none';   // a drag here turns the dial, not scrolls
    wrap.title = `${name} — click or drag along the row to turn it`;
  }
  for (let i = 0; i < edit.NBR_DIAL; i += 1) {
    const lamp = el(editable ? 'button' : 'span', 'lamp');
    lamp.dataset.pos = String(i);
    if (editable) {
      lamp.type = 'button';
      lamp.setAttribute('role', 'radio');
      lamp.setAttribute('aria-label', `${name} ${i}`);
      // The buttons are here to be focusable and to carry the radio group's
      // state; they have no click handler of their own, because the gesture
      // lives on the strip. Keyboard Enter/Space reaches the same code by
      // bubbling up to it.
      lamp.tabIndex = -1;
    }
    wrap.appendChild(lamp);
  }
  wrap.appendChild(el('span', 'dial-odd'));
  relightDial(wrap, name, value);
  return wrap;
}

/** Move a dial's filled circle, in place.
 *
 *  In place rather than by rebuilding the strip: a drag is holding a pointer
 *  over these very elements and a keyboard is holding focus inside one, and
 *  replacing the node mid-gesture would drop both. Nothing else about the
 *  strip depends on the value. */
function relightDial(wrap, name, value) {
  wrap.setAttribute('aria-label', `${name} ${value}`);
  const editable = wrap.getAttribute('role') === 'radiogroup';
  for (const lamp of wrap.querySelectorAll('.lamp')) {
    const on = Number(lamp.dataset.pos) === value;
    lamp.classList.toggle('on', on);
    if (editable) lamp.setAttribute('aria-checked', String(on));
  }
  // A value past the last position can only come from a record the machine
  // never wrote - a blank 0xFF slot decodes that way - so it fills no circle
  // and prints the raw byte instead of quietly reading as position 0.
  const real = value >= 0 && value < edit.NBR_DIAL;
  wrap.querySelector('.dial-odd').textContent = real ? '' : String(value);
  if (editable) {
    // One stop in the tab order for the whole group, landing on the position
    // the dial is set to - the arrow keys move within it. A dial holding a
    // byte no position stands for has nothing lit to land on, and putting the
    // stop on the first circle rather than nowhere is what keeps the keyboard
    // able to reach the one dial that most needs correcting.
    const stop = real ? wrap.querySelector('.lamp.on') : wrap.querySelector('.lamp');
    for (const lamp of wrap.querySelectorAll('.lamp')) lamp.tabIndex = lamp === stop ? 0 : -1;
  }
}

/** SCALE, as the four divisions the switch on the machine has rather than as
 *  the one it is on.
 *
 *  A short closed list, so all four are on show and picking one is a click -
 *  the same reason the dials show all eight positions. It is not a dial
 *  though: the divisions are not detents you sweep past, they are four names,
 *  so they are named buttons and the chosen one is an invert, which is how GEM
 *  said "this one".
 *
 *  A PPQN none of them stands for is printed rather than hidden, for the same
 *  reason an out-of-range dial prints its byte: a pattern whose scale is junk
 *  should look like one instead of like 1/16. */
function scalePicker(value, editable) {
  const wrap = el('div', 'seg');
  wrap.dataset.seg = 'scale';
  wrap.setAttribute('role', editable ? 'radiogroup' : 'img');
  wrap.setAttribute('aria-label', `SCALE ${SCALE_NAMES[value] ?? value}`);
  for (const ppqn of SCALE_ORDER) {
    const button = el(editable ? 'button' : 'span', 'seg-btn', SCALE_NAMES[ppqn]);
    button.dataset.ppqn = String(ppqn);
    if (editable) {
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.tabIndex = -1;
    }
    wrap.appendChild(button);
  }
  wrap.appendChild(el('span', 'seg-odd'));
  relightScale(wrap, value);
  return wrap;
}

/** Move the SCALE picker's selection, in place - same reason as relightDial. */
function relightScale(wrap, value) {
  wrap.setAttribute('aria-label', `SCALE ${SCALE_NAMES[value] ?? value}`);
  const editable = wrap.getAttribute('role') === 'radiogroup';
  for (const button of wrap.querySelectorAll('.seg-btn')) {
    const on = Number(button.dataset.ppqn) === value;
    button.classList.toggle('on', on);
    if (editable) button.setAttribute('aria-checked', String(on));
  }
  const known = SCALE_ORDER.includes(value);
  wrap.querySelector('.seg-odd').textContent = known ? '' : `${value}ppqn`;
  if (editable) {
    // One tab stop for the group, as on the dials - and on the first division
    // rather than nowhere when the record holds a PPQN none of them names.
    const stop = known ? wrap.querySelector('.seg-btn.on') : wrap.querySelector('.seg-btn');
    for (const b of wrap.querySelectorAll('.seg-btn')) b.tabIndex = b === stop ? 0 : -1;
  }
}

/** The boxes under the grid, where the panel prints TRACK and MODE.
 *
 *  SHUFFLE, FLAM and SCALE are the three things about a pattern you set rather
 *  than read, so they are together and in that order, and LAST STEP is last
 *  and hard right, opposite the handle it reports: the playhead sits at the
 *  top of the grid on the column the pattern loops at, and the readout that
 *  confirms the exact number belongs at the far end of the same edge.
 *
 *  `editable` makes all three editable; without it every box is text, which is
 *  what a read-only chart wants. */
function readouts(pattern, editable = false) {
  const wrap = el('div', 'chart-readouts');
  const boxes = [
    // The two dials are named apart because the narrow layouts order them
    // independently - see the .readout-* order rules in the media queries.
    ['SHUFFLE', dial('shuffle', 'SHUFFLE', pattern.shuffle, editable), 'readout readout-control readout-shuffle'],
    ['FLAM', dial('flam', 'FLAM', pattern.flam, editable), 'readout readout-control readout-flam'],
    // No box of its own: the divisions are already a bordered strip, and a
    // second rule around them was a box drawn around a box.
    ['SCALE', scalePicker(pattern.scale, editable), 'readout readout-control readout-bare readout-mid'],
  ];
  if (pattern.extLength !== pattern.length) boxes.push(['EXT STEPS', String(pattern.extSteps)]);
  if (pattern.groupLength) {
    boxes.push(['GROUP', `${pattern.groupPos + 1}/${pattern.groupLength}`]);
  }
  boxes.push(['LAST STEP', String(pattern.steps), 'readout readout-last']);
  for (const [label, value, className] of boxes) {
    const box = el('div', className ?? 'readout');
    box.appendChild(el('span', 'readout-label', label));
    box.appendChild(typeof value === 'string' ? el('span', 'readout-value', value) : value);
    wrap.appendChild(box);
    // Where the row is told to break rather than left to wrap where it likes.
    // Inert at every width but the one band that needs it - see .readout-break.
    if (label === 'SHUFFLE') wrap.appendChild(el('span', 'readout-break'));
  }
  return wrap;
}

export function chartLegend(editable = false) {
  const marks = 'loud  ■    soft  ▒    flam  ◤    beyond last step  ╱';
  if (!editable) return marks;
  return `${marks}\nclick cycles a step  ·  drag along a lane to lay down a run  ·  shift for flam  ·  drag LAST STEP to change the pattern's length  ·  click or drag along the SHUFFLE and FLAM dials to turn them  ·  pick a SCALE division`;
}
