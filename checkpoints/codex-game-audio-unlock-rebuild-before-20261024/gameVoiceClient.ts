import type { Socket } from 'socket.io-client'

type VoiceSignal = { sessionId: string; from: string; kind: 'offer' | 'answer' | 'ice'; data: RTCSessionDescriptionInit | RTCIceCandidateInit }
type Peer = { pc: RTCPeerConnection; sender: RTCRtpSender; pendingIce: RTCIceCandidateInit[]; work: Promise<void> }


type Options = {
  socket: () => Socket | null
  userId: string
  onState: (state: 'off' | 'connecting' | 'on') => void
  onMuted: (muted: boolean) => void
  onMembers: (ids: string[]) => void
  onStream: (userId: string, stream: MediaStream | null) => void
  notify: (message: string) => void
}

/** Isolated WebRTC client for game-room audio. Mic capture is lazy; receive
 * transceivers exist independently so listening never requires a local mic. */
export class GameVoiceClient {
  private sessionId = ''
  private joined = false
  private peers = new Map<string, Peer>()
  private members = new Set<string>()
  private orphanIce = new Map<string, RTCIceCandidateInit[]>()
  private localStream: MediaStream | null = null
  private muted = true
  private generation = 0

  constructor(private readonly options: Options) {}

  join(sessionId: string) {
    if (this.sessionId === sessionId) return
    this.leave()
    this.sessionId = sessionId
    this.generation++
    this.joined = false
    this.options.onState('connecting')
    this.options.socket()?.emit('game-audio:join', { sessionId })
  }

  roster(ids: string[]) {
    if (!this.sessionId) return
    this.joined = true
    this.options.onState('connecting')
    for (const id of ids) this.addMember(id)
    this.publishMembers()
    this.refreshState()
  }

  memberJoined(userId: string) {
    if (!userId || userId === this.options.userId) return
    this.addMember(userId)
    this.publishMembers()
  }

  private addMember(userId: string) {
    if (!userId || userId === this.options.userId) return
    this.members.add(userId)
    // Both sides create the receive/send m-line; only one side offers.
    const initiator = this.options.userId.localeCompare(userId) < 0
    const peer = this.getPeer(userId)
    if (initiator && peer.pc.signalingState === 'stable') this.enqueue(peer, () => this.makeOffer(userId, peer))
  }

  private getPeer(userId: string): Peer {
    const existing = this.peers.get(userId)
    if (existing) return existing
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ] })
    const sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender
    const peer: Peer = { pc, sender, pendingIce: this.orphanIce.get(userId) || [], work: Promise.resolve() }
    this.orphanIce.delete(userId)
    this.peers.set(userId, peer)
    const sessionId = this.sessionId
    const generation = this.generation
    pc.onicecandidate = event => {
      if (event.candidate && this.isCurrent(sessionId, generation)) {
        this.options.socket()?.emit('game-audio:signal', { sessionId, to: userId, kind: 'ice', data: event.candidate.toJSON() })
      }
    }
    pc.ontrack = event => {
      if (!this.isCurrent(sessionId, generation)) return
      const stream = event.streams[0] || new MediaStream([event.track])
      this.options.onStream(userId, stream)
    }
    pc.onconnectionstatechange = () => {
      if (!this.isCurrent(sessionId, generation)) return
      if (pc.connectionState === 'connected') this.refreshState()
      if (pc.connectionState === 'failed') {
        this.options.onState('connecting')
        this.options.notify('Game voice could not reach a player. Check the network and rejoin the game voice.')
      }
      if (pc.connectionState === 'disconnected') this.refreshState()
    }
    if (this.localStream) void sender.replaceTrack(this.localStream.getAudioTracks()[0] || null).catch(() => {})
    return peer
  }

  private enqueue(peer: Peer, task: () => Promise<void>) {
    peer.work = peer.work.then(task).catch(() => {
      if (this.sessionId) this.options.notify('Game voice negotiation failed. Rejoin the game to retry.')
    })
  }

  private async makeOffer(userId: string, peer: Peer) {
    if (!this.sessionId || peer.pc.signalingState !== 'stable') return
    const offer = await peer.pc.createOffer()
    await peer.pc.setLocalDescription(offer)
    this.options.socket()?.emit('game-audio:signal', { sessionId: this.sessionId, to: userId, kind: 'offer', data: peer.pc.localDescription })
  }

  signal(payload: VoiceSignal) {
    if (!this.sessionId || payload.sessionId !== this.sessionId || payload.from === this.options.userId) return
    if (payload.kind === 'ice' && !this.peers.has(payload.from)) {
      const queue = this.orphanIce.get(payload.from) || []
      if (queue.length < 64) queue.push(payload.data as RTCIceCandidateInit)
      this.orphanIce.set(payload.from, queue)
      return
    }
    const peer = this.getPeer(payload.from)
    this.members.add(payload.from)
    this.publishMembers()
    this.enqueue(peer, async () => {
      const pc = peer.pc
      if (payload.kind === 'ice') {
        const candidate = payload.data as RTCIceCandidateInit
        if (pc.remoteDescription) await pc.addIceCandidate(candidate)
        else if (peer.pendingIce.length < 64) peer.pendingIce.push(candidate)
        return
      }
      const description = payload.data as RTCSessionDescriptionInit
      await pc.setRemoteDescription(description)
      for (const candidate of peer.pendingIce.splice(0)) await pc.addIceCandidate(candidate)
      if (payload.kind === 'offer') {
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        this.options.socket()?.emit('game-audio:signal', { sessionId: this.sessionId, to: payload.from, kind: 'answer', data: pc.localDescription })
      }
      this.refreshState()
    })
  }

  memberLeft(userId: string) {
    this.members.delete(userId)
    this.peers.get(userId)?.pc.close()
    this.peers.delete(userId)
    this.options.onStream(userId, null)
    this.publishMembers()
    this.refreshState()
  }

  async toggleMic() {
    if (!this.muted) {
      this.muted = true
      this.localStream?.getAudioTracks().forEach(track => { track.enabled = false })
      this.options.onMuted(true)
      return
    }
    if (!this.sessionId || !this.joined) {
      this.options.notify('Game voice is still connecting. Wait a moment, then turn on your mic.')
      return
    }
    // Keep the same negotiated sender/track while muted. Replacing it with null
    // and stopping it can leave some browser peer connections one-way after unmute.
    if (this.localStream?.getAudioTracks().some(track => track.readyState === 'live')) {
      this.localStream.getAudioTracks().forEach(track => { track.enabled = true })
      this.muted = false
      this.options.onMuted(false)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.options.notify('Microphone access requires localhost or a secure HTTPS connection.')
      return
    }
    const generation = this.generation
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (generation !== this.generation || !this.sessionId) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      const track = stream.getAudioTracks()[0]
      if (!track) throw new Error('No microphone was found.')
      track.enabled = true
      this.localStream = stream
      await Promise.all([...this.peers.values()].map(peer => peer.sender.replaceTrack(track)))
      this.muted = false
      this.options.onMuted(false)
      track.onended = () => {
        if (this.localStream !== stream) return
        this.localStream = null
        this.muted = true
        this.options.onMuted(true)
      }
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop())
      this.localStream = null
      this.muted = true
      this.options.onMuted(true)
      this.options.notify(error instanceof Error && error.name === 'NotAllowedError' ? 'Allow microphone access for this site in your browser settings.' : error instanceof Error ? error.message : 'Could not start the microphone.')
    }
  }

  leave(notify = true) {
    const oldSession = this.sessionId
    this.generation++
    if (notify && oldSession) this.options.socket()?.emit('game-audio:leave', { sessionId: oldSession })
    this.peers.forEach(peer => peer.pc.close())
    this.peers.clear()
    this.orphanIce.clear()
    this.members.clear()
    this.localStream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    this.localStream = null
    this.sessionId = ''
    this.joined = false
    this.muted = true
    this.options.onMuted(true)
    this.options.onMembers([])
    this.options.onState('off')
  }

  private publishMembers() { this.options.onMembers([...this.members]) }
  private refreshState() {
    if (!this.sessionId) return this.options.onState('off')
    const connected = [...this.peers.values()].some(peer => peer.pc.connectionState === 'connected')
    // Once the server confirms room entry, players can enable their mic while
    // WebRTC is still negotiating. This lets the first speaker start the mesh.
    this.options.onState(this.joined || connected ? 'on' : 'connecting')
  }
  private isCurrent(sessionId: string, generation: number) { return this.sessionId === sessionId && this.generation === generation }
}
