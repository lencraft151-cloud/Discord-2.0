// Anrufe im Browser: WebRTC zwischen Discord-2.0-Nutzern (Mesh, jeder mit jedem)
// und – in Discord-Sprachkanälen – Audio über den Server zum Bot.

const SPEAKING_LEVEL = 0.02;

export class VoiceClient extends EventTarget {
  constructor(getSocket) {
    super();
    this.getSocket = getSocket;
    this.reset();
  }

  reset() {
    this.channelId = null;
    this.bridged = false;
    this.iceServers = [];
    this.peers = new Map(); // socketId -> { user, pc, stream, audio, pendingCandidates, speaking, videoSender, audioSender }
    this.localStream = null;
    this.cameraTrack = null;
    this.screenTrack = null;
    this.muted = false;
    this.deafened = false;
    this.localSpeaking = false;
    this.discordAudio = null;
    this.levelTimer = null;
    this.levelContext = null;
  }

  get connected() {
    return this.channelId != null;
  }

  get videoTrack() {
    return this.screenTrack ?? this.cameraTrack;
  }

  changed() {
    this.dispatchEvent(new Event('change'));
  }

  async join(channelId) {
    if (this.channelId === channelId) return;
    if (this.connected) this.leave();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      throw new Error('Kein Zugriff aufs Mikrofon. Bitte im Browser erlauben.');
    }
    const result = await this.getSocket().emitWithAck('voice:join', { channelId });
    if (!result.ok) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(result.error);
    }
    this.localStream = stream;
    this.channelId = result.channelId;
    this.bridged = result.bridged;
    this.iceServers = result.iceServers ?? [];
    for (const peer of result.peers) this.connectTo(peer.socketId, peer.user);
    if (this.bridged) await this.startDiscordAudio().catch((err) => console.warn('Discord-Audio:', err));
    this.startLevelMeter();
    this.changed();
  }

  leave() {
    if (!this.connected) return;
    this.getSocket()?.emit('voice:leave');
    for (const socketId of this.peers.keys()) this.removePeer(socketId, false);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.cameraTrack?.stop();
    this.screenTrack?.stop();
    this.discordAudio?.context.close();
    clearInterval(this.levelTimer);
    this.levelContext?.close();
    this.reset();
    this.changed();
  }

  // ---------- WebRTC ----------

  createPeer(socketId, user) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { user, pc, stream: new MediaStream(), audio: new Audio(), pendingCandidates: [], speaking: false };
    peer.audio.autoplay = true;
    peer.audio.muted = this.deafened;
    peer.audio.srcObject = peer.stream;
    pc.onicecandidate = ({ candidate }) => candidate && this.signal(socketId, { candidate });
    pc.ontrack = ({ track }) => {
      peer.stream.addTrack(track);
      if (track.kind === 'audio') this.watchLevel(peer);
      track.onunmute = () => this.changed();
      this.changed();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
    };
    this.peers.set(socketId, peer);
    return peer;
  }

  // Der Neue im Raum baut die Verbindungen zu allen anderen auf.
  async connectTo(socketId, user) {
    const peer = this.createPeer(socketId, user);
    const [micTrack] = this.localStream.getAudioTracks();
    peer.audioSender = peer.pc.addTransceiver(micTrack, { direction: 'sendrecv', streams: [this.localStream] }).sender;
    // Video-Kanal immer anlegen; Kamera/Bildschirm wird später nur per replaceTrack getauscht.
    peer.videoSender = peer.pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
    if (this.videoTrack) await peer.videoSender.replaceTrack(this.videoTrack);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.signal(socketId, { description: peer.pc.localDescription });
  }

  peerJoined(socketId, user) {
    if (!this.peers.has(socketId)) this.createPeer(socketId, user);
    this.changed();
  }

  async onSignal({ from, data }) {
    const peer = this.peers.get(from);
    if (!peer) return;
    const { pc } = peer;
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        for (const transceiver of pc.getTransceivers()) {
          transceiver.direction = 'sendrecv';
          if (transceiver.receiver.track.kind === 'audio') {
            peer.audioSender = transceiver.sender;
            await transceiver.sender.replaceTrack(this.localStream.getAudioTracks()[0]);
          } else {
            peer.videoSender = transceiver.sender;
            if (this.videoTrack) await transceiver.sender.replaceTrack(this.videoTrack);
          }
        }
        await pc.setLocalDescription(await pc.createAnswer());
        this.signal(from, { description: pc.localDescription });
      }
      for (const candidate of peer.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pendingCandidates.push(data.candidate);
    }
  }

  removePeer(socketId, notify = true) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    peer.pc.close();
    peer.audio.srcObject = null;
    this.peers.delete(socketId);
    if (notify) this.changed();
  }

  signal(to, data) {
    this.getSocket()?.emit('voice:signal', { to, data });
  }

  sendState() {
    this.getSocket()?.emit('voice:update', {
      muted: this.muted,
      deafened: this.deafened,
      video: Boolean(this.cameraTrack) && !this.screenTrack,
      screen: Boolean(this.screenTrack),
    });
    this.changed();
  }

  // ---------- Steuerung ----------

  setMuted(muted) {
    this.muted = muted;
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.sendState();
  }

  setDeafened(deafened) {
    this.deafened = deafened;
    for (const peer of this.peers.values()) peer.audio.muted = deafened;
    if (this.discordAudio) this.discordAudio.output.gain.value = deafened ? 0 : 1;
    // Wer nichts hört, spricht auch nicht (wie bei Discord).
    if (deafened && !this.muted) this.setMuted(true);
    else this.sendState();
  }

  async setVideoTrack(track) {
    for (const peer of this.peers.values()) await peer.videoSender?.replaceTrack(track).catch(() => {});
  }

  async toggleCamera() {
    if (this.cameraTrack) {
      this.cameraTrack.stop();
      this.cameraTrack = null;
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } });
        this.cameraTrack = stream.getVideoTracks()[0];
      } catch {
        throw new Error('Kein Zugriff auf die Kamera');
      }
    }
    await this.setVideoTrack(this.videoTrack);
    this.sendState();
  }

  async toggleScreen() {
    if (this.screenTrack) {
      this.screenTrack.stop();
      this.screenTrack = null;
    } else {
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch {
        return; // abgebrochen
      }
      this.screenTrack = stream.getVideoTracks()[0];
      this.screenTrack.onended = () => this.screenTrack && this.toggleScreen();
    }
    await this.setVideoTrack(this.videoTrack);
    this.sendState();
  }

  // ---------- Discord-Audio über den Server ----------

  async startDiscordAudio() {
    const context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule('/voice-worklets.js');
    await context.resume();
    const source = context.createMediaStreamSource(this.localStream);
    const capture = new AudioWorkletNode(context, 'pcm-capture');
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(capture).connect(sink).connect(context.destination);
    capture.port.onmessage = ({ data }) => {
      if (!this.muted) this.getSocket()?.emit('voice:pcm', data);
    };
    const player = new AudioWorkletNode(context, 'pcm-player', { outputChannelCount: [1] });
    const output = context.createGain();
    output.gain.value = this.deafened ? 0 : 1;
    player.connect(output).connect(context.destination);
    this.discordAudio = { context, player, output };
  }

  onDiscordAudio(data) {
    this.discordAudio?.player.port.postMessage(data, [data]);
  }

  bridgeLost() {
    this.bridged = false;
    this.discordAudio?.context.close();
    this.discordAudio = null;
    this.changed();
  }

  // ---------- Sprechanzeige ----------

  startLevelMeter() {
    this.levelContext = new AudioContext();
    this.localAnalyser = this.analyser(this.localStream);
    for (const peer of this.peers.values()) if (peer.stream.getAudioTracks().length) this.watchLevel(peer);
    this.levelTimer = setInterval(() => {
      let dirty = false;
      const local = !this.muted && level(this.localAnalyser) > SPEAKING_LEVEL;
      if (local !== this.localSpeaking) {
        this.localSpeaking = local;
        dirty = true;
      }
      for (const peer of this.peers.values()) {
        const speaking = Boolean(peer.analyser) && level(peer.analyser) > SPEAKING_LEVEL;
        if (speaking !== peer.speaking) {
          peer.speaking = speaking;
          dirty = true;
        }
      }
      if (dirty) this.dispatchEvent(new Event('speaking'));
    }, 120);
  }

  analyser(stream) {
    const node = this.levelContext.createAnalyser();
    node.fftSize = 512;
    this.levelContext.createMediaStreamSource(stream).connect(node);
    return node;
  }

  watchLevel(peer) {
    if (this.levelContext && !peer.analyser) peer.analyser = this.analyser(peer.stream);
  }
}

function level(analyser) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += v * v;
  return Math.sqrt(sum / data.length);
}
