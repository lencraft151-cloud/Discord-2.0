import { HttpError } from './store.js';

export function setupRealtime({ io, store, chat, voice }) {
  io.use((socket, next) => {
    const user = store.userByToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('Nicht angemeldet'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    socket.join(`user:${user.id}`);
    for (const serverId of store.serverIdsForUser(user.id)) socket.join(`server:${serverId}`);
    chat.setOnline(user.id, +1);
    socket.on('disconnect', () => {
      voice.leave(socket);
      chat.setOnline(user.id, -1);
    });

    socket.on('message:send', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      try {
        ack({ ok: true, message: await chat.sendMessage(user, payload?.channelId, payload?.content) });
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(err);
        ack({ ok: false, error: err instanceof HttpError ? err.message : 'Interner Serverfehler' });
      }
    });

    socket.on('voice:join', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const result = await voice.join(socket, payload?.channelId);
        ack(result ? { ok: true, ...result } : { ok: false, error: 'Verbindung getrennt' });
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(err);
        ack({ ok: false, error: err instanceof HttpError ? err.message : 'Interner Serverfehler' });
      }
    });
    socket.on('voice:leave', () => voice.leave(socket));
    socket.on('voice:signal', (payload) => voice.signal(socket, payload));
    socket.on('voice:update', (payload) => voice.update(socket, payload));
    socket.on('voice:pcm', (data) => voice.audio(socket, data));
    socket.on('voice:decline', (payload) => voice.decline(socket, payload));

    socket.on('typing', ({ channelId } = {}) => {
      const channel = store.getChannel(Number(channelId));
      if (!store.canAccess(user.id, channel)) return;
      const rooms =
        channel.type === 'dm'
          ? store.dmParticipantIds(channel.id).map((id) => `user:${id}`)
          : [`server:${channel.server_id}`];
      socket.to(rooms).except(`user:${user.id}`).emit('typing', { channelId: channel.id, username: user.username });
    });
  });
}
