import {
  ChannelType,
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  OAuth2Scopes,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';

// Die Brücke läuft über einen offiziellen Discord-Bot. Discord-Serveradmins laden
// den Bot ein; danach erscheinen ihre Server in Discord 2.0 und Nachrichten
// werden in beide Richtungen gespiegelt. Discord-2.0-Nutzer schreiben auf
// Discord über einen Webhook mit eigenem Namen. Direktnachrichten an
// Discord-Nutzer schickt der Bot.

const BRIDGED_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const WEBHOOK_NAME = 'D2 Bridge';
const NAME_SUFFIX = ' (D2)';

export const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.ManageWebhooks |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.AttachFiles;

const REQUIRED_CHANNEL_PERMISSIONS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;

// Discord verbietet "discord" und "clyde" in Webhook-Namen.
export function webhookUsername(username) {
  const cleaned = username.replace(/discord|clyde/gi, (m) => `${m[0]}​${m.slice(1)}`);
  return (cleaned + NAME_SUFFIX).slice(0, 80);
}

// Formt eine Discord-Nachricht in Text für Discord 2.0 um (Anhänge als Links).
export function discordMessageText(message) {
  const parts = [];
  if (message.cleanContent) parts.push(message.cleanContent);
  for (const attachment of message.attachments.values()) parts.push(attachment.url);
  for (const sticker of message.stickers.values()) parts.push(`[Sticker: ${sticker.name}]`);
  if (!parts.length && message.embeds.length) parts.push('[Eingebetteter Inhalt]');
  return parts.join('\n');
}

function discordAuthor(user, member) {
  return {
    id: user.id,
    username: member?.displayName ?? user.displayName ?? user.username,
    avatar: (member ?? user).displayAvatarURL({ size: 64 }),
  };
}

export function createDiscordBridge({ token, store, chat, avatarUrlTemplate }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const webhooks = new Map(); // Discord-Kanal-ID -> Promise<Webhook>
  const ownWebhookIds = new Set();
  let ready = false;

  function canRead(channel) {
    const permissions = channel.permissionsFor(client.user);
    return Boolean(permissions?.has(REQUIRED_CHANNEL_PERMISSIONS));
  }

  function syncGuild(guild) {
    const server = store.upsertGuild({ id: guild.id, name: guild.name, iconUrl: guild.iconURL({ size: 128 }) });
    const visible = [];
    for (const channel of guild.channels.cache.values()) {
      if (!BRIDGED_CHANNEL_TYPES.has(channel.type) || !canRead(channel)) continue;
      // rawPosition plus Kategorie-Position ergibt ungefähr die Reihenfolge wie in Discord.
      const position = (channel.parent?.rawPosition ?? -1) * 1000 + channel.rawPosition;
      store.upsertGuildChannel(server.id, { id: channel.id, name: channel.name, position });
      visible.push(channel.id);
    }
    store.pruneGuildChannels(server.id, visible);
    return server;
  }

  function refreshGuild(guild) {
    const server = syncGuild(guild);
    chat.channelsChanged(server.id);
    chat.serversChanged(store.memberIds(server.id));
  }

  client.once('clientReady', async () => {
    ready = true;
    console.log(`[discord] Verbunden als ${client.user.tag} – ${client.guilds.cache.size} Server`);
    for (const guild of client.guilds.cache.values()) {
      refreshGuild(guild);
      // Mitgliederliste laden, damit die Nutzersuche funktioniert.
      guild.members.fetch().catch((err) => console.warn(`[discord] Mitglieder von ${guild.name}:`, err.message));
    }
  });

  client.on('guildCreate', (guild) => {
    console.log(`[discord] Bot wurde zu "${guild.name}" hinzugefügt`);
    refreshGuild(guild);
    guild.members.fetch().catch(() => {});
  });

  client.on('guildUpdate', (_, guild) => refreshGuild(guild));

  client.on('guildDelete', (guild) => {
    const server = store.deactivateGuild(guild.id);
    if (server) chat.serversChanged(store.memberIds(server.id));
  });

  const refreshGuildOf = (channel) => channel.guild && refreshGuild(channel.guild);
  client.on('channelCreate', refreshGuildOf);
  client.on('channelUpdate', (_, channel) => refreshGuildOf(channel));
  client.on('channelDelete', (channel) => {
    webhooks.delete(channel.id);
    const row = store.deactivateChannel(channel.id);
    if (row) chat.channelsChanged(row.server_id);
  });
  client.on('roleUpdate', (_, role) => refreshGuild(role.guild));
  client.on('guildMemberUpdate', (_, member) => {
    if (member.id === client.user.id) refreshGuild(member.guild);
  });

  client.on('messageCreate', (message) => {
    if (message.author.id === client.user.id) return;
    if (message.webhookId && ownWebhookIds.has(message.webhookId)) return;
    if (message.system) return;
    const content = discordMessageText(message);
    if (!content) return;

    if (message.guildId) {
      const channel = store.channelByDiscordId(message.channelId);
      if (!channel || !channel.active) return;
      chat.receiveFromDiscord(channel, {
        discordAuthor: discordAuthor(message.author, message.member),
        content,
        createdAt: message.createdTimestamp,
        discordMessageId: message.id,
      });
      return;
    }

    // Direktnachricht an den Bot: an das passende Discord-2.0-Gespräch weiterleiten.
    const channel = store.routeDiscordDm(message.author.id, message.reference?.messageId);
    if (!channel) {
      message
        .reply(
          'Hallo! Ich bin die Brücke zu Discord 2.0. Sobald dir jemand von dort schreibt, kannst du hier antworten.',
        )
        .catch(() => {});
      return;
    }
    store.rememberDmRoute(message.id, message.author.id, channel.id);
    chat.receiveFromDiscord(channel, {
      discordAuthor: discordAuthor(message.author),
      content,
      createdAt: message.createdTimestamp,
      discordMessageId: message.id,
    });
  });

  client.on('messageUpdate', (_, message) => {
    if (message.partial || !message.editedTimestamp) return;
    const updated = store.updateDiscordMessage(message.id, discordMessageText(message), message.editedTimestamp);
    if (updated) chat.messageUpdated(updated);
  });

  client.on('messageDelete', (message) => {
    const deleted = store.deleteDiscordMessage(message.id);
    if (deleted) chat.messageDeleted(deleted);
  });

  client.on('error', (err) => console.error('[discord] Fehler:', err));
  client.on('shardDisconnect', () => (ready = false));
  client.on('shardResume', () => (ready = true));
  client.on('shardReady', () => (ready = Boolean(client.user)));

  function getWebhook(channel) {
    if (!webhooks.has(channel.id)) {
      const promise = (async () => {
        const existing = await channel.fetchWebhooks();
        const webhook =
          existing.find((w) => w.owner?.id === client.user.id && w.name === WEBHOOK_NAME) ??
          (await channel.createWebhook({ name: WEBHOOK_NAME, reason: 'Brücke zu Discord 2.0' }));
        ownWebhookIds.add(webhook.id);
        return webhook;
      })();
      promise.catch(() => webhooks.delete(channel.id));
      webhooks.set(channel.id, promise);
    }
    return webhooks.get(channel.id);
  }

  function avatarFor(user) {
    return avatarUrlTemplate
      ? avatarUrlTemplate.replace('{username}', encodeURIComponent(user.username)).replace('{id}', String(user.id))
      : undefined;
  }

  // Schickt die Nachricht eines Discord-2.0-Nutzers nach Discord und gibt die Discord-Nachrichten-ID zurück.
  async function relay(channelRow, user, content) {
    if (channelRow.discord_user_id) {
      const discordUser = await client.users.fetch(channelRow.discord_user_id);
      const sent = await discordUser.send({
        content: `**${user.username}** (Discord 2.0): ${content}`.slice(0, 2000),
        allowedMentions: { parse: [] },
      });
      store.rememberDmRoute(sent.id, discordUser.id, channelRow.id);
      return sent.id;
    }

    const channel = await client.channels.fetch(channelRow.discord_channel_id);
    if (!channel) throw new Error('Kanal existiert auf Discord nicht mehr');
    const allowedMentions = { parse: [] }; // keine @everyone-Pings aus Discord 2.0
    try {
      const webhook = await getWebhook(channel);
      const sent = await webhook.send({
        content,
        username: webhookUsername(user.username),
        avatarURL: avatarFor(user),
        allowedMentions,
      });
      return sent.id;
    } catch (err) {
      // Ohne "Webhooks verwalten" schreibt der Bot selbst, mit Namen davor.
      if (!(err instanceof DiscordAPIError) || err.code !== 50013) throw err;
      const sent = await channel.send({ content: `**${user.username}**${NAME_SUFFIX}: ${content}`.slice(0, 2000), allowedMentions });
      return sent.id;
    }
  }

  async function backfill(channelRow) {
    const channel = await client.channels.fetch(channelRow.discord_channel_id);
    const messages = await channel.messages.fetch({ limit: 50 });
    for (const message of messages.values()) {
      if (message.system) continue;
      const content = discordMessageText(message);
      if (!content) continue;
      // Eigene Webhook-Nachrichten sind Discord-2.0-Nutzer; ihren Namen ohne Suffix anzeigen.
      const author = discordAuthor(message.author, message.member);
      if (message.webhookId && ownWebhookIds.has(message.webhookId)) author.username = author.username.replace(NAME_SUFFIX, '');
      store.insertMessage({
        channelId: channelRow.id,
        discordAuthor: author,
        content,
        createdAt: message.createdTimestamp,
        discordMessageId: message.id,
      });
    }
    store.markBackfilled(channelRow.id);
  }

  function memberInfo(member) {
    return {
      id: member.id,
      username: member.user.username,
      displayName: member.displayName,
      avatar: member.displayAvatarURL({ size: 64 }),
      bot: member.user.bot,
    };
  }

  async function listGuildMembers(guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return [];
    return [...guild.members.cache.values()]
      .filter((m) => !m.user.bot)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .slice(0, 200)
      .map(memberInfo);
  }

  async function searchUsers(query) {
    const needle = query.toLowerCase();
    const found = new Map();
    for (const guild of client.guilds.cache.values()) {
      for (const member of guild.members.cache.values()) {
        if (member.user.bot || found.has(member.id)) continue;
        const names = [member.user.username, member.displayName, member.user.globalName].filter(Boolean);
        if (member.id === query || names.some((n) => n.toLowerCase().includes(needle))) {
          found.set(member.id, { ...memberInfo(member), guild: guild.name });
        }
        if (found.size >= 20) return [...found.values()];
      }
    }
    return [...found.values()];
  }

  async function fetchUser(id) {
    if (!/^\d{15,22}$/.test(id)) return null;
    const user = await client.users.fetch(id).catch(() => null);
    if (!user || user.bot) return null;
    return { id: user.id, username: user.displayName ?? user.username, avatar: user.displayAvatarURL({ size: 64 }) };
  }

  function inviteUrl() {
    if (!client.application?.id && !client.user?.id) return null;
    return client.generateInvite({ scopes: [OAuth2Scopes.Bot], permissions: BOT_PERMISSIONS });
  }

  function describeError(err) {
    if (err instanceof DiscordAPIError) {
      if (err.code === 50007) return 'Der Nutzer nimmt keine Direktnachrichten vom Bot an';
      if (err.code === 50013) return 'Dem Bot fehlen Berechtigungen in diesem Kanal';
      if (err.code === 50001) return 'Der Bot hat keinen Zugriff auf diesen Kanal';
    }
    return err.message;
  }

  return {
    get ready() {
      return ready;
    },
    start: () => client.login(token),
    stop: () => client.destroy(),
    relay,
    backfill,
    listGuildMembers,
    searchUsers,
    fetchUser,
    inviteUrl,
    describeError,
  };
}
