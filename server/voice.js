import { HttpError } from './store.js';
import { toWebFrame } from './audio.js';

// Sprach- und Videoanrufe. Discord-2.0-Teilnehmer verbinden sich direkt per
// WebRTC (der Server vermittelt nur die Verbindungsdaten). In gespiegelten
// Discord-Sprachkanälen schickt der Browser zusätzlich sein Mikrofon an den
// Server, der Bot spielt es auf Discord ab und schickt Discord-Audio zurück.
export function createVoice({ io, store, chat, iceServers }) {
  const rooms = new Map(); // Kanal-ID -> { channel, peers: Map<socketId, Peer>, discord, connecting }
  const socketRooms = new Map(); // socketId -> Kanal-ID

  function canCall(channel) {
    return channel.type === 'voice' || (channel.type === 'dm' && channel.discord_user_id == null);
  }

  function stateFor(channelId) {
    const room = rooms.get(channelId);
    const channel = room?.channel ?? store.getChannel(channelId);
    const participants = room
      ? [...room.peers.values()].map(({ socket, user, ...media }) => ({ socketId: socket.id, user, ...media }))
      : [];
    const discord = channel?.discord_channel_id && chat.bridge?.ready ? chat.bridge.voiceMembers(channel.discord_channel_id) : [];
    return { channelId, participants, discord, bridged: Boolean(room?.discord) };
  }

  function broadcast(channelId) {
    const channel = store.getChannel(channelId);
    if (channel) chat.emitToChannel(channel, 'voice:state', stateFor(channelId));
  }

  async function connectDiscord(room) {
    const session = chat.bridge.joinVoice(room.channel, {
      onAudio: (frame) => io.to(`voice:${room.channel.id}`).emit('voice:audio', Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)),
      onEnd: () => {
        if (room.discord !== session) return;
        room.discord = null;
        io.to(`voice:${room.channel.id}`).emit('voice:bridge-lost');
        broadcast(room.channel.id);
      },
    });
    try {
      await session.ready;
    } catch {
      session.destroy();
      throw new HttpError(502, 'Der Bot konnte dem Discord-Sprachkanal nicht beitreten');
    }
    room.discord = session;
  }

  async function join(socket, channelId) {
    const user = socket.data.user;
    const channel = store.getChannel(Number(channelId));
    if (!store.canAccess(user.id, channel)) throw new HttpError(403, 'Kein Zugriff auf diesen Kanal');
    if (!canCall(channel)) throw new HttpError(400, 'In diesem Kanal kann man nicht telefonieren');
    leave(socket);

    let room = rooms.get(channel.id);
    if (!room) rooms.set(channel.id, (room = { channel, peers: new Map(), discord: null, connecting: null }));

    if (channel.discord_channel_id && !room.discord) {
      if (!chat.bridge?.ready) {
        if (!room.peers.size) rooms.delete(channel.id);
        throw new HttpError(503, 'Die Discord-Brücke ist gerade nicht verbunden');
      }
      // Mehrere gleichzeitige Beitritte teilen sich denselben Verbindungsaufbau.
      room.connecting ??= connectDiscord(room).finally(() => (room.connecting = null));
      try {
        await room.connecting;
      } catch (err) {
        if (!room.peers.size) rooms.delete(channel.id);
        throw err;
      }
      if (!socket.connected) {
        if (!room.peers.size) {
          room.discord?.destroy();
          rooms.delete(channel.id);
        }
        return null;
      }
    }

    const others = [...room.peers.values()].map((p) => ({ socketId: p.socket.id, user: p.user }));
    room.peers.set(socket.id, { socket, user, muted: false, deafened: false, video: false, screen: false });
    socketRooms.set(socket.id, channel.id);
    socket.join(`voice:${channel.id}`);
    socket.to(`voice:${channel.id}`).emit('voice:peer-joined', { channelId: channel.id, socketId: socket.id, user });

    // Direktanruf: die andere Person klingeln lassen, wenn sie noch nicht drin ist.
    if (channel.type === 'dm') {
      const inCall = new Set([...room.peers.values()].map((p) => p.user.id));
      for (const id of store.dmParticipantIds(channel.id)) {
        if (!inCall.has(id)) io.to(`user:${id}`).emit('voice:ring', { channelId: channel.id, from: user });
      }
    }
    broadcast(channel.id);
    return { channelId: channel.id, peers: others, bridged: Boolean(room.discord), iceServers };
  }

  function leave(socket) {
    const channelId = socketRooms.get(socket.id);
    if (channelId == null) return;
    socketRooms.delete(socket.id);
    socket.leave(`voice:${channelId}`);
    const room = rooms.get(channelId);
    if (!room) return;
    room.peers.delete(socket.id);
    room.discord?.removeWeb(socket.id);
    io.to(`voice:${channelId}`).emit('voice:peer-left', { channelId, socketId: socket.id });
    if (!room.peers.size) {
      room.discord?.destroy();
      rooms.delete(channelId);
      if (room.channel.type === 'dm') {
        for (const id of store.dmParticipantIds(channelId)) io.to(`user:${id}`).emit('voice:ring-end', { channelId });
      }
    }
    broadcast(channelId);
  }

  function peerOf(socket) {
    const channelId = socketRooms.get(socket.id);
    return channelId == null ? null : { room: rooms.get(channelId), peer: rooms.get(channelId)?.peers.get(socket.id) };
  }

  // WebRTC-Verbindungsdaten (Offer/Answer/ICE) nur innerhalb desselben Raums weiterreichen.
  function signal(socket, { to, data } = {}) {
    const own = peerOf(socket);
    if (!own?.room?.peers.has(to)) return;
    io.to(to).emit('voice:signal', { from: socket.id, data });
  }

  function update(socket, media = {}) {
    const own = peerOf(socket);
    if (!own?.peer) return;
    for (const key of ['muted', 'deafened', 'video', 'screen']) {
      if (key in media) own.peer[key] = Boolean(media[key]);
    }
    if (own.peer.muted) own.room.discord?.removeWeb(socket.id);
    broadcast(own.room.channel.id);
  }

  function audio(socket, data) {
    const own = peerOf(socket);
    if (!own?.room?.discord || own.peer.muted) return;
    const frame = toWebFrame(data);
    if (frame) own.room.discord.pushWeb(socket.id, frame);
  }

  function decline(socket, { channelId } = {}) {
    const channel = store.getChannel(Number(channelId));
    if (!channel || !store.canAccess(socket.data.user.id, channel)) return;
    io.to(`voice:${channel.id}`).emit('voice:declined', { channelId: channel.id, username: socket.data.user.username });
  }

  // Wird von der Brücke aufgerufen, wenn sich auf Discord jemand im Sprachkanal bewegt.
  function discordMembersChanged(discordChannelId) {
    const channel = store.channelByDiscordId(discordChannelId);
    if (channel?.type === 'voice') broadcast(channel.id);
  }

  return { join, leave, signal, update, audio, decline, stateFor, discordMembersChanged, iceServers };
}
