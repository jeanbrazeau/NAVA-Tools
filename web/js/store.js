/* Remembered settings, the browser's answer to ~/.config/nava/tui.json.
 *
 * Ports are stored by NAME rather than by Web MIDI id: an id is stable within
 * one browser profile but means nothing to a human and nothing across machines,
 * and it is the name the Device panel shows. Everything here is best effort -
 * losing a remembered port is not worth an error, and localStorage throws
 * outright in a browser configured to block site data.
 */

const KEY = 'nava-tools';

export const DEFAULTS = {
  outputPort: null,
  inputPort: null,
};

export function load() {
  const settings = { ...DEFAULTS };
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (stored && typeof stored === 'object') {
      for (const key of Object.keys(DEFAULTS)) {
        if (key in stored) settings[key] = stored[key];
      }
    }
  } catch {
    return settings;
  }
  return settings;
}

export function save(settings) {
  try {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) out[key] = settings[key] ?? DEFAULTS[key];
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // A private window, or site data blocked. The app works without memory.
  }
}
