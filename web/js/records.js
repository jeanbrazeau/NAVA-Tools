/* Decoding of the EEPROM records a dump carries - the browser half of
 * nava/records.py.
 *
 * The transfer path treats records as opaque bytes on purpose; that is what
 * lets a backup survive firmware revisions that add fields inside the padding.
 * This module is the other half. Offsets come from EEprom.ino's LoadPattern:
 *
 *     0..31    inst[16], one 16-bit little-endian step mask per instrument
 *     32..63   length, scale, shuffle, flam, extLength+1, groupPos,
 *              groupLength, totalAcc, then 24 reserved bytes
 *     64..95   extTrack[16], one 16-bit step mask per ext MIDI track
 *     96..127  extAccent[16], INVERTED (see below)
 *     128..191 a second page the firmware writes as zeros and skips on read
 *     192..447 velocity[16][16], one byte per instrument per step
 *
 * extAccent is stored inverted because a pattern written before ext steps had
 * two velocity levels has zeros there, and those patterns played at the HIGH
 * level - the only one the ext lane had. Reading the complement decodes them as
 * accented, which is what they sounded like.
 */

import * as protocol from './protocol.js';

export const NBR_INST = 16;
export const NBR_STEP = 16;
export const NBR_EXT_TRACK = 16;

export const OFF_INST = 0;
export const OFF_SETUP = 32;
export const OFF_EXT_TRACK = 64;
export const OFF_EXT_ACCENT = 96;
export const OFF_VELOCITY = 192;

export const END_OF_TRACK = 128;

// Instrument index -> panel label, from nameInst[] in nava_strings.h. Indices 1
// and 5 drive no voice of their own, and 0 is the trigger output, so they are
// unnamed on the panel too.
export const INSTRUMENT_NAMES = [
  'TRG', '', 'HT', 'RIM', 'HCL', '', 'RID', 'CRH',
  'BD', 'SD', 'LT', 'MT', 'ACC', 'EXT', 'CH', 'OH',
];

// The instruments worth showing as a lane, in the order a 909 panel reads. ACC
// and EXT are shown separately: one accents the whole machine and the other is
// the MIDI layer, so neither is a drum voice.
export const VOICE_ORDER = [8, 9, 10, 11, 2, 3, 4, 14, 15, 7, 6];

export const TOTAL_ACC = 12;
export const EXT_INST = 13;

// instVelHigh/instVelLow from define.h - the two levels a step cycles through.
// Deliberately not uniform; the table matches the original TR-909.
export const INST_VEL_HIGH = [1, 1, 50, 50, 50, 108, 112, 107, 50, 50, 50, 50, 1, 50, 111, 109];
export const INST_VEL_LOW = [0, 0, 25, 25, 25, 50, 111, 106, 25, 25, 25, 25, 0, 25, 80, 108];

// PPQN ticks per step -> the division the panel shows.
export const SCALE_NAMES = { 24: '1/16', 12: '1/32', 16: '1/16t', 32: '1/8t' };

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Power-on ext track notes, EXT_TRACK_NOTES[] in define.h. Used when a backup
// carries no config record to say otherwise.
export const DEFAULT_EXT_NOTES = Array.from({ length: 16 }, (_, i) => 48 + i);

export const EXT_NOTES_OFFSET = 32; // within the 64-byte setup record
export const EXT_NOTES_SIG = 0x4e;

const SYNC_NAMES = { 0: 'MASTER', 1: 'SLAVE', 2: 'EXPANDER' };
const BOOT_MODES = ['TRACK PLAY', 'TRACK WRITE', 'PTRN PLAY', 'PTRN STEP', 'PTRN TAP', 'MUTE'];

export class RecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecordError';
  }
}

/** MIDI number as a name under the 60 = C4 convention the LCD uses. */
export function noteName(note) {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

export class Pattern {
  constructor(fields) {
    Object.assign(this, fields);
  }

  get scaleName() {
    return SCALE_NAMES[this.scale] ?? `${this.scale}ppqn`;
  }

  get steps() {
    return this.length + 1;
  }

  get extSteps() {
    return this.extLength + 1;
  }

  /** One step's on/velocity/flam, the flam flag stripped off the velocity. */
  step(instrument, index) {
    const raw = this.velocity[instrument][index];
    return {
      on: Boolean((this.inst[instrument] >> index) & 1),
      velocity: raw & 0x7f,
      flam: Boolean(raw & 0x80),
    };
  }

  /** 'accent', 'normal' or 'off', by comparison with this instrument's own two
   *  levels rather than a global threshold. */
  level(instrument, index) {
    const step = this.step(instrument, index);
    if (!step.on) return 'off';
    return step.velocity >= INST_VEL_HIGH[instrument] ? 'accent' : 'normal';
  }

  extStep(track, index) {
    if (!((this.extTrack[track] >> index) & 1)) return 'off';
    return (this.extAccent[track] >> index) & 1 ? 'accent' : 'normal';
  }

  activeVoices() {
    return VOICE_ORDER.filter((i) => this.inst[i]);
  }

  activeExtTracks() {
    const out = [];
    for (let i = 0; i < NBR_EXT_TRACK; i += 1) if (this.extTrack[i]) out.push(i);
    return out;
  }

  isEmpty() {
    return (
      this.activeVoices().length === 0 &&
      this.activeExtTracks().length === 0 &&
      !this.totalAcc
    );
  }
}

const word = (data, offset) => data[offset] | (data[offset + 1] << 8);

export function decodePattern(data) {
  if (data.length !== protocol.PATTERN_BYTES) {
    throw new RecordError(
      `pattern record is ${data.length} bytes, expected ${protocol.PATTERN_BYTES}`,
    );
  }

  const inst = [];
  for (let i = 0; i < NBR_INST; i += 1) inst.push(word(data, OFF_INST + 2 * i));

  const length = data[OFF_SETUP];
  const scale = data[OFF_SETUP + 1];
  const shuffle = data[OFF_SETUP + 2];
  const flam = data[OFF_SETUP + 3];
  const storedExtLength = data[OFF_SETUP + 4];
  const groupPos = data[OFF_SETUP + 5];
  const groupLength = data[OFF_SETUP + 6];
  const totalAcc = data[OFF_SETUP + 7];

  // Biased by one so that 0 still means "written before this existed"; an ext
  // length of 0 is itself legal (a one-step loop).
  const extLength = storedExtLength ? storedExtLength - 1 : length;

  const extTrack = [];
  const extAccent = [];
  for (let i = 0; i < NBR_EXT_TRACK; i += 1) {
    extTrack.push(word(data, OFF_EXT_TRACK + 2 * i));
    extAccent.push(~word(data, OFF_EXT_ACCENT + 2 * i) & 0xffff);
  }

  const velocity = [];
  for (let i = 0; i < NBR_INST; i += 1) {
    velocity.push(Array.from(data.subarray(OFF_VELOCITY + i * NBR_STEP, OFF_VELOCITY + (i + 1) * NBR_STEP)));
  }

  // A blank (0xFF-filled) EEPROM slot decodes to nonsense rather than failing,
  // so the obviously-impossible values are clamped instead of trusted. length is
  // a 0-15 index and scale is one of four PPQN divisions.
  return new Pattern({
    length: Math.min(length, NBR_STEP - 1),
    scale,
    shuffle,
    flam,
    extLength: Math.min(extLength, NBR_STEP - 1),
    groupPos,
    groupLength,
    totalAcc,
    inst,
    velocity,
    extTrack,
    extAccent,
  });
}

export class Config {
  constructor(fields) {
    Object.assign(this, fields);
  }

  get syncName() {
    return SYNC_NAMES[this.sync] ?? `?${this.sync}`;
  }

  get bootModeName() {
    return BOOT_MODES[this.bootMode] ?? `?${this.bootMode}`;
  }
}

export function decodeConfig(data) {
  if (data.length !== protocol.CONFIG_BYTES) {
    throw new RecordError(
      `config record is ${data.length} bytes, expected ${protocol.CONFIG_BYTES}`,
    );
  }

  // Bytes 8 and 9 postdate the original record. A unit written before they
  // existed reads 0 or 0xFF there, neither of which is a legal level, so both
  // fall back to the compiled-in defaults exactly as LoadSeqSetup() does.
  const level = (raw, fallback) => (raw >= 1 && raw <= 127 ? raw : fallback);

  const notesValid = data[EXT_NOTES_OFFSET] === EXT_NOTES_SIG;
  const extNotes = [];
  for (let i = 0; i < NBR_EXT_TRACK; i += 1) {
    const stored = data[EXT_NOTES_OFFSET + 1 + i];
    extNotes.push(notesValid && stored <= 127 ? stored : DEFAULT_EXT_NOTES[i]);
  }

  return new Config({
    sync: data[0],
    bpm: data[1],
    txChannel: data[2],
    rxChannel: data[3],
    patternChangeSync: data[4],
    muteModeHh: data[5],
    extChannel: data[6],
    bootMode: data[7],
    extVelLow: level(data[8], 63),
    extVelHigh: level(data[9], 111),
    extNotes,
    extNotesStored: notesValid,
  });
}

export class Track {
  constructor(patterns, length) {
    this.patterns = patterns;
    this.length = length;
  }

  /** Entries up to the end marker, which is what the sequencer plays. */
  get used() {
    const out = [];
    const limit = Math.min(this.length, this.patterns.length);
    for (let i = 0; i < limit; i += 1) {
      if (this.patterns[i] >= END_OF_TRACK) break;
      out.push(this.patterns[i]);
    }
    return out;
  }
}

export function decodeTrack(data) {
  if (data.length !== protocol.TRACK_BYTES) {
    throw new RecordError(
      `track record is ${data.length} bytes, expected ${protocol.TRACK_BYTES}`,
    );
  }
  // SaveTrack stores the length in the last two bytes of the record itself.
  const length = data[1022] | (data[1023] << 8);
  return new Track(Array.from(data.subarray(0, 1022)), length);
}
