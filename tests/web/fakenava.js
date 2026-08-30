/* An in-memory Nava that speaks the dump protocol, and a pair of fake Web MIDI
 * ports to reach it through - the JavaScript twin of tests/fakenava.py.
 *
 * The fake ports are deliberately MIDIInput/MIDIOutput shaped rather than a
 * stand-in for `midi.Ports`, so the real Ports class is what the tests drive:
 * its SysEx reassembly, its real-time filtering and its waiter queue are the
 * parts of the browser half that have no Python equivalent to be checked
 * against, and they are exactly where a browser-only bug would live.
 */

import * as protocol from '../../web/js/protocol.js';
import * as midi from '../../web/js/midi.js';

export const EEPROM_SIZE = 131072;
export const PTRN_OFFSET = 0;
export const TRACK_OFFSET = protocol.PATTERN_BYTES * protocol.MAX_PTRN;
export const SETUP_OFFSET = TRACK_OFFSET + protocol.TRACK_BYTES * protocol.MAX_TRACK;

export class FakeNava {
  constructor({ running = false } = {}) {
    this.eeprom = new Uint8Array(EEPROM_SIZE);
    this.running = running; // a running sequencer refuses SysEx work
    this.writes = []; // [cmd, param] actually stored
  }

  span(cmd, param) {
    if (cmd === protocol.NAVA_PTRN_DMP || cmd === protocol.NAVA_PTRN_REQ) {
      return [PTRN_OFFSET + param * protocol.PATTERN_BYTES, protocol.PATTERN_BYTES];
    }
    if (cmd === protocol.NAVA_TRACK_DMP || cmd === protocol.NAVA_TRACK_REQ) {
      return [TRACK_OFFSET + param * protocol.TRACK_BYTES, protocol.TRACK_BYTES];
    }
    return [SETUP_OFFSET, protocol.CONFIG_BYTES];
  }

  paramValid(cmd, param) {
    if (cmd === protocol.NAVA_PTRN_DMP || cmd === protocol.NAVA_PTRN_REQ) {
      return param >= 0 && param < protocol.MAX_PTRN;
    }
    if (cmd === protocol.NAVA_TRACK_DMP || cmd === protocol.NAVA_TRACK_REQ) {
      return param >= 0 && param < protocol.MAX_TRACK;
    }
    if (cmd === protocol.NAVA_BANK_REQ) return param >= 0 && param < protocol.MAX_BANK;
    return param === 0;
  }

  seedPattern(number, data) {
    this.eeprom.set(data, PTRN_OFFSET + number * protocol.PATTERN_BYTES);
  }

  readPattern(number) {
    const start = PTRN_OFFSET + number * protocol.PATTERN_BYTES;
    return this.eeprom.slice(start, start + protocol.PATTERN_BYTES);
  }

  /** Process one incoming message, returning whatever it replies with. */
  handle(raw) {
    let message;
    try {
      message = protocol.decode(raw);
    } catch (error) {
      const status = /expected/.test(error.message)
        ? protocol.ACK_BAD_LENGTH
        : protocol.ACK_BAD_CHECKSUM;
      return [protocol.encode(protocol.NAVA_ACK, status)];
    }

    if (this.running) return [protocol.encode(protocol.NAVA_ACK, protocol.ACK_BUSY)];
    if (!this.paramValid(message.cmd, message.param)) {
      return [protocol.encode(protocol.NAVA_ACK, protocol.ACK_BAD_PARAM)];
    }

    if (protocol.DUMP_PAYLOAD_SIZES[message.cmd] !== undefined) {
      const [start] = this.span(message.cmd, message.param);
      this.eeprom.set(message.payload, start);
      this.writes.push([message.cmd, message.param]);
      return [protocol.encode(protocol.NAVA_ACK, protocol.ACK_OK)];
    }

    if (message.cmd === protocol.NAVA_PTRN_REQ) {
      return [this.dump(protocol.NAVA_PTRN_DMP, message.param)];
    }
    if (message.cmd === protocol.NAVA_TRACK_REQ) {
      return [this.dump(protocol.NAVA_TRACK_DMP, message.param)];
    }
    if (message.cmd === protocol.NAVA_CONFIG_REQ) {
      return [this.dump(protocol.NAVA_CONFIG_DMP, 0)];
    }
    if (message.cmd === protocol.NAVA_BANK_REQ) {
      const base = message.param * protocol.PTRN_PER_BANK;
      return Array.from({ length: protocol.PTRN_PER_BANK }, (_, i) =>
        this.dump(protocol.NAVA_PTRN_DMP, base + i),
      );
    }
    return [protocol.encode(protocol.NAVA_ACK, protocol.ACK_BAD_PARAM)];
  }

  dump(cmd, param) {
    const [start, size] = this.span(cmd, param);
    return protocol.encode(cmd, param, this.eeprom.subarray(start, start + size));
  }
}

/** Wire a FakeNava up as a MIDIOutput/MIDIInput pair and hand back real Ports.
 *
 * `dropFirst` swallows that many replies and `corruptFirst` flips a payload bit
 * in that many, which is what the retry paths exist for. `chunk`, when set,
 * delivers each reply in slices of that many bytes with an 0xF8 clock byte
 * wedged between them - a MASTER-sync Nava emits clock continuously, and an
 * interface is free to interleave it mid-message.
 */
export function fakePorts(device, { dropFirst = 0, corruptFirst = 0, chunk = 0 } = {}) {
  const state = { dropFirst, corruptFirst, sent: 0, scheduled: [], cleared: 0 };

  const input = { name: 'fake in', onmidimessage: null };

  const deliver = (message) => {
    if (!input.onmidimessage) return;
    if (!chunk) {
      input.onmidimessage({ data: message });
      return;
    }
    for (let i = 0; i < message.length; i += chunk) {
      input.onmidimessage({ data: message.subarray(i, i + chunk) });
      input.onmidimessage({ data: Uint8Array.of(0xf8) });
    }
  };

  const output = {
    name: 'fake out',
    send(data, timestamp) {
      state.sent += 1;
      state.scheduled.push({ data, timestamp });
      let replies = device.handle(data);
      if (state.dropFirst > 0) {
        state.dropFirst -= 1;
        return;
      }
      if (state.corruptFirst > 0 && replies.length) {
        state.corruptFirst -= 1;
        const broken = Uint8Array.from(replies[0]);
        broken[8] ^= 0x01; // flip a payload bit; the checksum must catch it
        replies = [broken, ...replies.slice(1)];
      }
      for (const reply of replies) deliver(reply);
    },
    clear() {
      state.cleared += 1;
    },
  };

  const ports = new midi.Ports(input, output);
  ports.fake = state;
  return ports;
}
