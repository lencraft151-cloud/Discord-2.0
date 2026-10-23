import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webhookUsername, discordMessageText } from '../server/discord-bridge.js';

test('Webhook-Namen enthalten kein verbotenes "discord"', () => {
  const name = webhookUsername('DiscordKing');
  assert.ok(!/discord/i.test(name));
  assert.ok(name.endsWith(' (D2)'));
  assert.ok(webhookUsername('x'.repeat(100)).length <= 80);
});

test('Discord-Nachrichten werden in Text umgewandelt', () => {
  const message = {
    cleanContent: 'Schau mal',
    attachments: new Map([['1', { url: 'https://cdn.example/bild.png' }]]),
    stickers: new Map(),
    embeds: [],
  };
  assert.equal(discordMessageText(message), 'Schau mal\nhttps://cdn.example/bild.png');
  assert.equal(discordMessageText({ cleanContent: '', attachments: new Map(), stickers: new Map(), embeds: [{}] }), '[Eingebetteter Inhalt]');
});
