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
 */

import { INSTRUMENT_NAMES, NBR_STEP, TOTAL_ACC, noteName } from './records.js';

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

/** The chart for one pattern, plus the step strip under it.
 *
 * `onInstrument` is called with an instrument index when a row is picked, so
 * the caller can keep the strip in step with the selection.
 */
export function patternChart(pattern, { config = null, title = '' } = {}) {
  const root = el('div', 'chart');
  if (title) root.appendChild(el('div', 'chart-title', title));

  const table = el('table', 'chart-grid');
  const steps = pattern.steps;

  const head = el('tr');
  head.appendChild(el('th', 'chart-corner', 'STEP'));
  for (let i = 0; i < NBR_STEP; i += 1) {
    const cell = el('th', 'chart-num', String(i + 1));
    if (i % 4 === 0) cell.classList.add('beat');
    if (i >= steps) cell.classList.add('past');
    head.appendChild(cell);
  }
  const thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  const body = el('tbody');
  const rows = new Map();

  for (const [instrument, label] of CHART_ROWS) {
    const row = el('tr', 'chart-row');
    row.dataset.instrument = String(instrument);
    row.tabIndex = 0;
    row.title = `${label} (${INSTRUMENT_NAMES[instrument]})`;
    row.appendChild(el('th', 'chart-label', label));

    for (let i = 0; i < NBR_STEP; i += 1) {
      const cell = el('td', 'cell');
      if (i % 4 === 0) cell.classList.add('beat');
      // Steps past the pattern's length are printed but struck out: the chart
      // is always 16 wide and a 12-step pattern has to look like a 12-step
      // pattern rather than like four silent steps.
      if (i >= steps) {
        cell.classList.add('past');
      } else {
        const step = pattern.step(instrument, i);
        if (step.on) {
          cell.classList.add(pattern.level(instrument, i) === 'accent' ? 'loud' : 'soft');
          if (step.flam) cell.classList.add('flam');
        }
      }
      row.appendChild(cell);
    }
    rows.set(instrument, row);
    body.appendChild(row);
  }

  // ACCENT is the machine's own last row: it accents everything on that step
  // rather than playing a voice, which is why it is not in CHART_ROWS.
  const accent = el('tr', 'chart-row chart-accent');
  accent.appendChild(el('th', 'chart-label', 'ACCENT'));
  for (let i = 0; i < NBR_STEP; i += 1) {
    const cell = el('td', 'cell');
    if (i % 4 === 0) cell.classList.add('beat');
    if (i >= steps) cell.classList.add('past');
    else if ((pattern.inst[TOTAL_ACC] >> i) & 1) cell.classList.add('loud');
    accent.appendChild(cell);
  }
  body.appendChild(accent);

  // The ext MIDI layer runs on its own length, so a shorter loop repeats
  // against the kit - the same wrap the firmware does and the text grid shows.
  for (const track of pattern.activeExtTracks()) {
    const row = el('tr', 'chart-row chart-ext');
    const notes = config ? config.extNotes : null;
    const label = `T${track + 1}${notes ? ` ${noteName(notes[track])}` : ''}`;
    row.appendChild(el('th', 'chart-label', label));
    for (let i = 0; i < NBR_STEP; i += 1) {
      const cell = el('td', 'cell');
      if (i % 4 === 0) cell.classList.add('beat');
      if (i >= steps) {
        cell.classList.add('past');
      } else {
        const state = pattern.extStep(track, i % pattern.extSteps);
        if (state !== 'off') cell.classList.add(state === 'accent' ? 'loud' : 'soft');
      }
      row.appendChild(cell);
    }
    body.appendChild(row);
  }

  table.appendChild(body);
  root.appendChild(table);

  root.appendChild(readouts(pattern));

  // The step strip, which is the row of 16 keys under the panel. It shows one
  // instrument at a time, exactly as the machine does - INSTRUMENT SELECT picks
  // which, and here that is clicking a row.
  const strip = el('div', 'step-strip');
  root.appendChild(strip);

  const active = pattern.activeVoices();
  let chosen = active.includes(8) ? 8 : (active[0] ?? 8);

  const select = (instrument) => {
    chosen = instrument;
    for (const [index, row] of rows) {
      row.setAttribute('aria-selected', String(index === instrument));
    }
    drawStrip(strip, pattern, instrument);
  };

  for (const [instrument, row] of rows) {
    row.addEventListener('click', () => select(instrument));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select(instrument);
      }
    });
  }
  select(chosen);

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

function drawStrip(strip, pattern, instrument) {
  strip.replaceChildren();

  const name = el('div', 'strip-name');
  name.appendChild(el('span', 'strip-caption', 'INSTRUMENT'));
  name.appendChild(el('span', 'strip-value', chartName(instrument)));
  strip.appendChild(name);

  const keys = el('div', 'strip-keys');
  for (let i = 0; i < NBR_STEP; i += 1) {
    const key = el('div', 'key');
    if (i % 4 === 0) key.classList.add('group');
    key.appendChild(el('span', 'key-num', String(i + 1)));
    const lamp = el('span', 'lamp');
    if (i < pattern.steps) {
      const step = pattern.step(instrument, i);
      if (step.on) {
        lamp.classList.add(pattern.level(instrument, i) === 'accent' ? 'loud' : 'soft');
        if (step.flam) key.classList.add('flam');
      }
    } else {
      key.classList.add('past');
    }
    key.appendChild(lamp);
    keys.appendChild(key);
  }
  strip.appendChild(keys);
}

function chartName(instrument) {
  const found = CHART_ROWS.find(([index]) => index === instrument);
  return found ? found[1] : INSTRUMENT_NAMES[instrument];
}

export function chartLegend() {
  return 'loud  ■    soft  ▒    flam  ◤    beyond last step  ╱';
}
