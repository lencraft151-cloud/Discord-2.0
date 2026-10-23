import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../server/app.js';

let app;
let base;
const sockets = [];

before(async () => {
  app = createApp();
  const port = await app.listen(0);
  base = `http://localhost:${port}`;
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  await app.close();
  app.httpServer.close();
});

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function register(username) {
  const { status, data } = await call('/auth/register', { method: 'POST', body: { username, password: 'geheim123' } });
  assert.equal(status, 200, data.error);
  return data;
}

function socketFor(token) {
  const socket = connect(base, { auth: { token }, transports: ['websocket'] });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const nextEvent = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

test('Registrierung und Anmeldung', async () => {
  const { user } = await register('anna');
  assert.equal(user.username, 'anna');

  assert.equal((await call('/auth/register', { method: 'POST', body: { username: 'ANNA', password: 'geheim123' } })).status, 409);
  assert.equal((await call('/auth/login', { method: 'POST', body: { username: 'anna', password: 'falsch!!' } })).status, 401);

  const login = await call('/auth/login', { method: 'POST', body: { username: 'anna', password: 'geheim123' } });
  assert.equal(login.status, 200);
  const me = await call('/me', { token: login.data.token });
  assert.equal(me.data.user.username, 'anna');
  assert.equal(me.data.discord.enabled, false);
  assert.equal(me.data.discord.login, false);
  assert.ok(Array.isArray(me.data.iceServers));

  assert.equal((await call('/me')).status, 401);
});

test('Server erstellen, per Code beitreten und in Echtzeit chatten', async () => {
  const owner = await register('ben');
  const guest = await register('carla');

  const { data: server } = await call('/servers', { token: owner.token, method: 'POST', body: { name: 'Gaming' } });
  assert.ok(server.inviteCode);

  // Ohne Mitgliedschaft kein Zugriff
  assert.equal((await call(`/servers/${server.id}/channels`, { token: guest.token })).status, 403);

  const join = await call('/servers/join', { token: guest.token, method: 'POST', body: { code: server.inviteCode } });
  assert.equal(join.data.serverId, server.id);

  const { data: channels } = await call(`/servers/${server.id}/channels`, { token: guest.token });
  assert.deepEqual(
    channels.map((c) => c.name),
    ['allgemein'],
  );

  const ownerSocket = await socketFor(owner.token);
  const guestSocket = await socketFor(guest.token);
  const received = nextEvent(ownerSocket, 'message:new');
  const ack = await guestSocket.emitWithAck('message:send', { channelId: channels[0].id, content: 'Hallo zusammen!' });
  assert.equal(ack.ok, true);
  const message = await received;
  assert.equal(message.content, 'Hallo zusammen!');
  assert.equal(message.author.username, 'carla');

  const { data: history } = await call(`/channels/${channels[0].id}/messages`, { token: owner.token });
  assert.deepEqual(
    history.map((m) => m.content),
    ['Hallo zusammen!'],
  );

  const empty = await guestSocket.emitWithAck('message:send', { channelId: channels[0].id, content: '   ' });
  assert.equal(empty.ok, false);
});

test('Direktnachrichten zwischen Nutzern', async () => {
  const a = await register('dora');
  const b = await register('emil');
  const { data: found } = await call('/users/search?q=emi', { token: a.token });
  assert.deepEqual(
    found.local.map((u) => u.username),
    ['emil'],
  );

  const { data: dm } = await call('/dms', { token: a.token, method: 'POST', body: { userId: b.user.id } });
  assert.equal(dm.name, 'emil');
  const { data: again } = await call('/dms', { token: b.token, method: 'POST', body: { userId: a.user.id } });
  assert.equal(again.id, dm.id, 'gleiche DM wird wiederverwendet');

  const socketB = await socketFor(b.token);
  const received = nextEvent(socketB, 'message:new');
  const res = await call(`/channels/${dm.id}/messages`, { token: a.token, method: 'POST', body: { content: 'Na?' } });
  assert.equal(res.status, 200);
  assert.equal((await received).content, 'Na?');

  // Dritte dürfen nicht mitlesen
  const c = await register('fritz');
  assert.equal((await call(`/channels/${dm.id}/messages`, { token: c.token })).status, 403);
});

test('Gespiegelte Discord-Server: entdecken, beitreten, Nachrichten empfangen', async () => {
  const { store, chat } = app;
  const user = await register('greta');

  const server = store.upsertGuild({ id: '111111111111111111', name: 'Echter Discord-Server' });
  const channel = store.upsertGuildChannel(server.id, { id: '222222222222222222', name: 'general', position: 0 });

  const { data: discover } = await call('/servers/discover', { token: user.token });
  assert.ok(discover.servers.some((s) => s.id === server.id && s.bridged && !s.joined));

  // Lokale Server kann man nicht ohne Code über die ID betreten
  const own = await call('/servers', { token: user.token, method: 'POST', body: { name: 'Privat' } });
  const other = await register('hans');
  assert.equal((await call('/servers/join', { token: other.token, method: 'POST', body: { serverId: own.data.id } })).status, 404);

  await call('/servers/join', { token: user.token, method: 'POST', body: { serverId: server.id } });
  const socket = await socketFor(user.token);
  const received = nextEvent(socket, 'message:new');
  chat.receiveFromDiscord(channel, {
    discordAuthor: { id: '333', username: 'DiscordFan', avatar: null },
    content: 'Hi aus Discord',
    discordMessageId: '444',
  });
  const message = await received;
  assert.equal(message.author.source, 'discord');
  assert.equal(message.author.username, 'DiscordFan');

  // Doppelte Discord-Nachrichten werden ignoriert
  assert.equal(chat.receiveFromDiscord(channel, { discordAuthor: { id: '333', username: 'x' }, content: 'dup', discordMessageId: '444' }), null);

  // Ohne verbundene Brücke kann man nicht in Discord-Kanäle schreiben
  const ack = await socket.emitWithAck('message:send', { channelId: channel.id, content: 'Hallo Discord' });
  assert.equal(ack.ok, false);
  assert.match(ack.error, /Brücke/);

  // Server verschwindet aus "Entdecken", wenn der Bot entfernt wird
  store.deactivateGuild('111111111111111111');
  const { data: after } = await call('/servers/discover', { token: user.token });
  assert.ok(!after.servers.some((s) => s.id === server.id));
});

test('Discord-DMs werden an das richtige Gespräch geleitet', async () => {
  const { store } = app;
  const a = await register('ida');
  const b = await register('jonas');
  const discordUser = { id: '555555555555555555', username: 'Kim', avatar: null };
  const dmA = store.openDiscordDm(a.user.id, discordUser);
  const dmB = store.openDiscordDm(b.user.id, discordUser);
  assert.notEqual(dmA.id, dmB.id);

  store.rememberDmRoute('m1', discordUser.id, dmA.id);
  store.rememberDmRoute('m2', discordUser.id, dmB.id);
  assert.equal(store.routeDiscordDm(discordUser.id, 'm1').id, dmA.id, 'Antwort auf m1 geht an ida');
  assert.equal(store.routeDiscordDm(discordUser.id, null).id, dmB.id, 'ohne Reply an das letzte Gespräch');
  assert.equal(store.routeDiscordDm('999', null), null);
});

test('Nachrichten an Discord weiterleiten (mit Test-Brücke)', async () => {
  const { store, chat } = app;
  const user = await register('lena');
  const server = store.upsertGuild({ id: '777777777777777777', name: 'Brücken-Test' });
  const channel = store.upsertGuildChannel(server.id, { id: '888888888888888888', name: 'chat', position: 0 });
  await call('/servers/join', { token: user.token, method: 'POST', body: { serverId: server.id } });

  const relayed = [];
  let fail = false;
  chat.setBridge({
    ready: true,
    relay: async (row, author, content) => {
      if (fail) throw new Error('kaputt');
      relayed.push({ channel: row.discord_channel_id, author: author.username, content });
      return 'discord-msg-1';
    },
    describeError: (err) => err.message,
    inviteUrl: () => 'https://discord.com/oauth2/authorize?client_id=1',
    listGuildMembers: async () => [],
    searchUsers: async () => [],
    backfill: async () => {},
  });
  try {
    const ok = await call(`/channels/${channel.id}/messages`, { token: user.token, method: 'POST', body: { content: 'Hallo Discord!' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(relayed, [{ channel: '888888888888888888', author: 'lena', content: 'Hallo Discord!' }]);
    // Das spätere Discord-Echo derselben Nachricht wird nicht doppelt gespeichert
    assert.equal(chat.receiveFromDiscord(store.getChannel(channel.id), { discordAuthor: { id: '1', username: 'lena (D2)' }, content: 'Hallo Discord!', discordMessageId: 'discord-msg-1' }), null);

    fail = true;
    const failed = await call(`/channels/${channel.id}/messages`, { token: user.token, method: 'POST', body: { content: 'geht nicht' } });
    assert.equal(failed.status, 502);
    const { data: history } = await call(`/channels/${channel.id}/messages`, { token: user.token });
    assert.deepEqual(
      history.map((m) => m.content),
      ['Hallo Discord!'],
      'fehlgeschlagene Nachricht wird wieder entfernt',
    );
  } finally {
    chat.setBridge(null);
  }
});
