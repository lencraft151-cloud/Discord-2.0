import { HttpError } from './store.js';

export const MAX_MESSAGE_LENGTH = 2000;

// Verbindet Datenbank, Socket.IO und (optional) die Discord-Brücke.
export function createChat({ store, io }) {
  let bridge = null;
  const online = new Map(); // userId -> Anzahl offener Verbindungen

  function roomsForChannel(channel) {
    if (channel.type === 'dm') return store.dmParticipantIds(channel.id).map((id) => `user:${id}`);
    return [`server:${channel.server_id}`];
  }

  function emitToChannel(channel, event, payload) {
    const rooms = roomsForChannel(channel);
    if (rooms.length) io.to(rooms).emit(event, payload);
  }

  function isBridged(channel) {
    return channel.discord_channel_id != null || channel.discord_user_id != null;
  }

  async function sendMessage(user, channelId, rawContent) {
    const content = String(rawContent ?? '').trim();
    if (!content) throw new HttpError(400, 'Nachricht ist leer');
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new HttpError(400, `Nachricht ist zu lang (max. ${MAX_MESSAGE_LENGTH} Zeichen)`);
    }
    const channel = store.getChannel(Number(channelId));
    if (!store.canAccess(user.id, channel)) throw new HttpError(403, 'Kein Zugriff auf diesen Kanal');
    if (isBridged(channel) && !bridge?.ready) {
      throw new HttpError(503, 'Die Discord-Brücke ist gerade nicht verbunden');
    }

    const message = store.insertMessage({ channelId: channel.id, authorId: user.id, content });
    emitToChannel(channel, 'message:new', message);

    if (isBridged(channel)) {
      try {
        const discordMessageId = await bridge.relay(channel, user, content);
        if (discordMessageId) store.setDiscordMessageId(message.id, discordMessageId);
      } catch (err) {
        // Nicht zugestellt: lokal wieder entfernen, damit niemand eine
        // Nachricht sieht, die auf Discord nie angekommen ist.
        store.deleteMessageById(message.id);
        emitToChannel(channel, 'message:delete', { id: message.id, channelId: channel.id });
        throw new HttpError(502, `Discord hat die Nachricht abgelehnt: ${bridge.describeError(err)}`);
      }
    }
    return message;
  }

  // Wird von der Brücke für eingehende Discord-Nachrichten aufgerufen.
  function receiveFromDiscord(channel, data) {
    const message = store.insertMessage({ channelId: channel.id, ...data });
    if (message) emitToChannel(channel, 'message:new', message);
    return message;
  }

  function messageUpdated(message) {
    const channel = store.getChannel(message.channelId);
    if (channel) emitToChannel(channel, 'message:update', message);
  }

  function messageDeleted(message) {
    const channel = store.getChannel(message.channelId);
    if (channel) emitToChannel(channel, 'message:delete', { id: message.id, channelId: message.channelId });
  }

  function joinServerRoom(userId, serverId) {
    io.in(`user:${userId}`).socketsJoin(`server:${serverId}`);
  }

  function leaveServerRoom(userId, serverId) {
    io.in(`user:${userId}`).socketsLeave(`server:${serverId}`);
  }

  function serversChanged(userIds) {
    if (userIds.length) io.to(userIds.map((id) => `user:${id}`)).emit('servers:changed');
  }

  function channelsChanged(serverId) {
    io.to(`server:${serverId}`).emit('channels:changed', { serverId });
  }

  function setOnline(userId, delta) {
    const count = (online.get(userId) ?? 0) + delta;
    if (count > 0) online.set(userId, count);
    else online.delete(userId);
    const wasOnline = count - delta > 0;
    if (wasOnline !== count > 0) io.emit('presence', { userId, online: count > 0 });
  }

  return {
    get bridge() {
      return bridge;
    },
    setBridge(b) {
      bridge = b;
    },
    emitToChannel,
    sendMessage,
    receiveFromDiscord,
    messageUpdated,
    messageDeleted,
    joinServerRoom,
    leaveServerRoom,
    serversChanged,
    channelsChanged,
    setOnline,
    isOnline: (userId) => online.has(userId),
  };
}
