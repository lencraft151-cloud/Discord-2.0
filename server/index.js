import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;

function parseIceServers(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    console.error('ICE_SERVERS ist kein gültiges JSON – nutze Standard-STUN-Server.');
    return undefined;
  }
}

const app = createApp({
  databaseFile: process.env.DATABASE_FILE || 'data/discord2.db',
  discordToken: process.env.DISCORD_BOT_TOKEN,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET,
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  avatarUrlTemplate: process.env.AVATAR_URL_TEMPLATE,
  iceServers: parseIceServers(process.env.ICE_SERVERS),
});

await app.listen(port);
console.log(`Discord 2.0 läuft auf http://localhost:${port}`);
if (!process.env.DISCORD_BOT_TOKEN) {
  console.log('Hinweis: DISCORD_BOT_TOKEN ist nicht gesetzt – die Brücke zu Discord ist deaktiviert.');
}
if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
  console.log('Hinweis: DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET fehlen – "Mit Discord anmelden" ist deaktiviert.');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
