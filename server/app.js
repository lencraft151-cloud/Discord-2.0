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

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function createApp({ databaseFile, discordToken, avatarUrlTemplate } = {}) {
  const db = openDatabase(databaseFile ?? ':memory:');
  const store = createStore(db);

  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer);
  const chat = createChat({ store, io });

  app.use('/api', createApi({ store, chat }));
  app.use(express.static(PUBLIC_DIR));
  setupRealtime({ io, store, chat });

  const bridge = discordToken ? createDiscordBridge({ token: discordToken, store, chat, avatarUrlTemplate }) : null;
  chat.setBridge(bridge);

  return {
    httpServer,
    store,
    chat,
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
