/* Text rendering of a decoded pattern - the browser half of nava/render.py.
 *
 * The grid is plain text rather than a DOM table so it stays identical to what
 * `nava show` prints, and so the layout is testable as strings. Markers follow
 * how the panel programs a step - a step cycles off -> soft -> loud, so the
 * grid distinguishes those three and nothing else:
 *
 *     #  loud (the instrument's high level)
 *     o  soft (its low level)
 *     .  off
 *     f  a step carrying the flam flag
 */

import { INSTRUMENT_NAMES, TOTAL_ACC, noteName } from './records.js';
import { patternLabel } from './protocol.js';

export const MARKERS = { accent: '#', normal: 'o', off: '.' };

// Width of the lane label column: 'T16 C#-1' is the widest thing that goes there.
export const LABEL_WIDTH = 8;

const pad = (text, width) => String(text).padEnd(width, ' ');

/** Beat ruler. Marks every fourth step so 16ths are countable at a glance. */
function ruler(steps) {
  const cells = [];
  for (let i = 0; i < steps; i += 1) cells.push(i % 4 === 0 ? String(i / 4 + 1) : '·');
  return ' '.repeat(LABEL_WIDTH) + cells.join(' ');
}

function lane(label, cells) {
  return pad(label, LABEL_WIDTH) + cells.join(' ');
}

/** The full grid, as lines. Empty lanes are omitted - a 909 pattern uses a
 *  handful of voices and printing all 16 would bury them. */
export function patternLines(pattern, { config = null, title = null } = {}) {
  const steps = pattern.steps;
  const lines = [];

  if (title) {
    lines.push(title);
    lines.push('');
  }

  let header =
    `len ${steps}  scale ${pattern.scaleName}  ` +
    `shuffle ${pattern.shuffle}  flam ${pattern.flam}`;
  if (pattern.extLength !== pattern.length) header += `  ext len ${pattern.extSteps}`;
  if (pattern.groupLength) header += `  group ${pattern.groupPos + 1}/${pattern.groupLength}`;
  lines.push(header);
  lines.push('');
  lines.push(ruler(steps));

  for (const instrument of pattern.activeVoices()) {
    const cells = [];
    for (let i = 0; i < steps; i += 1) {
      const step = pattern.step(instrument, i);
      const marker = MARKERS[pattern.level(instrument, i)];
      cells.push(step.flam && step.on ? 'f' : marker);
    }
    lines.push(lane(INSTRUMENT_NAMES[instrument], cells));
  }

  if (pattern.totalAcc) {
    const cells = [];
    for (let i = 0; i < steps; i += 1) {
      cells.push((pattern.inst[TOTAL_ACC] >> i) & 1 ? MARKERS.accent : MARKERS.off);
    }
    lines.push(lane('ACC', cells));
  }

  const extTracks = pattern.activeExtTracks();
  if (extTracks.length) {
    lines.push('');
    lines.push(`ext MIDI  (${pattern.extSteps} steps)`);
    const notes = config ? config.extNotes : null;
    for (const track of extTracks) {
      let label = `T${track + 1}`;
      if (notes) label += ` ${noteName(notes[track])}`;
      const cells = [];
      // The ext layer wraps on its own length, so a shorter ext loop repeats
      // against the kit rather than leaving the tail blank.
      for (let i = 0; i < steps; i += 1) {
        cells.push(MARKERS[pattern.extStep(track, i % pattern.extSteps)]);
      }
      lines.push(lane(label, cells));
    }
  }

  if (pattern.isEmpty()) {
    lines.push('');
    lines.push('(empty pattern)');
  }

  return lines;
}

export function patternText(pattern, options) {
  return patternLines(pattern, options).join('\n');
}

export function legend() {
  return '#  loud    o  soft    .  off    f  flam';
}

export function configLines(config) {
  const lines = [
    `tempo          ${config.bpm} BPM`,
    `sync           ${config.syncName}`,
    `boot mode      ${config.bootModeName}`,
    `MIDI TX / RX   ${config.txChannel} / ${config.rxChannel}`,
    `MIDI ext ch    ${config.extChannel}`,
    `ext velocity   ${config.extVelLow} soft / ${config.extVelHigh} loud`,
    `pattern change ${config.patternChangeSync ? 'SYNC' : 'FREE'}`,
    `HH mute mode   ${config.muteModeHh ? 'HH' : 'C/O'}`,
    '',
    'ext track notes' + (config.extNotesStored ? '' : '  (defaults, none stored)'),
  ];
  for (let row = 0; row < 16; row += 4) {
    const cells = [];
    for (let track = row; track < row + 4; track += 1) {
      cells.push(`T${pad(track + 1, 2)} ${pad(noteName(config.extNotes[track]), 4)}`);
    }
    lines.push('  ' + cells.join(' '));
  }
  return lines;
}

export function trackLines(track, number) {
  const used = track.used;
  const lines = [
    `track ${number + 1}: ${used.length} pattern(s), stored length ${track.length}`,
  ];
  if (!used.length) {
    lines.push('(empty)');
    return lines;
  }
  for (let row = 0; row < used.length; row += 8) {
    const chunk = used.slice(row, row + 8);
    lines.push(
      `  ${String(row + 1).padStart(4, ' ')}: ` + chunk.map(patternLabel).join(' '),
    );
  }
  return lines;
}

/** One line for a table row. */
export function summarisePattern(pattern) {
  if (pattern.isEmpty()) return 'empty';
  const voices = pattern.activeVoices().map((i) => INSTRUMENT_NAMES[i]);
  const ext = pattern.activeExtTracks().length;
  const parts = [`${pattern.steps}st`, pattern.scaleName];
  if (voices.length) {
    parts.push(voices.slice(0, 6).join(' ') + (voices.length > 6 ? '…' : ''));
  }
  if (ext) parts.push(`+${ext} ext`);
  return parts.join('  ');
}
