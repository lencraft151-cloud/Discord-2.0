import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, nextEvent } from './helpers.js';

let t;
before(async () => (t = await startTestApp()));
after(() => t.close());

test('Sprachkanal: beitreten, WebRTC-Signale weiterreichen, Status, verlassen', async () => {
  const owner = await t.register('vera');
  const guest = await t.register('willi');
  const { data: server } = await t.call('/servers', { token: owner.token, method: 'POST', body: { name: 'Talk' } });
  await t.call('/servers/join', { token: guest.token, method: 'POST', body: { code: server.inviteCode } });
  const { data: channel, status } = await t.call(`/servers/${server.id}/channels`, {
    token: owner.token,
    method: 'POST',
    body: { name: 'Quatschen', type: 'voice' },
  });
  assert.equal(status, 200);
  assert.equal(channel.type, 'voice');

  const a = await t.socketFor(owner.token);
  const b = await t.socketFor(guest.token);

  const first = await a.emitWithAck('voice:join', { channelId: channel.id });
  assert.equal(first.ok, true);
  assert.deepEqual(first.peers, []);
  assert.ok(first.iceServers.length > 0);

  const joinedEvent = nextEvent(a, 'voice:peer-joined');
  const stateEvent = nextEvent(a, 'voice:state', (st) => st.participants.length === 2);
  const second = await b.emitWithAck('voice:join', { channelId: channel.id });
  assert.deepEqual(
    second.peers.map((p) => p.user.username),
    ['vera'],
  );
  assert.equal((await joinedEvent).user.username, 'willi');
  await stateEvent;

  // Kanalliste zeigt, wer drin ist
  const { data: channels } = await t.call(`/servers/${server.id}/channels`, { token: owner.token });
  assert.equal(channels.find((c) => c.id === channel.id).voice.participants.length, 2);

  const signal = nextEvent(a, 'voice:signal');
  b.emit('voice:signal', { to: a.id, data: { description: { type: 'offer', sdp: 'x' } } });
  assert.deepEqual(await signal, { from: b.id, data: { description: { type: 'offer', sdp: 'x' } } });

  const muted = nextEvent(a, 'voice:state', (st) => st.participants.some((p) => p.user.username === 'willi' && p.muted));
  b.emit('voice:update', { muted: true });
  await muted;

  const left = nextEvent(a, 'voice:peer-left');
  b.emit('voice:leave');
  assert.equal((await left).socketId, b.id);
});

test('Fremde dürfen nicht in Sprachkanäle und bekommen keine Signale', async () => {
  const owner = await t.register('xaver');
  const stranger = await t.register('yasmin');
  const { data: server } = await t.call('/servers', { token: owner.token, method: 'POST', body: { name: 'Privat' } });
  const { data: channel } = await t.call(`/servers/${server.id}/channels`, { token: owner.token, method: 'POST', body: { name: 'geheim', type: 'voice' } });
  const s = await t.socketFor(stranger.token);
  const res = await s.emitWithAck('voice:join', { channelId: channel.id });
  assert.equal(res.ok, false);

  // Textkanäle sind keine Anrufräume
  const { data: text } = await t.call(`/servers/${server.id}/channels`, { token: owner.token });
  const o = await t.socketFor(owner.token);
  assert.equal((await o.emitWithAck('voice:join', { channelId: text.find((c) => c.type === 'text').id })).ok, false);
});

test('Direktanruf klingelt beim anderen und endet, wenn aufgelegt wird', async () => {
  const a = await t.register('zora');
  const b = await t.register('anton');
  const { data: dm } = await t.call('/dms', { token: a.token, method: 'POST', body: { userId: b.user.id } });
  const sa = await t.socketFor(a.token);
  const sb = await t.socketFor(b.token);

  const ring = nextEvent(sb, 'voice:ring');
  assert.equal((await sa.emitWithAck('voice:join', { channelId: dm.id })).ok, true);
  const { channelId, from } = await ring;
  assert.equal(channelId, dm.id);
  assert.equal(from.username, 'zora');

  const declined = nextEvent(sa, 'voice:declined');
  sb.emit('voice:decline', { channelId: dm.id });
  assert.equal((await declined).username, 'anton');

  const ended = nextEvent(sb, 'voice:ring-end');
  sa.emit('voice:leave');
  assert.equal((await ended).channelId, dm.id);
});

test('Discord-Sprachkanal: Bot-Verbindung, Audio in beide Richtungen', async () => {
  const { store, chat } = t.app;
  const user = await t.register('bruno');
  const server = store.upsertGuild({ id: '900000000000000001', name: 'Voice-Guild' });
  const channel = store.upsertGuildChannel(server.id, { id: '900000000000000002', name: 'Lounge', type: 'voice' });
  await t.call('/servers/join', { token: user.token, method: 'POST', body: { serverId: server.id } });

  const pushed = [];
  let session;
  chat.setBridge({
    ready: true,
    voiceMembers: () => [{ id: '42', username: 'DiscordDora', avatar: null, muted: false, deafened: false }],
    joinVoice: (row, { onAudio, onEnd }) => {
      session = { onAudio, onEnd, destroyed: false };
      return {
        ready: Promise.resolve(),
        pushWeb: (key, frame) => pushed.push(frame[0]),
        removeWeb: () => {},
        destroy: () => (session.destroyed = true),
      };
    },
  });
  try {
    const s = await t.socketFor(user.token);
    const joined = await s.emitWithAck('voice:join', { channelId: channel.id });
    assert.equal(joined.ok, true);
    assert.equal(joined.bridged, true);

    // Browser -> Discord
    const frame = new Int16Array(480).fill(777);
    s.emit('voice:pcm', Buffer.from(frame.buffer));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(pushed, [777]);

    // Discord -> Browser
    const audio = nextEvent(s, 'voice:audio');
    session.onAudio(new Int16Array(480).fill(-5));
    const received = await audio;
    assert.equal(new Int16Array(new Uint8Array(received).buffer)[0], -5);

    // Stummgeschaltet: nichts mehr an Discord
    s.emit('voice:update', { muted: true });
    s.emit('voice:pcm', Buffer.from(frame.buffer));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pushed.length, 1);

    const stateEvent = nextEvent(s, 'voice:state', (st) => st.channelId === channel.id);
    s.emit('voice:update', { muted: false });
    assert.equal((await stateEvent).discord[0].username, 'DiscordDora');

    s.emit('voice:leave');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(session.destroyed, true, 'Bot verlässt den Kanal, wenn niemand mehr da ist');
  } finally {
    chat.setBridge(null);
  }
});
