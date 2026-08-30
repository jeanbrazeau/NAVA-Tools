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

import { INSTRUMENT_NAMES, NBR_EXT_TRACK, NBR_STEP, TOTAL_ACC, noteName } from './records.js';

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
 *  step strip that shows whichever lane is picked. */
export function patternChart(pattern, { config = null, title = '' } = {}) {
  const root = el('div', 'chart');
  if (title) root.appendChild(el('div', 'chart-title', title));

  const steps = pattern.steps;
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

  const table = el('table', 'chart-grid');
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

  const rows = new Map();
  const key = (kind, index) => `${kind}:${index}`;

  /* Steps past the pattern's length are printed but struck out: the chart is
     always 16 wide, and a 12-step pattern has to look like a 12-step pattern
     rather than like four silent steps. */
  const cellFor = (i, state, flam = false) => {
    const cell = el('td', 'cell');
    if (i % 4 === 0) cell.classList.add('beat');
    if (i >= steps) {
      cell.classList.add('past');
      return cell;
    }
    if (state !== 'off') cell.classList.add(state === 'accent' ? 'loud' : 'soft');
    if (flam) cell.classList.add('flam');
    return cell;
  };

  const instBody = el('tbody');
  for (const [instrument, label] of CHART_ROWS) {
    const row = el('tr', 'chart-row');
    row.tabIndex = 0;
    row.title = `${label} (${INSTRUMENT_NAMES[instrument]})`;
    row.appendChild(el('th', 'chart-label', label));
    for (let i = 0; i < NBR_STEP; i += 1) {
      const step = i < steps ? pattern.step(instrument, i) : null;
      row.appendChild(
        cellFor(i, step && step.on ? pattern.level(instrument, i) : 'off', step?.flam && step.on),
      );
    }
    rows.set(key('inst', instrument), row);
    instBody.appendChild(row);
  }

  // ACCENT belongs with the voices: it accents the whole machine on that step
  // rather than playing anything, which is why it is not in CHART_ROWS.
  const accent = el('tr', 'chart-row chart-accent');
  accent.appendChild(el('th', 'chart-label', 'ACCENT'));
  for (let i = 0; i < NBR_STEP; i += 1) {
    accent.appendChild(cellFor(i, (pattern.inst[TOTAL_ACC] >> i) & 1 ? 'accent' : 'off'));
  }
  instBody.appendChild(accent);

  // All sixteen ext lanes, not just the used ones, for the same reason the
  // voices are all present: T7 should be in the same place in every pattern.
  const extBody = el('tbody');
  for (let track = 0; track < NBR_EXT_TRACK; track += 1) {
    const row = el('tr', 'chart-row chart-ext');
    row.tabIndex = 0;
    const note = config ? noteName(config.extNotes[track]) : null;
    row.title = note ? `ext track ${track + 1}, note ${note}` : `ext track ${track + 1}`;
    row.appendChild(el('th', 'chart-label', `T${track + 1}${note ? `  ${note}` : ''}`));
    for (let i = 0; i < NBR_STEP; i += 1) {
      // The ext layer wraps on its own length, so a shorter ext loop repeats
      // against the kit rather than leaving the tail blank.
      row.appendChild(cellFor(i, i < steps ? pattern.extStep(track, i % pattern.extSteps) : 'off'));
    }
    rows.set(key('ext', track), row);
    extBody.appendChild(row);
  }

  table.append(instBody, extBody);
  root.appendChild(table);
  root.appendChild(readouts(pattern));

  const strip = el('div', 'step-strip');
  root.appendChild(strip);

  // One remembered lane per view, so switching tabs and back returns to what
  // was being looked at rather than resetting to the top.
  const active = pattern.activeVoices();
  const chosen = {
    inst: active.includes(8) ? 8 : (active[0] ?? 8),
    ext: pattern.activeExtTracks()[0] ?? 0,
  };
  let view = 'inst';

  const paint = () => {
    instTab.setAttribute('aria-selected', String(view === 'inst'));
    extTab.setAttribute('aria-selected', String(view === 'ext'));
    instBody.hidden = view !== 'inst';
    extBody.hidden = view === 'inst';
    for (const [id, row] of rows) {
      row.setAttribute('aria-selected', String(id === key(view, chosen[view])));
    }
    drawStrip(strip, pattern, view, chosen[view], config);
  };

  const pick = (kind, index) => {
    view = kind;
    chosen[kind] = index;
    paint();
  };

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
  instTab.addEventListener('click', () => {
    view = 'inst';
    paint();
  });
  extTab.addEventListener('click', () => {
    view = 'ext';
    paint();
  });

  paint();
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
  const found = CHART_ROWS.find(([i]) => i === index);
  return found ? found[1] : INSTRUMENT_NAMES[index];
}

export function chartLegend() {
  return 'loud  ■    soft  ▒    flam  ◤    beyond last step  ╱';
}
