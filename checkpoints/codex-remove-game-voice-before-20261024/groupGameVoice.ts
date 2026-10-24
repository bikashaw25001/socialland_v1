import type { Socket } from 'socket.io-client'

type VoiceDescription = RTCSessionDescriptionInit
type VoiceCandidate = RTCIceCandidateInit
export type GroupVoiceSignal = { sessionId: string; from: string; kind: 'description' | 'candidate'; data: VoiceDescription | VoiceCandidate }
type PeerLink = {
  userId: string
  connection: RTCPeerConnection
  sender: RTCRtpSender
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  settingAnswer: boolean
  pendingCandidates: VoiceCandidate[]
  remoteStream: MediaStream
  work: Promise<void>
}
type VoiceCallbacks = {
  socket: () => Socket | null
  userId: string
  onState: (state: 'off' | 'connecting' | 'on') => void
  onMuted: (muted: boolean) => void
  onMembers: (ids: string[]) => void
  onStream: (userId: string, stream: MediaStream | null) => void
  notify: (message: string) => void
}

/** Room membership and peer negotiation for the game group voice channel. */
export class GroupGameVoice {
  private roomId = ''
  private generation = 0
  private roomJoined = false
  private microphoneMuted = true
  private microphone: MediaStream | null = null
  private peers = new Map<string, PeerLink>()
  private memberIds = new Set<string>()
  private readonly callbacks: VoiceCallbacks

  constructor(callbacks: VoiceCallbacks) { this.callbacks = callbacks }

  enter(roomId: string) {
    if (!roomId || this.roomId === roomId) return
    this.exit(false)
    this.generation += 1
    this.roomId = roomId
    this.callbacks.onState('connecting')
    this.callbacks.socket()?.emit('game-voice:enter', { sessionId: roomId })
  }

  roomSnapshot(ids: string[]) {
    if (!this.roomId) return
    this.roomJoined = true
    this.memberIds = new Set(ids.filter(id => id && id !== this.callbacks.userId))
    for (const peerId of this.memberIds) this.makePeer(peerId)
    this.publishMembers()
    this.callbacks.onState('on')
  }

  participantEntered(userId: string) {
    if (!userId || userId === this.callbacks.userId || !this.roomId) return
    this.memberIds.add(userId)
    this.makePeer(userId)
    this.publishMembers()
  }

  participantExited(userId: string) {
    this.memberIds.delete(userId)
    const peer = this.peers.get(userId)
    peer?.connection.close()
    this.peers.delete(userId)
    this.callbacks.onStream(userId, null)
    this.publishMembers()
  }

  receiveSignal(signal: GroupVoiceSignal) {
    if (!this.roomId || signal.sessionId !== this.roomId || signal.from === this.callbacks.userId) return
    const peer = this.makePeer(signal.from)
    peer.work = peer.work.then(() => this.applySignal(signal, peer)).catch(error => {
      if (this.isCurrent(peer) && !peer.ignoreOffer) this.callbacks.notify(error instanceof Error ? `Voice connection failed: ${error.message}` : 'Voice connection failed. Rejoin game voice to retry.')
    })
  }

  async toggleMicrophone() {
    if (!this.microphoneMuted) {
      this.microphoneMuted = true
      this.microphone?.getAudioTracks().forEach(track => { track.enabled = false })
      this.callbacks.onMuted(true)
      return
    }
    if (!this.roomId || !this.roomJoined) {
      this.callbacks.notify('Joining the game voice channel. Wait a moment, then turn on your mic.')
      return
    }
    if (this.microphone?.getAudioTracks().some(track => track.readyState === 'live')) {
      this.microphone.getAudioTracks().forEach(track => { track.enabled = true })
      this.microphoneMuted = false
      this.callbacks.onMuted(false)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.callbacks.notify('Microphone access requires localhost or a secure HTTPS connection.')
      return
    }
    const generation = this.generation
    let captured: MediaStream | null = null
    try {
      captured = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (generation !== this.generation || !this.roomId) {
        captured.getTracks().forEach(track => track.stop())
        return
      }
      const track = captured.getAudioTracks()[0]
      if (!track) throw new Error('No microphone was found.')
      track.enabled = true
      this.microphone = captured
      this.microphoneMuted = false
      await Promise.all([...this.peers.values()].map(peer => peer.sender.replaceTrack(track)))
      track.onended = () => {
        if (this.microphone !== captured) return
        this.microphone = null
        this.microphoneMuted = true
        this.callbacks.onMuted(true)
      }
      this.callbacks.onMuted(false)
    } catch (error) {
      captured?.getTracks().forEach(track => track.stop())
      this.microphone = null
      this.microphoneMuted = true
      this.callbacks.onMuted(true)
      this.callbacks.notify(error instanceof Error && error.name === 'NotAllowedError' ? 'Allow microphone access for this site in your browser settings.' : error instanceof Error ? error.message : 'Could not start the microphone.')
    }
  }

  exit(notifyServer = true) {
    const previousRoom = this.roomId
    if (notifyServer && previousRoom) this.callbacks.socket()?.emit('game-voice:exit', { sessionId: previousRoom })
    this.generation += 1
    for (const [userId, peer] of this.peers) {
      peer.connection.close()
      this.callbacks.onStream(userId, null)
    }
    this.peers.clear()
    this.memberIds.clear()
    this.microphone?.getTracks().forEach(track => { track.onended = null; track.stop() })
    this.microphone = null
    this.microphoneMuted = true
    this.roomId = ''
    this.roomJoined = false
    this.callbacks.onMuted(true)
    this.callbacks.onMembers([])
    this.callbacks.onState('off')
  }

  private makePeer(userId: string) {
    const known = this.peers.get(userId)
    if (known) return known
    const connection = new RTCPeerConnection({ iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ] })
    const audio = connection.addTransceiver('audio', { direction: 'sendrecv' })
    const link: PeerLink = {
      userId, connection, sender: audio.sender, polite: this.callbacks.userId.localeCompare(userId) > 0,
      makingOffer: false, ignoreOffer: false, settingAnswer: false,
      pendingCandidates: [], remoteStream: new MediaStream(), work: Promise.resolve(),
    }
    this.peers.set(userId, link)
    const roomId = this.roomId
    const generation = this.generation
    connection.onicecandidate = event => {
      if (event.candidate && this.roomId === roomId && this.generation === generation)
        this.callbacks.socket()?.emit('game-voice:signal', { sessionId: roomId, to: userId, kind: 'candidate', data: event.candidate.toJSON() })
    }
    connection.ontrack = event => {
      if (this.roomId !== roomId || this.generation !== generation) return
      const stream = event.streams[0]
      if (stream) link.remoteStream = stream
      else if (!link.remoteStream.getTracks().some(track => track.id === event.track.id)) link.remoteStream.addTrack(event.track)
      this.callbacks.onStream(userId, link.remoteStream)
    }
    connection.onnegotiationneeded = () => { void this.offer(link, roomId, generation) }
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed' && this.roomId === roomId && this.generation === generation) {
        this.callbacks.notify('Could not connect to a game voice peer. Check network permissions or rejoin voice.')
        try { connection.restartIce() } catch { /* Browser may not support ICE restart. */ }
      }
    }
    if (this.microphone && !this.microphoneMuted) void link.sender.replaceTrack(this.microphone.getAudioTracks()[0] || null).catch(() => {})
    return link
  }

  private async offer(peer: PeerLink, roomId: string, generation: number) {
    if (this.roomId !== roomId || this.generation !== generation) return
    try {
      peer.makingOffer = true
      await peer.connection.setLocalDescription(await peer.connection.createOffer())
      if (this.roomId === roomId && this.generation === generation && peer.connection.localDescription)
        this.callbacks.socket()?.emit('game-voice:signal', { sessionId: roomId, to: peer.userId, kind: 'description', data: peer.connection.localDescription })
    } catch (error) {
      if (this.roomId === roomId && this.generation === generation) this.callbacks.notify(error instanceof Error ? `Voice negotiation failed: ${error.message}` : 'Voice negotiation failed.')
    } finally { peer.makingOffer = false }
  }

  private async applySignal(signal: GroupVoiceSignal, peer: PeerLink) {
    const connection = peer.connection
    if (signal.kind === 'candidate') {
      const candidate = signal.data as VoiceCandidate
      if (connection.remoteDescription) await connection.addIceCandidate(candidate)
      else peer.pendingCandidates.push(candidate)
      return
    }
    const description = signal.data as VoiceDescription
    const readyForOffer = !peer.makingOffer && (connection.signalingState === 'stable' || peer.settingAnswer)
    const collision = description.type === 'offer' && !readyForOffer
    peer.ignoreOffer = !peer.polite && collision
    if (peer.ignoreOffer) return
    if (collision && peer.polite) await connection.setLocalDescription({ type: 'rollback' })
    peer.settingAnswer = description.type === 'answer'
    await connection.setRemoteDescription(description)
    peer.settingAnswer = false
    for (const candidate of peer.pendingCandidates.splice(0)) await connection.addIceCandidate(candidate)
    if (description.type === 'offer') {
      await connection.setLocalDescription(await connection.createAnswer())
      if (connection.localDescription) this.callbacks.socket()?.emit('game-voice:signal', { sessionId: this.roomId, to: signal.from, kind: 'description', data: connection.localDescription })
    }
  }

  private isCurrent(peer: PeerLink) { return [...this.peers.values()].includes(peer) && !!this.roomId }
  private publishMembers() { this.callbacks.onMembers([...this.memberIds]) }
}

/** A single unlocked output element mixes each remote peer without depending on
 * browser autoplay permissions being granted separately for each participant. */
export class GameVoiceOutput {
  private context: AudioContext | null = null
  private destination: MediaStreamAudioDestinationNode | null = null
  private element: HTMLAudioElement | null = null
  private streams = new Map<string, MediaStream>()
  private gains = new Map<string, GainNode>()
  private muted = new Set<string>()
  private enabled = true

  mount(element: HTMLAudioElement) {
    this.element = element
    element.autoplay = true
    element.muted = false
    element.volume = 1
    element.setAttribute('playsinline', '')
    this.prepare()
  }

  add(userId: string, stream: MediaStream | null) {
    if (!stream) {
      this.streams.delete(userId)
      const gain = this.gains.get(userId)
      gain?.disconnect()
      this.gains.delete(userId)
      return
    }
    if (this.streams.get(userId) === stream) return
    const previousGain = this.gains.get(userId)
    previousGain?.disconnect()
    this.gains.delete(userId)
    this.streams.set(userId, stream)
    this.connect(userId, stream)
  }

  setEnabled(enabled: boolean) { this.enabled = enabled; this.updateGains() }
  setMutedUsers(userIds: string[]) { this.muted = new Set(userIds); this.updateGains() }

  async startFromUserGesture() {
    this.prepare()
    if (!this.element) throw new Error('Game audio output is not mounted yet.')
    const playback = this.element.play()
    if (this.context?.state !== 'running') await this.context?.resume()
    this.updateGains()
    await playback
  }

  stop() {
    for (const gain of this.gains.values()) gain.disconnect()
    this.gains.clear()
    this.streams.clear()
    const context = this.context
    this.context = null
    this.destination = null
    if (this.element) { this.element.pause(); this.element.srcObject = null; this.element = null }
    if (context && context.state !== 'closed') void context.close().catch(() => {})
  }

  private prepare() {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.destination = this.context.createMediaStreamDestination()
    }
    if (this.element && this.destination && this.element.srcObject !== this.destination.stream) this.element.srcObject = this.destination.stream
    for (const [userId, stream] of this.streams) this.connect(userId, stream)
  }

  private connect(userId: string, stream: MediaStream) {
    if (!this.context || !this.destination || this.gains.has(userId)) return
    const source = this.context.createMediaStreamSource(stream)
    const gain = this.context.createGain()
    source.connect(gain)
    gain.connect(this.destination)
    this.gains.set(userId, gain)
    this.updateGains()
  }

  private updateGains() {
    for (const [userId, gain] of this.gains) gain.gain.value = this.enabled && !this.muted.has(userId) ? 1 : 0
  }
}
