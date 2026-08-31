/* Backup, restore and flash against the in-memory device.
 *
 * The Python suite proves these loops against fakenava.py; this proves the same
 * loops in the browser, through the real Ports class - so the SysEx
 * reassembler, the promise-based timeout and the scheduled flash pacing are all
 * exercised without hardware.
 *
 *     node --test tests/web/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as protocol from '../../web/js/protocol.js';
import * as transfer from '../../web/js/transfer.js';
import * as midi from '../../web/js/midi.js';
import * as library from '../../web/js/library.js';
import { FakeNava, fakePorts } from './fakenava.js';

const TIMEOUT = 50;
const RETRIES = 2;

/** A pattern record whose every byte depends on the pattern number, so a dump
 *  stored under the wrong label is caught by comparing bytes rather than
 *  counts. */
function seedPattern(number) {
  const data = new Uint8Array(protocol.PATTERN_BYTES);
  for (let i = 0; i < data.length; i += 1) data[i] = (number * 31 + i * 7) & 0x7f;
  return data;
}

function seededDevice(count = 8) {
  const device = new FakeNava();
  for (let n = 0; n < count; n += 1) device.seedPattern(n, seedPattern(n));
  return device;
}

test('a dump comes back byte for byte', async () => {
  const device = seededDevice();
  const ports = fakePorts(device);
  const items = transfer.selections({ patterns: [0, 1, 2, 3], tracks: [], config: true });

  const outcome = await transfer.backup(ports, items, TIMEOUT, RETRIES);

  assert.deepEqual(outcome.failures, []);
  assert.ok(outcome.ok);
  const file = library.load('dump.syx', outcome.collected);
  assert.equal(file.kind, library.KIND_BACKUP);
  assert.equal(file.items.length, 5);
  for (let n = 0; n < 4; n += 1) {
    assert.deepEqual(file.items[n].payload, seedPattern(n), `pattern ${n}`);
  }
});

test('a full round trip restores the device byte for byte', async () => {
  const device = seededDevice(16);
  const ports = fakePorts(device);
  const items = transfer.selections({
    patterns: [...Array(16).keys()],
    tracks: [0, 1],
    config: true,
  });

  const dumped = await transfer.backup(ports, items, TIMEOUT, RETRIES);
  assert.deepEqual(dumped.failures, []);
  const before = device.eeprom.slice();

  device.eeprom.fill(0);
  assert.notDeepEqual(device.eeprom, before);

  const file = library.load('backup.syx', dumped.collected);
  const dumps = file.items.map((i) => new protocol.NavaMessage(i.cmd, i.param, i.payload));
  const restored = await transfer.restore(ports, dumps, TIMEOUT, RETRIES);

  assert.deepEqual(restored.failures, []);
  assert.deepEqual(device.eeprom, before);
});

test('a dropped reply is retried rather than lost', async () => {
  const device = seededDevice();
  const ports = fakePorts(device, { dropFirst: 1 });
  const items = transfer.selections({ patterns: [0, 1] });

  const outcome = await transfer.backup(ports, items, TIMEOUT, RETRIES);

  assert.deepEqual(outcome.failures, []);
  const file = library.load('dump.syx', outcome.collected);
  assert.deepEqual(file.items[0].payload, seedPattern(0));
  assert.equal(ports.fake.sent, 3, 'one request resent');
});

test('a corrupted reply fails its checksum and is retried', async () => {
  const device = seededDevice();
  const ports = fakePorts(device, { corruptFirst: 1 });
  const items = transfer.selections({ patterns: [0] });

  const outcome = await transfer.backup(ports, items, TIMEOUT, RETRIES);

  assert.deepEqual(outcome.failures, []);
  const file = library.load('dump.syx', outcome.collected);
  assert.deepEqual(file.items[0].payload, seedPattern(0));
});

test('a message split across events, with clock wedged in, still arrives', async () => {
  const device = seededDevice();
  const ports = fakePorts(device, { chunk: 64 });
  const items = transfer.selections({ patterns: [0] });

  const outcome = await transfer.backup(ports, items, TIMEOUT, RETRIES);

  assert.deepEqual(outcome.failures, []);
  const file = library.load('dump.syx', outcome.collected);
  assert.deepEqual(file.items[0].payload, seedPattern(0));
});

test('a busy device is reported, not retried into a wrong answer', async () => {
  const device = seededDevice();
  device.running = true;
  const ports = fakePorts(device);

  await assert.rejects(
    () => midi.requestDump(ports, protocol.NAVA_PTRN_REQ, 0, TIMEOUT, RETRIES),
    /sequencer running/,
  );
});

test('a partial dump keeps what came back', async () => {
  const device = seededDevice();
  // Every reply is swallowed, so the second item times out after its retries
  // while the first has already been collected.
  const ports = fakePorts(device);
  const items = transfer.selections({ patterns: [0, 1] });

  const first = await transfer.backup(ports, items.slice(0, 1), TIMEOUT, RETRIES);
  ports.fake.dropFirst = 99;
  const second = await transfer.backup(ports, items.slice(1), TIMEOUT, RETRIES);

  assert.equal(first.collected.length > 0, true);
  assert.equal(second.collected.length, 0);
  assert.equal(second.failures.length, 1);
  assert.match(second.failures[0], /pattern A2/);
});

test('restore stops at the first refusal instead of carrying on', async () => {
  const device = seededDevice();
  const ports = fakePorts(device);
  const good = new protocol.NavaMessage(protocol.NAVA_PTRN_DMP, 0, seedPattern(0));
  // Track 99 is past MAX_TRACK, so the device answers ACK_BAD_PARAM.
  const bad = new protocol.NavaMessage(
    protocol.NAVA_TRACK_DMP,
    99,
    new Uint8Array(protocol.TRACK_BYTES),
  );

  const outcome = await transfer.restore(ports, [good, bad, good], TIMEOUT, 0);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0], /track 100/);
  // Only the first write landed: the loop stopped rather than skipping past it.
  assert.deepEqual(device.writes, [[protocol.NAVA_PTRN_DMP, 0]]);
});

test('a cancel between items leaves no half-written record', async () => {
  const device = seededDevice();
  const ports = fakePorts(device);
  const dumps = [0, 1, 2].map((n) => new protocol.NavaMessage(protocol.NAVA_PTRN_DMP, n, seedPattern(n)));

  let done = 0;
  const outcome = await transfer.restore(ports, dumps, TIMEOUT, RETRIES, {
    progress: () => {
      done += 1;
    },
    shouldStop: () => done >= 1,
  });

  assert.deepEqual(outcome.failures, ['cancelled']);
  assert.deepEqual(device.writes, [[protocol.NAVA_PTRN_DMP, 0]]);
});

test('flash paces pages and reports every one', async () => {
  const device = new FakeNava();
  const ports = fakePorts(device);
  const messages = Array.from({ length: 12 }, (_, i) =>
    Uint8Array.of(0xf0, 0x7d, 0x08, 0x08, 0x02, 0x7e, 0x00, i, 0xf7),
  );

  const seen = [];
  const before = performance.now();
  const outcome = await transfer.flash(ports, messages, 5, {
    progress: (done, total) => seen.push([done, total]),
  });
  const elapsed = performance.now() - before;

  assert.ok(outcome.ok);
  assert.equal(ports.fake.scheduled.length, 12);
  assert.equal(seen.at(-1)[0], 12, 'progress reaches the last page');

  // The spacing is enforced twice: each send carries its due time as a
  // timestamp, AND the loop waits in real time before handing the next page
  // over. The second is what flashes hardware - a queued window of timestamped
  // sends arrived as a burst through at least one browser/driver/dongle stack,
  // while the CLI's sleep pacing worked over the same dongle - so a regression
  // to queue-ahead scheduling must fail here.
  const stamps = ports.fake.scheduled.map((s) => s.timestamp);
  for (let i = 1; i < stamps.length; i += 1) {
    assert.equal(Math.round(stamps[i] - stamps[i - 1]), 5, `gap before page ${i}`);
  }
  assert.ok(
    elapsed >= (messages.length - 1) * 5 - 20,
    `12 pages at 5ms took ${elapsed.toFixed(1)}ms; pages are being queued ahead, not paced`,
  );
});

test('cancelling a flash flushes the queue and says so', async () => {
  const device = new FakeNava();
  const ports = fakePorts(device);
  const messages = Array.from({ length: 400 }, (_, i) =>
    Uint8Array.of(0xf0, 0x7d, 0x08, 0x08, 0x02, 0x7e, 0x00, i & 0x7f, 0xf7),
  );

  let ticks = 0;
  const outcome = await transfer.flash(ports, messages, 10, {
    progress: () => {
      ticks += 1;
    },
    shouldStop: () => ticks > 2,
  });

  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.failures, ['cancelled mid-flash']);
  assert.equal(ports.fake.cleared, 1, 'the scheduled window was flushed');
  assert.ok(ports.fake.scheduled.length < messages.length, 'stopped early');
});
