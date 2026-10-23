import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameMixer, discordToWeb, mixFrames, toWebFrame, webToDiscord, DISCORD_FRAME_BYTES, WEB_FRAME_BYTES } from '../server/audio.js';

const frame = (value) => new Int16Array(480).fill(value);

test('Browser-Frames werden für Discord hoch- und zurückgerechnet', () => {
  const discord = webToDiscord(frame(1000));
  assert.equal(discord.length, DISCORD_FRAME_BYTES);
  assert.equal(discord.readInt16LE(0), 1000);
  assert.equal(discord.readInt16LE(2), 1000, 'rechter Kanal');
  assert.deepEqual([...discordToWeb(discord)].slice(0, 5), [1000, 1000, 1000, 1000, 1000]);
});

test('Mischen begrenzt auf 16 Bit', () => {
  assert.equal(mixFrames([frame(20000), frame(20000)])[0], 32767);
  assert.equal(mixFrames([frame(-20000), frame(-20000)])[0], -32768);
  assert.equal(mixFrames([frame(100), frame(-50)])[0], 50);
});

test('Ungültige oder unausgerichtete Frames', () => {
  assert.equal(toWebFrame('kaputt'), null);
  assert.equal(toWebFrame(Buffer.alloc(10)), null);
  const unaligned = Buffer.alloc(WEB_FRAME_BYTES + 1).subarray(1);
  unaligned.writeInt16LE(1234, 0);
  assert.equal(toWebFrame(unaligned)[0], 1234);
});

test('FrameMixer mischt pro Takt und begrenzt den Rückstand', () => {
  const mixer = new FrameMixer({ maxQueue: 4 });
  mixer.push('a', frame(1));
  mixer.push('b', frame(2));
  assert.equal(mixer.next()[0], 3);
  assert.equal(mixer.next(), null);
  for (let i = 0; i < 10; i++) mixer.push('a', frame(i));
  assert.ok(mixer.queues.get('a').length <= 4);
});
