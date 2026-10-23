import { randomBytes } from 'node:crypto';
import express from 'express';
import { HttpError } from './store.js';

const API = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds';
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

export function discordAvatarUrl(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}

// "Mit Discord anmelden" (OAuth2). Discord bestätigt nur, wer jemand ist und auf
// welchen Servern er ist; Nachrichten im Namen des Kontos schickt Discord 2.0 nie.
export function createDiscordOAuth({ store, clientId, clientSecret, publicUrl, fetch = globalThis.fetch }) {
  const redirectUri = `${publicUrl}/auth/discord/callback`;
  const pending = new Map(); // state -> { linkUserId, expires }

  async function discordFetch(path, options = {}) {
    const res = await fetch(`${API}${path}`, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new HttpError(res.status === 401 ? 401 : 502, data.error_description || data.message || `Discord-Fehler ${res.status}`);
      err.discordStatus = res.status;
      throw err;
    }
    return data;
  }

  function tokenRequest(params) {
    return discordFetch('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    }).then((data) => ({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    }));
  }

  function authorizeUrl(linkUserId = null) {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expires < now) pending.delete(key);
    const state = randomBytes(16).toString('hex');
    pending.set(state, { linkUserId, expires: now + 10 * 60 * 1000 });
    const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, state, prompt: 'none' });
    return `https://discord.com/oauth2/authorize?${query}`;
  }

  async function validTokens(userId) {
    const tokens = store.getDiscordTokens(userId);
    if (!tokens) throw new HttpError(400, 'Dein Konto ist nicht mit Discord verbunden');
    if (tokens.expiresAt && tokens.expiresAt - 60_000 > Date.now()) return tokens;
    if (!tokens.refreshToken) throw new HttpError(401, 'Bitte verbinde Discord erneut');
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    store.saveDiscordTokens(userId, fresh);
    return fresh;
  }

  // Die Discord-Server des Nutzers (laut Discord), inkl. ob er dort den Bot hinzufügen darf.
  async function listGuilds(userId) {
    const { accessToken } = await validTokens(userId);
    const guilds = await discordFetch('/users/@me/guilds', { headers: { Authorization: `Bearer ${accessToken}` } });
    return guilds.map((g) => {
      const permissions = BigInt(g.permissions ?? 0);
      return {
        id: g.id,
        name: g.name,
        iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null,
        canManage: Boolean(g.owner || permissions & MANAGE_GUILD || permissions & ADMINISTRATOR),
      };
    });
  }

  const router = express.Router();

  router.get('/auth/discord', (req, res) => res.redirect(authorizeUrl()));

  router.get('/auth/discord/callback', async (req, res) => {
    const fail = (message) => res.redirect(`/#auth_error=${encodeURIComponent(message)}`);
    const entry = pending.get(String(req.query.state ?? ''));
    pending.delete(String(req.query.state ?? ''));
    if (req.query.error) return fail('Anmeldung bei Discord abgebrochen');
    if (!entry || entry.expires < Date.now() || !req.query.code) return fail('Anmeldung abgelaufen, bitte erneut versuchen');
    try {
      const tokens = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri });
      const me = await discordFetch('/users/@me', { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
      const discordUser = { id: me.id, username: me.username, avatar: discordAvatarUrl(me) };
      if (entry.linkUserId) {
        store.linkDiscord(entry.linkUserId, discordUser, tokens);
        return res.redirect('/#discord_linked');
      }
      const user = store.loginWithDiscord(discordUser, tokens);
      res.redirect(`/#login=${store.createSession(user.id)}`);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      fail(err instanceof HttpError ? err.message : 'Anmeldung mit Discord fehlgeschlagen');
    }
  });

  return { router, authorizeUrl, listGuilds };
}
