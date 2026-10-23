import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';
import { DISCORD_FRAME_BYTES, FRAME_MS, FrameMixer, discordToWeb, webToDiscord } from './audio.js';

// Hält die Sprachverbindung des Bots zu einem Discord-Sprachkanal.
// Browser-Audio wird gemischt nach Discord gespielt, Discord-Audio gemischt an onAudio gegeben.
export function createDiscordVoiceSession({ guild, channelId, onAudio, onEnd }) {
  const connection = joinVoiceChannel({
    channelId,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 25 } });
  connection.subscribe(player);

  const toDiscord = new FrameMixer();
  const fromDiscord = new FrameMixer();
  const listening = new Set();
  let output = null;
  let lastOutput = 0;
  let ended = false;

  // Discord-Sprecher abonnieren, sobald sie anfangen zu reden.
  connection.receiver.speaking.on('start', (userId) => {
    if (listening.has(userId)) return;
    const member = guild.members.cache.get(userId);
    if (member?.user.bot) return;
    listening.add(userId);
    const opus = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 500 } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    let rest = Buffer.alloc(0);
    decoder.on('data', (chunk) => {
      rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      while (rest.length >= DISCORD_FRAME_BYTES) {
        fromDiscord.push(userId, discordToWeb(rest.subarray(0, DISCORD_FRAME_BYTES)));
        rest = rest.subarray(DISCORD_FRAME_BYTES);
      }
    });
    const stop = () => {
      listening.delete(userId);
      decoder.destroy();
    };
    opus.on('end', stop);
    opus.on('error', stop);
    decoder.on('error', stop);
    opus.pipe(decoder);
  });

  const timer = setInterval(() => {
    const now = Date.now();
    const web = toDiscord.next();
    if (web) {
      // Für jede Sprechphase einen neuen Stream, damit Discord den Bot nur beim Reden als sprechend zeigt.
      if (!output) {
        output = new Readable({ read() {} });
        player.play(createAudioResource(output, { inputType: StreamType.Raw }));
      }
      output.push(webToDiscord(web));
      lastOutput = now;
    } else if (output && now - lastOutput > 300) {
      output.push(null);
      output = null;
    }
    const discord = fromDiscord.next();
    if (discord) onAudio(discord);
  }, FRAME_MS);

  player.on('error', (err) => console.warn('[discord] Sprachausgabe:', err.message));
  player.on(AudioPlayerStatus.Idle, () => (output = null));

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Kurz warten: ein Kanalwechsel durch Discord ist kein echtes Trennen.
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      destroy();
    }
  });
  connection.on(VoiceConnectionStatus.Destroyed, () => finish());

  function finish() {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    output?.push(null);
    player.stop(true);
    onEnd?.();
  }

  function destroy() {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    finish();
  }

  return {
    channelId,
    ready: entersState(connection, VoiceConnectionStatus.Ready, 20_000),
    pushWeb: (key, frame) => toDiscord.push(key, frame),
    removeWeb: (key) => toDiscord.remove(key),
    destroy,
  };
}
