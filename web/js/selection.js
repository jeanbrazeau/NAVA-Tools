/* Parsing for the pattern/track selection fields - the browser half of
 * nava/selection.py. Kept apart from the UI so the range semantics are
 * unit-testable without a DOM.
 */

import { MAX_PTRN, MAX_TRACK, PTRN_PER_BANK, parsePatternLabel } from './protocol.js';

/** Order-preserving, so a dump follows the order the user asked for. */
function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** 'all', 'A1', 'A1,B3', 'A1-A4', 'A' (a whole bank), or plain numbers. */
export function parsePatterns(spec) {
  if (spec.trim().toLowerCase() === 'all') {
    return Array.from({ length: MAX_PTRN }, (_, i) => i);
  }

  const selected = [];
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    // A bare bank letter expands to its 16 patterns - the panel's own unit of
    // organisation, and what someone means by "back up bank C".
    if (part.length === 1 && /[a-zA-Z]/.test(part)) {
      const base = parsePatternLabel(`${part.toUpperCase()}1`);
      for (let i = 0; i < PTRN_PER_BANK; i += 1) selected.push(base + i);
      continue;
    }
    if (part.includes('-')) {
      const cut = part.indexOf('-');
      const start = parsePatternLabel(part.slice(0, cut));
      const end = parsePatternLabel(part.slice(cut + 1));
      if (end < start) throw new RangeError(`range '${part}' runs backwards`);
      for (let i = start; i <= end; i += 1) selected.push(i);
      continue;
    }
    selected.push(parsePatternLabel(part));
  }

  if (!selected.length) throw new RangeError('empty pattern selection');
  return dedupe(selected);
}

/** 'all', '1', '1,3', '1-4'. Tracks are 1-based on the panel, 0-based here. */
export function parseTracks(spec) {
  if (spec.trim().toLowerCase() === 'all') {
    return Array.from({ length: MAX_TRACK }, (_, i) => i);
  }

  const selected = [];
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const cut = part.indexOf('-');
      const start = trackNumber(part.slice(0, cut));
      const end = trackNumber(part.slice(cut + 1));
      if (end < start) throw new RangeError(`range '${part}' runs backwards`);
      for (let i = start; i <= end; i += 1) selected.push(i);
      continue;
    }
    selected.push(trackNumber(part));
  }

  if (!selected.length) throw new RangeError('empty track selection');
  return dedupe(selected);
}

function trackNumber(text) {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new RangeError(`unrecognised track '${trimmed}': use 1-${MAX_TRACK}`);
  }
  const number = parseInt(trimmed, 10);
  if (number < 1 || number > MAX_TRACK) {
    throw new RangeError(`track ${number} out of range 1-${MAX_TRACK}`);
  }
  return number - 1;
}
