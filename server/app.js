import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { openDatabase } from './db.js';
import { createStore } from './store.js';
import { createChat } from './chat.js';
import { createApi } from './api.js';
import { setupRealtime } from './realtime.js';
import { createDiscordBridge } from './discord-bridge.js';
import { createDiscordOAuth } from './discord-oauth.js';
import { createVoice } from './voice.js';

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function createApp({
  databaseFile,
  discordToken,
  discordClientId,
  discordClientSecret,
  publicUrl = 'http://localhost:3000',
  avatarUrlTemplate,
  iceServers = DEFAULT_ICE_SERVERS,
  fetch,
} = {}) {
  const db = openDatabase(databaseFile ?? ':memory:');
  const store = createStore(db);

  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer);
  const chat = createChat({ store, io });
  const voice = createVoice({ io, store, chat, iceServers });
  const oauth =
    discordClientId && discordClientSecret
      ? createDiscordOAuth({ store, clientId: discordClientId, clientSecret: discordClientSecret, publicUrl, fetch })
      : null;

  if (oauth) app.use(oauth.router);
  app.use('/api', createApi({ store, chat, voice, oauth }));
  app.use(express.static(PUBLIC_DIR));
  setupRealtime({ io, store, chat, voice });

  const bridge = discordToken
    ? createDiscordBridge({
        token: discordToken,
        store,
        chat,
        avatarUrlTemplate,
        publicUrl,
        hooks: { voiceMembersChanged: (id) => voice.discordMembersChanged(id) },
      })
    : null;
  chat.setBridge(bridge);

  return {
    httpServer,
    store,
    chat,
    voice,
    async listen(port) {
      if (bridge) {
        bridge.start().catch((err) => console.error('[discord] Anmeldung fehlgeschlagen:', err.message));
      }
      await new Promise((resolve) => httpServer.listen(port, resolve));
      return httpServer.address().port;
    },
    async close() {
      await bridge?.stop();
      await io.close();
      db.close();
    },
  };
}
