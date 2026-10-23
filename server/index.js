import { createApp } from './app.js';

const app = createApp({
  databaseFile: process.env.DATABASE_FILE || 'data/discord2.db',
  discordToken: process.env.DISCORD_BOT_TOKEN,
  avatarUrlTemplate: process.env.AVATAR_URL_TEMPLATE,
});

const port = await app.listen(Number(process.env.PORT) || 3000);
console.log(`Discord 2.0 läuft auf http://localhost:${port}`);
if (!process.env.DISCORD_BOT_TOKEN) {
  console.log('Hinweis: DISCORD_BOT_TOKEN ist nicht gesetzt – die Brücke zu Discord ist deaktiviert.');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
