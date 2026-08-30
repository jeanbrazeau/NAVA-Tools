/* The JavaScript half of the cross-implementation contract.
 *
 * Every case here comes from tests/fixtures/vectors.json, which is generated
 * from the Python package by tests/make_vectors.py. Nothing in this file
 * encodes an expectation of its own: if the two implementations of the protocol
 * or of the EEPROM layout disagree by one byte or one space, this fails and
 * names the case.
 *
 *     node --test tests/web/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as protocol from '../../web/js/protocol.js';
import * as bootloader from '../../web/js/bootloader.js';
import * as ihex from '../../web/js/ihex.js';
import * as records from '../../web/js/records.js';
import * as render from '../../web/js/render.js';
import * as selection from '../../web/js/selection.js';
import * as library from '../../web/js/library.js';

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/vectors.json', import.meta.url)), 'utf8'),
);

const bytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (data) => Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');

test('pack7 matches the Python encoder byte for byte', () => {
  for (const vector of vectors.pack7) {
    const raw = bytes(vector.raw);
    assert.equal(hex(protocol.pack7(raw)), vector.packed, `pack7(${vector.raw})`);
    assert.equal(hex(protocol.unpack7(bytes(vector.packed))), vector.raw, `unpack7(${vector.packed})`);
  }
});

test('encode produces the same message bytes', () => {
  for (const vector of vectors.messages) {
    const encoded = protocol.encode(vector.cmd, vector.param, bytes(vector.payload));
    assert.equal(hex(encoded), vector.encoded, `encode(${vector.cmd}, ${vector.param})`);
  }
});

test('decode reads those messages back', () => {
  for (const vector of vectors.messages) {
    const message = protocol.decode(bytes(vector.encoded));
    assert.equal(message.cmd, vector.cmd);
    assert.equal(message.param, vector.param);
    assert.equal(hex(message.payload), vector.payload);
  }
});

test('a corrupted payload fails the checksum rather than decoding', () => {
  const vector = vectors.messages.find((m) => m.payload.length > 0);
  const damaged = bytes(vector.encoded);
  damaged[protocol.HEADERSIZE + 3] ^= 0x01;
  assert.throws(() => protocol.decode(damaged), protocol.ProtocolError);
});

test('pattern labels agree', () => {
  for (const { number, label } of vectors.pattern_labels) {
    assert.equal(protocol.patternLabel(number), label);
    assert.equal(protocol.parsePatternLabel(label), number);
  }
});

test('pattern records decode and render identically', () => {
  const config = records.decodeConfig(bytes(vectors.configs[0].record));
  for (const vector of vectors.patterns) {
    const pattern = records.decodePattern(bytes(vector.record));
    // `config` says whether Python rendered this case with a config record, and
    // so whether its ext lanes carry note names rather than bare track numbers.
    const lines = render.patternLines(pattern, {
      config: vector.config ? config : null,
      title: vector.name,
    });
    assert.deepEqual(lines, vector.lines, `${vector.name} grid`);
    assert.equal(render.summarisePattern(pattern), vector.summary, `${vector.name} summary`);
    assert.equal(pattern.steps, vector.steps);
    assert.equal(pattern.extSteps, vector.ext_steps);
    assert.equal(pattern.scaleName, vector.scale_name);
    assert.equal(pattern.isEmpty(), vector.empty);
  }
});

test('config records decode and render identically', () => {
  for (const vector of vectors.configs) {
    const config = records.decodeConfig(bytes(vector.record));
    assert.deepEqual(render.configLines(config), vector.lines, vector.name);
  }
});

test('track records decode and render identically', () => {
  for (const vector of vectors.tracks) {
    const track = records.decodeTrack(bytes(vector.record));
    assert.deepEqual(track.used, vector.used, vector.name);
    assert.deepEqual(render.trackLines(track, vector.number), vector.lines, vector.name);
  }
});

test('selection specs expand the same way', () => {
  for (const vector of vectors.selections) {
    const parse = vector.kind === 'patterns' ? selection.parsePatterns : selection.parseTracks;
    assert.deepEqual(parse(vector.spec), vector.result, `${vector.kind} '${vector.spec}'`);
  }
});

test('Intel HEX parses to the same image', () => {
  for (const vector of vectors.ihex) {
    assert.equal(hex(ihex.load(vector.text)), vector.image);
  }
});

test('firmware encoding matches, and decodes back to the image', () => {
  for (const vector of vectors.firmware) {
    const image = bytes(vector.image);
    const syx = bootloader.encodeFirmware(image);
    assert.equal(hex(syx), vector.syx);
    // encode pads the final page, so the round trip is longer than the input;
    // what has to survive is the image itself.
    const decoded = bootloader.decodeFirmware(syx);
    assert.equal(hex(decoded.subarray(0, image.length)), vector.image);
    assert.equal(bootloader.firmwareMessages(image).length, vector.pages + 1);
  }
});

test('the legend is the same string', () => {
  assert.equal(render.legend(), vectors.legend);
});

test('a firmware .syx and a backup .syx are told apart by their header', () => {
  const firmware = bytes(vectors.firmware[0].syx);
  const dump = vectors.messages.find((m) => m.cmd === 0x01);
  const backup = bytes(dump.encoded);

  assert.equal(library.classify(firmware), library.KIND_FIRMWARE);
  assert.equal(library.classify(backup), library.KIND_BACKUP);
  assert.equal(library.classify(Uint8Array.of(0xf0, 0x7e, 0x00, 0xf7)), library.KIND_UNKNOWN);

  const loaded = library.load('backup.syx', backup);
  assert.equal(loaded.kind, library.KIND_BACKUP);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].label, protocol.patternLabel(dump.param));
  assert.deepEqual(loaded.errors, []);

  const image = library.load('firmware.syx', firmware);
  assert.equal(image.kind, library.KIND_FIRMWARE);
  assert.equal(image.pages, vectors.firmware[0].pages);
});

test('a partly corrupt backup still lists what survived', () => {
  const dump = vectors.messages.find((m) => m.cmd === 0x01);
  const good = bytes(dump.encoded);
  const damaged = bytes(dump.encoded);
  damaged[protocol.HEADERSIZE + 3] ^= 0x01;

  const stream = new Uint8Array(good.length + damaged.length);
  stream.set(damaged, 0);
  stream.set(good, damaged.length);

  const loaded = library.load('mixed.syx', stream);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.summary(), /1 pattern {2}\(1 bad\)/);
});
