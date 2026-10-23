import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { transaction } from './db.js';

const COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c'];
const USERNAME_RE = /^[\p{L}\p{N}_.-]{2,32}$/u;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

function inviteCode() {
  return randomBytes(6).toString('base64url');
}

export function createStore(db) {
  const now = () => Date.now();
  const q = (sql) => db.prepare(sql);

  // ---------- Nutzer & Sitzungen ----------

  function publicUser(row) {
    return row && { id: row.id, username: row.username, color: row.color };
  }

  function register(username, password) {
    username = String(username ?? '').trim();
    password = String(password ?? '');
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Benutzername: 2–32 Zeichen, nur Buchstaben, Zahlen, _ . -');
    }
    if (password.length < 6) throw new HttpError(400, 'Passwort muss mindestens 6 Zeichen haben');
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new HttpError(409, 'Benutzername ist bereits vergeben');
    }
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const { lastInsertRowid } = q(
      'INSERT INTO users (username, password_hash, color, created_at) VALUES (?, ?, ?, ?)',
    ).run(username, hashPassword(password), color, now());
    return getUser(Number(lastInsertRowid));
  }

  function login(username, password) {
    const row = q('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim());
    if (!row || !checkPassword(String(password ?? ''), row.password_hash)) {
      throw new HttpError(401, 'Benutzername oder Passwort falsch');
    }
    return publicUser(row);
  }

  function createSession(userId) {
    const token = randomBytes(32).toString('hex');
    q('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now());
    return token;
  }

  function deleteSession(token) {
    q('DELETE FROM sessions WHERE token = ?').run(token);
  }

  function userByToken(token) {
    if (!token) return null;
    return publicUser(
      q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token),
    );
  }

  function getUser(id) {
    return publicUser(q('SELECT * FROM users WHERE id = ?').get(id));
  }

  function searchUsers(query, excludeId) {
    return q(
      `SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' AND id != ? ORDER BY username LIMIT 20`,
    )
      .all(`%${String(query).replace(/[\\%_]/g, '\\$&')}%`, excludeId)
      .map(publicUser);
  }

  // ---------- Server ----------

  function serializeServer(row, userId) {
    return {
      id: row.id,
      name: row.name,
      iconUrl: row.icon_url,
      bridged: row.discord_guild_id != null,
      active: Boolean(row.active),
      inviteCode: row.owner_id === userId ? row.invite_code : undefined,
      isOwner: row.owner_id === userId,
      memberCount: row.member_count,
    };
  }

  const SERVER_COLUMNS = `s.*, (SELECT COUNT(*) FROM members m2 WHERE m2.server_id = s.id) AS member_count`;

  function getServer(id) {
    return q('SELECT * FROM servers WHERE id = ?').get(id);
  }

  function listServers(userId) {
    return q(
      `SELECT ${SERVER_COLUMNS} FROM servers s JOIN members m ON m.server_id = s.id
       WHERE m.user_id = ? ORDER BY m.joined_at`,
    )
      .all(userId)
      .map((row) => serializeServer(row, userId));
  }

  function createServer(userId, name) {
    name = String(name ?? '').trim();
    if (!name || name.length > 100) throw new HttpError(400, 'Servername: 1–100 Zeichen');
    const serverId = transaction(db, () => {
      const id = Number(
        q('INSERT INTO servers (name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?)').run(
          name,
          userId,
          inviteCode(),
          now(),
        ).lastInsertRowid,
      );
      q(`INSERT INTO channels (server_id, type, name, created_at) VALUES (?, 'text', 'allgemein', ?)`).run(
        id,
        now(),
      );
      q('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, userId, now());
      return id;
    });
    return serializeServer(q(`SELECT ${SERVER_COLUMNS} FROM servers s WHERE id = ?`).get(serverId), userId);
  }

  function addMember(serverId, userId) {
    q('INSERT OR IGNORE INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(
      serverId,
      userId,
      now(),
    );
  }

  function joinByInvite(userId, code) {
    const server = q('SELECT * FROM servers WHERE invite_code = ?').get(String(code ?? '').trim());
    if (!server) throw new HttpError(404, 'Einladung ungültig');
    addMember(server.id, userId);
    return server.id;
  }

  // Gespiegelten Discord-Servern darf jeder beitreten: ein Admin hat den Bot
  // dort eingeladen und den Server damit für Discord 2.0 freigegeben.
  function joinBridged(userId, serverId) {
    const server = getServer(serverId);
    if (!server || server.discord_guild_id == null || !server.active) {
      throw new HttpError(404, 'Server nicht gefunden');
    }
    addMember(server.id, userId);
    return server.id;
  }

  function leaveServer(userId, serverId) {
    const server = getServer(serverId);
    if (!server) throw new HttpError(404, 'Server nicht gefunden');
    if (server.owner_id === userId) throw new HttpError(400, 'Der Besitzer kann seinen Server nicht verlassen');
    q('DELETE FROM members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  }

  function isMember(serverId, userId) {
    return Boolean(q('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId));
  }

  function memberIds(serverId) {
    return q('SELECT user_id FROM members WHERE server_id = ?')
      .all(serverId)
      .map((r) => r.user_id);
  }

  function serverIdsForUser(userId) {
    return q('SELECT server_id FROM members WHERE user_id = ?')
      .all(userId)
      .map((r) => r.server_id);
  }

  function listMembers(serverId) {
    return q(
      `SELECT u.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? ORDER BY u.username`,
    )
      .all(serverId)
      .map(publicUser);
  }

  function discoverServers(userId) {
    return q(
      `SELECT ${SERVER_COLUMNS} FROM servers s
       WHERE s.discord_guild_id IS NOT NULL AND s.active = 1 ORDER BY s.name`,
    )
      .all()
      .map((row) => ({ ...serializeServer(row, userId), joined: isMember(row.id, userId) }));
  }

  // ---------- Kanäle ----------

  function serializeChannel(row) {
    return {
      id: row.id,
      serverId: row.server_id,
      type: row.type,
      name: row.name,
      bridged: row.discord_channel_id != null,
    };
  }

  function getChannel(id) {
    return q('SELECT * FROM channels WHERE id = ?').get(id);
  }

  function listChannels(serverId) {
    return q(
      `SELECT * FROM channels WHERE server_id = ? AND type = 'text' AND active = 1 ORDER BY position, id`,
    )
      .all(serverId)
      .map(serializeChannel);
  }

  function createChannel(userId, serverId, name) {
    const server = getServer(serverId);
    if (!server || server.owner_id !== userId) {
      throw new HttpError(403, 'Nur der Besitzer kann Kanäle erstellen');
    }
    name = String(name ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-');
    if (!name || name.length > 100) throw new HttpError(400, 'Kanalname: 1–100 Zeichen');
    const id = Number(
      q(`INSERT INTO channels (server_id, type, name, created_at) VALUES (?, 'text', ?, ?)`).run(
        serverId,
        name,
        now(),
      ).lastInsertRowid,
    );
    return serializeChannel(getChannel(id));
  }

  function dmParticipantIds(channelId) {
    return q('SELECT user_id FROM dm_participants WHERE channel_id = ?')
      .all(channelId)
      .map((r) => r.user_id);
  }

  function canAccess(userId, channel) {
    if (!channel || !channel.active) return false;
    if (channel.type === 'dm') return dmParticipantIds(channel.id).includes(userId);
    return isMember(channel.server_id, userId);
  }

  // ---------- Direktnachrichten ----------

  function serializeDm(row, userId) {
    if (row.discord_user_id) {
      return {
        id: row.id,
        type: 'dm',
        name: row.name,
        recipient: { source: 'discord', id: row.discord_user_id, username: row.name, avatar: row.discord_avatar },
      };
    }
    const other = q(
      `SELECT u.* FROM dm_participants p JOIN users u ON u.id = p.user_id WHERE p.channel_id = ? AND p.user_id != ?`,
    ).get(row.id, userId);
    return {
      id: row.id,
      type: 'dm',
      name: other?.username ?? 'Unbekannt',
      recipient: other ? { source: 'local', ...publicUser(other) } : null,
    };
  }

  function listDms(userId) {
    return q(
      `SELECT c.*, (SELECT MAX(created_at) FROM messages WHERE channel_id = c.id) AS last_at
       FROM channels c JOIN dm_participants p ON p.channel_id = c.id
       WHERE p.user_id = ? AND c.type = 'dm'
       ORDER BY COALESCE(last_at, c.created_at) DESC`,
    )
      .all(userId)
      .map((row) => serializeDm(row, userId));
  }

  function openDm(userId, otherUserId) {
    if (userId === otherUserId) throw new HttpError(400, 'Du kannst dir nicht selbst schreiben');
    if (!getUser(otherUserId)) throw new HttpError(404, 'Nutzer nicht gefunden');
    const existing = q(
      `SELECT c.* FROM channels c
       JOIN dm_participants a ON a.channel_id = c.id AND a.user_id = ?
       JOIN dm_participants b ON b.channel_id = c.id AND b.user_id = ?
       WHERE c.type = 'dm' AND c.discord_user_id IS NULL`,
    ).get(userId, otherUserId);
    if (existing) return serializeDm(existing, userId);
    const id = transaction(db, () => {
      const id = Number(
        q(`INSERT INTO channels (type, name, created_at) VALUES ('dm', '', ?)`).run(now()).lastInsertRowid,
      );
      q('INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?), (?, ?)').run(id, userId, id, otherUserId);
      return id;
    });
    return serializeDm(getChannel(id), userId);
  }

  function openDiscordDm(userId, discordUser) {
    const existing = q(
      `SELECT c.* FROM channels c JOIN dm_participants p ON p.channel_id = c.id
       WHERE c.discord_user_id = ? AND p.user_id = ?`,
    ).get(discordUser.id, userId);
    if (existing) {
      q('UPDATE channels SET name = ?, discord_avatar = ? WHERE id = ?').run(
        discordUser.username,
        discordUser.avatar ?? null,
        existing.id,
      );
      return serializeDm(getChannel(existing.id), userId);
    }
    const id = transaction(db, () => {
      const id = Number(
        q(
          `INSERT INTO channels (type, name, discord_user_id, discord_avatar, created_at) VALUES ('dm', ?, ?, ?, ?)`,
        ).run(discordUser.username, discordUser.id, discordUser.avatar ?? null, now()).lastInsertRowid,
      );
      q('INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)').run(id, userId);
      return id;
    });
    return serializeDm(getChannel(id), userId);
  }

  function rememberDmRoute(discordMessageId, discordUserId, channelId) {
    q('INSERT OR REPLACE INTO discord_dm_routes (discord_message_id, channel_id) VALUES (?, ?)').run(
      discordMessageId,
      channelId,
    );
    q('INSERT OR REPLACE INTO discord_dm_last (discord_user_id, channel_id) VALUES (?, ?)').run(
      discordUserId,
      channelId,
    );
  }

  // Findet das Gespräch, zu dem eine eingehende Discord-DM gehört: zuerst über
  // die Nachricht, auf die geantwortet wurde, sonst das zuletzt aktive Gespräch.
  function routeDiscordDm(discordUserId, repliedToMessageId) {
    if (repliedToMessageId) {
      const row = q(
        `SELECT r.channel_id FROM discord_dm_routes r JOIN channels c ON c.id = r.channel_id
         WHERE r.discord_message_id = ? AND c.discord_user_id = ?`,
      ).get(repliedToMessageId, discordUserId);
      if (row) return getChannel(row.channel_id);
    }
    const last = q('SELECT channel_id FROM discord_dm_last WHERE discord_user_id = ?').get(discordUserId);
    return last ? getChannel(last.channel_id) : null;
  }

  // ---------- Nachrichten ----------

  const MESSAGE_SELECT = `
    SELECT m.*, c.server_id, u.username AS author_username, u.color AS author_color
    FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.author_id`;

  function serializeMessage(row) {
    const author =
      row.author_id != null
        ? { source: 'local', id: row.author_id, username: row.author_username, color: row.author_color }
        : row.discord_author_id != null
          ? {
              source: 'discord',
              id: row.discord_author_id,
              username: row.discord_author_name,
              avatar: row.discord_author_avatar,
            }
          : { source: 'local', id: null, username: 'Gelöschter Nutzer', color: '#747f8d' };
    return {
      id: row.id,
      channelId: row.channel_id,
      serverId: row.server_id,
      content: row.content,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      author,
    };
  }

  function getMessage(id) {
    const row = q(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
    return row && serializeMessage(row);
  }

  function getMessageByDiscordId(discordMessageId) {
    const row = q(`${MESSAGE_SELECT} WHERE m.discord_message_id = ?`).get(discordMessageId);
    return row && serializeMessage(row);
  }

  function listMessages(channelId, { before, limit = 50 } = {}) {
    limit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    let rows;
    const anchor = before ? q('SELECT id, created_at FROM messages WHERE id = ?').get(before) : null;
    if (anchor) {
      rows = q(
        `${MESSAGE_SELECT} WHERE m.channel_id = ? AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
         ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      ).all(channelId, anchor.created_at, anchor.created_at, anchor.id, limit);
    } else {
      rows = q(`${MESSAGE_SELECT} WHERE m.channel_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(
        channelId,
        limit,
      );
    }
    return rows.reverse().map(serializeMessage);
  }

  // Legt eine Nachricht an. Gibt null zurück, wenn die Discord-Nachricht schon existiert.
  function insertMessage({ channelId, authorId = null, discordAuthor = null, content, createdAt, discordMessageId = null }) {
    const result = q(
      `INSERT OR IGNORE INTO messages
        (channel_id, author_id, discord_author_id, discord_author_name, discord_author_avatar, content, created_at, discord_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      channelId,
      authorId,
      discordAuthor?.id ?? null,
      discordAuthor?.username ?? null,
      discordAuthor?.avatar ?? null,
      content,
      createdAt ?? now(),
      discordMessageId,
    );
    return result.changes ? getMessage(Number(result.lastInsertRowid)) : null;
  }

  function setDiscordMessageId(messageId, discordMessageId) {
    q('UPDATE messages SET discord_message_id = ? WHERE id = ?').run(discordMessageId, messageId);
  }

  function updateDiscordMessage(discordMessageId, content, editedAt) {
    q('UPDATE messages SET content = ?, edited_at = ? WHERE discord_message_id = ?').run(
      content,
      editedAt ?? now(),
      discordMessageId,
    );
    return getMessageByDiscordId(discordMessageId);
  }

  function deleteMessageById(id) {
    q('DELETE FROM messages WHERE id = ?').run(id);
  }

  function deleteDiscordMessage(discordMessageId) {
    const message = getMessageByDiscordId(discordMessageId);
    if (message) q('DELETE FROM messages WHERE id = ?').run(message.id);
    return message;
  }

  // ---------- Discord-Spiegelung ----------

  function upsertGuild({ id, name, iconUrl }) {
    q(
      `INSERT INTO servers (name, discord_guild_id, icon_url, active, created_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (discord_guild_id) DO UPDATE SET name = excluded.name, icon_url = excluded.icon_url, active = 1`,
    ).run(name, id, iconUrl ?? null, now());
    return q('SELECT * FROM servers WHERE discord_guild_id = ?').get(id);
  }

  function deactivateGuild(guildId) {
    q('UPDATE servers SET active = 0 WHERE discord_guild_id = ?').run(guildId);
    return q('SELECT * FROM servers WHERE discord_guild_id = ?').get(guildId);
  }

  function serverByGuild(guildId) {
    return q('SELECT * FROM servers WHERE discord_guild_id = ?').get(guildId);
  }

  function upsertGuildChannel(serverId, { id, name, position }) {
    q(
      `INSERT INTO channels (server_id, type, name, position, discord_channel_id, active, created_at)
       VALUES (?, 'text', ?, ?, ?, 1, ?)
       ON CONFLICT (discord_channel_id) DO UPDATE SET
         server_id = excluded.server_id, name = excluded.name, position = excluded.position, active = 1`,
    ).run(serverId, name, position ?? 0, id, now());
    return q('SELECT * FROM channels WHERE discord_channel_id = ?').get(id);
  }

  // Deaktiviert alle Kanäle eines Servers, die nicht mehr (sichtbar) existieren.
  function pruneGuildChannels(serverId, keepDiscordIds) {
    const keep = new Set(keepDiscordIds);
    for (const row of q('SELECT id, discord_channel_id FROM channels WHERE server_id = ? AND active = 1').all(serverId)) {
      if (row.discord_channel_id && !keep.has(row.discord_channel_id)) {
        q('UPDATE channels SET active = 0 WHERE id = ?').run(row.id);
      }
    }
  }

  function deactivateChannel(discordChannelId) {
    q('UPDATE channels SET active = 0 WHERE discord_channel_id = ?').run(discordChannelId);
    return q('SELECT * FROM channels WHERE discord_channel_id = ?').get(discordChannelId);
  }

  function channelByDiscordId(discordChannelId) {
    return q('SELECT * FROM channels WHERE discord_channel_id = ?').get(discordChannelId);
  }

  function markBackfilled(channelId) {
    q('UPDATE channels SET backfilled = 1 WHERE id = ?').run(channelId);
  }

  return {
    register,
    login,
    createSession,
    deleteSession,
    userByToken,
    getUser,
    searchUsers,
    getServer,
    listServers,
    createServer,
    joinByInvite,
    joinBridged,
    leaveServer,
    isMember,
    memberIds,
    serverIdsForUser,
    listMembers,
    discoverServers,
    getChannel,
    listChannels,
    createChannel,
    dmParticipantIds,
    canAccess,
    listDms,
    openDm,
    openDiscordDm,
    rememberDmRoute,
    routeDiscordDm,
    getMessage,
    listMessages,
    insertMessage,
    setDiscordMessageId,
    updateDiscordMessage,
    deleteMessageById,
    deleteDiscordMessage,
    upsertGuild,
    deactivateGuild,
    serverByGuild,
    upsertGuildChannel,
    pruneGuildChannels,
    deactivateChannel,
    channelByDiscordId,
    markBackfilled,
  };
}
