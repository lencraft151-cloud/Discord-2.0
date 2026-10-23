import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

// Nachgebaute Discord-API für den OAuth-Ablauf.
function fakeDiscord() {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/oauth2/token')) {
      const body = new URLSearchParams(options.body);
      if (body.get('code') === 'bad') return json({ error_description: 'Ungültiger Code' }, 400);
      return json({ access_token: `token-${body.get('code') ?? 'refresh'}`, refresh_token: 'r1', expires_in: 3600 });
    }
    if (url.endsWith('/users/@me')) {
      const token = options.headers.Authorization;
      return json(token === 'Bearer token-c2' ? { id: '222222222222222222', username: 'linker', avatar: null } : { id: '111111111111111111', username: 'discordfan', avatar: 'abc' });
    }
    if (url.endsWith('/users/@me/guilds')) {
      return json([
        { id: '500000000000000001', name: 'Mein Server', icon: null, owner: true, permissions: '0' },
        { id: '500000000000000002', name: 'Fremder Server', icon: null, owner: false, permissions: '1024' },
      ]);
    }
    return json({ message: 'unbekannt' }, 404);
  };
  return { fetch, calls };
}

let t;
let discord;
before(async () => {
  discord = fakeDiscord();
  t = await startTestApp({ discordClientId: 'cid', discordClientSecret: 'secret', publicUrl: 'http://d2.test', fetch: discord.fetch });
});
after(() => t.close());

async function startLogin() {
  const res = await t.call('/auth/discord', { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin, 'https://discord.com');
  assert.equal(location.searchParams.get('redirect_uri'), 'http://d2.test/auth/discord/callback');
  return location.searchParams.get('state');
}

test('Mit Discord anmelden legt ein Konto an und meldet beim zweiten Mal dasselbe Konto an', async () => {
  assert.deepEqual((await t.call('/config')).data, { discordLogin: true });

  const state = await startLogin();
  const res = await t.call(`/auth/discord/callback?code=c1&state=${state}`, { redirect: 'manual' });
  const token = res.headers.get('location').match(/#login=(\w+)/)?.[1];
  assert.ok(token, res.headers.get('location'));

  const { data: me } = await t.call('/me', { token });
  assert.equal(me.user.username, 'discordfan');
  assert.equal(me.user.discordLinked, true);
  assert.equal(me.user.avatar, 'https://cdn.discordapp.com/avatars/111111111111111111/abc.png?size=128');

  const again = await t.call(`/auth/discord/callback?code=c1&state=${await startLogin()}`, { redirect: 'manual' });
  const token2 = again.headers.get('location').match(/#login=(\w+)/)[1];
  assert.equal((await t.call('/me', { token: token2 })).data.user.id, me.user.id);

  // Ein State gilt nur einmal
  const replay = await t.call(`/auth/discord/callback?code=c1&state=${state}`, { redirect: 'manual' });
  assert.match(replay.headers.get('location'), /auth_error/);
});

test('Fehler von Discord landen als Meldung auf der Startseite', async () => {
  const res = await t.call(`/auth/discord/callback?code=bad&state=${await startLogin()}`, { redirect: 'manual' });
  assert.match(decodeURIComponent(res.headers.get('location')), /#auth_error=Ungültiger Code/);
});

test('Bestehendes Konto mit Discord verbinden und eigene Discord-Server sehen', async () => {
  const { token } = await t.register('lokal');
  const { data } = await t.call('/discord/link', { token, method: 'POST' });
  const state = new URL(data.url).searchParams.get('state');
  const res = await t.call(`/auth/discord/callback?code=c2&state=${state}`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/#discord_linked');

  const { data: me } = await t.call('/me', { token });
  assert.equal(me.user.discordLinked, true);

  const { data: guilds } = await t.call('/discord/guilds', { token });
  assert.deepEqual(
    guilds.map((g) => [g.name, g.canManage, g.serverId]),
    [
      ['Fremder Server', false, null],
      ['Mein Server', true, null],
    ],
  );

  // Dasselbe Discord-Konto kann nicht an ein zweites Konto gehängt werden
  const other = await t.register('zweiter');
  const link2 = await t.call('/discord/link', { token: other.token, method: 'POST' });
  const res2 = await t.call(`/auth/discord/callback?code=c2&state=${new URL(link2.data.url).searchParams.get('state')}`, { redirect: 'manual' });
  assert.match(decodeURIComponent(res2.headers.get('location')), /schon mit einem anderen Konto/);
});

test('DM an einen Discord-Nutzer mit verknüpftem Konto wird zur normalen DM', async () => {
  const { token } = await t.register('sucher');
  const { data: dm } = await t.call('/dms', { token, method: 'POST', body: { discordUserId: '111111111111111111' } });
  assert.equal(dm.recipient.source, 'local');
  assert.equal(dm.name, 'discordfan');
});
