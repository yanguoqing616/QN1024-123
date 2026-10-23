/**
 * 极简 WebRTC 网状语音（6 人以内够用）
 * - 服务端只做信令转发，音频点对点
 * - 默认不放音：只有「当前发言者」把自己的音轨打开
 */
export class Voice {
  constructor(sendSignal) {
    this.send = sendSignal;
    this.pcs = new Map();
    this.pending = new Set();
    this.stream = null;
    this.enabled = false;
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

    pc.ontrack = (ev) => {
      let audio = document.getElementById('audio-' + id);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'audio-' + id;
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = ev.streams[0];
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({ t: 'rtc', to: id, data: { type: 'offer', sdp: pc.localDescription } });
    }
  }

  async onSignal(from, data) {
    if (!data) return;
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

  setTalking(on) {
    if (!this.stream) return;
    this.stream.getAudioTracks().forEach((t) => { t.enabled = !!on; });
  }

  peerCount() {
    return this.pcs.size;
  }
}
