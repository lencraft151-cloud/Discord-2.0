import express from 'express';
import { HttpError } from './store.js';

export function createApi({ store, chat, voice, oauth }) {
  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));

  const route = (fn) => async (req, res, next) => {
    try {
      const result = await fn(req, res);
      if (result !== undefined) res.json(result);
    } catch (err) {
      next(err);
    }
  };

  const bridgeInfo = () => {
    const bridge = chat.bridge;
    const ready = Boolean(bridge?.ready);
    return {
      enabled: Boolean(bridge),
      ready,
      login: Boolean(oauth),
      inviteUrl: ready ? bridge.inviteUrl() : null,
      userInstallUrl: ready ? bridge.userInstallUrl() : null,
    };
  };

  // ---------- Anmeldung ----------

  api.get('/config', (req, res) => res.json({ discordLogin: Boolean(oauth) }));

  api.post(
    '/auth/register',
    route((req) => {
      const user = store.register(req.body?.username, req.body?.password);
      return { token: store.createSession(user.id), user };
    }),
  );

  api.post(
    '/auth/login',
    route((req) => {
      const user = store.login(req.body?.username, req.body?.password);
      return { token: store.createSession(user.id), user };
    }),
  );

  api.use((req, res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer /, '');
    req.user = store.userByToken(token);
    req.token = token;
    if (!req.user) return next(new HttpError(401, 'Nicht angemeldet'));
    next();
  });

  api.post(
    '/auth/logout',
    route((req) => {
      store.deleteSession(req.token);
      return { ok: true };
    }),
  );

  api.get(
    '/me',
    route((req) => ({ user: req.user, discord: bridgeInfo(), iceServers: voice.iceServers })),
  );

  // ---------- Discord-Konto ----------

  const requireOAuth = () => {
    if (!oauth) throw new HttpError(503, 'Die Anmeldung mit Discord ist auf diesem Server nicht eingerichtet');
  };

  api.post(
    '/discord/link',
    route((req) => {
      requireOAuth();
      return { url: oauth.authorizeUrl(req.user.id) };
    }),
  );

  // Deine eigenen Discord-Server: beitreten, wenn der Bot dort ist, sonst Bot hinzufügen.
  api.get(
    '/discord/guilds',
    route(async (req) => {
      requireOAuth();
      const bridge = chat.bridge?.ready ? chat.bridge : null;
      const guilds = await oauth.listGuilds(req.user.id);
      return guilds
        .map((guild) => {
          const server = store.serverByGuild(guild.id);
          const connected = Boolean(server?.active && bridge?.hasGuild(guild.id));
          return {
            ...guild,
            serverId: connected ? server.id : null,
            joined: connected && store.isMember(server.id, req.user.id),
            inviteUrl: !connected && guild.canManage && bridge ? bridge.inviteUrl(guild.id) : null,
          };
        })
        .sort((a, b) => Number(Boolean(b.serverId)) - Number(Boolean(a.serverId)) || a.name.localeCompare(b.name));
    }),
  );

  // ---------- Server ----------

  const requireMember = (req) => {
    const serverId = Number(req.params.id);
    if (!store.isMember(serverId, req.user.id)) throw new HttpError(403, 'Du bist kein Mitglied dieses Servers');
    return serverId;
  };

  api.get(
    '/servers',
    route((req) => store.listServers(req.user.id)),
  );

  api.post(
    '/servers',
    route((req) => {
      const server = store.createServer(req.user.id, req.body?.name);
      chat.joinServerRoom(req.user.id, server.id);
      chat.serversChanged([req.user.id]);
      return server;
    }),
  );

  api.get(
    '/servers/discover',
    route((req) => ({ servers: store.discoverServers(req.user.id), discord: bridgeInfo() })),
  );

  api.post(
    '/servers/join',
    route((req) => {
      const serverId = req.body?.code
        ? store.joinByInvite(req.user.id, req.body.code)
        : store.joinBridged(req.user.id, Number(req.body?.serverId));
      chat.joinServerRoom(req.user.id, serverId);
      chat.serversChanged([req.user.id]);
      return { serverId };
    }),
  );

  api.delete(
    '/servers/:id/membership',
    route((req) => {
      const serverId = requireMember(req);
      store.leaveServer(req.user.id, serverId);
      chat.leaveServerRoom(req.user.id, serverId);
      chat.serversChanged([req.user.id]);
      return { ok: true };
    }),
  );

  const withVoice = (channel) => (channel.type === 'voice' ? { ...channel, voice: voice.stateFor(channel.id) } : channel);

  api.get(
    '/servers/:id/channels',
    route((req) => store.listChannels(requireMember(req)).map(withVoice)),
  );

  api.post(
    '/servers/:id/channels',
    route((req) => {
      const serverId = requireMember(req);
      const server = store.getServer(serverId);
      if (server.discord_guild_id) throw new HttpError(400, 'Kanäle von Discord-Servern werden auf Discord verwaltet');
      const channel = store.createChannel(req.user.id, serverId, req.body?.name, req.body?.type ?? 'text');
      chat.channelsChanged(serverId);
      return channel;
    }),
  );

  api.get(
    '/servers/:id/members',
    route(async (req) => {
      const serverId = requireMember(req);
      const server = store.getServer(serverId);
      const local = store.listMembers(serverId).map((u) => ({ ...u, online: chat.isOnline(u.id) }));
      const discord =
        server.discord_guild_id && chat.bridge?.ready ? await chat.bridge.listGuildMembers(server.discord_guild_id) : [];
      return { local, discord };
    }),
  );

  // ---------- Kanäle & Nachrichten ----------

  api.get(
    '/channels/:id/messages',
    route(async (req) => {
      const channel = store.getChannel(Number(req.params.id));
      if (!store.canAccess(req.user.id, channel)) throw new HttpError(403, 'Kein Zugriff auf diesen Kanal');
      // Beim ersten Öffnen eines Discord-Kanals den bisherigen Verlauf nachladen.
      if (channel.discord_channel_id && !channel.backfilled && !req.query.before && chat.bridge?.ready) {
        await chat.bridge.backfill(channel).catch((err) => console.warn('[discord] Verlauf laden fehlgeschlagen:', err.message));
      }
      if (channel.type === 'voice') return [];
      return store.listMessages(channel.id, { before: Number(req.query.before) || null, limit: req.query.limit });
    }),
  );

  api.post(
    '/channels/:id/messages',
    route((req) => chat.sendMessage(req.user, req.params.id, req.body?.content)),
  );

  // ---------- Direktnachrichten ----------

  api.get(
    '/dms',
    route((req) => store.listDms(req.user.id).map((dm) => ({ ...dm, voice: voice.stateFor(dm.id) }))),
  );

  api.post(
    '/dms',
    route(async (req) => {
      if (req.body?.discordUserId) {
        // Hat die Person ein mit Discord verknüpftes Konto hier, direkt dort schreiben.
        const linked = store.userByDiscordId(String(req.body.discordUserId));
        if (linked && linked.id !== req.user.id) return store.openDm(req.user.id, linked.id);
        if (!chat.bridge?.ready) throw new HttpError(503, 'Die Discord-Brücke ist nicht verbunden');
        const discordUser = await chat.bridge.fetchUser(String(req.body.discordUserId));
        if (!discordUser) throw new HttpError(404, 'Discord-Nutzer nicht gefunden');
        return store.openDiscordDm(req.user.id, discordUser);
      }
      return store.openDm(req.user.id, Number(req.body?.userId));
    }),
  );

  api.get(
    '/users/search',
    route(async (req) => {
      const query = String(req.query.q ?? '').trim();
      if (!query) return { local: [], discord: [] };
      const local = store.searchUsers(query, req.user.id);
      const discord = chat.bridge?.ready ? await chat.bridge.searchUsers(query) : [];
      return { local, discord };
    }),
  );

  api.use((req, res, next) => next(new HttpError(404, 'Nicht gefunden')));

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (!(err instanceof HttpError)) {
      if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Ungültiges JSON');
      else {
        console.error(err);
        err = new HttpError(500, 'Interner Serverfehler');
      }
    }
    res.status(err.status).json({ error: err.message });
  });

  return api;
}
