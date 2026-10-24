/**
 * 极简 WebRTC 网状语音
 * - 两条独立通道：
 *   1) 大厅/发言频段（所有人互连，麦克风只在需要时打开）
 *   2) 狼人频道（只有狼人之间互连，普通频道听不到这条线上的声音）
 * - 服务端只做信令转发，音频点对点
 */
export class Voice {
  constructor(sendSignal) {
    this.send = sendSignal;
    this.pcs = new Map();
    this.pending = new Set();
    this.stream = null;
    this.enabled = false;

    this.wolfPcs = new Map();
    this.wolfStream = null;
    this.wolfSeat = null;
    this.wolfListen = false; // 观战旁听模式：只收不发
  }

  async enable() {
    if (this.enabled) return true;
    if (!navigator.mediaDevices || !window.RTCPeerConnection) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      this.stream.getAudioTracks().forEach((t) => { t.enabled = false; });
      this.enabled = true;
      const waiting = [...this.pending];
      this.pending.clear();
      waiting.forEach((entry) => {
        const initiator = entry.endsWith('+');
        this.addPeer(entry.slice(0, -1), initiator);
      });
      return true;
    } catch {
      return false;
    }
  }

  setPeers(ids) {
    ids.forEach((id) => this.addPeer(id, true));
  }

  async addPeer(id, initiator) {
    if (!id) return;
    if (!this.enabled) { this.pending.add(id + (initiator ? '+' : '-')); return; }
    if (this.pcs.has(id)) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    this.pcs.set(id, pc);

    this.stream.getTracks().forEach((track) => pc.addTrack(track, this.stream));

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.send({ t: 'rtc', to: id, data: { type: 'ice', candidate: ev.candidate } });
    };

    pc.ontrack = (ev) => this.attachAudio('audio-' + id, ev.streams[0]);

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({ t: 'rtc', to: id, data: { type: 'offer', sdp: pc.localDescription } });
    }
  }

  attachAudio(elId, stream) {
    let audio = document.getElementById(elId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = elId;
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(() => {});
  }

  /* ---------------- 狼人频道 ---------------- */

  /** 狼人频道用自己的麦克风副本，普通频道完全听不到 */
  async ensureWolfStream() {
    if (this.wolfStream) return true;
    if (!navigator.mediaDevices) return false;
    try {
      this.wolfStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      this.wolfStream.getAudioTracks().forEach((t) => { t.enabled = false; });
      return true;
    } catch {
      return false;
    }
  }

  async setWolfMode(on, ids = [], myId = '', listeners = []) {
    if (!on) {
      this.closeWolf();
      return false;
    }
    const ok = await this.ensureWolfStream();
    if (!ok) return false;
    const list = ids.filter((id) => id && id !== myId);
    this.wolfSeat = myId;
    for (const id of list) await this.addWolfPeer(id, String(myId) < String(id));
    // 观战旁听：把密谈音频推一份给观众（自己发起 offer，只发不收对方的麦）
    for (const lid of listeners) {
      if (lid && lid !== myId) await this.addWolfPeer(lid, true);
    }
    return true;
  }

  /** 观战旁听狼聊：只收不发，不占用麦克风 */
  async setWolfListen(ids = []) {
    this.wolfListen = true;
    for (const id of ids) {
      if (id) await this.addWolfPeer(id, false);
    }
  }

  async addWolfPeer(id, initiator) {
    if (!id || this.wolfPcs.has(id)) return;
    const listenOnly = !this.wolfStream; // 观战没有本地麦，只收音频
    if (!listenOnly && !this.wolfStream) return;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.wolfPcs.set(id, pc);

    if (!listenOnly) {
      this.wolfStream.getTracks().forEach((t) => pc.addTrack(t, this.wolfStream));
    }
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.send({ t: 'rtc', to: id, data: { channel: 'wolf', type: 'ice', candidate: ev.candidate } });
      }
    };
    pc.ontrack = (ev) => this.attachAudio('audio-wolf-' + id, ev.streams[0]);

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({ t: 'rtc', to: id, data: { channel: 'wolf', type: 'offer', sdp: pc.localDescription } });
    }
  }

  closeWolf() {
    for (const [id, pc] of this.wolfPcs) {
      try { pc.close(); } catch { /* ignore */ }
      const el = document.getElementById('audio-wolf-' + id);
      if (el) el.remove();
    }
    this.wolfPcs.clear();
    this.wolfListen = false;
    this.setWolfTalking(false);
  }

  setWolfTalking(on) {
    if (!this.wolfStream) return;
    this.wolfStream.getAudioTracks().forEach((t) => { t.enabled = !!on; });
  }

  /* ---------------- 信令 ---------------- */

  async onSignal(from, data) {
    if (!data) return;
    if (data.channel === 'wolf') return this.onWolfSignal(from, data);
    if (!this.enabled) await this.enable();

    if (data.type === 'offer') {
      await this.addPeer(from, false);
      const pc = this.pcs.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ t: 'rtc', to: from, data: { type: 'answer', sdp: pc.localDescription } });
    } else if (data.type === 'answer') {
      const pc = this.pcs.get(from);
      if (pc) await pc.setRemoteDescription(data.sdp);
    } else if (data.type === 'ice') {
      const pc = this.pcs.get(from);
      if (pc) {
        try { await pc.addIceCandidate(data.candidate); } catch { /* ignore */ }
      }
    }
  }

  async onWolfSignal(from, data) {
    if (!this.wolfListen) {
      const ok = await this.ensureWolfStream();
      if (!ok) return;
    }
    if (data.type === 'offer') {
      await this.addWolfPeer(from, false);
      const pc = this.wolfPcs.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ t: 'rtc', to: from, data: { channel: 'wolf', type: 'answer', sdp: pc.localDescription } });
    } else if (data.type === 'answer') {
      const pc = this.wolfPcs.get(from);
      if (pc) await pc.setRemoteDescription(data.sdp);
    } else if (data.type === 'ice') {
      const pc = this.wolfPcs.get(from);
      if (pc) {
        try { await pc.addIceCandidate(data.candidate); } catch { /* ignore */ }
      }
    }
  }

  setTalking(on) {
    if (!this.stream) return;
    this.stream.getAudioTracks().forEach((t) => { t.enabled = !!on; });
  }

  peerCount() {
    return this.pcs.size;
  }
}
