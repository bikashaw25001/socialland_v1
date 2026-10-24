import 'dotenv/config'
import express from 'express'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import multer from 'multer'
import nodemailer from 'nodemailer'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { Server } from 'socket.io'
import { createReelTranscoder } from './reelTranscode.js'
import { scanModerationFrame, scanUploadedMedia, warmContentModeration } from './contentModeration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: process.env.NODE_ENV === 'production' ? (process.env.CLIENT_ORIGIN || 'http://localhost:5173') : true, credentials: true } })
const PORT = Number(process.env.PORT || 3001)
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me-before-deploying'
let dbReady = false
void warmContentModeration().then(() => console.log('Content moderation model ready')).catch(error => console.error('Content moderation model could not be loaded:', error.message))

app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }))
app.use(express.json({ limit: '4mb' }))
const uploadsDir = path.join(__dirname, 'uploads')
const pendingUploadsDir = path.join(__dirname, 'pending-uploads')
const reelStreamsDir = path.join(__dirname, 'reel-streams')
const storyUploadsDir = path.join(__dirname, 'story-media')
const chatUploadsDir = path.join(__dirname, 'chat-media')
fs.mkdirSync(uploadsDir, { recursive: true })
fs.mkdirSync(pendingUploadsDir, { recursive: true })
fs.mkdirSync(reelStreamsDir, { recursive: true })
fs.mkdirSync(storyUploadsDir, { recursive: true })
fs.mkdirSync(chatUploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', immutable: true, dotfiles: 'deny' }))
app.use('/reel-streams', express.static(reelStreamsDir, { maxAge: '30d', immutable: true, dotfiles: 'deny', setHeaders: res => res.setHeader('Access-Control-Allow-Origin', '*') }))
const allowedMedia = new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['video/mp4','mp4'],['video/webm','webm'],['video/quicktime','mov']])
const upload = multer({ storage: multer.diskStorage({ destination: pendingUploadsDir, filename: (_req, file, cb) => cb(null, `${randomUUID()}.${allowedMedia.get(file.mimetype) || 'bin'}`) }), limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(allowedMedia.has(file.mimetype) ? null : new Error('Upload a JPG, PNG, WebP, MP4, or WebM file.'), allowedMedia.has(file.mimetype)) })
const storyUpload = multer({ storage: multer.diskStorage({ destination: storyUploadsDir, filename: (_req, file, cb) => cb(null, `${randomUUID()}.${allowedMedia.get(file.mimetype) || 'bin'}`) }), limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(allowedMedia.has(file.mimetype) ? null : new Error('Upload a JPG, PNG, WebP, MP4, or WebM file.'), allowedMedia.has(file.mimetype)) })
const allowedChatFiles = new Map([...allowedMedia, ['application/pdf','pdf'],['application/msword','doc'],['application/vnd.openxmlformats-officedocument.wordprocessingml.document','docx'],['application/vnd.ms-excel','xls'],['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','xlsx'],['application/vnd.ms-powerpoint','ppt'],['application/vnd.openxmlformats-officedocument.presentationml.presentation','pptx'],['text/plain','txt'],['text/csv','csv'],['application/rtf','rtf'],['text/rtf','rtf'],['application/vnd.oasis.opendocument.text','odt'],['application/vnd.oasis.opendocument.spreadsheet','ods'],['application/vnd.oasis.opendocument.presentation','odp'],['application/zip','zip']])
const chatMimeByExtension = new Map([...allowedChatFiles].flatMap(([mime, extension]) => [[`.${extension}`, mime], ...(extension === 'jpg' ? [['.jpeg', mime]] : [])]))
const chatMimeForFile = file => allowedChatFiles.has(file.mimetype) ? file.mimetype : chatMimeByExtension.get(path.extname(file.originalname || '').toLowerCase())
const chatUpload = multer({ storage: multer.diskStorage({ destination: chatUploadsDir, filename: (_req, file, cb) => cb(null, `${randomUUID()}.${allowedChatFiles.get(chatMimeForFile(file)) || 'bin'}`) }), limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (_req, file, cb) => { const supported = !!chatMimeForFile(file); cb(supported ? null : new Error('Upload a supported chat file (JPG, PNG, WebP, MP4, WebM, PDF, Office, TXT, CSV, or ZIP).'), supported) } })
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 35, standardHeaders: 'draft-8', legacyHeaders: false }))
const passwordResetLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false })

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true, minlength: 3, maxlength: 24 },
  displayName: { type: String, required: true, trim: true, maxlength: 50 },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  alternateEmail: { type: String, default: '', trim: true, lowercase: true, select: false },
  alternateEmailPending: { type: String, default: '', trim: true, lowercase: true, select: false },
  pendingEmailType: { type: String, enum: ['primary', 'alternate'], select: false },
  alternateEmailCodeHash: { type: String, select: false },
  alternateEmailCodeExpires: { type: Date, select: false },
  alternateEmailCodeAttempts: { type: Number, default: 0, select: false },
  twoStepEnabled: { type: Boolean, default: false },
  twoStepLoginChallengeHash: { type: String, select: false },
  twoStepLoginCodeHash: { type: String, select: false },
  twoStepLoginExpires: { type: Date, select: false },
  twoStepLoginAttempts: { type: Number, default: 0, select: false },
  passwordHash: { type: String, required: true, select: false },
  bio: { type: String, default: '', maxlength: 250 },
  avatarUrl: { type: String, default: '', maxlength: 700000 },
  avatarBorder: { type: String, default: '', maxlength: 40 },
  avatarBorderColor: { type: String, default: '', maxlength: 7 },
  bannerUrl: { type: String, default: '', maxlength: 1800000 },
  lastSeenAt: { type: Date, default: null },
  location: { type: String, default: '', maxlength: 80 },
  website: { type: String, default: '', maxlength: 200 },
  pronouns: { type: String, default: '', maxlength: 40 },
  gender: { type: String, default: '', maxlength: 40 },
  age: { type: Number, default: null, min: 13, max: 120 },
  hobbies: { type: String, default: '', maxlength: 200 },
  relationWith: { type: String, default: '', maxlength: 160 },
  relationshipStatus: { type: String, default: '', maxlength: 40 },
  favoriteGame: { type: String, default: '', maxlength: 80 },
  privateProfile: { type: Boolean, default: false },
  groupAddPrivacy: { type: String, enum: ['anyone','approval'], default: 'anyone' },
  messagePrivacy: { type: String, enum: ['friends','everyone'], default: 'friends' },
  lastSeenPrivacy: { type: String, enum: ['everyone','friends','selected'], default: 'friends' },
  lastSeenFriendIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  reconnectRequired: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  storyAudiencePrivacy: { type: String, enum: ['everyone','friends','selected'], default: 'everyone' },
  storyAudienceFriendIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  passwordResetTokenHash: { type: String, select: false },
  passwordResetCodeHash: { type: String, select: false },
  passwordResetAttempts: { type: Number, default: 0, select: false },
  passwordResetExpires: { type: Date, select: false },
  sessionVersion: { type: Number, default: 0 },
  moderationStrikes: { type: Number, default: 0 },
  bannedAt: { type: Date, default: null },
  banReason: { type: String, default: '', maxlength: 240 },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followRequestsIncoming: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followRequestsOutgoing: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  incoming: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  outgoing: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true })
userSchema.index({ twoStepLoginChallengeHash: 1 }, { unique: true, sparse: true })
const User = mongoose.model('User', userSchema)
const deviceSessionSchema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, sessionId: { type: String, required: true, unique: true }, deviceId: { type: String, required: true, index: true }, deviceName: { type: String, required: true, maxlength: 80 }, location: { type: String, default: 'Approximate location unavailable', maxlength: 160 }, userAgent: { type: String, default: '', maxlength: 500 }, sessionVersion: { type: Number, default: 0 }, lastActiveAt: { type: Date, default: Date.now }, expiresAt: { type: Date, required: true }, revokedAt: { type: Date, default: null } }, { timestamps: true })
deviceSessionSchema.index({ user: 1, revokedAt: 1, expiresAt: 1 })
deviceSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
const DeviceSession = mongoose.model('DeviceSession', deviceSessionSchema)
const emailVerificationSchema = new mongoose.Schema({ email: { type: String, required: true, unique: true, lowercase: true, trim: true }, codeHash: { type: String, required: true }, attempts: { type: Number, default: 0 }, expiresAt: { type: Date, required: true }, verifiedAt: { type: Date, default: null } }, { timestamps: true })
emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
const EmailVerification = mongoose.model('EmailVerification', emailVerificationSchema)
const messageSchema = new mongoose.Schema({ conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true }, sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, senderName: { type: String, default: '' }, system: { type: Boolean, default: false }, replyTo: { type: new mongoose.Schema({ messageId: String, senderId: String, senderName: String, text: String, mediaType: String }, { _id: false }), default: undefined }, text: { type: String, default: '', maxlength: 4000, trim: true }, deliveredAt: { type: Date, default: null }, readAt: { type: Date, default: null }, hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], mediaFilename: { type: String, default: '' }, mediaOriginalName: { type: String, default: '' }, mediaType: { type: String, enum: ['image','video','file'] }, viewOnce: { type: Boolean, default: false }, viewOnceRecipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], viewOnceViewedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], storyContext: { storyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Story' }, authorName: String, mediaType: { type: String, enum: ['image','video'] }, caption: String, action: { type: String, enum: ['reply','like'] } }, partyInvite: { type: new mongoose.Schema({ sessionId: String, url: String, hostId: String, hostName: String, invitedIds: [String], participantIds: [String], controllerIds: [String], status: { type: String, enum: ['open','ended'], default: 'open' } }, { _id: false }), default: undefined }, gameInvite: { type: new mongoose.Schema({ sessionId: String, game: { type: String, enum: ['tic-tac-toe','chess','ludo','math-quiz'] }, status: { type: String, enum: ['open','started','ended','declined'], default: 'open' }, hostId: String, hostName: String, maxPlayers: Number, invitedIds: [String], playerIds: [String], leftPlayerIds: [String], leftPlayerId: String, leftPlayerName: String, quizDifficulty: String, quizTimeLimitMinutes: Number }, { _id: false }), default: undefined }, callLog: { type: new mongoose.Schema({ callId: { type: String, required: true }, mode: { type: String, enum: ['audio','video'], required: true }, event: { type: String, enum: ['started','ended','missed'], required: true } }, { _id: false }), default: undefined } }, { timestamps: true })
messageSchema.index({ conversation: 1, _id: -1 })
messageSchema.index({ conversation: 1, readAt: 1, sender: 1 })
const Message = mongoose.model('Message', messageSchema)
const messagePreview = message => {
  if (!message) return ''
  if (message.callLog) {
    const kind = message.callLog.mode === 'audio' ? 'voice' : 'video'
    return message.callLog.event === 'missed' ? 'Missed ' + kind + ' call' : kind[0].toUpperCase() + kind.slice(1) + ' call ended'
  }
  return message.text || (message.mediaType === 'video' ? 'Video' : message.mediaType === 'file' ? message.mediaOriginalName : 'Photo')
}
const logCallMessage = async (conversationId, actorId, callId, mode, event) => {
  const existing = await Message.findOne({ conversation: conversationId, 'callLog.callId': callId, 'callLog.event': event }).select('_id').lean()
  if (existing) return
  const [conversation, actor] = await Promise.all([Conversation.findById(conversationId), User.findById(actorId).select('displayName')])
  if (!conversation || !actor) return
  const label = mode === 'audio' ? 'Voice call' : 'Video call'
  const message = await Message.create({ conversation: conversation._id, sender: actor._id, senderName: actor.displayName || 'Member', text: '', callLog: { callId, mode, event } })
  conversation.latestText = `${label} ${event}`
  conversation.latestAt = message.createdAt
  await conversation.save()
  const payload = { id: message.id, conversationId: conversation.id, senderId: actor.id, senderName: message.senderName, text: '', callLog: message.callLog, deliveredAt: null, readAt: null, createdAt: message.createdAt }
  io.to(conversation.id).emit('message:new', payload)
  for (const member of conversation.members) io.to(member.toString()).emit('message:new', payload)
}
const activeDirectCalls = new Map()
const pendingDirectIce = new Map()
const pendingDirectEnds = new Map()
const conversationSchema = new mongoose.Schema({ members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }], archivedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], mutedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], isGroup: { type: Boolean, default: false }, groupName: { type: String, default: '', maxlength: 60 }, groupImage: { type: String, default: '', maxlength: 2000 }, directKey: { type: String, unique: true }, latestText: { type: String, default: '' }, latestAt: { type: Date, default: Date.now } }, { timestamps: true })
conversationSchema.index({ members: 1, latestAt: -1 })
const Conversation = mongoose.model('Conversation', conversationSchema)
const groupInvitationSchema = new mongoose.Schema({ conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true }, inviter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, invitee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, status: { type: String, enum: ['pending','accepted','rejected'], default: 'pending' } }, { timestamps: true })
groupInvitationSchema.index({ conversation: 1, invitee: 1, status: 1 })
const GroupInvitation = mongoose.model('GroupInvitation', groupInvitationSchema)
const reportSchema = new mongoose.Schema({ reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, target: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, reason: { type: String, required: true, maxlength: 500 }, conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' } }, { timestamps: true })
const Report = mongoose.model('Report', reportSchema)
const NOTE_THEMES = [
  { id: 'classic', name: 'Classic', symbol: '\u2726', color: '#eeeaff' },
  { id: 'hearts', name: 'Hearts', symbol: '\u2665', color: '#ffe3ec' },
  { id: 'bubbles', name: 'Bubbles', symbol: '\u25cb', color: '#dff5ff' },
  { id: 'happy', name: 'Happy', symbol: '\u263a', color: '#fff2b8' },
  { id: 'sunshine', name: 'Sunshine', symbol: '\u2600', color: '#fff0c2' },
  { id: 'ocean', name: 'Ocean', symbol: '\u2248', color: '#d9f1ff' },
  { id: 'lavender', name: 'Lavender', symbol: '\u273f', color: '#eee3ff' },
  { id: 'blossom', name: 'Blossom', symbol: '\u2740', color: '#ffe4f3' },
  { id: 'galaxy', name: 'Galaxy', symbol: '\u2727', color: '#ded9ff' },
  { id: 'confetti', name: 'Confetti', symbol: '\u2726', color: '#ffe6ca' },
  { id: 'waves', name: 'Waves', symbol: '\u2301', color: '#d8f4ed' },
  { id: 'stars', name: 'Stars', symbol: '\u2605', color: '#e5eaff' },
  { id: 'nature', name: 'Nature', symbol: '\u274b', color: '#e1f2d7' },
  { id: 'candy', name: 'Candy', symbol: '\u25cf', color: '#ffe2dc' },
  { id: 'sunset', name: 'Sunset', symbol: '\u25d2', color: '#ffdfd0' },
  { id: 'floral', name: 'Floral', symbol: '\u2741', color: '#f7e5cf' },
  { id: 'rainbow', name: 'Rainbow', symbol: '\u25c9', color: '#f4e3ff' },
  { id: 'sparkle', name: 'Sparkle', symbol: '\u2727', color: '#f1e9ff' },
  { id: 'clouds', name: 'Clouds', symbol: '\u2601', color: '#e7f2ff' },
  { id: 'retro', name: 'Retro', symbol: '\u25a6', color: '#f5e6c8' },
  { id: 'leaf', name: 'Leaf', symbol: '\u2619', color: '#e2f2e3' },
  { id: 'neon', name: 'Neon', symbol: '\u2733', color: '#e1f6df' },
  { id: 'cherry', name: 'Cherry', symbol: '\u25cf', color: '#ffdfe1' },
  { id: 'cozy', name: 'Cozy', symbol: '\u274b', color: '#f5e5d7' },
  { id: 'custom', name: 'Custom color', symbol: '\u25c9', color: '#e9e4ff' },
]
const isValidNoteColor = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
const postSchema = new mongoose.Schema({ author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, caption: { type: String, default: '', maxlength: 15000 }, topics: { type: [String], default: [] }, mediaUrl: { type: String, default: '' }, mediaType: { type: String, enum: ['image','video'], default: 'image' }, mediaItems: { type: [{ url: { type: String, required: true }, type: { type: String, enum: ['image','video'], required: true }, variants: { type: [{ width: Number, url: String }], default: undefined }, playback: { status: { type: String, enum: ['queued','processing','ready','fallback'], default: 'fallback' }, masterUrl: { type: String, default: '' }, av1Url: { type: String, default: '' } } }], default: undefined }, kind: { type: String, enum: ['post','reel','note'], default: 'post', index: true }, moderationStatus: { type: String, enum: ['pending','processing','approved','removed'], default: 'approved', index: true }, moderationStartedAt: { type: Date, default: null }, mediaDelivery: { status: { type: String, enum: ['queued','processing','ready','fallback'], default: 'fallback' }, masterUrl: { type: String, default: '' }, av1Url: { type: String, default: '' }, processedAt: { type: Date, default: null } }, likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], commentCount: { type: Number, default: 0 }, shareCount: { type: Number, default: 0 }, likesHidden: { type: Boolean, default: false }, commentsDisabled: { type: Boolean, default: false }, archived: { type: Boolean, default: false }, noteTheme: { type: String, default: 'classic', maxlength: 24 }, noteBackgroundColor: { type: String, default: '#eeeaff', maxlength: 7 }, noteTextColor: { type: String, default: '#342e48', maxlength: 7 } }, { timestamps: true })
postSchema.index({ kind: 1, author: 1, createdAt: -1 })
const Post = mongoose.model('Post', postSchema)
const recommendationSignalSchema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true }, author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, action: { type: String, enum: ['view','skip','like','comment','share'], required: true }, topics: { type: [String], default: [] }, watchMs: { type: Number, default: 0, min: 0, max: 60000 } }, { timestamps: true })
recommendationSignalSchema.index({ user: 1, post: 1, action: 1 }, { unique: true })
recommendationSignalSchema.index({ user: 1, updatedAt: -1 })
recommendationSignalSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 15552000 })
const RecommendationSignal = mongoose.model('RecommendationSignal', recommendationSignalSchema)
const transcodeReel = createReelTranscoder({ outputRoot: reelStreamsDir })
const reelTranscodeQueue = []
let reelTranscodeRunning = false
const scheduleVideoTranscode = (postId, sourceUrl, mediaIndex = 0) => {
  if (!sourceUrl?.startsWith('/uploads/')) return
  reelTranscodeQueue.push({ postId: String(postId), mediaIndex, sourceUrl, sourcePath: path.join(uploadsDir, path.basename(sourceUrl)) })
  if (reelTranscodeRunning) return
  reelTranscodeRunning = true
  void (async () => {
    while (reelTranscodeQueue.length) {
      const job = reelTranscodeQueue.shift()
      const mediaPath = `mediaItems.${job.mediaIndex}.playback`
        const streamId = `${job.postId}-${job.mediaIndex}`
      try {
        const post = await Post.findById(job.postId).select('kind moderationStatus mediaUrl mediaDelivery mediaItems')
        const item = post?.mediaItems?.[job.mediaIndex]
        if (!post || ['pending','processing','removed'].includes(post.moderationStatus) || !['post','reel'].includes(post.kind) || item?.type !== 'video' || item.url !== job.sourceUrl || !fs.existsSync(job.sourcePath)) continue
        const isPrimaryReel = post.kind === 'reel' && job.mediaIndex === 0
        const processing = { [mediaPath + '.status']: 'processing', ...(isPrimaryReel ? { 'mediaDelivery.status': 'processing' } : {}) }
        await Post.updateOne({ _id: job.postId }, { $set: processing })
        const result = await transcodeReel(job.sourcePath, streamId, { onAv1Ready: async delivery => {
          const fields = { [mediaPath + '.av1Url']: delivery.av1Url, ...(isPrimaryReel ? { 'mediaDelivery.av1Url': delivery.av1Url } : {}) }
          const update = await Post.updateOne({ _id: job.postId, [`mediaItems.${job.mediaIndex}.url`]: job.sourceUrl }, { $set: fields }); if (!update.matchedCount) await fs.promises.rm(path.join(reelStreamsDir, streamId), { recursive: true, force: true })
        } })
        const ready = { [mediaPath + '.status']: 'ready', [mediaPath + '.masterUrl']: result.masterUrl, [mediaPath + '.av1Url']: result.av1Url, ...(isPrimaryReel ? { 'mediaDelivery.status': 'ready', 'mediaDelivery.masterUrl': result.masterUrl, 'mediaDelivery.av1Url': result.av1Url, 'mediaDelivery.processedAt': new Date() } : {}) }
        const update = await Post.updateOne({ _id: job.postId, [`mediaItems.${job.mediaIndex}.url`]: job.sourceUrl }, { $set: ready }); if (!update.matchedCount) await fs.promises.rm(path.join(reelStreamsDir, streamId), { recursive: true, force: true })
      } catch (error) {
        console.error(`Post video transcode failed for ${job.postId}:`, error.message)
        const isPrimaryReel = (await Post.findById(job.postId).select('kind').lean())?.kind === 'reel' && job.mediaIndex === 0
        await Post.updateOne({ _id: job.postId, [`mediaItems.${job.mediaIndex}.url`]: job.sourceUrl }, { $set: { [mediaPath + '.status']: 'fallback', ...(isPrimaryReel ? { 'mediaDelivery.status': 'fallback' } : {}) } }).catch(() => {})
      }
    }
    reelTranscodeRunning = false
  })()
}
const profileNoteSchema = new mongoose.Schema({ author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, text: { type: String, required: true, trim: true, maxlength: 500 }, likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], shareCount: { type: Number, default: 0 }, likesHidden: { type: Boolean, default: false }, noteTheme: { type: String, default: 'classic', maxlength: 24 }, noteBackgroundColor: { type: String, default: '#eeeaff', maxlength: 7 }, noteTextColor: { type: String, default: '#342e48', maxlength: 7 } }, { timestamps: true })
const ProfileNote = mongoose.model('ProfileNote', profileNoteSchema)
const commentSchema = new mongoose.Schema({ post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, index: true }, author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, parentComment: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null, index: true }, likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], text: { type: String, required: true, trim: true, maxlength: 1000 } }, { timestamps: true })
const Comment = mongoose.model('Comment', commentSchema)
const activitySchema = new mongoose.Schema({ recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, type: { type: String, enum: ['friend_request','friend_accepted','follow_request','like','comment','share','message','story_like','moderation_warning'], required: true }, post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' }, postKind: { type: String, enum: ['post','reel','note'] }, message: { type: String, default: '', maxlength: 500 }, strikeCount: { type: Number, default: 0 }, read: { type: Boolean, default: false } }, { timestamps: true })
activitySchema.index({ recipient: 1, createdAt: -1 })
const Activity = mongoose.model('Activity', activitySchema)
const storySchema = new mongoose.Schema({ author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, mediaUrl: { type: String, required: true }, mediaType: { type: String, enum: ['image','video'], required: true }, caption: { type: String, default: '', maxlength: 240 }, privacy: { type: String, enum: ['everyone','friends','selected'], default: 'everyone' }, selectedFriends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], views: [{ _id: false, user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, seenAt: { type: Date, default: Date.now } }], expiresAt: { type: Date, required: true } }, { timestamps: true })
const Story = mongoose.model('Story', storySchema)
const cleanExpiredStories = async () => {
  const expired = await Story.find({ expiresAt: { $lte: new Date() } }).select('_id mediaUrl').lean()
  if (!expired.length) return
  await Story.deleteMany({ _id: { $in: expired.map(story => story._id) } })
  await Promise.all(expired.map(removeStoryMedia))
}
const removeStoryMedia = story => {
  const filename = path.basename(story.mediaUrl || '')
  if (!filename) return Promise.resolve()
  const directory = story.mediaUrl.startsWith('/story-media/') ? storyUploadsDir : story.mediaUrl.startsWith('/uploads/') ? uploadsDir : null
  return directory ? fs.promises.unlink(path.join(directory, filename)).catch(() => {}) : Promise.resolve()
}
const secureActiveStoryMedia = async () => {
  const stories = await Story.find({ mediaUrl: /^\/uploads\//, expiresAt: { $gt: new Date() } })
  for (const story of stories) {
    const filename = path.basename(story.mediaUrl)
    try { await fs.promises.rename(path.join(uploadsDir, filename), path.join(storyUploadsDir, filename)); story.mediaUrl = `/story-media/${filename}`; await story.save() }
    catch (err) { if (err.code !== 'ENOENT') console.error('Story media migration failed:', err.message) }
  }
}
const selectedStoryFriends = (value, user) => {
  let ids = value
  if (typeof ids === 'string') { try { ids = JSON.parse(ids) } catch { return null } }
  if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id))) return null
  const unique = [...new Set(ids)]
  const friends = new Set(user.friends.map(id => id.toString()))
  return unique.every(id => friends.has(id)) ? unique.map(id => new mongoose.Types.ObjectId(id)) : null
}

const publicUser = user => ({ id: user._id.toString(), username: user.username, displayName: user.displayName, accountCreatedAt: user.createdAt || null, isBanned: !!user.bannedAt, bio: user.bio || '', avatarUrl: user.avatarUrl || '', avatarBorder: user.avatarBorder || '', avatarBorderColor: user.avatarBorderColor || '', location: user.location || '', website: user.website || '', pronouns: user.pronouns || '', gender: user.gender || '', age: user.age ?? null, hobbies: user.hobbies || '', relationWith: user.relationWith || '', relationshipStatus: user.relationshipStatus || '', favoriteGame: user.favoriteGame || '', messagePrivacy: user.messagePrivacy || 'friends' })
const publicProfileUser = user => ({ ...publicUser(user), bannerUrl: user.bannerUrl || '', privateProfile: !!user.privateProfile, followerCount: user.followers?.length || 0, followingCount: user.following?.length || 0, friendCount: user.friends?.length || 0 })
const publicActivity = activity => ({ id: activity._id.toString(), type: activity.type, actor: publicUser(activity.actor), postId: activity.post?._id?.toString() || activity.post?.toString() || '', postKind: activity.postKind || 'post', message: activity.message || '', strikeCount: activity.strikeCount || 0, read: activity.read, createdAt: activity.createdAt })
const publicStory = (story, viewerId) => { const id = story._id.toString(); const mediaToken = jwt.sign({ purpose: 'story-media', storyId: id, viewerId: viewerId.toString() }, JWT_SECRET, { expiresIn: '24h' }); const owner = story.author._id?.toString() === viewerId.toString() || story.author.toString?.() === viewerId.toString(); return { id, author: publicUser(story.author), mediaUrl: `/api/stories/${id}/media?token=${mediaToken}`, mediaType: story.mediaType, caption: story.caption || '', privacy: story.privacy || 'everyone', likesCount: (story.likes || []).length, likedByMe: (story.likes || []).some(userId => userId.toString() === viewerId.toString()), seenByMe: !owner && (story.views || []).some(view => view.user?.toString() === viewerId.toString()), ...(owner ? { selectedFriendIds: (story.selectedFriends || []).map(id => id._id?.toString() || id.toString()), viewsCount: (story.views || []).length } : {}), createdAt: story.createdAt, expiresAt: story.expiresAt } }
const canViewStory = async (story, user, authorRecord) => {
  const authorId = story.author._id || story.author
  if (authorId.toString() === user._id.toString()) return true
  const author = authorRecord || await User.findById(authorId).select('privateProfile followers')
  if (!author) return false
  const follower = (author.followers || []).some(id => id.equals(user._id))
  const friend = isFriend(user, authorId)
  if (author.privateProfile && !follower && !friend) return false
  return (!story.privacy || story.privacy === 'everyone') && (follower || friend) || story.privacy === 'friends' && friend || story.privacy === 'selected' && friend && (story.selectedFriends || []).some(id => id.equals(user._id))
}
const createActivity = async (recipientId, actorId, type, postId, postKind) => {
  if (!recipientId || recipientId.toString() === actorId.toString()) return
  const activity = await Activity.create({ recipient: recipientId, actor: actorId, type, ...(postId ? { post: postId, postKind } : {}) })
  await activity.populate('actor', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
  const payload = publicActivity(activity)
  io.to(recipientId.toString()).emit('activity:new', payload)
  return payload
}
const moderationQueue = []
const moderationQueuedIds = new Set()
let moderationWorkerRunning = false
const enqueuePostModeration = postId => {
  const id = String(postId)
  if (!id || moderationQueuedIds.has(id)) return
  moderationQueuedIds.add(id)
  moderationQueue.push(id)
  if (moderationWorkerRunning) return
  moderationWorkerRunning = true
  void (async () => {
    while (moderationQueue.length) {
      const nextId = moderationQueue.shift()
      try { await moderatePost(nextId) }
      catch (error) {
        console.error(`Content moderation failed for ${nextId}:`, error.message)
        await Post.updateOne({ _id: nextId, moderationStatus: 'processing' }, { $set: { moderationStatus: 'pending', moderationStartedAt: null } }).catch(() => {})
        const retry = setTimeout(() => enqueuePostModeration(nextId), 30_000)
        retry.unref?.()
      } finally { moderationQueuedIds.delete(nextId) }
    }
    moderationWorkerRunning = false
  })()
}
const postMediaFiles = post => [...new Set([...(post.mediaItems || []).flatMap(item => [item.url, ...(item.variants || []).map(variant => variant.url)]), post.mediaUrl].filter(Boolean))]
const removePostMedia = async post => {
  await Promise.all(postMediaFiles(post).map(url => {
    if (!String(url).startsWith('/uploads/')) return Promise.resolve()
    const filename = path.basename(url)
    return Promise.all([fs.promises.unlink(path.join(uploadsDir, filename)).catch(() => {}), fs.promises.unlink(path.join(pendingUploadsDir, filename)).catch(() => {})])
  }))
  await fs.promises.rm(path.join(reelStreamsDir, String(post._id)), { recursive: true, force: true }).catch(() => {})
  for (let index = 0; index < (post.mediaItems || []).length; index++) await fs.promises.rm(path.join(reelStreamsDir, `${post._id}-${index}`), { recursive: true, force: true }).catch(() => {})
}
const warnAndCountModerationStrike = async (post, scan) => {
  const user = await User.findByIdAndUpdate(post.author, { $inc: { moderationStrikes: 1 } }, { new: true })
  if (!user) return
  const isBanned = user.moderationStrikes >= 3
  if (isBanned && !user.bannedAt) {
    user.bannedAt = new Date()
    user.banReason = 'Three pieces of content were removed for nudity.'
    user.sessionVersion = (user.sessionVersion || 0) + 1
    await user.save()
    await DeviceSession.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } })
  }
  const contentLabel = post.kind === 'reel' ? 'Reel' : post.kind === 'story' ? 'Story' : post.kind === 'live' ? 'live broadcast' : 'post'
  const contentAction = post.kind === 'live' ? 'ended' : 'removed'
  const message = isBanned
    ? `Your ${contentLabel} was ${contentAction} because nudity was detected. This is your third violation, so your account has been permanently banned.`
    : `Your ${contentLabel} was ${contentAction} because the content classifier detected nudity. This is warning ${user.moderationStrikes} of 3; another violation will permanently ban your account.`
  const activity = await Activity.create({ recipient: user._id, actor: user._id, type: 'moderation_warning', message, strikeCount: user.moderationStrikes })
  await activity.populate('actor', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
  io.to(user._id.toString()).emit('activity:new', publicActivity(activity))
  if (post.kind === 'post' || post.kind === 'reel') io.to(user._id.toString()).emit('post:moderation', { postId: post._id.toString(), status: 'removed' })
  if (isBanned) {
    io.to(user._id.toString()).emit('account:banned', { message })
    io.in(user._id.toString()).disconnectSockets(true)
  }
  console.warn(`Moderated ${post.kind} ${post._id || 'live'} for classifier ${scan.label} (${scan.score.toFixed(3)}); @${user.username} has ${user.moderationStrikes} strike(s).`)
}
const moderatePost = async postId => {
  const post = await Post.findOneAndUpdate({ _id: postId, moderationStatus: 'pending', kind: { $in: ['post','reel'] } }, { $set: { moderationStatus: 'processing', moderationStartedAt: new Date() } }, { new: true }).lean()
  if (!post) return
  const sources = [...new Map((post.mediaItems?.length ? post.mediaItems : post.mediaUrl ? [{ url: post.mediaUrl, type: post.mediaType }] : []).filter(item => item?.url?.startsWith('/uploads/')).map(item => {
    const filename = path.basename(item.url)
    const pendingPath = path.join(pendingUploadsDir, filename)
    return [item.url, { path: fs.existsSync(pendingPath) ? pendingPath : path.join(uploadsDir, filename), mimetype: item.type === 'video' ? `video/${path.extname(item.url).slice(1)}` : `image/${path.extname(item.url).slice(1)}` }]
  })).values()]
  if (!sources.length || sources.some(file => !fs.existsSync(file.path))) throw new Error('An uploaded media file is missing; keeping the post hidden for retry.')
  const scan = await scanUploadedMedia(sources)
  if (scan.flagged) {
    const claimed = await Post.findOneAndUpdate({ _id: post._id, moderationStatus: 'processing' }, { $set: { moderationStatus: 'removed' } }, { new: true }).select('_id').lean()
    if (!claimed) { await removePostMedia(post); return }
    await Comment.deleteMany({ post: post._id })
    await RecommendationSignal.deleteMany({ post: post._id })
    await Post.deleteOne({ _id: post._id })
    await removePostMedia(post)
    await warnAndCountModerationStrike(post, scan)
    return
  }
  for (const url of postMediaFiles(post)) {
    if (!String(url).startsWith('/uploads/')) continue
    const filename = path.basename(url), pendingPath = path.join(pendingUploadsDir, filename), publicPath = path.join(uploadsDir, filename)
    if (fs.existsSync(pendingPath)) await fs.promises.rename(pendingPath, publicPath)
    else if (!fs.existsSync(publicPath)) throw new Error('A scanned media file disappeared before publication.')
  }
  const approved = await Post.findOneAndUpdate({ _id: post._id, moderationStatus: 'processing' }, { $set: { moderationStatus: 'approved', moderationStartedAt: null } }, { new: true }).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
  if (!approved) { await removePostMedia(post); return }
  approved.mediaItems?.forEach((item, index) => { if (item.type === 'video') scheduleVideoTranscode(approved._id, item.url, index) })
  io.to(approved.author._id.toString()).emit('post:moderation', { postId: approved._id.toString(), status: 'approved', post: publicPost(approved, approved.author._id) })
}
const MESSAGE_NOTIFICATION_IDLE_MS = 3 * 24 * 60 * 60 * 1000
const shouldNotifyMessage = async conversationId => {
  const latestMessage = await Message.findOne({ conversation: conversationId }).sort({ createdAt: -1 }).select('createdAt').lean()
  return !latestMessage || Date.now() - new Date(latestMessage.createdAt).getTime() >= MESSAGE_NOTIFICATION_IDLE_MS
}
const tokenFor = user => jwt.sign({ sub: user._id.toString(), ver: user.sessionVersion || 0 }, JWT_SECRET, { expiresIn: '7d' })
const deviceSessionRoom = sessionId => `device-session:${sessionId}`
const deviceDetailsFor = req => {
  const rawAgent = String(req.get('user-agent') || '').slice(0, 500)
  const deviceId = String(req.body?.deviceId || '').trim()
  const platform = /iPhone/i.test(rawAgent) ? 'iPhone' : /iPad/i.test(rawAgent) ? 'iPad' : /Android/i.test(rawAgent) ? 'Android device' : /Windows/i.test(rawAgent) ? 'Windows PC' : /Macintosh|Mac OS/i.test(rawAgent) ? 'Mac' : /Linux/i.test(rawAgent) ? 'Linux PC' : 'Unknown device'
  const browser = /Edg\//i.test(rawAgent) ? 'Edge' : /Firefox\//i.test(rawAgent) ? 'Firefox' : /Chrome\//i.test(rawAgent) ? 'Chrome' : /Safari\//i.test(rawAgent) ? 'Safari' : 'Browser'
  const headers = req.headers || {}
  const clean = value => String(value || '').replace(/[\r\n<>]/g, '').trim().slice(0, 70)
  const city = clean(headers['cf-ipcity'] || headers['x-vercel-ip-city'])
  const region = clean(headers['cf-region'] || headers['x-vercel-ip-country-region'])
  const country = clean(headers['cf-ipcountry'] || headers['x-vercel-ip-country'])
  const location = [city, region && region !== city ? region : '', country].filter(Boolean).join(', ') || 'Approximate location unavailable'
  return { deviceId: /^[a-zA-Z0-9-]{16,80}$/.test(deviceId) ? deviceId : randomUUID(), deviceName: `${platform} - ${browser}`.slice(0, 80), location, userAgent: rawAgent }
}
const createDeviceLogin = async (user, req) => {
  const details = deviceDetailsFor(req)
  const knownDevice = await DeviceSession.exists({ user: user._id, deviceId: details.deviceId })
  const sessionId = randomUUID()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await DeviceSession.create({ user: user._id, sessionId, ...details, sessionVersion: user.sessionVersion || 0, lastActiveAt: new Date(), expiresAt })
  if (!knownDevice && mailTransport) {
    const when = new Date().toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC'
    const text = `A new device signed in to your Social Land account.\n\nDevice: ${details.deviceName}\nApproximate location: ${details.location}\nTime: ${when}\n\nIf this was not you, change your password and log out of unfamiliar devices in Settings > Security.`
    void mailTransport.sendMail({ from: process.env.EMAIL_FROM || 'Social Land <' + process.env.GMAIL_USER + '>', to: user.email, subject: 'New device login to Social Land', text, html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:24px;color:#211d31"><h2>New device login</h2><p>A device signed in to your Social Land account.</p><p><b>Device:</b> ${details.deviceName}<br/><b>Approximate location:</b> ${details.location}<br/><b>Time:</b> ${when}</p><p>If this was not you, change your password and log out of unfamiliar devices in Settings &gt; Security.</p></div>` }).catch(error => console.error('Could not send new-device login alert:', error.message))
  }
  return { token: jwt.sign({ sub: user._id.toString(), ver: user.sessionVersion || 0, sid: sessionId }, JWT_SECRET, { expiresIn: '7d' }), newDevice: !knownDevice }
}
const auth = async (req, res, next) => {
  if (!dbReady) return res.status(503).json({ error: 'Database is not connected yet. Add MONGODB_URI to .env and restart the server.' })
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Please log in to continue.' })
  try { const claims = jwt.verify(token, JWT_SECRET); req.user = await User.findById(claims.sub); if (!req.user) return res.status(401).json({ error: 'Account no longer exists.' }); if (req.user.bannedAt) return res.status(403).json({ error: `Your account is banned. Reason: ${req.user.banReason || 'Repeated nudity violations.'}` }); if ((claims.ver || 0) !== (req.user.sessionVersion || 0)) return res.status(401).json({ error: 'Your password changed. Please log in again.' }); if (claims.sid) { const session = await DeviceSession.findOne({ sessionId: claims.sid, user: req.user._id, sessionVersion: claims.ver || 0, revokedAt: null, expiresAt: { $gt: new Date() } }).select('_id lastActiveAt'); if (!session) return res.status(401).json({ error: 'This device session has been logged out. Please sign in again.' }); req.deviceSession = session; if (Date.now() - new Date(session.lastActiveAt).getTime() > 5 * 60 * 1000) void DeviceSession.updateOne({ _id: session._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {}) } next() }
  catch { return res.status(401).json({ error: 'Your session expired. Please log in again.' }) }
}
const dbOnly = (req, res, next) => dbReady ? next() : res.status(503).json({ error: 'Database is not connected yet. Add MONGODB_URI to .env and restart the server.' })
const handle = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const isFriend = (a, b) => a.friends.some(id => id.toString() === b.toString())
const acceptedFriendship = (a, b) => !!a && !!b && isFriend(a, b._id) && isFriend(b, a._id)
const pairRequiresReconnect = (first, second) => (first?.reconnectRequired || []).some(id => id.toString() === String(second?._id)) || (second?.reconnectRequired || []).some(id => id.toString() === String(first?._id))
const pairIsBlocked = (first, second) => (first?.blockedUsers || []).some(id => id.toString() === String(second?._id)) || (second?.blockedUsers || []).some(id => id.toString() === String(first?._id))
const canUseFriendFeatures = (first, second) => !!first && !!second && !pairIsBlocked(first, second) && !pairRequiresReconnect(first, second) && acceptedFriendship(first, second)
const canViewPresence = (viewer, target) => {
  if (!viewer || !target || !Array.isArray(viewer.friends) || !Array.isArray(target.friends) || String(viewer._id) === String(target._id) || pairIsBlocked(viewer, target)) return false
  if ((target.lastSeenPrivacy || 'friends') === 'everyone' && target.messagePrivacy === 'everyone') return true
  if (!acceptedFriendship(viewer, target)) return false
  if ((target.lastSeenPrivacy || 'friends') === 'selected') return (target.lastSeenFriendIds || []).some(id => id.toString() === String(viewer._id))
  return true
}
const canDirectlyInteract = (sender, recipient) => {
  if (!sender || !recipient || String(sender._id) === String(recipient._id)) return false
  return !pairIsBlocked(sender, recipient) && !pairRequiresReconnect(sender, recipient) && (acceptedFriendship(sender, recipient) || recipient.messagePrivacy === 'everyone')
}
const directPairFor = async (firstId, secondId) => User.find({ _id: { $in: [firstId, secondId] } }).select('_id friends blockedUsers reconnectRequired messagePrivacy')
const canDirectlyInteractIds = async (senderId, recipientId) => {
  const users = await directPairFor(senderId, recipientId)
  const sender = users.find(user => user._id.toString() === String(senderId)), recipient = users.find(user => user._id.toString() === String(recipientId))
  return canDirectlyInteract(sender, recipient)
}
const canUseFriendFeaturesIds = async (firstId, secondId) => {
  const users = await directPairFor(firstId, secondId)
  return canUseFriendFeatures(users.find(user => user._id.toString() === String(firstId)), users.find(user => user._id.toString() === String(secondId)))
}
const canInteractWithoutBlockIds = async (firstId, secondId) => {
  const users = await directPairFor(firstId, secondId)
  const first = users.find(user => user._id.toString() === String(firstId)), second = users.find(user => user._id.toString() === String(secondId))
  return !!first && !!second && !pairIsBlocked(first, second) && !pairRequiresReconnect(first, second)
}
const canViewUserContent = async (viewer, author) => {
  const authorId = author._id || author
  if (viewer._id.equals(authorId) || isFriend(viewer, authorId) || (viewer.following || []).some(id => id.toString() === authorId.toString())) return true
  if (author && typeof author === 'object' && Object.prototype.hasOwnProperty.call(author, 'privateProfile')) return !author.privateProfile
  const profile = await User.findById(authorId).select('privateProfile')
  return !!profile && !profile.privateProfile
}

app.get('/api/health', (req, res) => res.json({ ok: true, database: dbReady ? 'connected' : 'not-configured' }))
app.post('/api/auth/register', dbOnly, handle(async (req, res) => {
  const { username, displayName, email, password } = req.body || {}
  const normalized = String(username || '').trim().toLowerCase()
  if (!/^[a-z0-9_]{3,24}$/.test(normalized)) return res.status(400).json({ error: 'Username must be 3â€“24 characters using letters, numbers, or underscores.' })
  if (!String(displayName || '').trim() || String(displayName).trim().length > 50) return res.status(400).json({ error: 'Please enter a display name under 50 characters.' })
  if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) return res.status(400).json({ error: 'Enter a valid email address.' })
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8â€“72 characters.' })
  const normalizedEmail = String(email).trim().toLowerCase()
  const bannedEmailAccount = await User.findOne({ $or: [{ email: normalizedEmail }, { alternateEmail: normalizedEmail }, { alternateEmailPending: normalizedEmail }], bannedAt: { $ne: null } }).select('banReason')
  if (bannedEmailAccount) return res.status(403).json({ error: `This email belongs to a banned account and cannot be used to create another account. Reason: ${bannedEmailAccount.banReason || 'Repeated nudity violations.'}` })
  if (await User.exists({ $or: [{ email: normalizedEmail }, { alternateEmail: normalizedEmail }, { alternateEmailPending: normalizedEmail }] })) return res.status(409).json({ error: 'An account with that email already exists.' })
  if (await User.exists({ username: normalized })) return res.status(409).json({ error: 'That username is already taken.' })
  if (!await EmailVerification.exists({ email: normalizedEmail, verifiedAt: { $ne: null }, expiresAt: { $gt: new Date() } })) return res.status(403).json({ error: 'Verify your email address before creating your account.' })
  const user = await User.create({ username: normalized, displayName: String(displayName).trim(), email: normalizedEmail, passwordHash: await bcrypt.hash(password, 12) })
  await EmailVerification.deleteOne({ email: normalizedEmail })
  const session = await createDeviceLogin(user, req)
  res.status(201).json({ ...session, user: publicUser(user) })
}))
app.post('/api/auth/login', dbOnly, handle(async (req, res) => {
  const identity = String(req.body?.identity || '').trim().toLowerCase()
  const user = await User.findOne({ $or: [{ email: identity }, { username: identity }] }).select('+passwordHash +twoStepEnabled')
  if (user?.bannedAt) return res.status(403).json({ error: `Your account is banned. Reason: ${user.banReason || 'Repeated nudity violations.'}` })
  if (!user || !await bcrypt.compare(String(req.body?.password || ''), user.passwordHash)) return res.status(401).json({ error: 'Sign-in failed. Check your details and try again.' })
  if (user.twoStepEnabled) {
    if (!mailTransport) return res.status(503).json({ error: 'Two-step verification email is not configured. Contact support before trying to sign in.' })
    const challengeToken = randomBytes(32).toString('base64url')
    const code = String(randomInt(100000, 1000000))
    user.twoStepLoginChallengeHash = hashResetToken(challengeToken)
    user.twoStepLoginCodeHash = hashResetToken(code)
    user.twoStepLoginExpires = new Date(Date.now() + 10 * 60 * 1000)
    user.twoStepLoginAttempts = 0
    await user.save()
    try {
      await mailTransport.sendMail({
        from: process.env.EMAIL_FROM || 'Social Land <' + process.env.GMAIL_USER + '>',
        to: user.email,
        subject: 'Your Social Land sign-in verification code',
        text: 'Your Social Land sign-in code is ' + code + '. Enter it within 10 minutes to finish signing in. If you did not try to sign in, change your password.',
        html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#211d31"><h2>Finish signing in to Social Land</h2><p>Enter this six-digit code to continue:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;padding:16px;background:#f1effa;border-radius:12px;text-align:center">' + code + '</p><p>This code expires in 10 minutes. If you did not try to sign in, change your password.</p></div>',
      })
    } catch (error) {
      user.twoStepLoginChallengeHash = undefined
      user.twoStepLoginCodeHash = undefined
      user.twoStepLoginExpires = undefined
      user.twoStepLoginAttempts = 0
      await user.save()
      return res.status(503).json({ error: 'Could not send the sign-in code. Please try again.' })
    }
    return res.json({ twoStepRequired: true, challengeToken, maskedEmail: maskEmail(user.email) })
  }
  const session = await createDeviceLogin(user, req)
  res.json({ ...session, user: publicUser(user) })
}))
const mailTransport = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') } })
  : null
const hashResetToken = token => createHash('sha256').update(token).digest('hex')
app.post('/api/auth/verify-login-code', passwordResetLimit, dbOnly, handle(async (req, res) => {
  const challengeToken = String(req.body?.challengeToken || '')
  const code = String(req.body?.code || '').trim()
  if (!challengeToken || challengeToken.length > 200 || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the six-digit sign-in code.' })
  const user = await User.findOne({ twoStepLoginChallengeHash: hashResetToken(challengeToken) }).select('+twoStepEnabled +twoStepLoginChallengeHash +twoStepLoginCodeHash +twoStepLoginExpires +twoStepLoginAttempts')
  if (user?.bannedAt) return res.status(403).json({ error: `Your account is banned. Reason: ${user.banReason || 'Repeated nudity violations.'}` })
  const valid = user?.twoStepEnabled && user.twoStepLoginCodeHash === hashResetToken(code) && user.twoStepLoginExpires > new Date() && user.twoStepLoginAttempts < 5
  if (!valid) {
    if (user?.twoStepLoginExpires > new Date() && user.twoStepLoginAttempts < 5) {
      user.twoStepLoginAttempts += 1
      await user.save()
    }
    return res.status(400).json({ error: 'That sign-in code is incorrect or expired. Log in again to request a new code.' })
  }
  user.twoStepLoginChallengeHash = undefined
  user.twoStepLoginCodeHash = undefined
  user.twoStepLoginExpires = undefined
  user.twoStepLoginAttempts = 0
  await user.save()
  const session = await createDeviceLogin(user, req)
  res.json({ ...session, user: publicUser(user) })
}))
const registrationCodeLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false })
app.post('/api/auth/register/send-code', registrationCodeLimit, dbOnly, handle(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase()
  const displayName = String(req.body?.displayName || '').trim()
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3â€“24 characters using letters, numbers, or underscores.' })
  if (!displayName || displayName.length > 50) return res.status(400).json({ error: 'Please enter a display name under 50 characters.' })
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' })
  const bannedEmailAccount = await User.findOne({ $or: [{ email }, { alternateEmail: email }, { alternateEmailPending: email }], bannedAt: { $ne: null } }).select('banReason')
  if (bannedEmailAccount) return res.status(403).json({ error: `This email belongs to a banned account and cannot be used to create another account. Reason: ${bannedEmailAccount.banReason || 'Repeated nudity violations.'}` })
  if (await User.exists({ $or: [{ email }, { alternateEmail: email }, { alternateEmailPending: email }] })) return res.status(409).json({ error: 'An account with that email already exists.' })
  if (await User.exists({ username })) return res.status(409).json({ error: 'That username is already taken.' })
  if (!mailTransport) return res.status(503).json({ error: 'Email verification is not configured yet. Please contact support.' })
  const code = String(randomInt(100000, 1000000))
  await EmailVerification.findOneAndUpdate({ email }, { $set: { codeHash: hashResetToken(code), attempts: 0, expiresAt: new Date(Date.now() + 10 * 60 * 1000), verifiedAt: null } }, { upsert: true, new: true, setDefaultsOnInsert: true })
  try {
    await mailTransport.sendMail({ from: process.env.EMAIL_FROM || 'Social Land <' + process.env.GMAIL_USER + '>', to: email, subject: 'Verify your Social Land email', text: 'Your Social Land verification code is ' + code + '. Enter it within 10 minutes to finish creating your account.', html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#211d31"><h2>Verify your Social Land email</h2><p>Enter this code to finish creating your account:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;padding:16px;background:#f1effa;border-radius:12px;text-align:center">' + code + '</p><p>This code expires in 10 minutes.</p></div>' })
  } catch (error) { await EmailVerification.deleteOne({ email }); throw error }
  res.json({ ok: true })
}))
app.post('/api/auth/register/verify-code', registrationCodeLimit, dbOnly, handle(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const code = String(req.body?.code || '').trim()
  if (!/^\S+@\S+\.\S+$/.test(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the six-digit code sent to your email.' })
  const now = new Date()
  const verified = await EmailVerification.findOneAndUpdate({ email, codeHash: hashResetToken(code), expiresAt: { $gt: now }, attempts: { $lt: 5 } }, { $set: { verifiedAt: now } }, { new: true })
  if (!verified) {
    await EmailVerification.updateOne({ email, expiresAt: { $gt: now }, attempts: { $lt: 5 }, verifiedAt: null }, { $inc: { attempts: 1 } })
    return res.status(400).json({ error: 'That verification code is incorrect or expired. Request a new code and try again.' })
  }
  res.json({ ok: true })
}))
const maskEmail = email => { const [local, domain] = String(email || '').split('@'); if (!local || !domain) return ''; const dot = domain.lastIndexOf('.'); const domainName = dot > 0 ? domain.slice(0, dot) : domain; const suffix = dot > 0 ? domain.slice(dot) : ''; return local[0] + '***@' + domainName[0] + '***' + suffix }
const developmentAppOrigin = req => {
  try {
    const origin = new URL(req.get('origin') || '')
    const host = origin.hostname.toLowerCase()
    const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
    const privateLan = /^10(?:\.\d{1,3}){3}$/.test(host) || /^192\.168(?:\.\d{1,3}){2}$/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host)
    if (origin.protocol === 'https:' && (loopback || privateLan) || origin.protocol === 'http:' && loopback) return origin.origin
  } catch {}
  return process.env.CLIENT_ORIGIN
}
app.post('/api/auth/forgot-password', passwordResetLimit, dbOnly, handle(async (req, res) => {
  const identity = String(req.body?.identity ?? req.body?.email ?? '').trim().toLowerCase()
  const isEmail = /^\S+@\S+\.\S+$/.test(identity)
  const username = identity.replace(/^@/, '')
  if (!isEmail && !/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Enter your account email or username.' })
  if (!mailTransport) return res.status(503).json({ error: 'Password reset email is not configured yet. Please contact support.' })
  const accountFilter = isEmail ? { email: identity } : { username }
  const user = await User.findOne(accountFilter)
  if (!user) return res.status(404).json({ error: 'No account found for that email or username.' })
  const code = String(randomInt(100000, 1000000))
  user.passwordResetTokenHash = undefined
  user.passwordResetCodeHash = hashResetToken(code)
  user.passwordResetAttempts = 0
  user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000)
  await user.save()
  try {
    await mailTransport.sendMail({
      from: process.env.EMAIL_FROM || 'Social Land <' + process.env.GMAIL_USER + '>',
      to: user.email,
      subject: 'Your Social Land password reset code',
      text: 'Your Social Land password reset code is ' + code + '. Enter it in the app within 10 minutes. If you did not request this, you can ignore this email.',
      html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#211d31"><h2>Reset your Social Land password</h2><p>Enter this code in the app to choose a new password:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;padding:16px;background:#f1effa;border-radius:12px;text-align:center">' + code + '</p><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p></div>',
    })
  } catch (error) {
    user.passwordResetCodeHash = undefined
    user.passwordResetExpires = undefined
    user.passwordResetAttempts = 0
    await user.save()
    throw error
  }
  res.json({ ok: true, ...(!isEmail ? { maskedEmail: maskEmail(user.email) } : {}) })
}))
app.post('/api/auth/verify-reset-code', passwordResetLimit, dbOnly, handle(async (req, res) => {
  const identity = String(req.body?.identity ?? req.body?.email ?? '').trim().toLowerCase()
  const isEmail = /^\S+@\S+\.\S+$/.test(identity)
  const username = identity.replace(/^@/, '')
  const code = String(req.body?.code || '').trim()
  if ((!isEmail && !/^[a-z0-9_]{3,24}$/.test(username)) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter your account email or username and the six-digit reset code.' })
  const accountFilter = isEmail ? { email: identity } : { username }
  const now = new Date()
  const user = await User.findOne({ ...accountFilter, passwordResetCodeHash: hashResetToken(code), passwordResetExpires: { $gt: now }, passwordResetAttempts: { $lt: 5 } }).select('_id').lean()
  if (!user) {
    await User.updateOne({ ...accountFilter, passwordResetCodeHash: { $exists: true }, passwordResetExpires: { $gt: now }, passwordResetAttempts: { $lt: 5 } }, { $inc: { passwordResetAttempts: 1 } })
    return res.status(400).json({ error: 'That reset code is incorrect or expired. Request a new code and try again.' })
  }
  res.json({ ok: true })
}))
app.post('/api/auth/reset-password', passwordResetLimit, dbOnly, handle(async (req, res) => {
  const token = String(req.body?.token || '').trim()
  const identity = String(req.body?.identity ?? req.body?.email ?? '').trim().toLowerCase()
  const isEmail = /^\S+@\S+\.\S+$/.test(identity)
  const username = identity.replace(/^@/, '')
  const accountFilter = isEmail ? { email: identity } : { username }
  const code = String(req.body?.code || '').trim()
  const password = req.body?.password
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be between 8 and 72 characters.' })
  const legacyToken = /^[a-f0-9]{64}$/i.test(token)
  if (!legacyToken && ((!isEmail && !/^[a-z0-9_]{3,24}$/.test(username)) || !/^\d{6}$/.test(code))) return res.status(400).json({ error: 'Enter your account email or username and the six-digit reset code.' })
  const passwordHash = await bcrypt.hash(password, 12)
  const filter = legacyToken
    ? { passwordResetTokenHash: hashResetToken(token), passwordResetExpires: { $gt: new Date() } }
    : { ...accountFilter, passwordResetCodeHash: hashResetToken(code), passwordResetExpires: { $gt: new Date() }, passwordResetAttempts: { $lt: 5 } }
  const resetUser = await User.findOneAndUpdate(
    filter,
    { $set: { passwordHash }, $inc: { sessionVersion: 1 }, $unset: { passwordResetTokenHash: 1, passwordResetCodeHash: 1, passwordResetExpires: 1, passwordResetAttempts: 1 } },
    { new: true },
  )
  if (!resetUser) {
    if (!legacyToken) await User.updateOne({ ...accountFilter, passwordResetCodeHash: { $exists: true }, passwordResetExpires: { $gt: new Date() }, passwordResetAttempts: { $lt: 5 } }, { $inc: { passwordResetAttempts: 1 } })
    return res.status(400).json({ error: 'That reset code is incorrect, expired, or has already been used. Request a new code and try again.' })
  }
  io.in(resetUser._id.toString()).disconnectSockets(true)
  const session = await createDeviceLogin(resetUser, req)
  res.json({ ok: true, ...session, user: publicUser(resetUser) })
}))
app.post('/api/auth/change-password', auth, handle(async (req, res) => {
  const currentPassword = req.body?.currentPassword
  const newPassword = req.body?.newPassword
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) return res.status(400).json({ error: 'New password must be 8â€“72 characters.' })
  const user = await User.findById(req.user._id).select('+passwordHash')
  if (!user || !await bcrypt.compare(String(currentPassword || ''), user.passwordHash)) return res.status(400).json({ error: 'Your current password is incorrect.' })
  user.passwordHash = await bcrypt.hash(newPassword, 12)
  user.sessionVersion += 1
  user.set('passwordResetTokenHash', undefined)
  user.set('passwordResetExpires', undefined)
  await user.save()
  io.in(user._id.toString()).disconnectSockets(true)
  const session = await createDeviceLogin(user, req)
  res.json({ ...session, user: publicUser(user) })
}))
app.get('/api/me/alternate-email', auth, handle(async (req, res) => {
  const user = await User.findById(req.user._id).select('+alternateEmail')
  res.json({ email: maskEmail(user.email), alternateEmail: user.alternateEmail ? maskEmail(user.alternateEmail) : '', hasAlternateEmail: !!user.alternateEmail })
}))
app.post('/api/me/alternate-email/send-code', auth, passwordResetLimit, handle(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const currentPassword = String(req.body?.currentPassword || '')
  const emailType = req.body?.type === 'primary' ? 'primary' : 'alternate'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid Gmail or email address.' })
  if (!currentPassword) return res.status(400).json({ error: 'Enter your current password to continue.' })
  const user = await User.findById(req.user._id).select('+passwordHash +alternateEmail')
  if (!user || !await bcrypt.compare(currentPassword, user.passwordHash)) return res.status(400).json({ error: 'Your current password is incorrect.' })
  if (email === user.email || email === user.alternateEmail) return res.status(400).json({ error: 'That email is already on this account.' })
  const alreadyUsed = await User.exists({ _id: { $ne: user._id }, $or: [{ email }, { alternateEmail: email }, { alternateEmailPending: email }] })
  if (alreadyUsed) return res.status(409).json({ error: 'That email is already connected to another account.' })
  if (!mailTransport) return res.status(503).json({ error: 'Email verification is not configured yet. Please contact support.' })
  const code = String(randomInt(0, 1000000)).padStart(6, '0')
  user.alternateEmailPending = email
  user.pendingEmailType = emailType
  user.alternateEmailCodeHash = hashResetToken(code)
  user.alternateEmailCodeExpires = new Date(Date.now() + 10 * 60 * 1000)
  user.alternateEmailCodeAttempts = 0
  await user.save()
  try {
    await mailTransport.sendMail({
      from: process.env.EMAIL_FROM || 'Social Land <' + process.env.GMAIL_USER + '>',
      to: email,
      subject: 'Verify your alternate Social Land email',
      text: 'Your Social Land email verification code is ' + code + '. Enter it in the app within 10 minutes to add this email to your account.',
      html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#211d31"><h2>Verify your alternate email</h2><p>Enter this code in Social Land to add this email to your account:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;padding:16px;background:#f1effa;border-radius:12px;text-align:center">' + code + '</p><p>This code expires in 10 minutes.</p></div>',
    })
  } catch (error) {
    user.alternateEmailPending = ''
    user.pendingEmailType = undefined
    user.alternateEmailCodeHash = undefined
    user.alternateEmailCodeExpires = undefined
    user.alternateEmailCodeAttempts = 0
    await user.save()
    throw error
  }
  res.json({ ok: true, maskedEmail: maskEmail(email) })
}))
app.post('/api/me/alternate-email/verify-code', auth, passwordResetLimit, handle(async (req, res) => {
  const code = String(req.body?.code || '').trim()
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the six-digit code from your email.' })
  const user = await User.findById(req.user._id).select('+alternateEmail +alternateEmailPending +pendingEmailType +alternateEmailCodeHash +alternateEmailCodeExpires +alternateEmailCodeAttempts')
  const valid = user && user.alternateEmailPending && user.alternateEmailCodeHash === hashResetToken(code) && user.alternateEmailCodeExpires > new Date() && user.alternateEmailCodeAttempts < 5
  if (!valid) {
    if (user?.alternateEmailPending && user.alternateEmailCodeExpires > new Date() && user.alternateEmailCodeAttempts < 5) {
      user.alternateEmailCodeAttempts += 1
      await user.save()
    }
    return res.status(400).json({ error: 'That verification code is incorrect or expired. Request a new code and try again.' })
  }
  const alreadyUsed = await User.exists({ _id: { $ne: user._id }, $or: [{ email: user.alternateEmailPending }, { alternateEmail: user.alternateEmailPending }, { alternateEmailPending: user.alternateEmailPending }] })
  if (alreadyUsed) return res.status(409).json({ error: 'That email has been connected to another account. Request a code for a different address.' })
  if (user.pendingEmailType === 'primary') user.email = user.alternateEmailPending
  else user.alternateEmail = user.alternateEmailPending
  user.alternateEmailPending = ''
  user.pendingEmailType = undefined
  user.alternateEmailCodeHash = undefined
  user.alternateEmailCodeExpires = undefined
  user.alternateEmailCodeAttempts = 0
  await user.save()
  res.json({ ok: true, email: maskEmail(user.email), alternateEmail: user.alternateEmail ? maskEmail(user.alternateEmail) : '', hasAlternateEmail: !!user.alternateEmail })
}))
app.get('/api/me/two-step', auth, handle(async (req, res) => {
  const user = await User.findById(req.user._id).select('email twoStepEnabled')
  res.json({ enabled: !!user.twoStepEnabled, maskedEmail: maskEmail(user.email) })
}))
app.post('/api/me/two-step', auth, passwordResetLimit, handle(async (req, res) => {
  const enabled = req.body?.enabled
  const currentPassword = String(req.body?.currentPassword || '')
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Choose whether two-step verification should be on or off.' })
  if (!currentPassword) return res.status(400).json({ error: 'Enter your current password to change this setting.' })
  const user = await User.findById(req.user._id).select('+passwordHash +twoStepEnabled')
  if (!user || !await bcrypt.compare(currentPassword, user.passwordHash)) return res.status(400).json({ error: 'Your current password is incorrect.' })
  if (enabled && !mailTransport) return res.status(503).json({ error: 'Email verification is not configured, so two-step verification cannot be enabled yet.' })
  user.twoStepEnabled = enabled
  if (!enabled) {
    user.twoStepLoginChallengeHash = undefined
    user.twoStepLoginCodeHash = undefined
    user.twoStepLoginExpires = undefined
    user.twoStepLoginAttempts = 0
  }
  await user.save()
  res.json({ enabled: user.twoStepEnabled, maskedEmail: maskEmail(user.email) })
}))
app.get('/api/security/sessions', auth, handle(async (req, res) => {
  const sessions = await DeviceSession.find({ user: req.user._id, sessionVersion: req.user.sessionVersion || 0, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastActiveAt: -1 }).lean()
  const currentSessionId = req.deviceSession?.sessionId || ''
  res.json({ sessions: sessions.map(session => ({ id: session.sessionId, deviceName: session.deviceName, location: session.location || 'Approximate location unavailable', lastActiveAt: session.lastActiveAt, createdAt: session.createdAt, current: session.sessionId === currentSessionId })) })
}))
app.delete('/api/security/sessions/:id', auth, handle(async (req, res) => {
  if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Choose a valid device session.' })
  const session = await DeviceSession.findOneAndUpdate({ sessionId: req.params.id, user: req.user._id, sessionVersion: req.user.sessionVersion || 0, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true })
  if (!session) return res.status(404).json({ error: 'This device session was already logged out.' })
  io.in(deviceSessionRoom(session.sessionId)).disconnectSockets(true)
  res.json({ ok: true, current: req.deviceSession?.sessionId === session.sessionId })
}))
const assistantChatLimit = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false })
const socialLandHelp = question => {
  const text = question.toLowerCase()
  if (/\b(reel|reels|video feed)\b/.test(text)) return 'Open Reels from the navigation. Tap a reel to pause or resume it, and use the + button to upload a short video.'
  if (/\b(post|publish|upload|share a photo)\b/.test(text)) return 'Open Home and use the post composer to add a photo, video, or note. Add a caption, then choose Share to publish it.'
  if (/\b(friend|find people|search people|follow)\b/.test(text)) return 'Open Find people, search by name or username, then use Add friend or Follow on the person card. Private accounts may require approval.'
  if (/\b(archive|archived chat)\b/.test(text)) return 'Open Messages and choose Archived above the conversation list. Long-press a conversation to archive or restore it.'
  if (/\b(message|chat|conversation)\b/.test(text)) return 'Open Messages, choose a conversation, or select New chat to find someone. Your AI conversation is saved on this device.'
  if (/\b(game|chess|quiz|tic.?tac.?toe|ludo)\b/.test(text)) return 'Open Play, choose a game, invite a friend from Messages, and start after they join.'
  if (/\b(watch together|watch party|video room)\b/.test(text)) return 'Open Watch together, create or join a room, then share a video link. Playback controls synchronize for room members.'
  if (/\b(profile|avatar|bio|banner|privacy|account)\b/.test(text)) return 'Open Profile to view your page. Use Edit profile to change profile details and Profile settings to manage privacy and account options.'
  return 'I can help explain Social Land features right now. General AI answers need a model provider connection, which is not enabled yet.'
}
app.post('/api/assistant/chat', auth, assistantChatLimit, handle(async (req, res) => {
  const question = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  if (!question || question.length > 2500) return res.status(400).json({ error: 'Send a question under 2,500 characters.' })
  return res.json({ reply: socialLandHelp(question), modelConfigured: false })
}))
app.get('/api/me', auth, (req, res) => res.json({ user: publicProfileUser(req.user), groupAddPrivacy: req.user.groupAddPrivacy || 'anyone', messagePrivacy: req.user.messagePrivacy || 'friends', lastSeenPrivacy: req.user.lastSeenPrivacy || 'friends', lastSeenFriendIds: (req.user.lastSeenFriendIds || []).map(id => id.toString()), storyAudience: { privacy: req.user.storyAudiencePrivacy || 'everyone', selectedFriendIds: (req.user.storyAudienceFriendIds || []).map(id => id.toString()) } }))
app.get('/api/me/blocked-users', auth, handle(async (req, res) => {
  const users = await User.find({ _id: { $in: req.user.blockedUsers || [] } }).select('username displayName bio avatarUrl avatarBorder avatarBorderColor').lean()
  res.json({ users: users.map(publicUser) })
}))
app.patch('/api/me/story-audience', auth, handle(async (req, res) => {
  const privacy = req.body?.privacy
  if (!['everyone','friends','selected'].includes(privacy)) return res.status(400).json({ error: 'Choose Everyone, Friends, or Selected friends.' })
  const selected = privacy === 'selected' ? selectedStoryFriends(req.body?.selectedFriendIds, req.user) : []
  if (selected === null) return res.status(400).json({ error: 'Selected audience members must be your accepted friends.' })
  req.user.storyAudiencePrivacy = privacy
  req.user.storyAudienceFriendIds = selected
  await req.user.save()
  res.json({ storyAudience: { privacy, selectedFriendIds: selected.map(id => id.toString()) } })
}))
app.get('/api/notifications', auth, handle(async (req, res) => {
  const activities = await Activity.find({ recipient: req.user._id }).sort({ createdAt: -1 }).limit(60).populate('actor', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
  res.json({ notifications: activities.map(publicActivity), unreadCount: activities.filter(activity => !activity.read).length })
}))
app.post('/api/notifications/read', auth, handle(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => typeof id === 'string').slice(0, 60) : []
  const filter = { recipient: req.user._id, read: false, ...(ids.length ? { _id: { $in: ids } } : {}) }
  await Activity.updateMany(filter, { $set: { read: true } })
  res.json({ ok: true })
}))
app.get('/api/stories', auth, handle(async (req, res) => {
  const followedAuthors = await User.find({ followers: req.user._id }).distinct('_id')
  const everyoneAuthors = [...followedAuthors, ...(req.user.friends || [])]
  const foundStories = await Story.find({ expiresAt: { $gt: new Date() }, $or: [{ author: req.user._id }, { privacy: { $in: ['everyone', null] }, author: { $in: everyoneAuthors } }, { privacy: 'friends', author: { $in: req.user.friends } }, { privacy: 'selected', author: { $in: req.user.friends }, selectedFriends: req.user._id }] }).sort({ createdAt: 1 }).limit(500).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
  const authorIds = [...new Set(foundStories.map(story => story.author._id.toString()))]
  const authors = await User.find({ _id: { $in: authorIds } }).select('privateProfile followers').lean()
  const authorsById = new Map(authors.map(author => [author._id.toString(), author]))
  const stories = []
  for (const story of foundStories) if (await canViewStory(story, req.user, authorsById.get(story.author._id.toString()))) stories.push(story)
  const groups = new Map()
  for (const story of stories) {
    const key = story.author._id.toString()
    if (!groups.has(key)) groups.set(key, { user: publicUser(story.author), stories: [] })
    groups.get(key).stories.push(publicStory(story, req.user._id))
  }
  res.json({ groups: [...groups.values()] })
}))
app.post('/api/stories', auth, storyUpload.single('media'), handle(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a photo or video for your story.' })
  const caption = String(req.body?.caption || '').trim()
  if (caption.length > 240) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Story captions can be up to 240 characters.' }) }
  const privacy = req.body?.privacy || 'everyone'
  const selectedFriends = privacy === 'selected' ? selectedStoryFriends(req.body?.selectedFriendIds, req.user) : []
  if (!['everyone','friends','selected'].includes(privacy) || selectedFriends === null) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Choose a valid audience using your accepted friends.' }) }
  let scan
  try { scan = await scanUploadedMedia([{ path: req.file.path, mimetype: req.file.mimetype }]) }
  catch (error) { await fs.promises.unlink(req.file.path).catch(() => {}); throw error }
  if (scan.flagged) {
    await fs.promises.unlink(req.file.path).catch(() => {})
    await warnAndCountModerationStrike({ author: req.user._id, kind: 'story', _id: new mongoose.Types.ObjectId() }, scan)
    return res.status(422).json({ error: 'This story was removed because the content classifier detected nudity.' })
  }
  const story = await Story.create({ author: req.user._id, mediaUrl: `/story-media/${path.basename(req.file.path)}`, mediaType: req.file.mimetype.startsWith('video/') ? 'video' : 'image', caption, privacy, selectedFriends, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
  await story.populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
  res.status(201).json({ story: publicStory(story, req.user._id) })
}))
app.post('/api/stories/:id/view', auth, handle(async (req, res) => {
  const story = await Story.findOne({ _id: req.params.id, expiresAt: { $gt: new Date() } })
  if (!story) return res.status(404).json({ error: 'Story not found or expired.' })
  if (!await canViewStory(story, req.user)) return res.status(403).json({ error: 'You are not in the selected audience for this story.' })
  if (story.author.equals(req.user._id)) return res.json({ ok: true, recorded: false })
  const result = await Story.updateOne({ _id: story._id, expiresAt: { $gt: new Date() }, 'views.user': { $ne: req.user._id } }, { $push: { views: { user: req.user._id, seenAt: new Date() } } })
  res.json({ ok: true, recorded: result.modifiedCount > 0 })
}))
app.post('/api/stories/:id/like', auth, handle(async (req, res) => {
  const story = await Story.findOne({ _id: req.params.id, expiresAt: { $gt: new Date() } })
  if (!story) return res.status(404).json({ error: 'Story not found or expired.' })
  if (!await canViewStory(story, req.user)) return res.status(403).json({ error: 'You are not in the selected audience for this story.' })
  if (story.author.equals(req.user._id)) return res.status(400).json({ error: 'You cannot like your own story.' })
  const liked = story.likes.some(id => id.equals(req.user._id))
  await Story.updateOne({ _id: story._id, expiresAt: { $gt: new Date() } }, liked ? { $pull: { likes: req.user._id } } : { $addToSet: { likes: req.user._id } })
  const updated = await Story.findById(story._id).select('likes').lean()
  if (!liked) await createActivity(story.author, req.user._id, 'story_like')
  res.json({ liked: !liked, likesCount: updated?.likes.length || 0 })
}))
app.post('/api/stories/:id/reply', auth, handle(async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text || text.length > 1000) return res.status(400).json({ error: 'Story replies must be 1 to 1,000 characters.' })
  const story = await Story.findOne({ _id: req.params.id, expiresAt: { $gt: new Date() } })
  if (!story) return res.status(404).json({ error: 'Story not found or expired.' })
  if (story.author.equals(req.user._id)) return res.status(400).json({ error: 'You cannot reply to your own story.' })
  if (!await canViewStory(story, req.user)) return res.status(403).json({ error: 'You are not in the selected audience for this story.' })
  const author = await User.findById(story.author)
  if (!author || author.blockedUsers.some(id => id.equals(req.user._id)) || req.user.blockedUsers.some(id => id.equals(author._id))) return res.status(403).json({ error: 'This person is unavailable because of a block.' })
  if (!isFriend(req.user, author._id)) return res.status(403).json({ error: 'You can reply to a story after becoming friends.' })
  const members = [req.user._id, author._id].sort((a, b) => a.toString().localeCompare(b.toString()))
  const directKey = members.map(user => user.toString()).join(':')
  const conversation = await Conversation.findOneAndUpdate({ directKey }, { $setOnInsert: { members, directKey }, $pull: { archivedFor: req.user._id, hiddenFor: req.user._id } }, { upsert: true, new: true, setDefaultsOnInsert: true })
  const notifyAuthor = await shouldNotifyMessage(conversation._id)
  const storyContext = { storyId: story._id, authorName: author.displayName, mediaType: story.mediaType, caption: story.caption || '', action: 'reply' }
  const message = await Message.create({ conversation: conversation._id, sender: req.user._id, text, storyContext })
  await Conversation.updateOne({ _id: conversation._id }, { $pullAll: { archivedFor: [author._id, req.user._id], hiddenFor: [author._id, req.user._id] } })
  conversation.latestText = `Story reply: ${text}`; conversation.latestAt = message.createdAt; await conversation.save()
  const payload = { id: message.id, conversationId: conversation.id, senderId: req.user.id, senderName: message.senderName || req.user.displayName || 'Member', ...(message.replyTo ? { replyTo: message.replyTo } : {}), text, deliveredAt: null, readAt: null, storyContext: { ...storyContext, storyId: story._id.toString() }, createdAt: message.createdAt }
  io.to(conversation.id).emit('message:new', payload)
  io.to(author.id).emit('message:new', payload)
  if (notifyAuthor) await createActivity(author._id, req.user._id, 'message')
  res.status(201).json({ message: payload, conversation: { id: conversation.id, user: { ...publicUser(author), lastSeenAt: canViewPresence(req.user, author) ? author.lastSeenAt || null : null }, latestText: conversation.latestText, latestAt: conversation.latestAt } })
}))
app.get('/api/stories/:id/media', handle(async (req, res) => {
  let claims
  try { claims = jwt.verify(String(req.query.token || ''), JWT_SECRET) } catch { return res.status(401).json({ error: 'This story link has expired. Reload stories to continue.' }) }
  if (claims.purpose !== 'story-media' || claims.storyId !== req.params.id || !mongoose.Types.ObjectId.isValid(claims.viewerId)) return res.status(401).json({ error: 'This story link is invalid.' })
  const [story, viewer] = await Promise.all([Story.findOne({ _id: req.params.id, expiresAt: { $gt: new Date() } }), User.findById(claims.viewerId)])
  if (!story || !viewer) return res.status(404).json({ error: 'Story not found or expired.' })
  if (!await canViewStory(story, viewer)) return res.status(403).json({ error: 'You are not in the selected audience for this story.' })
  const directory = story.mediaUrl.startsWith('/story-media/') ? storyUploadsDir : story.mediaUrl.startsWith('/uploads/') ? uploadsDir : null
  if (!directory) return res.status(404).json({ error: 'Story media not found.' })
  res.set('Cache-Control', 'private, no-store')
  res.sendFile(path.join(directory, path.basename(story.mediaUrl)), err => { if (err && !res.headersSent) res.status(404).json({ error: 'Story media not found.' }) })
}))
app.get('/api/stories/:id/views', auth, handle(async (req, res) => {
  const story = await Story.findOne({ _id: req.params.id, author: req.user._id, expiresAt: { $gt: new Date() } }).populate('views.user', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').populate('likes', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
  if (!story) return res.status(404).json({ error: 'Story not found or expired.' })
  res.json({ viewers: (story.views || []).filter(view => view.user).sort((a, b) => new Date(b.seenAt) - new Date(a.seenAt)).map(view => ({ user: publicUser(view.user), seenAt: view.seenAt })), likers: (story.likes || []).filter(Boolean).map(publicUser) })
}))
app.patch('/api/stories/:id', auth, handle(async (req, res) => {
  const privacy = req.body?.privacy
  if (!['everyone','friends','selected'].includes(privacy)) return res.status(400).json({ error: 'Choose Everyone, Friends, or Selected friends for story privacy.' })
  const selectedFriends = privacy === 'selected' ? selectedStoryFriends(req.body?.selectedFriendIds, req.user) : []
  if (selectedFriends === null) return res.status(400).json({ error: 'Selected viewers must be accepted friends.' })
  const story = await Story.findOne({ _id: req.params.id, author: req.user._id, expiresAt: { $gt: new Date() } })
  if (!story) return res.status(404).json({ error: 'Story not found or expired.' })
  story.privacy = privacy
  story.selectedFriends = selectedFriends
  await story.save()
  await story.populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
  res.json({ story: publicStory(story, req.user._id) })
}))
app.delete('/api/stories/:id', auth, handle(async (req, res) => {
  const story = await Story.findById(req.params.id)
  if (!story) return res.status(404).json({ error: 'Story not found.' })
  if (!story.author.equals(req.user._id)) return res.status(403).json({ error: 'You can only delete your own story.' })
  await story.deleteOne()
  await removeStoryMedia(story)
  res.json({ ok: true })
}))
app.patch('/api/me', auth, handle(async (req, res) => {
  if (req.body?.character !== undefined) {
    const character = req.body.character
    const colors = ['skin', 'hair', 'top', 'bottom']
    const allowedFigures = ['masculine', 'feminine']
    const choices = { figure: ['masculine','feminine'], shape: ['slim','average','athletic','curvy'], hairStyle: ['short','messy','long','curly','bun','buzz'], topStyle: ['hoodie','tshirt','crop','jacket','shirt','dress'], bottomStyle: ['cargo','jeans','shorts','skirt','trousers'], footwear: ['sneakers','boots','heels','sandals'] }
    const allowedAccessories = ['cap','glasses','backpack','chain','watch','earrings']
    if (!character || typeof character !== 'object' || Array.isArray(character) || Object.entries(choices).some(([key, values]) => !values.includes(character[key])) || !Array.isArray(character.accessories) || character.accessories.length > allowedAccessories.length || character.accessories.some(item => !allowedAccessories.includes(item)) || colors.some(key => typeof character[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(character[key]))) return res.status(400).json({ error: 'Choose a valid character shape, hairstyle, outfit, footwear, accessory, and colors.' })
    req.user.character = { ...Object.fromEntries(Object.keys(choices).map(key => [key, character[key]])), accessories: [...new Set(character.accessories)], ...Object.fromEntries(colors.map(key => [key, character[key].toLowerCase()])) }
    await req.user.save()
    return res.json({ user: publicProfileUser(req.user) })
  }
  const username = String(req.body?.username ?? req.user.username).trim().toLowerCase()
  const displayName = String(req.body?.displayName ?? req.user.displayName).trim()
  const bio = String(req.body?.bio ?? req.user.bio).trim()
  const avatarUrl = String(req.body?.avatarUrl ?? req.user.avatarUrl).trim()
  const avatarBorder = String(req.body?.avatarBorder ?? req.user.avatarBorder ?? '').trim()
  const avatarBorderColor = String(req.body?.avatarBorderColor ?? req.user.avatarBorderColor ?? '').trim()
  const bannerUrl = String(req.body?.bannerUrl ?? req.user.bannerUrl).trim()
  const location = String(req.body?.location ?? req.user.location).trim()
  const website = String(req.body?.website ?? req.user.website).trim()
  const pronouns = String(req.body?.pronouns ?? req.user.pronouns).trim()
  const gender = String(req.body?.gender ?? req.user.gender ?? '').trim()
  const ageInput = req.body?.age === undefined ? req.user.age : req.body.age
  const age = ageInput === null || ageInput === '' ? null : Number(ageInput)
  const hobbies = String(req.body?.hobbies ?? req.user.hobbies ?? '').trim()
  const relationWith = String(req.body?.relationWith ?? req.user.relationWith ?? '').trim()
  const relationshipStatus = String(req.body?.relationshipStatus ?? req.user.relationshipStatus ?? '').trim()
  const favoriteGame = String(req.body?.favoriteGame ?? req.user.favoriteGame ?? '').trim()
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3â€“24 characters using letters, numbers, or underscores.' })
  if (!displayName || displayName.length > 50 || bio.length > 250 || location.length > 80 || website.length > 200 || pronouns.length > 40 || gender.length > 40 || hobbies.length > 200 || relationWith.length > 160 || relationshipStatus.length > 40 || favoriteGame.length > 80) return res.status(400).json({ error: 'One or more profile details are too long.' })
  if (age !== null && (!Number.isInteger(age) || age < 13 || age > 120)) return res.status(400).json({ error: 'Age must be a whole number between 13 and 120.' })
  if (username !== req.user.username && await User.exists({ username, _id: { $ne: req.user._id } })) return res.status(409).json({ error: 'That username is already taken.' })
  if (avatarUrl && (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(avatarUrl) || avatarUrl.length > 700000)) return res.status(400).json({ error: 'Choose a smaller JPG, PNG, or WebP profile photo.' })
  if (avatarBorder && !/^[a-z0-9-]{1,40}$/.test(avatarBorder)) return res.status(400).json({ error: 'Choose a valid avatar border.' })
  if (avatarBorderColor && !/^#[0-9a-f]{6}$/i.test(avatarBorderColor)) return res.status(400).json({ error: 'Choose a valid avatar frame color.' })
  if (bannerUrl && (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(bannerUrl) || bannerUrl.length > 1800000)) return res.status(400).json({ error: 'Choose a smaller JPG, PNG, or WebP banner image.' })
  if (website) { try { const parsed = new URL(website); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error() } catch { return res.status(400).json({ error: 'Enter a valid website address, including https://.' }) } }
  Object.assign(req.user, { username, displayName, bio, avatarUrl, bannerUrl, location, website, pronouns, gender, age, hobbies, relationWith, relationshipStatus, favoriteGame, avatarBorder, avatarBorderColor })
  if (typeof req.body?.privateProfile === 'boolean') req.user.privateProfile = req.body.privateProfile
  if (req.body?.groupAddPrivacy !== undefined) {
    if (!['anyone','approval'].includes(req.body.groupAddPrivacy)) return res.status(400).json({ error: 'Choose anyone or approve before adding.' })
    req.user.groupAddPrivacy = req.body.groupAddPrivacy
  }
  if (req.body?.messagePrivacy !== undefined) {
    if (!['friends','everyone'].includes(req.body.messagePrivacy)) return res.status(400).json({ error: 'Choose Friends or Everyone for message privacy.' })
    req.user.messagePrivacy = req.body.messagePrivacy
    if (req.user.messagePrivacy !== 'everyone' && req.user.lastSeenPrivacy === 'everyone') { req.user.lastSeenPrivacy = 'friends'; req.user.lastSeenFriendIds = [] }
  }
  if (req.body?.lastSeenPrivacy !== undefined || req.body?.lastSeenFriendIds !== undefined) {
    const privacy = req.body?.lastSeenPrivacy ?? req.user.lastSeenPrivacy ?? 'friends'
    if (!['everyone','friends','selected'].includes(privacy)) return res.status(400).json({ error: 'Choose Everyone, Friends, or Selected friends for last-seen privacy.' })
    if (privacy === 'everyone' && req.user.messagePrivacy !== 'everyone') return res.status(400).json({ error: 'Set Who can message you to Everyone before showing your last seen to everyone.' })
    const selected = privacy === 'selected' ? selectedStoryFriends(req.body?.lastSeenFriendIds ?? (req.user.lastSeenFriendIds || []).map(id => id.toString()), req.user) : []
    if (selected === null) return res.status(400).json({ error: 'Selected people must be accepted friends.' })
    req.user.lastSeenPrivacy = privacy
    req.user.lastSeenFriendIds = selected
  }
  await req.user.save()
  if (req.body?.lastSeenPrivacy !== undefined || req.body?.lastSeenFriendIds !== undefined || req.body?.messagePrivacy !== undefined) void emitPresenceUpdate(req.user.id, { online: onlineUserCounts.has(req.user.id), lastSeenAt: req.user.lastSeenAt || null })
  const updatedProfile = publicProfileUser(req.user)
  io.emit('profile:avatar-frame', { id: req.user.id, avatarBorder: req.user.avatarBorder || '', avatarBorderColor: req.user.avatarBorderColor || '' })
  res.json({ user: updatedProfile })
}))
const recommendationStopWords = new Set('about after again also and are because been before being but can could did does for from had has have how into its just more most not off out over post reel she that the their them then there these they this those through too under was were what when where which who will with you your'.split(' '))
const extractPostTopics = caption => [...new Set((String(caption || '').toLowerCase().match(/[\p{L}\p{N}#]+/gu) || []).map(word => word.replace(/^#/, '')).filter(word => word.length > 2 && !recommendationStopWords.has(word)))].slice(0, 24)
const recordRecommendationSignal = async (userId, post, action, watchMs = 0) => {
  if (!userId || !post?._id || !post.author || !['view','skip','like','comment','share'].includes(action)) return
  const topics = post.topics?.length ? post.topics : extractPostTopics(post.caption)
  const update = { $set: { author: post.author._id || post.author, topics }, ...(action === 'view' ? { $max: { watchMs: Math.min(60000, Math.max(0, Number(watchMs) || 0)) } } : {}) }
  await RecommendationSignal.updateOne({ user: userId, post: post._id, action }, update, { upsert: true })
}
const rankRecommendedPosts = (posts, signals) => {
  if (!posts.length) return posts
  const topicAffinity = new Map()
  const creatorAffinity = new Map()
  const actionWeight = { view: 0.45, skip: -1.25, like: 1.6, comment: 2.4, share: 3 }
  const now = Date.now()
  for (const signal of signals) {
    const ageDays = Math.max(0, (now - new Date(signal.updatedAt || signal.createdAt || now).getTime()) / 86400000)
    const weight = (actionWeight[signal.action] || 0) * Math.exp(-ageDays / 18) * (signal.action === 'view' ? 0.65 + Math.min(1, (signal.watchMs || 0) / 12000) : 1)
    const authorId = signal.author?.toString()
    if (authorId) creatorAffinity.set(authorId, (creatorAffinity.get(authorId) || 0) + weight)
    for (const topic of signal.topics || []) topicAffinity.set(topic, (topicAffinity.get(topic) || 0) + weight)
  }
  const ranked = posts.map((post, index) => {
    const authorId = (post.author?._id || post.author?.id || post.author)?.toString()
    const topics = post.topics?.length ? post.topics : extractPostTopics(post.caption)
    const interest = topics.reduce((sum, topic) => sum + (topicAffinity.get(topic) || 0), 0) / Math.sqrt(Math.max(1, topics.length))
    const creator = Math.max(-2, Math.min(3, creatorAffinity.get(authorId) || 0))
    const ageDays = Math.max(0, (now - new Date(post.createdAt || now).getTime()) / 86400000)
    const freshness = Math.exp(-ageDays / 5)
    const popularity = Math.log1p(Math.max(0, post.likes?.length || post.likesCount || 0) + Math.max(0, post.commentCount || 0) * 1.5 + Math.max(0, post.shareCount || 0) * 2)
    return { post, index, score: interest * 0.8 + creator * 0.55 + freshness * 0.8 + Math.min(1.2, popularity * 0.12) + Math.max(0, 0.06 - index * 0.001) }
  })
  const result = []
  const authorSeen = new Map()
  while (ranked.length) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (let index = 0; index < ranked.length; index++) {
      const authorId = (ranked[index].post.author?._id || ranked[index].post.author)?.toString()
      const adjusted = ranked[index].score - (authorSeen.get(authorId) || 0) * 0.38
      if (adjusted > bestScore) { bestScore = adjusted; bestIndex = index }
    }
    const [{ post }] = ranked.splice(bestIndex, 1)
    const authorId = (post.author?._id || post.author?.id || post.author)?.toString()
    authorSeen.set(authorId, (authorSeen.get(authorId) || 0) + 1)
    result.push(post)
  }
  return result
}
const publicPost = (post, viewerId) => ({ id: post._id.toString(), author: publicUser(post.author), caption: post.caption, mediaUrl: post.mediaUrl, mediaType: post.mediaType, mediaItems: post.mediaItems?.length ? post.mediaItems.map(item => ({ url: item.url, type: item.type, variants: item.variants || [], playback: item.type === 'video' ? (item.playback || (post.kind === 'reel' ? { status: post.mediaDelivery?.status || 'fallback', masterUrl: post.mediaDelivery?.masterUrl || '', av1Url: post.mediaDelivery?.av1Url || '' } : undefined)) : undefined })) : (post.mediaUrl ? [{ url: post.mediaUrl, type: post.mediaType }] : []), kind: post.kind, moderationStatus: post.moderationStatus || 'approved', playback: post.kind === 'reel' ? { status: post.mediaDelivery?.status || 'fallback', hlsUrl: post.mediaDelivery?.masterUrl || '', av1Url: post.mediaDelivery?.av1Url || '' } : undefined, createdAt: post.createdAt, likesCount: post.likes.length, commentCount: post.commentCount, shareCount: post.shareCount, likesHidden: !!post.likesHidden, commentsDisabled: !!post.commentsDisabled, noteTheme: post.noteTheme || 'classic', noteSymbol: NOTE_THEMES.find(theme => theme.id === (post.noteTheme || 'classic'))?.symbol || '\u2726', noteBackgroundColor: post.noteBackgroundColor || '#eeeaff', noteTextColor: post.noteTextColor || '#342e48', ...(String(post.author?._id || post.author) === viewerId.toString() ? { archived: !!post.archived } : {}), likedByMe: post.likes.some(id => id.toString() === viewerId.toString()) })
const publicLegacyNotePost = (note, viewerId) => ({ id: note._id.toString(), author: publicUser(note.author), caption: note.text, mediaUrl: '', mediaType: 'image', mediaItems: [], kind: 'note', createdAt: note.createdAt, likesCount: note.likes?.length || 0, commentCount: 0, shareCount: note.shareCount || 0, likesHidden: !!note.likesHidden, commentsDisabled: true, noteTheme: note.noteTheme || 'classic', noteSymbol: NOTE_THEMES.find(theme => theme.id === (note.noteTheme || 'classic'))?.symbol || '\u2726', noteBackgroundColor: note.noteBackgroundColor || '#eeeaff', noteTextColor: note.noteTextColor || '#342e48', likedByMe: !!viewerId && (note.likes || []).some(id => id.toString() === viewerId.toString()) })
const publicComment = (comment, viewerId) => ({ id: comment._id.toString(), author: publicUser(comment.author), text: comment.text, parentCommentId: comment.parentComment?.toString() || null, likesCount: comment.likes?.length || 0, likedByMe: !!viewerId && (comment.likes || []).some(id => id.toString() === viewerId.toString()), createdAt: comment.createdAt })
const publicProfileNote = (note, viewerId) => ({ id: note._id.toString(), authorId: note.author.toString(), text: note.text, createdAt: note.createdAt, noteTheme: note.noteTheme || 'classic', noteSymbol: NOTE_THEMES.find(theme => theme.id === (note.noteTheme || 'classic'))?.symbol || '\u2726', noteBackgroundColor: note.noteBackgroundColor || '#eeeaff', noteTextColor: note.noteTextColor || '#342e48', likesCount: note.likes?.length || 0, likedByMe: !!viewerId && (note.likes || []).some(id => id.toString() === viewerId.toString()), shareCount: note.shareCount || 0, likesHidden: !!note.likesHidden })
app.get('/api/note-themes', auth, handle(async (_req, res) => res.json({ themes: NOTE_THEMES })))
app.get('/api/me/notes', auth, handle(async (req, res) => {
  const notes = await ProfileNote.find({ author: req.user._id }).sort({ createdAt: -1 }).limit(100).lean()
  res.json({ notes: notes.map(note => publicProfileNote(note, req.user._id)) })
}))
app.post('/api/me/notes', auth, handle(async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text || text.length > 500) return res.status(400).json({ error: 'Notes must be between 1 and 500 characters.' })
  const note = await ProfileNote.create({ author: req.user._id, text })
  res.status(201).json({ note: publicProfileNote(note, req.user._id) })
}))
app.delete('/api/me/notes/:id', auth, handle(async (req, res) => {
  const note = await ProfileNote.findOneAndDelete({ _id: req.params.id, author: req.user._id })
  if (!note) return res.status(404).json({ error: 'Note not found.' })
  res.json({ ok: true })
}))
app.get('/api/users/username-availability', auth, handle(async (req, res) => {
  const username = String(req.query.username || '').trim().toLowerCase()
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(200).json({ available: false, suggestions: [] })
  const exists = username === req.user.username || await User.exists({ username })
  const suggestions = []
  if (exists && username !== req.user.username) {
    for (let suffix = 1; suffix <= 8 && suggestions.length < 4; suffix++) {
      const candidate = `${username.slice(0, Math.min(username.length, 21))}${suffix}`
      if (!(await User.exists({ username: candidate }))) suggestions.push(candidate)
    }
  }
  res.json({ available: !exists || username === req.user.username, suggestions })
}))
app.post('/api/users/:id/follow', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || target._id.equals(req.user._id)) return res.status(404).json({ error: 'That profile could not be found.' })
  if (target.bannedAt) return res.status(403).json({ error: 'You cannot follow a banned account.' })
  if (req.user.blockedUsers.some(id => id.equals(target._id)) || target.blockedUsers.some(id => id.equals(req.user._id))) return res.status(403).json({ error: 'This person is unavailable because of a block.' })
  if (target.privateProfile && !target.followers.some(id => id.equals(req.user._id))) {
    const alreadyRequested = target.followRequestsIncoming.some(id => id.equals(req.user._id))
    target.followRequestsIncoming.addToSet(req.user._id)
    req.user.followRequestsOutgoing.addToSet(target._id)
    await Promise.all([req.user.save(), target.save()])
    if (!alreadyRequested) await createActivity(target._id, req.user._id, 'follow_request')
    return res.json({ following: false, requested: true, followerCount: target.followers.length, followingCount: req.user.following.length })
  }
  target.followRequestsIncoming.pull(req.user._id)
  req.user.followRequestsOutgoing.pull(target._id)
  req.user.following.addToSet(target._id)
  target.followers.addToSet(req.user._id)
  await Promise.all([req.user.save(), target.save()])
  await refreshLiveAudiencePair(req.user._id, target._id)
  res.json({ following: true, followerCount: target.followers.length, followingCount: req.user.following.length })
}))
app.delete('/api/users/:id/follow', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || target._id.equals(req.user._id)) return res.status(404).json({ error: 'That profile could not be found.' })
  target.followRequestsIncoming.pull(req.user._id)
  req.user.followRequestsOutgoing.pull(target._id)
  req.user.following.pull(target._id)
  target.followers.pull(req.user._id)
  await Promise.all([req.user.save(), target.save()])
  await refreshLiveAudiencePair(req.user._id, target._id)
  res.json({ following: false, followerCount: target.followers.length, followingCount: req.user.following.length })
}))
app.delete('/api/users/:id/follower', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || target._id.equals(req.user._id)) return res.status(404).json({ error: 'That profile could not be found.' })
  req.user.followers.pull(target._id)
  target.following.pull(req.user._id)
  await Promise.all([req.user.save(), target.save()])
  await refreshLiveAudiencePair(req.user._id, target._id)
  res.json({ removed: true, followerCount: req.user.followers.length, followingCount: target.following.length })
}))
app.get('/api/me/follow-requests', auth, handle(async (req, res) => {
  const users = await User.find({ _id: { $in: req.user.followRequestsIncoming || [] } }).select('username displayName bio avatarUrl avatarBorder avatarBorderColor bannerUrl location website pronouns followers following friends').sort({ username: 1 })
  res.json({ users: users.map(user => ({ ...publicProfileUser(user), relationship: isFriend(req.user, user._id) ? 'friend' : 'none' })) })
}))
app.post('/api/me/follow-requests/:id/approve', auth, handle(async (req, res) => {
  const requester = await User.findById(req.params.id)
  if (!requester || !req.user.followRequestsIncoming.some(id => id.equals(requester._id))) return res.status(404).json({ error: 'Follow request not found.' })
  req.user.followRequestsIncoming.pull(requester._id); requester.followRequestsOutgoing.pull(req.user._id)
  req.user.followers.addToSet(requester._id); requester.following.addToSet(req.user._id)
  await Promise.all([req.user.save(), requester.save()])
  await refreshLiveAudiencePair(req.user._id, requester._id)
  res.json({ ok: true, followerCount: req.user.followers.length })
}))
app.post('/api/me/follow-requests/approve-all', auth, handle(async (req, res) => {
  const ids = [...(req.user.followRequestsIncoming || [])]
  if (ids.length) {
    await User.updateMany({ _id: { $in: ids } }, { $addToSet: { following: req.user._id }, $pull: { followRequestsOutgoing: req.user._id } })
    req.user.followers.addToSet(...ids); req.user.followRequestsIncoming = []
    await req.user.save()
    for (const id of ids) await refreshLiveAudiencePair(req.user._id, id)
  }
  res.json({ ok: true, approvedCount: ids.length, followerCount: req.user.followers.length })
}))
app.post('/api/me/follow-requests/:id/reject', auth, handle(async (req, res) => {
  const requester = await User.findById(req.params.id)
  if (!requester || !req.user.followRequestsIncoming.some(id => id.equals(requester._id))) return res.status(404).json({ error: 'Follow request not found.' })
  req.user.followRequestsIncoming.pull(requester._id); requester.followRequestsOutgoing.pull(req.user._id)
  await Promise.all([req.user.save(), requester.save()]); res.json({ ok: true })
}))
for (const list of ['followers','following','friends']) app.get(`/api/users/:username/${list}`, auth, handle(async (req, res) => {
  const target = await User.findOne({ username: String(req.params.username || '').toLowerCase() }).select('followers following privateProfile friends')
  if (!target) return res.status(404).json({ error: 'That profile could not be found.' })
  const isFollower = (target.followers || []).some(id => id.equals(req.user._id))
  if (target.privateProfile && !isFollower && !isFriend(req.user, target._id) && !target._id.equals(req.user._id)) return res.status(403).json({ error: 'Follow this private profile to view its connections.' })
  const users = await User.find({ _id: { $in: target[list] || [] } }).select('username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').sort({ username: 1 })
  res.json({ users: users.map(publicUser) })
}))
app.get('/api/users/:username/profile', auth, handle(async (req, res) => {
  const username = String(req.params.username || '').toLowerCase()
  const profileLookup = username.startsWith('id-') && mongoose.Types.ObjectId.isValid(username.slice(3))
    ? User.findById(username.slice(3))
    : User.findOne({ username })
  const user = await profileLookup.select('username displayName bio avatarUrl avatarBorder avatarBorderColor bannerUrl createdAt bannedAt location website pronouns gender age hobbies relationWith relationshipStatus favoriteGame privateProfile followers following friends incoming outgoing followRequestsIncoming blockedUsers reconnectRequired messagePrivacy')
  if (!user) return res.status(404).json({ error: 'That profile could not be found.' })
  const blockedByViewer = (req.user.blockedUsers || []).some(id => id.equals(user._id))
  const blockedViewer = (user.blockedUsers || []).some(id => id.equals(req.user._id))
  if (blockedByViewer || blockedViewer) return res.json({ user: { id: user.id, username: 'user', displayName: '@user', bio: '', avatarUrl: '', bannerUrl: '', relationship: 'none', followerCount: 0, followingCount: 0, friendCount: 0, postCount: 0, reelCount: 0, noteCount: 0, blockedProfile: true, canViewContent: false }, posts: [], reels: [], notes: [] })

  const relationship = isFriend(req.user, user._id) ? 'friend' : req.user.outgoing.some(id => id.equals(user._id)) ? 'sent' : req.user.incoming.some(id => id.equals(user._id)) ? 'received' : 'none'
  const isFollowing = user.followers.some(id => id.equals(req.user._id))
  const canViewContent = user._id.equals(req.user._id) || !user.privateProfile || isFollowing || relationship === 'friend'
  const moderationVisibility = { moderationStatus: { $nin: ['pending','processing','removed'] } }
  const [posts, reels, legacyNotes, notePosts, postCount, reelCount, legacyNoteCount, notePostCount] = await Promise.all([
    canViewContent ? Post.find({ author: user._id, kind: 'post', archived: { $ne: true }, ...moderationVisibility }).sort({ createdAt: -1 }).limit(60).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor bannerUrl location website pronouns').lean() : [],
    canViewContent ? Post.find({ author: user._id, kind: 'reel', archived: { $ne: true }, ...moderationVisibility }).sort({ createdAt: -1 }).limit(60).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor bannerUrl location website pronouns').lean() : [],
    canViewContent ? ProfileNote.find({ author: user._id }).sort({ createdAt: -1 }).limit(100).lean() : [],
    canViewContent ? Post.find({ author: user._id, kind: 'note', archived: { $ne: true } }).sort({ createdAt: -1 }).limit(100).lean() : [],
    Post.countDocuments({ author: user._id, kind: 'post', archived: { $ne: true }, ...moderationVisibility }),
    Post.countDocuments({ author: user._id, kind: 'reel', archived: { $ne: true }, ...moderationVisibility }),
    ProfileNote.countDocuments({ author: user._id }),
    Post.countDocuments({ author: user._id, kind: 'note', archived: { $ne: true } }),
  ])
  const notes = [...legacyNotes.map(note => ({ ...publicProfileNote(note, req.user._id), legacy: true })), ...notePosts.map(note => ({ id: note._id.toString(), authorId: note.author.toString(), text: note.caption, createdAt: note.createdAt, noteTheme: note.noteTheme || 'classic', noteSymbol: NOTE_THEMES.find(theme => theme.id === (note.noteTheme || 'classic'))?.symbol || '\u2726', noteBackgroundColor: note.noteBackgroundColor || '#eeeaff', noteTextColor: note.noteTextColor || '#342e48', likesCount: note.likes?.length || 0, likedByMe: (note.likes || []).some(id => id.toString() === req.user._id.toString()), shareCount: note.shareCount || 0, likesHidden: !!note.likesHidden, legacy: false }))].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const isFollowRequested = (user.followRequestsIncoming || []).some(id => id.equals(req.user._id))
  res.json({ user: { ...publicProfileUser(user), relationship, requiresFriendReconnect: pairRequiresReconnect(req.user, user), followerCount: user.followers.length, followingCount: user.following.length, postCount, reelCount, noteCount: legacyNoteCount + notePostCount, isFollowing, isFollowRequested, pendingFollowRequestCount: user._id.equals(req.user._id) ? (user.followRequestsIncoming || []).length : undefined, canViewContent }, posts: posts.map(post => publicPost(post, req.user._id)), reels: reels.map(post => publicPost(post, req.user._id)), notes })
}))
app.get('/api/posts', auth, handle(async (req, res) => {
  if (req.query.liked === 'true') {
    const kind = ['post','reel','note'].includes(req.query.kind) ? req.query.kind : null
    if (!kind) return res.status(400).json({ error: 'Choose posts, Reels, or Notes.' })
    const [likedPosts, likedLegacyNotes] = await Promise.all([
      Post.find({ kind, likes: req.user._id, archived: { $ne: true }, moderationStatus: { $nin: ['pending','processing','removed'] } }).sort({ createdAt: -1 }).limit(100).populate('author', 'username displayName bio avatarUrl avatarBorder avatarColor location website pronouns').lean(),
      kind === 'note' ? ProfileNote.find({ likes: req.user._id }).sort({ createdAt: -1 }).limit(100).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean() : []
    ])
    const accessiblePosts = await Promise.all(likedPosts.map(async post => await canViewUserContent(req.user, post.author._id) && !pairIsBlocked(req.user, post.author) ? publicPost(post, req.user._id) : null))
    const accessibleLegacyNotes = await Promise.all(likedLegacyNotes.map(async note => await canViewUserContent(req.user, note.author._id) && !pairIsBlocked(req.user, note.author) ? publicLegacyNotePost(note, req.user._id) : null))
    const posts = [...accessiblePosts, ...accessibleLegacyNotes].filter(Boolean).sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt)).slice(0, 100)
    return res.json({ posts })
  }
  if (req.query.archived === 'true') {
    const archivedPosts = await Post.find({ author: req.user._id, archived: true }).sort({ createdAt: -1 }).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
    return res.json({ posts: archivedPosts.map(post => publicPost(post, req.user._id)) })
  }
  const kind = ['post','reel','note'].includes(req.query.kind) ? req.query.kind : 'post'
  const allowedAuthors = [...new Set([req.user._id.toString(), ...(req.user.following || []).map(id => id.toString()), ...(req.user.friends || []).map(id => id.toString())])]
  const recommendationSignals = await RecommendationSignal.find({ user: req.user._id }).sort({ updatedAt: -1 }).limit(300).lean()
  if (kind === 'post') {
    const [posts, notePosts, legacyNotes] = await Promise.all([
      Post.find({ kind: 'post', archived: { $ne: true }, author: { $in: allowedAuthors }, moderationStatus: { $nin: ['pending','processing','removed'] } }).sort({ createdAt: -1 }).limit(40).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean(),
      Post.find({ kind: 'note', archived: { $ne: true }, author: { $in: allowedAuthors }, moderationStatus: { $nin: ['pending','processing','removed'] } }).sort({ createdAt: -1 }).limit(100).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean(),
      ProfileNote.find({ author: { $in: allowedAuthors } }).sort({ createdAt: -1 }).limit(100).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
    ])
    const eligibleNotes = await Promise.all(legacyNotes.map(async note => await canViewUserContent(req.user, note.author) && !pairIsBlocked(req.user, note.author) ? publicLegacyNotePost(note, req.user._id) : null))
    const feed = [...posts.map(post => publicPost(post, req.user._id)), ...notePosts.map(note => publicPost(note, req.user._id)), ...eligibleNotes.filter(Boolean)]
    const rankedFeed = rankRecommendedPosts(feed, recommendationSignals).slice(0, 60)
    return res.json({ posts: rankedFeed })
  }
  if (kind === 'reel') {
    const reels = []
    const pageSize = 40
    // Scan newest first in batches so private or blocked accounts do not
    // leave the viewer with a short feed when public Reels are available.
    for (let skip = 0; reels.length < 80 && skip < 400; skip += pageSize) {
      const batch = await Post.find({ kind: 'reel', archived: { $ne: true }, moderationStatus: { $nin: ['pending','processing','removed'] } })
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns privateProfile blockedUsers')
        .lean()
      if (!batch.length) break
      for (const reel of batch) {
        if (!reel.author || pairIsBlocked(req.user, reel.author)) continue
        if (!await canViewUserContent(req.user, reel.author)) continue
        reels.push(publicPost(reel, req.user._id))
        if (reels.length === 80) break
      }
      if (batch.length < pageSize) break
    }
    return res.json({ posts: rankRecommendedPosts(reels, recommendationSignals).slice(0, 40) })
  }
  const posts = await Post.find({ kind, archived: { $ne: true }, author: { $in: allowedAuthors }, moderationStatus: { $nin: ['pending','processing','removed'] } }).sort({ createdAt: -1 }).limit(40).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
  res.json({ posts: rankRecommendedPosts(posts, recommendationSignals).map(post => publicPost(post, req.user._id)) })
}))
app.post('/api/recommendations/feedback', auth, handle(async (req, res) => {
  const postId = String(req.body?.postId || '')
  const action = String(req.body?.action || '')
  if (!mongoose.Types.ObjectId.isValid(postId) || !['view','skip'].includes(action)) return res.status(400).json({ error: 'Invalid recommendation feedback.' })
  const post = await Post.findOne({ _id: postId, kind: { $in: ['post','reel'] }, archived: { $ne: true }, moderationStatus: 'approved' }).select('author caption topics kind').lean()
  if (!post || !await canViewUserContent(req.user, post.author) || pairIsBlocked(req.user, post.author)) return res.status(404).json({ error: 'This content is unavailable.' })
  await RecommendationSignal.deleteOne({ user: req.user._id, post: post._id, action: action === 'view' ? 'skip' : 'view' })
  await recordRecommendationSignal(req.user._id, post, action, Math.min(60000, Math.max(0, Number(req.body?.watchMs) || 0)))
  res.json({ recorded: true })
}))
app.post('/api/posts', auth, upload.fields([{ name: 'media', maxCount: 10 }, { name: 'imageVariants', maxCount: 20 }]), handle(async (req, res) => {
  const caption = String(req.body?.caption || '').trim()
  const kind = ['post','reel','note'].includes(req.body?.kind) ? req.body.kind : 'post'
  const files = req.files?.media || []
  const variantFiles = req.files?.imageVariants || []
  const allFiles = [...files, ...variantFiles]
  const discardFiles = () => allFiles.forEach(file => fs.unlink(file.path, () => {}))
  if (kind === 'note' && (allFiles.length || !caption || caption.trim().split(/\s+/).filter(Boolean).length > 250)) { discardFiles(); return res.status(400).json({ error: 'Notes must contain text only and be no longer than 250 words.' }) }
  if (kind === 'note' ? caption.length > 15000 : caption.length > 2200) { discardFiles(); return res.status(400).json({ error: kind === 'note' ? 'Notes can be up to 250 words.' : 'Captions can be up to 2,200 characters.' }) }
  if (kind === 'post' && !files.length) { discardFiles(); return res.status(400).json({ error: 'Add at least one photo or video to publish a post. For text only, share a Note.' }) }
  if (kind === 'reel' && (files.length !== 1 || !files[0].mimetype.startsWith('video/'))) { discardFiles(); return res.status(400).json({ error: 'Choose a single video to publish a Reel.' }) }
  if (files.length > 10 || variantFiles.length > 20 || allFiles.reduce((total, file) => total + file.size, 0) > 200 * 1024 * 1024) { discardFiles(); return res.status(400).json({ error: 'A post and its optimized image sizes must stay under 200 MB total.' }) }
  if (kind === 'note' && !caption) return res.status(400).json({ error: 'Add text to publish a Note.' })
  const variantsByMedia = new Map()
  for (const file of variantFiles) {
    const match = /^media-(\d+)-(480|960)\.webp$/i.exec(file.originalname || '')
    const mediaIndex = match ? Number(match[1]) : -1
    if (!match || file.mimetype !== 'image/webp' || !files[mediaIndex] || !files[mediaIndex].mimetype.startsWith('image/')) { discardFiles(); return res.status(400).json({ error: 'An optimized image variant is invalid. Please retry your upload.' }) }
    const variants = variantsByMedia.get(mediaIndex) || []
    variants.push({ width: Number(match[2]), url: `/uploads/${path.basename(file.path)}` })
    variantsByMedia.set(mediaIndex, variants)
  }
  const mediaItems = files.map((file, index) => {
    const type = file.mimetype.startsWith('video/') ? 'video' : 'image'
    const item = { url: `/uploads/${path.basename(file.path)}`, type }
    if (type === 'image') {
      const mainSize = /^media-\d+-(\d+)\.webp$/i.exec(file.originalname || '')
      const variants = variantsByMedia.get(index) || []
      if (mainSize) variants.push({ width: Number(mainSize[1]), url: item.url })
      if (variants.length) item.variants = variants.sort((a, b) => a.width - b.width)
    }
    if (type === 'video') item.playback = { status: 'queued' }
    return item
  })
  const requestedTheme = String(req.body?.noteTheme || 'classic')
  const noteTheme = NOTE_THEMES.some(theme => theme.id === requestedTheme) ? requestedTheme : 'classic'
  const requestedColor = String(req.body?.noteBackgroundColor || '')
  const noteBackgroundColor = isValidNoteColor(requestedColor) ? requestedColor : (NOTE_THEMES.find(theme => theme.id === noteTheme)?.color || '#eeeaff')
  const requestedTextColor = String(req.body?.noteTextColor || '')
  const noteTextColor = isValidNoteColor(requestedTextColor) ? requestedTextColor : '#342e48'
  const needsModeration = kind === 'post' || kind === 'reel'
  const post = await Post.create({ author: req.user._id, caption, topics: extractPostTopics(caption), kind, mediaUrl: mediaItems[0]?.url || '', mediaType: mediaItems[0]?.type || 'image', mediaItems, moderationStatus: needsModeration ? 'pending' : 'approved', ...(kind === 'reel' ? { mediaDelivery: { status: 'queued' } } : {}), likesHidden: req.body?.likesHidden === 'true', commentsDisabled: req.body?.commentsDisabled === 'true', noteTheme: kind === 'note' ? noteTheme : 'classic', noteBackgroundColor: kind === 'note' ? noteBackgroundColor : '#eeeaff', noteTextColor: kind === 'note' ? noteTextColor : '#342e48' })
  if (needsModeration) enqueuePostModeration(post._id)
  else mediaItems.forEach((item, index) => { if (item.type === 'video') scheduleVideoTranscode(post._id, item.url, index) })
  await post.populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
  res.status(201).json({ post: publicPost(post, req.user._id) })
}))
app.get('/api/posts/:id', auth, handle(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Note or post not found.' })
  const post = await Post.findById(req.params.id).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
  if (post) {
    if (['pending','processing','removed'].includes(post.moderationStatus) && post.author._id.toString() !== req.user._id.toString()) return res.status(404).json({ error: 'Post not found.' })
    if (!await canViewUserContent(req.user, post.author._id)) return res.status(403).json({ error: 'Follow this account to view this post.' })
    return res.json({ post: publicPost(post, req.user._id) })
  }
  const note = await ProfileNote.findById(req.params.id).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
  if (!note) return res.status(404).json({ error: 'Note or post not found.' })
  if (!await canViewUserContent(req.user, note.author._id)) return res.status(403).json({ error: 'Follow this account to view this note.' })
  res.json({ post: publicLegacyNotePost(note, req.user._id) })
}))
app.get('/api/posts/:id/playback', auth, handle(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Reel not found.' })
  const post = await Post.findOne({ _id: req.params.id, moderationStatus: { $nin: ['pending','processing','removed'] } }).select('author kind mediaUrl mediaType mediaDelivery mediaItems').lean()
  if (!post || !['post','reel'].includes(post.kind)) return res.status(404).json({ error: 'Post video not found.' })
  if (!await canViewUserContent(req.user, post.author) || pairIsBlocked(req.user, post.author)) return res.status(403).json({ error: 'You cannot view this post.' })
  const mediaIndex = Number(req.query.media || 0)
  if (!Number.isInteger(mediaIndex) || mediaIndex < 0) return res.status(400).json({ error: 'Invalid post media index.' })
  const item = post.mediaItems?.[mediaIndex]
  if (item?.type === 'video') return res.json({ playback: { status: item.playback?.status || (post.kind === 'reel' ? post.mediaDelivery?.status : 'fallback') || 'fallback', hlsUrl: item.playback?.masterUrl || (post.kind === 'reel' && mediaIndex === 0 ? post.mediaDelivery?.masterUrl : '') || '', av1Url: item.playback?.av1Url || (post.kind === 'reel' && mediaIndex === 0 ? post.mediaDelivery?.av1Url : '') || '', sourceUrl: item.url } })
  if (post.kind === 'reel' && mediaIndex === 0 && post.mediaType === 'video') return res.json({ playback: { status: post.mediaDelivery?.status || 'fallback', hlsUrl: post.mediaDelivery?.masterUrl || '', av1Url: post.mediaDelivery?.av1Url || '', sourceUrl: post.mediaUrl } })
  return res.status(404).json({ error: 'Post video not found.' })
}))
app.post('/api/posts/:id/like', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id)
  if (post) {
    if (!await User.exists({ _id: post.author })) return res.status(404).json({ error: 'Post author not found.' })
    if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'Follow this account to interact with its posts.' })
    const wasLiked = post.likes.some(id => id.equals(req.user._id))
    const liked = typeof req.body?.liked === 'boolean' ? req.body.liked : !wasLiked
    if (liked !== wasLiked) await Post.updateOne({ _id: post._id }, liked ? { $addToSet: { likes: req.user._id } } : { $pull: { likes: req.user._id } })
    const count = await Post.findById(post._id).select('likes').lean()
    if (liked && !wasLiked) await createActivity(post.author, req.user._id, 'like', post._id, post.kind)
    if (liked && !wasLiked) void recordRecommendationSignal(req.user._id, post, 'like').catch(error => console.warn('Recommendation like signal failed:', error.message))
    else if (!liked && wasLiked) void RecommendationSignal.deleteOne({ user: req.user._id, post: post._id, action: 'like' }).catch(error => console.warn('Recommendation unlike signal failed:', error.message))
    return res.json({ liked, likesCount: count.likes.length })
  }
  const note = await ProfileNote.findById(req.params.id).select('likes author')
  if (!note) return res.status(404).json({ error: 'Note or post not found.' })
  if (!await canViewUserContent(req.user, note.author)) return res.status(403).json({ error: 'Follow this account to interact with this note.' })
  const wasLiked = note.likes.some(id => id.equals(req.user._id))
  const liked = typeof req.body?.liked === 'boolean' ? req.body.liked : !wasLiked
  if (liked !== wasLiked) await ProfileNote.updateOne({ _id: note._id }, liked ? { $addToSet: { likes: req.user._id } } : { $pull: { likes: req.user._id } })
  const count = await ProfileNote.findById(note._id).select('likes').lean()
  if (liked && !wasLiked) await createActivity(note.author, req.user._id, 'like')
  res.json({ liked, likesCount: count.likes.length })
}))
app.get('/api/posts/:id/comments', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id).select('author')
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'Follow this account to view its post comments.' })
  const parentCommentId = req.query.parentCommentId ? String(req.query.parentCommentId) : ''
  if (parentCommentId) {
    if (!mongoose.Types.ObjectId.isValid(parentCommentId)) return res.status(400).json({ error: 'That comment is no longer available.' })
    const parent = await Comment.findOne({ _id: parentCommentId, post: req.params.id }).select('_id')
    if (!parent) return res.status(404).json({ error: 'That comment is no longer available.' })
    const replies = await Comment.find({ post: req.params.id, parentComment: parent._id }).sort({ createdAt: 1 }).limit(100).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
    return res.json({ comments: replies.map(comment => publicComment(comment, req.user._id)) })
  }
  const comments = await Comment.find({ post: req.params.id, parentComment: null }).sort({ createdAt: 1 }).limit(100).populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()
  const replyCounts = comments.length ? await Comment.aggregate([{ $match: { post: post._id, parentComment: { $in: comments.map(comment => comment._id) } } }, { $group: { _id: '$parentComment', count: { $sum: 1 } } }]) : []
  const countByParent = new Map(replyCounts.map(item => [item._id.toString(), item.count]))
  res.json({ comments: comments.map(comment => ({ ...publicComment(comment, req.user._id), repliesCount: countByParent.get(comment._id.toString()) || 0 })) })
}))
app.post('/api/posts/:id/comments', auth, handle(async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text || text.length > 1000) return res.status(400).json({ error: 'Comments must be 1â€“1,000 characters.' })
  const post = await Post.findById(req.params.id)
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'Follow this account to interact with its posts.' })
  if (post.commentsDisabled) return res.status(403).json({ error: 'Comments are turned off for this post.' })
  let parentComment = null
  if (req.body?.parentCommentId) {
    if (!mongoose.Types.ObjectId.isValid(String(req.body.parentCommentId))) return res.status(400).json({ error: 'That comment is no longer available.' })
    parentComment = await Comment.findOne({ _id: req.body.parentCommentId, post: post._id }).select('_id')
    if (!parentComment) return res.status(400).json({ error: 'That comment is no longer available.' })
  }
  const comment = await Comment.create({ post: post._id, author: req.user._id, parentComment: parentComment?._id || null, text })
  await Post.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } })
  void recordRecommendationSignal(req.user._id, post, 'comment').catch(error => console.warn('Recommendation comment signal failed:', error.message))
  await comment.populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
  await createActivity(post.author, req.user._id, 'comment', post._id, post.kind)
  res.status(201).json({ comment: publicComment(comment, req.user._id) })
}))
app.post('/api/posts/:id/comments/:commentId/like', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id).select('author')
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'Follow this account to interact with its posts.' })
  const comment = await Comment.findOne({ _id: req.params.commentId, post: post._id }).select('likes')
  if (!comment) return res.status(404).json({ error: 'Comment not found.' })
  const liked = comment.likes.some(id => id.equals(req.user._id))
  await Comment.updateOne({ _id: comment._id }, liked ? { $pull: { likes: req.user._id } } : { $addToSet: { likes: req.user._id } })
  const updated = await Comment.findById(comment._id).select('likes').lean()
  res.json({ liked: !liked, likesCount: updated?.likes.length || 0 })
}))
app.delete('/api/posts/:id/comments/:commentId', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id).select('author commentCount')
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'You cannot manage comments on this post.' })
  const comment = await Comment.findOne({ _id: req.params.commentId, post: post._id }).select('author')
  if (!comment) return res.status(404).json({ error: 'Comment not found.' })
  if (!comment.author.equals(req.user._id) && !post.author.equals(req.user._id)) return res.status(403).json({ error: 'Only the comment author or post owner can delete this comment.' })
  const deletedIds = [comment._id]
  let parents = [comment._id]
  while (parents.length) {
    const children = await Comment.find({ post: post._id, parentComment: { $in: parents } }).select('_id').lean()
    parents = children.map(child => child._id)
    deletedIds.push(...parents)
  }
  await Comment.deleteMany({ _id: { $in: deletedIds }, post: post._id })
  await Post.updateOne({ _id: post._id }, { $inc: { commentCount: -deletedIds.length } })
  res.json({ deletedIds: deletedIds.map(id => id.toString()), deletedCount: deletedIds.length })
}))
app.post('/api/posts/:id/share', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id).select('shareCount author kind caption topics')
  if (post) {
    if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'Follow this account to interact with its posts.' })
    await Post.updateOne({ _id: post._id }, { $inc: { shareCount: 1 } })
    post.shareCount += 1
    await createActivity(post.author, req.user._id, 'share', post._id, post.kind)
    void recordRecommendationSignal(req.user._id, post, 'share').catch(error => console.warn('Recommendation share signal failed:', error.message))
    return res.json({ shareCount: post.shareCount })
  }
  const note = await ProfileNote.findById(req.params.id).select('shareCount author')
  if (!note) return res.status(404).json({ error: 'Note or post not found.' })
  if (!await canViewUserContent(req.user, note.author)) return res.status(403).json({ error: 'Follow this account to interact with this note.' })
  await ProfileNote.updateOne({ _id: note._id }, { $inc: { shareCount: 1 } })
  note.shareCount += 1
  await createActivity(note.author, req.user._id, 'share')
  res.json({ shareCount: note.shareCount })
}))
app.patch('/api/posts/:id', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id)
  if (post) {
    if (!post.author.equals(req.user._id)) return res.status(403).json({ error: 'You can only edit your own post settings.' })
    const allowed = ['likesHidden', 'commentsDisabled', 'archived', 'noteTheme', 'noteBackgroundColor', 'noteTextColor']
    const keys = Object.keys(req.body || {}).filter(key => allowed.includes(key))
    if (!keys.length || keys.some(key => ['likesHidden','commentsDisabled','archived'].includes(key) ? typeof req.body[key] !== 'boolean' : key === 'noteTheme' ? !NOTE_THEMES.some(theme => theme.id === req.body[key]) : !isValidNoteColor(req.body[key]))) return res.status(400).json({ error: 'Choose a valid post setting.' })
    for (const key of keys) post[key] = req.body[key]
    await post.save()
    await post.populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
    return res.json({ post: publicPost(post, req.user._id) })
  }
  const note = await ProfileNote.findById(req.params.id)
  if (!note) return res.status(404).json({ error: 'Note or post not found.' })
  if (!note.author.equals(req.user._id)) return res.status(403).json({ error: 'You can only edit your own note settings.' })
  const keys = Object.keys(req.body || {}).filter(key => ['likesHidden','noteTheme','noteBackgroundColor','noteTextColor'].includes(key))
  if (!keys.length || keys.some(key => key === 'likesHidden' ? typeof req.body[key] !== 'boolean' : key === 'noteTheme' ? !NOTE_THEMES.some(theme => theme.id === req.body[key]) : !isValidNoteColor(req.body[key]))) return res.status(400).json({ error: 'Choose a valid note setting.' })
  for (const key of keys) note[key] = req.body[key]
  await note.save()
  await note.populate('author', 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
  res.json({ post: publicLegacyNotePost(note, req.user._id) })
}))
app.delete('/api/posts/:id', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id)
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!post.author.equals(req.user._id)) return res.status(403).json({ error: 'You can only delete your own post.' })
  await Promise.all([Comment.deleteMany({ post: post._id }), Activity.deleteMany({ post: post._id }), RecommendationSignal.deleteMany({ post: post._id }), post.deleteOne()])
  await removePostMedia(post)
  res.json({ ok: true })
}))
app.get('/api/users', auth, handle(async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@+/, '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const select = 'username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns gender age hobbies relationWith friends incoming outgoing followers followRequestsIncoming privateProfile blockedUsers reconnectRequired messagePrivacy'
  const relationshipFor = u => isFriend(req.user, u._id) ? 'friend' : req.user.outgoing.some(x => x.equals(u._id)) ? 'sent' : req.user.incoming.some(x => x.equals(u._id)) ? 'received' : 'none'
  const followStateFor = u => ({ isFollowing: (u.followers || []).some(id => id.equals(req.user._id)), isFollowRequested: (u.followRequestsIncoming || []).some(id => id.equals(req.user._id)), privateProfile: !!u.privateProfile, requiresFriendReconnect: pairRequiresReconnect(req.user, u) })
  if (q.length >= 2) {
    const users = await User.find({ _id: { $nin: [req.user._id, ...(req.user.blockedUsers || [])] }, blockedUsers: { $ne: req.user._id }, $or: [{ username: new RegExp(q, 'i') }, { displayName: new RegExp(q, 'i') }] }).select(select).limit(20)
    return res.json({ users: users.map(u => ({ ...publicUser(u), ...followStateFor(u), relationship: relationshipFor(u) })) })
  }
  const blockedBy = await User.find({ blockedUsers: req.user._id }).distinct('_id')
  const excluded = new Set([req.user._id.toString(), ...(req.user.blockedUsers || []).map(id => id.toString()), ...blockedBy.map(id => id.toString()), ...req.user.friends, ...req.user.incoming, ...req.user.outgoing].map(id => id.toString()))
  const mutualCounts = new Map()
  if (req.user.friends.length) {
    const friendRows = await User.find({ _id: { $in: req.user.friends } }).select('friends').lean()
    for (const friend of friendRows) for (const id of friend.friends) { const key = id.toString(); if (!excluded.has(key)) mutualCounts.set(key, (mutualCounts.get(key) || 0) + 1) }
  }
  const mutualIds = [...mutualCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id)
  const suggestions = mutualIds.length ? await User.find({ _id: { $in: mutualIds } }).select(select).lean() : []
  const byId = new Map(suggestions.map(user => [user._id.toString(), user]))
  const ranked = mutualIds.map(id => byId.get(id)).filter(Boolean)
  const remaining = Math.max(0, 12 - ranked.length)
  const newest = remaining ? await User.find({ _id: { $nin: [...excluded, ...ranked.map(user => user._id.toString())] } }).select(select).sort({ createdAt: -1 }).limit(remaining).lean() : []
  const users = [...ranked, ...newest].map(user => {
    const count = mutualCounts.get(user._id.toString()) || 0
    return { ...publicUser(user), ...followStateFor(user), relationship: relationshipFor(user), suggestionReason: count ? `${count} mutual friend${count === 1 ? '' : 's'}` : 'New on Social Land' }
  })
  res.json({ users })
}))
app.get('/api/friends', auth, handle(async (req, res) => {
  const [friends, requests] = await Promise.all([User.find({ _id: { $in: req.user.friends } }).select('username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean(), User.find({ _id: { $in: req.user.incoming } }).select('username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns').lean()])
  res.json({ friends: friends.map(publicUser), requests: requests.map(publicUser) })
}))
app.post('/api/friends/:id/request', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'That profile could not be found.' })
  if (target.bannedAt) return res.status(403).json({ error: 'You cannot send a friend request to a banned account.' })
  if (req.user.blockedUsers.some(id => id.equals(target._id)) || target.blockedUsers.some(id => id.equals(req.user._id))) return res.status(403).json({ error: 'This person is unavailable because of a block.' })
  if (isFriend(req.user, target._id)) return res.status(409).json({ error: 'You are already friends.' })
  if (req.user.incoming.some(x => x.equals(target._id))) return res.status(409).json({ error: 'They already sent you a request. Accept it in Friends.' })
  if (!req.user.outgoing.some(x => x.equals(target._id))) { req.user.outgoing.push(target._id); target.incoming.push(req.user._id); await Promise.all([req.user.save(), target.save()]); io.to(target.id).emit('friend:request', publicUser(req.user)); await createActivity(target._id, req.user._id, 'friend_request') }
  res.json({ ok: true })
}))
app.post('/api/friends/:id/accept', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || !req.user.incoming.some(x => x.equals(target._id))) return res.status(404).json({ error: 'No pending request from that person.' })
  if (target.bannedAt) return res.status(403).json({ error: 'You cannot accept a friend request from a banned account.' })
  req.user.incoming.pull(target._id); target.outgoing.pull(req.user._id); req.user.reconnectRequired.pull(target._id); target.reconnectRequired.pull(req.user._id); req.user.friends.addToSet(target._id); target.friends.addToSet(req.user._id)
  await Promise.all([req.user.save(), target.save()]); await refreshLiveAudiencePair(req.user._id, target._id); io.to(target.id).emit('friend:accepted', publicUser(req.user)); io.to(req.user.id).emit('friend:accepted', publicUser(target)); await createActivity(target._id, req.user._id, 'friend_accepted'); res.json({ ok: true })
}))
app.post('/api/friends/:id/reject', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || !req.user.incoming.some(id => id.equals(target._id))) return res.status(404).json({ error: 'No pending request from that person.' })
  req.user.incoming.pull(target._id)
  target.outgoing.pull(req.user._id)
  await Promise.all([req.user.save(), target.save()])
  res.json({ ok: true })
}))
app.delete('/api/friends/:id', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || !isFriend(req.user, target._id)) return res.status(404).json({ error: 'Friend not found.' })
  req.user.friends.pull(target._id); target.friends.pull(req.user._id)
  req.user.incoming.pull(target._id); req.user.outgoing.pull(target._id)
  target.incoming.pull(req.user._id); target.outgoing.pull(req.user._id)
  await Promise.all([req.user.save(), target.save()])
  await refreshLiveAudiencePair(req.user._id, target._id)
  res.json({ removed: true, friendCount: req.user.friends.length })
}))
app.post('/api/conversations', auth, handle(async (req, res) => {
  if (Array.isArray(req.body?.memberIds)) {
    const name = String(req.body.name || '').trim().slice(0, 60)
    const ids = [...new Set([req.user.id, ...req.body.memberIds.map(String)])]
    if (!name || ids.length < 3 || ids.length > 51 || ids.some(id => !mongoose.Types.ObjectId.isValid(id))) return res.status(400).json({ error: 'Choose a group name and at least two friends.' })
    const members = await User.find({ _id: { $in: ids } }).select('_id friends groupAddPrivacy')
    const owner = members.find(user => user.id === req.user.id)
    if (members.length !== ids.length || !ids.slice(1).every(id => owner?.friends.some(friendId => friendId.toString() === id))) return res.status(403).json({ error: 'Group members must be your accepted friends.' })
    const approvalIds = members.filter(user => user.id !== req.user.id && user.groupAddPrivacy === 'approval').map(user => user.id)
    const activeIds = ids.filter(id => !approvalIds.includes(id))
    const group = await Conversation.create({ members: activeIds, isGroup: true, directKey: `group:${randomUUID()}`, groupName: name, groupImage: String(req.body.image || '').slice(0, 2000) })
    for (const inviteeId of approvalIds) {
      const invitation = await GroupInvitation.create({ conversation: group._id, inviter: req.user._id, invitee: inviteeId })
      io.to(inviteeId).emit('group:invite-request', { invitationId: invitation.id })
    }
    return res.status(201).json({ conversation: { id: group.id, isGroup: true, groupName: group.groupName, groupImage: group.groupImage, members: activeIds, user: { id: group.id, username: 'group', displayName: name, bio: '', avatarUrl: group.groupImage, lastSeenAt: null }, latestText: '', latestAt: group.latestAt } })
  }
  const target = await User.findById(req.body?.userId)
  if (!target) return res.status(404).json({ error: 'That profile could not be found.' })
  if (!canDirectlyInteract(req.user, target)) return res.status(403).json({ error: target.reconnectRequired?.some(id => id.equals(req.user._id)) || req.user.reconnectRequired?.some(id => id.equals(target._id)) ? 'Send and accept a new friend request before starting a chat with this person.' : req.user.blockedUsers?.some(id => id.equals(target._id)) || target.blockedUsers?.some(id => id.equals(req.user._id)) ? 'Chat is unavailable because one of you blocked the other.' : 'This person only accepts messages from friends. Send a friend request and wait for it to be accepted.' })
  const members = [req.user._id, target._id].sort((a,b) => a.toString().localeCompare(b.toString()))
  const directKey = members.map(x => x.toString()).join(':')
  const conversation = await Conversation.findOneAndUpdate({ directKey }, { $setOnInsert: { members, directKey }, $pull: { archivedFor: req.user._id, hiddenFor: req.user._id } }, { upsert: true, new: true, setDefaultsOnInsert: true })
  res.json({ conversation: { id: conversation.id, user: { ...publicUser(target), lastSeenAt: canViewPresence(req.user, target) ? target.lastSeenAt || null : null }, latestText: conversation.latestText, latestAt: conversation.latestAt } })
}))
app.get('/api/group-invitations', auth, handle(async (req, res) => {
  const invitations = await GroupInvitation.find({ invitee: req.user._id, status: 'pending' }).sort({ createdAt: -1 }).populate('conversation', 'groupName groupImage isGroup').populate('inviter', 'username displayName bio avatarUrl avatarBorder avatarBorderColor').lean()
  res.json({ invitations: invitations.filter(item => item.conversation?.isGroup && item.inviter).map(item => ({ id: item._id.toString(), groupId: item.conversation._id.toString(), groupName: item.conversation.groupName || 'Group chat', groupImage: item.conversation.groupImage || '', inviter: publicUser(item.inviter), createdAt: item.createdAt })) })
}))
app.post('/api/group-invitations/:id/respond', auth, handle(async (req, res) => {
  const response = req.body?.response
  if (!['approve','reject'].includes(response)) return res.status(400).json({ error: 'Choose approve or reject.' })
  const invitation = await GroupInvitation.findOne({ _id: req.params.id, invitee: req.user._id, status: 'pending' })
  if (!invitation) return res.status(404).json({ error: 'This group invitation is no longer available.' })
  if (response === 'approve' && !await canUseFriendFeaturesIds(invitation.inviter, req.user._id)) { invitation.status = 'rejected'; await invitation.save(); return res.status(403).json({ error: 'Reconnect as friends with the inviter before joining this group.' }) }
  const group = await Conversation.findOne({ _id: invitation.conversation, isGroup: true })
  if (!group) { invitation.status = 'rejected'; await invitation.save(); return res.status(404).json({ error: 'This group no longer exists.' }) }
  invitation.status = response === 'approve' ? 'accepted' : 'rejected'
  await invitation.save()
  if (response === 'approve') {
    group.members.addToSet(req.user._id)
    await group.save()
    io.to(group.id).emit('group:updated', { id: group.id, name: group.groupName, image: group.groupImage })
  }
  res.json({ ok: true, accepted: response === 'approve', groupId: group.id, groupName: group.groupName })
}))
app.delete('/api/conversations/:id/leave', auth, handle(async (req, res) => {
  const group = await Conversation.findOne({ _id: req.params.id, members: req.user._id, isGroup: true })
  if (!group) return res.status(404).json({ error: 'Group not found.' })
  const leaverName = req.user.displayName || 'A member'
  const text = `${leaverName} left the group.`
  const message = await Message.create({ conversation: group._id, sender: req.user._id, senderName: leaverName, text, system: true })
  group.members.pull(req.user._id)
  group.archivedFor.pull(req.user._id)
  group.hiddenFor.pull(req.user._id)
  group.mutedFor.pull(req.user._id)
  let systemMessage = null
  if (!group.members.length) await Promise.all([group.deleteOne(), GroupInvitation.deleteMany({ conversation: group._id })])
  else {
    group.latestText = text
    group.latestAt = message.createdAt
    await group.save()
    systemMessage = { id: message.id, conversationId: group.id, senderId: req.user.id, senderName: leaverName, text, system: true, deliveredAt: null, readAt: null, createdAt: message.createdAt }
    for (const memberId of group.members) io.to(memberId.toString()).emit('message:new', systemMessage)
  }
  io.to(group.id).emit('group:member-left', { conversationId: group.id, userId: req.user.id, displayName: leaverName, message: systemMessage })
  res.json({ ok: true })
}))
app.get('/api/conversations', auth, handle(async (req, res) => {
  const archivedOnly = req.query.archived === 'true'
  const rows = await Conversation.find({ members: req.user._id, hiddenFor: { $ne: req.user._id }, archivedFor: archivedOnly ? req.user._id : { $ne: req.user._id } }).sort({ latestAt: -1 }).lean()
  const users = await User.find({ _id: { $in: rows.flatMap(c => c.members).filter(id => !id.equals(req.user._id)) } }).select('username displayName bio avatarUrl avatarBorder avatarBorderColor lastSeenAt lastSeenPrivacy lastSeenFriendIds location website pronouns friends blockedUsers reconnectRequired messagePrivacy').lean()
  const byId = new Map(users.map(u => [u._id.toString(), u]))
  const visibleRows = []
  for (const conversation of rows) {
    if (conversation.isGroup) {
      const members = conversation.members.filter(id => !id.equals(req.user._id)).map(id => byId.get(id.toString()))
      if (members.length === conversation.members.length - 1 && members.every(member => member && !pairIsBlocked(req.user, member) && !pairRequiresReconnect(req.user, member))) visibleRows.push(conversation)
      continue
    }
    const peerId = conversation.members.find(id => !id.equals(req.user._id)), peer = byId.get(peerId?.toString())
    if (canDirectlyInteract(req.user, peer) || canDirectlyInteract(peer, req.user)) visibleRows.push(conversation)
  }
  const conversationIds = visibleRows.map(conversation => conversation._id)
  const [latestMessages, unreadCounts] = conversationIds.length ? await Promise.all([
    Message.aggregate([
      { $match: { conversation: { $in: conversationIds }, hiddenFor: { $ne: req.user._id } } },
      { $sort: { conversation: 1, _id: -1 } },
      { $group: { _id: '$conversation', message: { $first: '$$ROOT' } } }
    ]),
    Message.aggregate([
      { $match: { conversation: { $in: conversationIds }, sender: { $ne: req.user._id }, readAt: null, hiddenFor: { $ne: req.user._id } } },
      { $group: { _id: '$conversation', count: { $sum: 1 } } }
    ])
  ]) : [[], []]
  const latestByConversation = new Map(latestMessages.map(row => [row._id.toString(), row.message]))
  const unreadByConversation = new Map(unreadCounts.map(row => [row._id.toString(), row.count]))
  const previewById = new Map(visibleRows.map(conversation => {
    const id = conversation._id.toString(), latest = latestByConversation.get(id)
    return [id, { text: messagePreview(latest), at: latest?.createdAt || conversation.latestAt, unreadCount: unreadByConversation.get(id) || 0 }]
  }))
  res.json({ conversations: visibleRows.map(c => { const other = c.members.find(id => !id.equals(req.user._id)); const user = c.isGroup ? { _id: c._id, username: 'group', displayName: c.groupName || 'Group chat', bio: '', avatarUrl: c.groupImage || '', lastSeenAt: null } : byId.get(other.toString()); const preview = previewById.get(c._id.toString()); return { id: c._id.toString(), isGroup: !!c.isGroup, groupName: c.groupName || '', groupImage: c.groupImage || '', members: c.members.map(id => id.toString()), user: { ...publicUser(user), lastSeenAt: canViewPresence(req.user, user) ? user.lastSeenAt || null : null }, latestText: preview?.text || '', latestAt: preview?.at || c.latestAt, unreadCount: preview?.unreadCount || 0, muted: (c.mutedFor || []).some(id => id.equals(req.user._id)), blocked: !!user && (req.user.blockedUsers || []).some(id => id.equals(user._id)), unavailable: !!user && ((req.user.blockedUsers || []).some(id => id.equals(user._id)) || (user.blockedUsers || []).some(id => id.equals(req.user._id))) } }) })
}))
app.get('/api/conversations/search', auth, handle(async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 120)
  if (query.length < 2) return res.json({ results: [] })
  const conversations = await Conversation.find({ members: req.user._id, hiddenFor: { $ne: req.user._id } }).select('_id members isGroup groupName groupImage latestText latestAt').lean()
  const rows = await Message.find({ conversation: { $in: conversations.map(item => item._id) }, hiddenFor: { $ne: req.user._id }, text: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }).sort({ createdAt: -1 }).limit(100).lean()
  const peerIds = conversations.flatMap(c => c.members).filter(id => !id.equals(req.user._id))
  const users = await User.find({ _id: { $in: peerIds } }).select('username displayName bio avatarUrl avatarBorder avatarBorderColor lastSeenAt lastSeenPrivacy lastSeenFriendIds friends blockedUsers reconnectRequired messagePrivacy').lean()
  const byId = new Map(users.map(user => [user._id.toString(), user]))
  const visibleConversations = []
  for (const conversation of conversations) {
    if (conversation.isGroup) { if (await directConversationAllowed(conversation, req.user._id)) visibleConversations.push(conversation); continue }
    const peerId = conversation.members.find(id => !id.equals(req.user._id)), peer = byId.get(peerId?.toString())
    if (canDirectlyInteract(req.user, peer) || canDirectlyInteract(peer, req.user)) visibleConversations.push(conversation)
  }
  const byConversation = new Map(visibleConversations.map(c => { const peer = c.members.find(id => !id.equals(req.user._id)); const person = c.isGroup ? { _id: c._id, username: 'group', displayName: c.groupName || 'Group chat', bio: '', avatarUrl: c.groupImage || '', lastSeenAt: null } : byId.get(peer?.toString()); return [c._id.toString(), { id: c._id.toString(), isGroup: !!c.isGroup, groupName: c.groupName || '', groupImage: c.groupImage || '', members: c.members.map(id => id.toString()), user: { ...publicUser(person), lastSeenAt: canViewPresence(req.user, person) ? person.lastSeenAt || null : null }, latestText: c.latestText || '', latestAt: c.latestAt }] }))
  res.json({ results: rows.map(message => ({ id: message._id.toString(), text: message.text, createdAt: message.createdAt, conversation: byConversation.get(message.conversation.toString()) })).filter(result => result.conversation) })
}))
const memberConversation = async (id, userId) => Conversation.findOne({ _id: id, members: userId })
const directConversationAllowed = async (conversation, userId, direction='either') => {
  if (!conversation) return false
  if (conversation.isGroup) {
    const memberIds = conversation.members.filter(id => id.toString() !== String(userId))
    const [viewer, members] = await Promise.all([User.findById(userId).select('_id blockedUsers reconnectRequired'), User.find({ _id: { $in: memberIds } }).select('_id blockedUsers reconnectRequired')])
    return !!viewer && members.length === memberIds.length && members.every(member => !pairIsBlocked(viewer, member) && !pairRequiresReconnect(viewer, member))
  }
  const peerId = conversation.members.find(id => id.toString() !== String(userId))
  if (!peerId) return false
  const firstToSecond = await canDirectlyInteractIds(userId, peerId)
  if (direction === 'send') return firstToSecond
  return firstToSecond || await canDirectlyInteractIds(peerId, userId)
}
app.patch('/api/conversations/:id/group', auth, handle(async (req, res) => {
  const conversation = await Conversation.findOne({ _id: req.params.id, members: req.user._id, isGroup: true })
  if (!conversation || !await directConversationAllowed(conversation, req.user._id)) return res.status(404).json({ error: 'Group not found.' })
  if (typeof req.body?.name === 'string') conversation.groupName = req.body.name.trim().slice(0, 60) || conversation.groupName
  if (typeof req.body?.image === 'string') conversation.groupImage = req.body.image.slice(0, 2000)
  await conversation.save()
  io.to(conversation.id).emit('group:updated', { id: conversation.id, name: conversation.groupName, image: conversation.groupImage })
  res.json({ ok: true, name: conversation.groupName, image: conversation.groupImage })
}))
app.post('/api/conversations/:id/members', auth, handle(async (req, res) => {
  const group = await Conversation.findOne({ _id: req.params.id, members: req.user._id, isGroup: true })
  if (!group || !await directConversationAllowed(group, req.user._id)) return res.status(404).json({ error: 'Group not found.' })
  if (!Array.isArray(req.body?.memberIds) || !req.body.memberIds.length || req.body.memberIds.length > 50 || req.body.memberIds.some(id => !mongoose.Types.ObjectId.isValid(String(id)))) return res.status(400).json({ error: 'Choose at least one valid friend to add.' })
  const requestedIds = [...new Set(req.body.memberIds.map(String))]
  const friendIds = new Set((req.user.friends || []).map(id => id.toString()))
  if (requestedIds.some(id => !friendIds.has(id))) return res.status(403).json({ error: 'You can only add accepted friends to a group.' })
  if (group.members.length + requestedIds.filter(id => !group.members.some(member => member.toString() === id)).length > 51) return res.status(400).json({ error: 'Groups can have up to 51 members.' })
  const [people, pendingRows] = await Promise.all([
    User.find({ _id: { $in: requestedIds } }).select('_id displayName groupAddPrivacy'),
    GroupInvitation.find({ conversation: group._id, invitee: { $in: requestedIds }, status: 'pending' }).select('invitee')
  ])
  const pendingIds = new Set(pendingRows.map(item => item.invitee.toString()))
  const currentIds = new Set(group.members.map(id => id.toString()))
  const eligible = people.filter(person => !currentIds.has(person.id) && !pendingIds.has(person.id))
  const approvalPeople = eligible.filter(person => person.groupAddPrivacy === 'approval')
  const directPeople = eligible.filter(person => person.groupAddPrivacy !== 'approval')
  for (const person of approvalPeople) {
    const invitation = await GroupInvitation.create({ conversation: group._id, inviter: req.user._id, invitee: person._id })
    io.to(person.id).emit('group:invite-request', { invitationId: invitation.id })
  }
  if (directPeople.length) {
    group.members.addToSet(...directPeople.map(person => person._id))
    group.archivedFor.pull(...directPeople.map(person => person._id))
    group.hiddenFor.pull(...directPeople.map(person => person._id))
    await group.save()
    for (const person of directPeople) io.to(person.id).emit('group:added', { conversationId: group.id, groupName: group.groupName })
    io.to(group.id).emit('group:members-updated', { conversationId: group.id, members: group.members.map(id => id.toString()) })
  }
  res.json({ ok: true, added: directPeople.length, pending: approvalPeople.length, alreadyInvited: pendingIds.size, members: group.members.map(id => id.toString()) })
}))
app.post('/api/conversations/:id/mute', auth, handle(async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user._id)
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' })
  const muted = req.body?.muted === true
  await Conversation.updateOne({ _id: conversation._id }, muted ? { $addToSet: { mutedFor: req.user._id } } : { $pull: { mutedFor: req.user._id } })
  res.json({ muted })
}))
app.post('/api/users/:id/block', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || target._id.equals(req.user._id)) return res.status(404).json({ error: 'User not found.' })
  const blocked = req.body?.blocked !== false
  if (blocked) {
    await User.updateOne({ _id: req.user._id }, { $addToSet: { blockedUsers: target._id, reconnectRequired: target._id }, $pull: { friends: target._id, followers: target._id, following: target._id, incoming: target._id, outgoing: target._id, followRequestsIncoming: target._id, followRequestsOutgoing: target._id } })
    await User.updateOne({ _id: target._id }, { $addToSet: { reconnectRequired: req.user._id }, $pull: { friends: req.user._id, followers: req.user._id, following: req.user._id, incoming: req.user._id, outgoing: req.user._id, followRequestsIncoming: req.user._id, followRequestsOutgoing: req.user._id } })
    await refreshLiveAudiencePair(req.user._id, target._id)
    const sharedGroups = await Conversation.find({ isGroup: true, members: { $all: [req.user._id, target._id] } }).select('_id').lean()
    for (const group of sharedGroups) { io.in(req.user.id).socketsLeave(group._id.toString()); io.in(target.id).socketsLeave(group._id.toString()) }
    for (const [callId, call] of activeDirectCalls) if ((call.callerId === req.user.id && call.calleeId === target.id) || (call.callerId === target.id && call.calleeId === req.user.id)) {
      activeDirectCalls.delete(callId); pendingDirectIce.delete(callId); pendingDirectEnds.delete(callId)
      io.to(call.callerId).emit('call:signal', { from: req.user.id, kind: 'end', callId, conversationId: call.conversationId })
      io.to(call.calleeId).emit('call:signal', { from: req.user.id, kind: 'end', callId, conversationId: call.conversationId })
      void logCallMessage(call.conversationId, req.user._id, callId, call.mode, call.answered ? 'ended' : 'missed').catch(error => console.error('Call log write failed:', error.message))
    }
    for (const [callId, call] of activeChatCalls) {
      const people = new Set([call.hostId, ...call.invited, ...call.participants])
      if (!people.has(req.user.id) || !people.has(target.id)) continue
      clearTimeout(call.expiryTimer); activeChatCalls.delete(callId)
      for (const id of people) io.to(id).emit('group-call:ended', { callId })
      void logCallMessage(call.conversationId, req.user._id, callId, call.mode, call.everJoined ? 'ended' : 'missed').catch(error => console.error('Call log write failed:', error.message))
    }
    for (const session of activePartySessions.values()) {
      const people = new Set([session.hostId, ...session.invitedIds, ...session.participantIds])
      if (!people.has(req.user.id) || !people.has(target.id) || session.status !== 'open') continue
      session.status = 'ended'; session.playing = false
      io.to(`party:${session.id}`).emit('party:session', partySessionPayload(session))
      void updatePartyInviteMessages(session)
    }
    for (const session of activeGameSessions.values()) {
      const people = new Set([session.hostId, ...session.invitedIds, ...session.playerIds])
      if (!people.has(req.user.id) || !people.has(target.id) || session.status === 'ended') continue
      session.status = 'ended'; session.endedAt = new Date().toISOString()
      io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
      void updateGameInviteMessages(session)
    }
    io.to(target.id).emit('call:signal', { from: req.user.id, kind: 'blocked' })
    io.to(target.id).emit('privacy:blocked', { userId: req.user.id })
  } else await User.updateOne({ _id: req.user._id }, { $pull: { blockedUsers: target._id } })
  res.json({ blocked, needsReconnect: !blocked && (req.user.reconnectRequired || []).some(id => id.equals(target._id)) })
}))
app.post('/api/users/:id/report', auth, handle(async (req, res) => {
  if (req.params.id === req.user.id || !await User.exists({ _id: req.params.id })) return res.status(404).json({ error: 'User not found.' })
  const reason = String(req.body?.reason || '').trim().slice(0, 500)
  if (!reason) return res.status(400).json({ error: 'Add a reason for the report.' })
  await Report.create({ reporter: req.user._id, target: req.params.id, reason })
  res.status(201).json({ ok: true })
}))
app.delete('/api/conversations/:id', auth, handle(async (req, res) => {
  const action = req.body?.action
  if (!['archive', 'unarchive', 'delete'].includes(action)) return res.status(400).json({ error: 'Choose archive, unarchive, or delete.' })
  const conversation = await memberConversation(req.params.id, req.user._id)
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' })
  if (action === 'archive') {
    await Conversation.updateOne({ _id: conversation._id }, { $addToSet: { archivedFor: req.user._id }, $pull: { hiddenFor: req.user._id } })
  } else if (action === 'unarchive') {
    await Conversation.updateOne({ _id: conversation._id }, { $pull: { archivedFor: req.user._id } })
  } else {
    await Conversation.updateOne({ _id: conversation._id }, { $addToSet: { hiddenFor: req.user._id }, $pull: { archivedFor: req.user._id } })
    await Message.updateMany({ conversation: conversation._id }, { $addToSet: { hiddenFor: req.user._id } })
  }
  res.json({ ok: true })
}))
app.get('/api/conversations/:id/media/:filename', auth, handle(async (req, res) => {
  const filename = path.basename(req.params.filename)
  const conversation = await memberConversation(req.params.id, req.user._id)
  if (filename !== req.params.filename || !conversation || !await directConversationAllowed(conversation, req.user._id)) return res.status(404).json({ error: 'Media not found.' })
  const message = await Message.findOne({ conversation: req.params.id, mediaFilename: filename, hiddenFor: { $ne: req.user._id } }).select('_id sender viewOnce viewOnceRecipients viewOnceViewedBy mediaFilename')
  if (!message) return res.status(404).json({ error: 'Media not found.' })
  const filePath = path.join(chatUploadsDir, filename)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Media not found.' })
  let openedMessage = null
  if (message.viewOnce) {
    const viewerId = req.user._id
    if (message.sender.equals(viewerId) || !message.viewOnceRecipients.some(id => id.equals(viewerId))) return res.status(403).json({ error: 'Only a recipient can open this media.' })
    openedMessage = await Message.findOneAndUpdate({ _id: message._id, mediaFilename: filename, viewOnce: true, viewOnceRecipients: viewerId, viewOnceViewedBy: { $ne: viewerId } }, { $addToSet: { viewOnceViewedBy: viewerId } }, { new: true }).select('_id sender viewOnceRecipients viewOnceViewedBy')
    if (!openedMessage) return res.status(410).json({ error: 'This photo or video has already been opened.' })
    const openedCount = openedMessage.viewOnceViewedBy.length
    const update = { conversationId: conversation.id, messageId: message.id, viewerId: viewerId.toString(), openedCount, recipientCount: openedMessage.viewOnceRecipients.length }
    io.to(conversation.id).emit('message:view-once-opened', update)
    io.to(message.sender.toString()).emit('message:view-once-opened', update)
    res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0', 'X-Content-Type-Options': 'nosniff' })
  }
  res.sendFile(filePath, async error => {
    if (error) { if (!res.headersSent) res.status(404).json({ error: 'Media not found.' }); return }
    if (!openedMessage) return
    const activeRecipients = openedMessage.viewOnceRecipients.filter(id => conversation.members.some(memberId => memberId.equals(id)))
    const allOpened = activeRecipients.length > 0 && activeRecipients.every(id => openedMessage.viewOnceViewedBy.some(viewerId => viewerId.equals(id)))
    if (allOpened) {
      await Message.updateOne({ _id: openedMessage._id, mediaFilename: filename }, { $set: { mediaFilename: '', mediaOriginalName: '' } })
      void fs.promises.unlink(filePath).catch(() => {})
    }
  })
}))
app.get('/api/conversations/:id/media', auth, handle(async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user._id)
  if (!conversation || !await directConversationAllowed(conversation, req.user._id)) return res.status(404).json({ error: 'Conversation not found.' })
  const rows = await Message.find({ conversation: req.params.id, hiddenFor: { $ne: req.user._id }, mediaFilename: { $ne: '' }, viewOnce: { $ne: true } }).sort({ createdAt: -1 }).limit(500).select('mediaFilename mediaOriginalName mediaType createdAt').lean()
  res.json({ media: rows.map(message => ({ url: `/api/conversations/${req.params.id}/media/${encodeURIComponent(message.mediaFilename)}`, name: message.mediaOriginalName || message.mediaFilename, mediaType: message.mediaType, createdAt: message.createdAt })) })
}))
app.get('/api/conversations/:id/messages', auth, handle(async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user._id)
  if (!conversation || !await directConversationAllowed(conversation, req.user._id)) return res.status(404).json({ error: 'Conversation not found.' })
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 50))
  const before = req.query.before
  if (before && !mongoose.Types.ObjectId.isValid(before)) return res.status(400).json({ error: 'Invalid message cursor.' })
  const filter = { conversation: req.params.id, hiddenFor: { $ne: req.user._id }, ...(before ? { _id: { $lt: before } } : {}) }
  const rows = await Message.find(filter).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  const messages = rows.slice(0, limit).reverse()
  const senderIds = [...new Set(messages.map(message => message.sender.toString()))]
  const senderRows = await User.find({ _id: { $in: senderIds } }).select('displayName').lean()
  const senderNames = new Map(senderRows.map(user => [user._id.toString(), user.displayName]))
  res.json({ hasMore, messages: messages.map(m => ({ id: m._id.toString(), conversationId: m.conversation.toString(), senderId: m.sender.toString(), senderName: m.senderName || senderNames.get(m.sender.toString()) || 'Member', ...(m.system ? { system: true } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), text: m.text, ...(m.mediaFilename && (!m.viewOnce || (!m.sender.equals(req.user._id) && !(m.viewOnceViewedBy || []).some(id => id.equals(req.user._id)))) ? { mediaUrl: `/api/conversations/${m.conversation}/media/${encodeURIComponent(m.mediaFilename)}`, mediaType: m.mediaType, fileName: m.mediaOriginalName || m.mediaFilename } : {}), ...(m.viewOnce ? { viewOnce: true, viewOnceViewedByMe: (m.viewOnceViewedBy || []).some(id => id.equals(req.user._id)), viewOnceOpenedCount: (m.viewOnceViewedBy || []).length } : {}), ...(m.storyContext ? { storyContext: { ...m.storyContext, storyId: m.storyContext.storyId?.toString() || '' } } : {}), ...(m.partyInvite ? { partyInvite: m.partyInvite } : {}), ...(m.gameInvite ? { gameInvite: m.gameInvite } : {}), ...(m.callLog ? { callLog: m.callLog } : {}), deliveredAt: m.deliveredAt || null, readAt: m.readAt || null, createdAt: m.createdAt })) })
}))
app.post('/api/conversations/:id/messages/sync', auth, handle(async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user._id)
  if (!conversation || !await directConversationAllowed(conversation, req.user._id)) return res.status(404).json({ error: 'Conversation not found.' })
  const knownIds = [...new Set((Array.isArray(req.body?.knownIds) ? req.body.knownIds : []).map(String).filter(id => mongoose.Types.ObjectId.isValid(id)))].slice(0, 150)
  if (!knownIds.length) return res.json({ deletedIds: [] })
  const stillVisible = await Message.find({ _id: { $in: knownIds }, conversation: conversation._id, hiddenFor: { $ne: req.user._id } }).distinct('_id')
  const visibleIds = new Set(stillVisible.map(id => id.toString()))
  res.json({ deletedIds: knownIds.filter(id => !visibleIds.has(id)) })
}))
app.delete('/api/conversations/:id/messages/:messageId/me', auth, handle(async (req, res) => {
  if (!await memberConversation(req.params.id, req.user._id)) return res.status(404).json({ error: 'Message not found.' })
  const message = await Message.findOneAndUpdate(
    { _id: req.params.messageId, conversation: req.params.id },
    { $addToSet: { hiddenFor: req.user._id } },
    { new: true }
  ).select('_id')
  if (!message) return res.status(404).json({ error: 'Message not found.' })
  res.json({ ok: true })
}))
app.delete('/api/conversations/:id/messages/:messageId', auth, handle(async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user._id)
  if (!conversation) return res.status(404).json({ error: 'Message not found.' })
  const message = await Message.findOneAndDelete({ _id: req.params.messageId, conversation: conversation._id, sender: req.user._id })
  if (!message) return res.status(404).json({ error: 'Message not found or you cannot delete it.' })
  if (message.mediaFilename) void fs.promises.unlink(path.join(chatUploadsDir, path.basename(message.mediaFilename))).catch(() => {})
  const latest = await Message.findOne({ conversation: conversation._id }).sort({ createdAt: -1, _id: -1 }).lean()
  conversation.latestText = messagePreview(latest)
  conversation.latestAt = latest?.createdAt || new Date()
  await conversation.save()
  io.to(conversation.id).emit('message:deleted', { conversationId: conversation.id, id: message.id })
  res.json({ ok: true })
}))
app.post('/api/conversations/:id/messages', auth, chatUpload.array('media', 5), handle(async (req, res) => {
  const uploads = Array.isArray(req.files) ? req.files : []
  const removeUploads = () => uploads.forEach(file => fs.unlink(file.path, () => {}))
  const conversation = await memberConversation(req.params.id, req.user._id)
  const text = String(req.body?.text || '').trim()
  if (!conversation) { removeUploads(); return res.status(404).json({ error: 'Conversation not found.' }) }
  if (conversation.isGroup && !await directConversationAllowed(conversation, req.user._id, 'send')) { removeUploads(); return res.status(403).json({ error: 'This group chat is unavailable because of a block. Reconnect with the group member before continuing.' }) }
  if ((!text && !uploads.length) || text.length > 4000) { removeUploads(); return res.status(400).json({ error: text.length > 4000 ? 'Messages can be up to 4,000 characters.' : 'Write a message or attach a file.' }) }
  if (uploads.length > 5) { removeUploads(); return res.status(400).json({ error: 'You can attach up to 5 photos or videos at once.' }) }
  const mediaTypes = uploads.map(file => { const mime = chatMimeForFile(file); return mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : 'file' })
  if (uploads.length > 1 && mediaTypes.some(type => !['image','video'].includes(type))) { removeUploads(); return res.status(400).json({ error: 'Select up to 5 photos or videos, or attach one document.' }) }
  const recipientIds = conversation.members.filter(id => !id.equals(req.user._id))
  const viewOnce = req.body?.viewOnce === 'true'
  if (viewOnce && (!uploads.length || mediaTypes.some(type => !['image','video'].includes(type)))) { removeUploads(); return res.status(400).json({ error: 'View once is available for photos and videos only.' }) }
  if (!conversation.isGroup) {
    const target = await User.findById(recipientIds[0]).select('_id friends blockedUsers reconnectRequired messagePrivacy')
    if (!canDirectlyInteract(req.user, target)) { removeUploads(); return res.status(403).json({ error: req.user.blockedUsers.some(id => id.equals(recipientIds[0])) || target?.blockedUsers.some(id => id.equals(req.user._id)) ? 'Message could not be sent because one of you blocked the other.' : 'You need an accepted friend connection to message this person.' }) }
  }
  let replyTo
  if (req.body?.replyTo) {
    let requestedReplyId = String(req.body.replyTo)
    try { const parsed = JSON.parse(requestedReplyId); requestedReplyId = String(parsed?.messageId || '') } catch {}
    if (!mongoose.Types.ObjectId.isValid(requestedReplyId)) { removeUploads(); return res.status(400).json({ error: 'That reply is no longer available.' }) }
    const original = await Message.findOne({ _id: requestedReplyId, conversation: conversation._id, hiddenFor: { $ne: req.user._id } }).select('sender senderName text mediaType').lean()
    if (!original) { removeUploads(); return res.status(400).json({ error: 'That reply is no longer available.' }) }
    const originalSender = await User.findById(original.sender).select('displayName').lean()
    replyTo = { messageId: requestedReplyId, senderId: original.sender.toString(), senderName: original.senderName || originalSender?.displayName || 'Member', text: String(original.text || '').slice(0, 300), mediaType: original.mediaType || '' }
  }
  const notifyConversation = await shouldNotifyMessage(conversation._id)
  const count = Math.max(uploads.length, 1)
  const messages = []
  for (let index = 0; index < count; index++) {
    const file = uploads[index]
    const itemText = index === 0 ? text : ''
    const mediaType = file ? mediaTypes[index] : undefined
    const mediaFilename = file ? path.basename(file.path) : ''
    const mediaOriginalName = file ? path.basename(file.originalname).replace(/[^A-Za-z0-9_.() -]/g, '_').slice(0, 160) : ''
    const message = await Message.create({ conversation: conversation._id, sender: req.user._id, senderName: req.user.displayName || '', ...(index === 0 && replyTo ? { replyTo } : {}), text: itemText, mediaFilename, mediaOriginalName, ...(mediaType ? { mediaType } : {}), viewOnce, ...(viewOnce ? { viewOnceRecipients: recipientIds } : {}) })
    const payload = { id: message.id, conversationId: conversation.id, senderId: req.user.id, senderName: message.senderName || req.user.displayName || 'Member', ...(message.replyTo ? { replyTo: message.replyTo } : {}), text: itemText, deliveredAt: null, readAt: null, ...(mediaFilename ? { mediaUrl: '/api/conversations/' + conversation.id + '/media/' + encodeURIComponent(mediaFilename), mediaType, fileName: mediaOriginalName } : {}), ...(viewOnce ? { viewOnce: true, viewOnceViewedByMe: false, viewOnceOpenedCount: 0 } : {}), createdAt: message.createdAt }
    messages.push(payload)
  }
  const latestText = text || (uploads.length > 1 ? uploads.length + ' photos and videos' : uploads.length ? (mediaTypes[0] === 'video' ? 'Video' : mediaTypes[0] === 'file' ? path.basename(uploads[0].originalname) : 'Photo') : '')
  conversation.latestText = latestText; conversation.latestAt = messages[messages.length - 1].createdAt; await conversation.save()
  await Conversation.updateOne({ _id: conversation._id }, { $pullAll: { archivedFor: [...recipientIds, req.user._id], hiddenFor: [...recipientIds, req.user._id] } })
  const recipients = await User.find({ _id: { $in: recipientIds } }).select('blockedUsers')
  const allowedRecipients = recipientIds.filter(recipientId => {
    const recipient = recipients.find(user => user._id.equals(recipientId))
    return !recipient?.blockedUsers.some(id => id.equals(req.user._id))
  })
  let messageBroadcast = io.to(conversation.id)
  for (const recipientId of allowedRecipients) messageBroadcast = messageBroadcast.to(recipientId.toString())
  for (const payload of messages) messageBroadcast.emit('message:new', payload)
  for (const recipientId of allowedRecipients) if (notifyConversation) await createActivity(recipientId, req.user._id, 'message')
  res.status(201).json({ message: messages[0], messages })
}))
io.use(async (socket, next) => {
  try { const token = socket.handshake.auth?.token; const claims = jwt.verify(token, JWT_SECRET); const user = await User.findById(claims.sub).select('sessionVersion bannedAt'); if (!dbReady || !user || user.bannedAt || (claims.ver || 0) !== (user.sessionVersion || 0)) return next(new Error('Authentication required')); if (claims.sid) { const session = await DeviceSession.exists({ sessionId: claims.sid, user: user._id, sessionVersion: claims.ver || 0, revokedAt: null, expiresAt: { $gt: new Date() } }); if (!session) return next(new Error('This device session has been logged out.')); socket.sessionId = claims.sid } socket.userId = claims.sub; next() }
  catch { next(new Error('Authentication required')) }
})
const activeLives = new Map()
const refreshLiveAudiencePair = async (firstId, secondId) => {
  const users = await User.find({ _id: { $in: [firstId, secondId] } }).select('_id friends followers following blockedUsers').lean()
  const byId = new Map(users.map(user => [user._id.toString(), user]))
  for (const live of activeLives.values()) {
    if (live.hostId !== String(firstId) && live.hostId !== String(secondId)) continue
    const viewerId = live.hostId === String(firstId) ? String(secondId) : String(firstId)
    const host = byId.get(live.hostId)
    const viewer = byId.get(viewerId)
    if (!host || !viewer) continue
    const allowed = !usersBlockEachOther(host._id, viewer._id, byId) && (host.friends.some(id => id.toString() === viewerId) || host.followers.some(id => id.toString() === viewerId))
    const wasAllowed = live.audienceIds.has(viewerId)
    if (allowed) {
      live.audienceIds.add(viewerId)
      if (!wasAllowed) io.to(viewerId).emit('live:available', { id: live.id, host: live.host, startedAt: live.startedAt })
      continue
    }
    live.audienceIds.delete(viewerId)
    if (!wasAllowed) continue
    if (live.viewers.delete(viewerId)) {
      live.joinRequests.delete(viewerId)
      if (live.cohostId === viewerId) { live.cohostId = null; for (const remainingId of live.viewers) io.to(remainingId).emit('live:viewer-left', { liveId: live.id, viewerId }) }
      io.to(live.hostId).emit('live:viewer-left', { liveId: live.id, viewerId })
      io.to(live.hostId).emit('live:viewer-count', { liveId: live.id, count: live.viewers.size })
    }
    io.to(viewerId).emit('live:ended', { liveId: live.id, hostId: live.hostId })
  }
}
const activeGameSessions = new Map()
const activePartySessions = new Map()
const activeChatCalls = new Map()
const liveChatLastSent = new Map()
const onlineUserCounts = new Map()
const usersBlockEachOther = (first, second, usersById) => {
  const a = usersById.get(String(first)), b = usersById.get(String(second))
  return !a || !b || (a.blockedUsers || []).some(id => id.toString() === String(second)) || (b.blockedUsers || []).some(id => id.toString() === String(first))
}
const emitPresenceUpdate = async (subjectId, payload) => {
  const userIds = [...new Set([String(subjectId), ...onlineUserCounts.keys()])]
  const users = await User.find({ _id: { $in: userIds } }).select('_id blockedUsers friends lastSeenPrivacy lastSeenFriendIds').lean()
  const byId = new Map(users.map(user => [user._id.toString(), user]))
  const subject = byId.get(String(subjectId))
  for (const viewerId of onlineUserCounts.keys()) {
    if (viewerId === String(subjectId)) continue
    const viewer = byId.get(viewerId)
    const visible = canViewPresence(viewer, subject)
    io.to(viewerId).emit('presence:update', visible ? { userId: String(subjectId), ...payload } : { userId: String(subjectId), online: false, lastSeenAt: null })
  }
}
const presenceSnapshot = async viewerId => {
  const onlineIds = [...onlineUserCounts.keys()]
  const users = await User.find({ _id: { $in: [String(viewerId), ...onlineIds] } }).select('_id blockedUsers friends lastSeenPrivacy lastSeenFriendIds').lean()
  const byId = new Map(users.map(user => [user._id.toString(), user]))
  const viewer = byId.get(String(viewerId))
  return onlineIds.filter(subjectId => subjectId !== String(viewerId) && canViewPresence(viewer, byId.get(subjectId)))
}
const endLiveSession = (liveId, hostId) => {
  const live = activeLives.get(String(liveId))
  if (!live || live.hostId !== String(hostId)) return
  activeLives.delete(String(liveId))
  for (const key of liveChatLastSent.keys()) if (key.startsWith(`${live.id}:`)) liveChatLastSent.delete(key)
  const payload = { liveId: String(liveId), hostId: live.hostId }
  for (const audienceId of live.audienceIds) io.to(audienceId).emit('live:ended', payload)
  for (const viewerId of live.viewers) io.to(viewerId).emit('live:ended', payload)
  io.to(live.hostId).emit('live:ended', payload)
}
const gameSessionPayload = session => ({ id: session.id, game: session.game, status: session.status, hostId: session.hostId, hostName: session.hostName, maxPlayers: session.maxPlayers, invitedIds: session.invitedIds, playerIds: session.playerIds, playerNames: session.playerNames, leftPlayerIds: session.leftPlayerIds || [], leftPlayerId: session.leftPlayerId || null, leftPlayerName: session.leftPlayerName || '', quizDifficulty: session.quizDifficulty, quizTimeLimitMinutes: session.quizTimeLimitMinutes, board: session.board, turn: session.turn, lastRoll: session.lastRoll ?? null, lastRollBy: session.lastRollBy ?? null, winner: session.winner || null, quiz: session.quiz ? { phase: session.quiz.phase, difficulty: session.quiz.difficulty, timeLimitMinutes: session.quiz.timeLimitMinutes, endsAt: session.quiz.endsAt, questionEndsAt: session.quiz.questionEndsAt, questionNumber: session.quiz.questionNumber, question: session.quiz.question ? { prompt: session.quiz.question.prompt, options: session.quiz.question.options } : null, scores: { ...session.quiz.scores }, readyBy: session.quiz.readyBy || [], answeredBy: Object.keys(session.quiz.answersBy || {}) } : undefined })
const makeMathQuizQuestion = difficulty => {
  const int = (min, max) => min + Math.floor(Math.random() * (max - min + 1))
  const pick = values => values[int(0, values.length - 1)]
  let prompt, answer
  const level = ['easy', 'medium', 'high', 'extreme'].includes(difficulty) ? difficulty : 'easy'
  const operation = level === 'easy' ? pick(['add', 'subtract', 'multiply', 'divide', 'square']) : level === 'medium' ? pick(['add', 'subtract', 'multiply', 'divide', 'square']) : pick(['add', 'subtract', 'multiply', 'divide', 'square', 'root'])
  if (operation === 'add') { const max = level === 'easy' ? 20 : level === 'medium' ? 100 : level === 'high' ? 500 : 2000; const a = int(1,max), b = int(1,max); prompt = `${a} + ${b} = ?`; answer = a+b }
  else if (operation === 'subtract') { const max = level === 'easy' ? 20 : level === 'medium' ? 100 : level === 'high' ? 500 : 2000; const a = int(1,max), b = int(1,a); prompt = `${a} âˆ’ ${b} = ?`; answer = a-b }
  else if (operation === 'multiply') { const min = level === 'easy' ? 2 : level === 'medium' ? 3 : level === 'high' ? 12 : 20; const max = level === 'easy' ? 10 : level === 'medium' ? 15 : level === 'high' ? 40 : 99; const a=int(min,max),b=int(min,max);prompt=`${a} Ã— ${b} = ?`;answer=a*b }
  else if (operation === 'divide') { const max=level==='easy'?10:level==='medium'?15:level==='high'?40:99;const divisor=int(2,max),quotient=int(2,max);prompt=`${divisor*quotient} Ã· ${divisor} = ?`;answer=quotient }
  else if (operation === 'square') { const max=level==='easy'?10:level==='medium'?12:level==='high'?25:50;const a=int(2,max);prompt=`${a}Â² = ?`;answer=a*a }
  else { const root=int(6,100);prompt=`âˆš${root*root} = ?`;answer=root }
  const spread = level === 'easy' ? 5 : level === 'medium' ? 12 : level === 'high' ? 25 : 50
  const options = new Set([answer])
  while (options.size < 4) { const offset = int(1,spread) * (Math.random() < 0.5 ? -1 : 1); const candidate = answer + offset; if (candidate >= 0) options.add(candidate) }
  return { prompt, options: [...options].sort(() => Math.random() - 0.5), correctAnswer: answer }
}
const finishMathQuiz = session => {
  session.status = 'ended'; session.endedAt = new Date().toISOString()
  const [first, second] = session.playerIds
  const firstScore = Number(session.quiz?.scores[first] || 0), secondScore = Number(session.quiz?.scores[second] || 0)
  session.winner = firstScore === secondScore ? null : firstScore > secondScore ? first : second
  void updateGameInviteMessages(session)
  io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
}
const prepareMathQuiz = session => {
  session.quiz = { phase: 'ready', difficulty: session.quizDifficulty, timeLimitMinutes: session.quizTimeLimitMinutes, endsAt: null, questionEndsAt: null, questionNumber: 0, question: null, scores: Object.fromEntries(session.playerIds.map(id => [id, 0])), readyBy: [], answersBy: {} }
}
const beginMathQuiz = session => {
  const now = Date.now()
  session.quiz.phase = 'playing'; session.quiz.endsAt = now + session.quiz.timeLimitMinutes * 60_000; session.quiz.questionEndsAt = now + 8_000; session.quiz.questionNumber = 1; session.quiz.question = makeMathQuizQuestion(session.quiz.difficulty); session.quiz.answersBy = {}
  scheduleMathQuizQuestion(session)
}
const scheduleMathQuizQuestion = session => {
  clearTimeout(session.quizTimer)
  const delay = Math.max(0, Math.min(8000, session.quiz.endsAt - Date.now()))
  session.quiz.questionEndsAt = Date.now() + delay
  session.quizTimer = setTimeout(() => {
    if (activeGameSessions.get(session.id) !== session || session.status !== 'started') return
    for (const [playerId, answer] of Object.entries(session.quiz.answersBy)) if (answer === session.quiz.question.correctAnswer) session.quiz.scores[playerId] = (session.quiz.scores[playerId] || 0) + 1
    if (Date.now() >= session.quiz.endsAt) return finishMathQuiz(session)
    session.quiz.questionNumber++
    session.quiz.question = makeMathQuizQuestion(session.quiz.difficulty)
    session.quiz.answersBy = {}
    scheduleMathQuizQuestion(session)
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
  }, delay)
}
const advanceGameTurn = session => {
  for (let offset = 1; offset <= session.playerIds.length; offset++) {
    const nextIndex = (session.turn + offset) % session.playerIds.length
    if (!session.leftPlayerIds?.includes(session.playerIds[nextIndex])) { session.turn = nextIndex; return }
  }
}
const markGamePlayerLeft = (session, userId) => {
  if (!session || session.status === 'ended' || !session.playerIds.includes(String(userId))) return
  session.leftPlayerIds ||= []
  if (session.leftPlayerIds.includes(String(userId))) return
  session.leftPlayerIds.push(String(userId))
  session.leftPlayerId = String(userId)
  session.leftPlayerName = session.playerNames?.[String(userId)] || 'A player'

  const activePlayers = session.playerIds.filter(id => !session.leftPlayerIds.includes(id))
  if (session.maxPlayers > 2 && session.hostId === String(userId) && activePlayers.length) {
    session.hostId = activePlayers[0]
    session.hostName = session.playerNames?.[session.hostId] || 'Game host'
  }
  if (session.maxPlayers <= 2 || activePlayers.length === 0) {
    session.status = 'ended'
    session.endedAt = new Date().toISOString()
    if (session.maxPlayers <= 2) session.winner = activePlayers[0] || null
  } else {
    if (session.lastRollBy === String(userId)) {
      session.lastRoll = null
      session.lastRollBy = null
      clearTimeout(session.noMoveTimer)
    }
    if (session.playerIds[session.turn] === String(userId)) advanceGameTurn(session)
  }

  const payload = gameSessionPayload(session)
  for (const playerId of activePlayers) io.to(String(playerId)).emit('game:session', payload)
  void updateGameInviteMessages(session).catch(error => console.error('Game invite update failed:', error.message))
}
const partySessionPayload = session => { const snapshotAt = Date.now(); const currentTime = session.currentTime + (session.playing ? Math.max(0, snapshotAt - session.playbackUpdatedAt) / 1000 : 0); return { id: session.id, sessionId: session.id, url: session.url, status: session.status, hostId: session.hostId, hostName: session.hostName, invitedIds: session.invitedIds, participantIds: session.participantIds, controllerIds: [...new Set([session.hostId, ...session.controllerIds])], participants: [...session.members].filter(([id]) => session.participantIds.includes(id)).map(([id, member]) => ({ id, ...member })), currentTime, playing: session.playing, playbackUpdatedAt: snapshotAt, messages: session.messages } }
const updatePartyInviteMessages = async session => {
  const invite = { sessionId: session.id, url: session.url, hostId: session.hostId, hostName: session.hostName, invitedIds: session.invitedIds, participantIds: session.participantIds, controllerIds: session.controllerIds, status: session.status }
  for (const ref of session.invites) {
    const message = await Message.findByIdAndUpdate(ref.messageId, { $set: { partyInvite: invite } }, { new: true })
    if (!message) continue
    const payload = { id: message.id, conversationId: ref.conversationId, senderId: message.sender.toString(), text: message.text, partyInvite: invite, deliveredAt: message.deliveredAt || null, readAt: message.readAt || null, createdAt: message.createdAt }
    io.to(ref.conversationId).emit('party:invite:update', payload)
    io.to(ref.userId).emit('party:invite:update', payload)
  }
}
const sendPartyInvites = async (session, host, targetIds) => {
  const invite = { sessionId: session.id, url: session.url, hostId: session.hostId, hostName: session.hostName, invitedIds: session.invitedIds, participantIds: session.participantIds, controllerIds: session.controllerIds, status: session.status }
  for (const targetId of targetIds) {
    const members = [session.hostId, targetId].sort()
    const directKey = members.join(':')
    const conversation = await Conversation.findOneAndUpdate({ directKey }, { $setOnInsert: { members, directKey }, $pull: { archivedFor: targetId, hiddenFor: targetId } }, { upsert: true, new: true, setDefaultsOnInsert: true })
    const message = await Message.create({ conversation: conversation._id, sender: host._id, text: 'Invited you to watch together.', partyInvite: invite })
    conversation.latestText = message.text; conversation.latestAt = message.createdAt; await conversation.save()
    session.invites.push({ userId: targetId, conversationId: conversation.id, messageId: message.id })
    const payload = { id: message.id, conversationId: conversation.id, senderId: session.hostId, text: message.text, partyInvite: invite, deliveredAt: null, readAt: null, createdAt: message.createdAt }
    io.to(conversation.id).emit('message:new', payload); io.to(targetId).emit('message:new', payload)
  }
}
const updateGameInviteMessages = async session => {
  for (const inviteRef of session.invites) {
    const invite = { sessionId: session.id, game: session.game, status: session.status, hostId: session.hostId, hostName: session.hostName, maxPlayers: session.maxPlayers, invitedIds: session.invitedIds, playerIds: session.playerIds, leftPlayerIds: session.leftPlayerIds || [], leftPlayerId: session.leftPlayerId || null, leftPlayerName: session.leftPlayerName || '', quizDifficulty: session.quizDifficulty, quizTimeLimitMinutes: session.quizTimeLimitMinutes }
    const message = await Message.findByIdAndUpdate(inviteRef.messageId, { $set: { gameInvite: invite } }, { new: true })
    if (!message) continue
    const payload = { id: message.id, conversationId: inviteRef.conversationId, senderId: message.sender.toString(), text: message.text, gameInvite: invite, deliveredAt: message.deliveredAt || null, readAt: message.readAt || null, createdAt: message.createdAt }
    io.to(inviteRef.conversationId).emit('game:invite:update', payload)
    io.to(inviteRef.userId).emit('game:invite:update', payload)
  }
}

io.on('connection', async socket => {
  socket.join(socket.userId)
  if (socket.sessionId) socket.join(deviceSessionRoom(socket.sessionId))
  const wasOnline = onlineUserCounts.has(socket.userId)
  onlineUserCounts.set(socket.userId, (onlineUserCounts.get(socket.userId) || 0) + 1)
  socket.emit('presence:snapshot', dbReady ? await presenceSnapshot(socket.userId) : [])
  if (!wasOnline && dbReady) await emitPresenceUpdate(socket.userId, { online: true })
  socket.on('live:list', async () => {
    if (!dbReady) return
    const user = await User.findById(socket.userId).select('friends following')
    if (!user) return
    const audienceIds = new Set([...user.friends, ...user.following].map(id => id.toString()))
    socket.emit('live:list', [...activeLives.values()].filter(live => audienceIds.has(live.hostId)).map(({ id, host, startedAt }) => ({ id, host, startedAt })))
  })
  socket.on('live:start', async () => {
    if (!dbReady) return socket.emit('live:error', { message: 'The server is not connected to the database.' })
    try { await warmContentModeration() }
    catch { return socket.emit('live:error', { message: 'Live moderation is unavailable right now, so the broadcast cannot start. Please try again shortly.' }) }
    const host = await User.findById(socket.userId).select('username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns friends followers')
    if (!host) return
    const existing = [...activeLives.values()].find(live => live.hostId === socket.userId)
    if (existing) return socket.emit('live:started', { id: existing.id, host: existing.host, startedAt: existing.startedAt })
    const audienceIds = new Set([...host.friends, ...host.followers].map(id => id.toString()))
    const live = { id: randomUUID(), hostId: socket.userId, host: publicUser(host), startedAt: new Date().toISOString(), audienceIds, viewers: new Set(), joinRequests: new Map(), cohostId: null, moderationBusy: false, moderationPositiveFrames: 0, moderationScanFailures: 0, lastModerationFrameAt: 0 }
    activeLives.set(live.id, live)
    const payload = { id: live.id, host: live.host, startedAt: live.startedAt }
    socket.emit('live:started', payload)
    for (const audienceId of live.audienceIds) io.to(audienceId).emit('live:available', payload)
  })
  socket.on('live:moderation-frame', async ({ liveId, frame } = {}) => {
    const live = activeLives.get(String(liveId))
    if (!live || live.hostId !== socket.userId || live.moderationBusy || Date.now() - live.lastModerationFrameAt < 4500) return
    if (typeof frame !== 'string' || frame.length > 470_000 || !frame.startsWith('data:image/jpeg;base64,')) return
    const encoded = frame.slice('data:image/jpeg;base64,'.length)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return
    const imageBuffer = Buffer.from(encoded, 'base64')
    if (!imageBuffer.length || imageBuffer.length > 350_000) return
    live.moderationBusy = true
    live.lastModerationFrameAt = Date.now()
    try {
      const scan = await scanModerationFrame(imageBuffer)
      if (activeLives.get(live.id) !== live) return
      live.moderationScanFailures = 0
      live.moderationPositiveFrames = scan.flagged ? live.moderationPositiveFrames + 1 : 0
      if (live.moderationPositiveFrames >= 2) {
        endLiveSession(live.id, live.hostId)
        await warnAndCountModerationStrike({ author: live.hostId, kind: 'live', _id: live.id }, scan)
      }
    } catch (error) {
      console.error(`Live moderation scan failed for ${live.id}:`, error.message)
      if (activeLives.get(live.id) === live) {
        live.moderationScanFailures += 1
        if (live.moderationScanFailures >= 3) {
          endLiveSession(live.id, live.hostId)
          io.to(live.hostId).emit('live:moderation-error', { message: 'The live ended after repeated safety scan errors. Please try again shortly.' })
        }
      }
    } finally {
      live.moderationBusy = false
    }
  })
  socket.on('live:join', async ({ liveId } = {}) => {
    const live = activeLives.get(String(liveId))
    const viewer = await User.findById(socket.userId).select('friends following')
    if (!live || !(viewer?.friends.some(id => id.toString() === live.hostId) || viewer?.following.some(id => id.toString() === live.hostId))) return socket.emit('live:error', { message: 'This live is no longer available to you.' })
    if (live.viewers.has(socket.userId)) return socket.emit('live:joined', { liveId: live.id, host: live.host })
    if (live.viewers.size >= 6) return socket.emit('live:error', { message: 'This live has reached its viewer limit. Try again later.' })
    live.viewers.add(socket.userId)
    io.to(live.hostId).emit('live:viewer-joined', { liveId: live.id, viewerId: socket.userId })
    socket.emit('live:joined', { liveId: live.id, host: live.host })
    io.to(live.hostId).emit('live:viewer-count', { liveId: live.id, count: live.viewers.size })
  })
  socket.on('live:leave', ({ liveId } = {}) => {
    const live = activeLives.get(String(liveId))
    if (!live || live.hostId === socket.userId) return
    live.viewers.delete(socket.userId)
    live.joinRequests.delete(socket.userId)
    if (live.cohostId === socket.userId) { live.cohostId = null; for (const viewerId of live.viewers) io.to(viewerId).emit('live:viewer-left', { liveId: live.id, viewerId: socket.userId }) }
    io.to(live.hostId).emit('live:viewer-left', { liveId: live.id, viewerId: socket.userId })
    io.to(live.hostId).emit('live:viewer-count', { liveId: live.id, count: live.viewers.size })
  })
  socket.on('live:request-join', async ({ liveId } = {}) => {
    const live = activeLives.get(String(liveId))
    if (!live || live.hostId === socket.userId || !live.viewers.has(socket.userId)) return socket.emit('live:join-denied', { liveId, message: 'Join the live as a viewer before requesting to join on camera.' })
    if (live.cohostId === socket.userId) return socket.emit('live:join-approved', { liveId: live.id })
    const requester = await User.findById(socket.userId).select('username displayName bio avatarUrl avatarBorder avatarBorderColor location website pronouns')
    if (!requester || activeLives.get(live.id) !== live) return
    live.joinRequests.set(socket.userId, publicUser(requester))
    io.to(live.hostId).emit('live:join-request', { liveId: live.id, user: publicUser(requester) })
    socket.emit('live:join-request-sent', { liveId: live.id })
  })
  socket.on('live:join-response', ({ liveId, userId, approved } = {}) => {
    const live = activeLives.get(String(liveId))
    const userKey = String(userId)
    if (!live || live.hostId !== socket.userId || !live.joinRequests.has(userKey)) return
    const requester = live.joinRequests.get(userKey)
    live.joinRequests.delete(userKey)
    if (approved && !live.cohostId && live.viewers.has(userKey)) {
      live.cohostId = userKey
      io.to(userKey).emit('live:join-approved', { liveId: live.id })
      for (const viewerId of live.viewers) io.to(viewerId).emit('live:guest-joined', { liveId: live.id, user: requester })
    } else {
      io.to(userKey).emit('live:join-denied', { liveId: live.id, message: approved ? 'Someone else is already on stage.' : 'The host declined your request.' })
    }
  })
  socket.on('live:join-cancel', ({ liveId } = {}) => {
    const live = activeLives.get(String(liveId))
    if (live?.cohostId === socket.userId) { live.cohostId = null; io.to(live.hostId).emit('live:join-cancelled', { liveId: live.id, userId: socket.userId }); for (const viewerId of live.viewers) io.to(viewerId).emit('live:viewer-left', { liveId: live.id, viewerId: socket.userId }) }
  })
  socket.on('live:participant-mute', ({ liveId, muted } = {}) => {
    const live = activeLives.get(String(liveId))
    if (!live || live.hostId !== socket.userId || !live.cohostId || typeof muted !== 'boolean') return
    io.to(live.cohostId).emit('live:host-mute', { liveId: live.id, muted })
    for (const viewerId of live.viewers) io.to(viewerId).emit('live:participant-muted', { liveId: live.id, userId: live.cohostId, muted })
  })
  socket.on('live:end', ({ liveId } = {}) => endLiveSession(liveId, socket.userId))
  socket.on('live:signal', async ({ liveId, to, kind, data } = {}) => {
    const live = activeLives.get(String(liveId))
    if (!live || !['offer','answer','ice'].includes(kind) || !to) return
    const senderIsHost = live.hostId === socket.userId
    const allowed = senderIsHost ? live.viewers.has(String(to)) : live.viewers.has(socket.userId) && String(to) === live.hostId && (kind !== 'offer' || live.cohostId === socket.userId)
    if (allowed) io.to(String(to)).emit('live:signal', { liveId: live.id, from: socket.userId, kind, data })
  })
  socket.on('live:chat', async ({ liveId, text } = {}) => {
    const live = activeLives.get(String(liveId))
    const message = typeof text === 'string' ? text.trim().slice(0, 300) : ''
    if (!live || !message || live.hostId !== socket.userId && !live.viewers.has(socket.userId)) return
    const throttleKey = `${live.id}:${socket.userId}`
    const now = Date.now()
    if (now - (liveChatLastSent.get(throttleKey) || 0) < 600) return
    liveChatLastSent.set(throttleKey, now)
    const sender = await User.findById(socket.userId).select('username displayName')
    if (!sender || activeLives.get(live.id) !== live) return
    const payload = { id: randomUUID(), liveId: live.id, userId: socket.userId, displayName: sender.displayName, username: sender.username, text: message, createdAt: new Date(now).toISOString() }
    io.to(live.hostId).emit('live:chat', payload)
    for (const viewerId of live.viewers) io.to(viewerId).emit('live:chat', payload)
  })
  socket.on('message:delivered', async ({ conversationId, id } = {}) => {
    const conversation = !dbReady || !mongoose.Types.ObjectId.isValid(id) ? null : await memberConversation(conversationId, socket.userId)
    if (!conversation || !await directConversationAllowed(conversation, socket.userId)) return
    const message = await Message.findOneAndUpdate({ _id: id, conversation: conversationId, sender: { $ne: socket.userId }, deliveredAt: null }, { $set: { deliveredAt: new Date() } }, { new: true }).select('_id sender deliveredAt readAt')
    if (message) io.to(message.sender.toString()).emit('message:status', { conversationId: String(conversationId), ids: [message.id], status: 'delivered', deliveredAt: message.deliveredAt })
  })
  socket.on('chat:typing', async ({ conversationId, typing } = {}) => {
    const allowedConversation = !dbReady || typeof typing !== 'boolean' ? null : await memberConversation(conversationId, socket.userId)
    if (!allowedConversation || !await directConversationAllowed(allowedConversation, socket.userId, 'send')) return
    const conversation = await Conversation.findById(conversationId).select('members').lean()
    if (!conversation) return
    const participants = await User.find({ _id: { $in: conversation.members } }).select('_id displayName blockedUsers').lean()
    const usersById = new Map(participants.map(user => [user._id.toString(), user]))
    const sender = usersById.get(socket.userId)
    if (!sender) return
    for (const member of conversation.members) {
      const recipientId = member.toString()
      if (recipientId !== socket.userId && !usersBlockEachOther(socket.userId, recipientId, usersById)) io.to(recipientId).emit('chat:typing', { conversationId: String(conversationId), userId: socket.userId, displayName: sender.displayName || 'Someone', typing })
    }
  })
  socket.on('location:share', async ({ conversationId, latitude, longitude, accuracy } = {}) => {
    if (!dbReady || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || accuracy < 0) return
    const allowedConversation = await memberConversation(conversationId, socket.userId)
    if (!allowedConversation || !await directConversationAllowed(allowedConversation, socket.userId, 'send')) return
    const conversation = await Conversation.findById(conversationId).select('members').lean()
    for (const member of conversation.members) if (member.toString() !== socket.userId) io.to(member.toString()).emit('location:update', { conversationId: String(conversationId), userId: socket.userId, latitude, longitude, accuracy, updatedAt: new Date().toISOString() })
  })
  socket.on('location:stop', async ({ conversationId } = {}) => {
    if (!dbReady || !await memberConversation(conversationId, socket.userId)) return
    const conversation = await Conversation.findById(conversationId).select('members').lean()
    for (const member of conversation.members) if (member.toString() !== socket.userId) io.to(member.toString()).emit('location:stopped', { conversationId: String(conversationId), userId: socket.userId })
  })
  socket.on('messages:read', async ({ conversationId } = {}) => {
    const allowedConversation = !dbReady ? null : await memberConversation(conversationId, socket.userId)
    if (!allowedConversation || !await directConversationAllowed(allowedConversation, socket.userId)) return
    const now = new Date()
    const rows = await Message.find({ conversation: conversationId, sender: { $ne: socket.userId }, readAt: null }).select('_id sender').lean()
    if (!rows.length) { socket.emit('messages:read:done', { conversationId: String(conversationId) }); return }
    const ids = rows.map(row => row._id)
    await Message.updateMany({ _id: { $in: ids } }, { $set: { deliveredAt: now, readAt: now } })
    const senderIds = [...new Set(rows.map(row => row.sender.toString()))]
    for (const senderId of senderIds) io.to(senderId).emit('message:status', { conversationId: String(conversationId), ids: ids.map(id => id.toString()), status: 'read', deliveredAt: now, readAt: now })
    socket.emit('messages:read:done', { conversationId: String(conversationId) })
  })
  socket.on('conversation:join', async id => { const conversation = dbReady ? await memberConversation(id, socket.userId) : null; if (conversation && await directConversationAllowed(conversation, socket.userId)) socket.join(id) })
  socket.on('conversation:leave', async id => { if (dbReady && await memberConversation(id, socket.userId)) socket.leave(id) })
  socket.on('call:signal', async ({ to, kind, data, mode, callId, conversationId }) => {
    if (!dbReady || !['offer','answer','ice','end','mode','renegotiate-offer','renegotiate-answer'].includes(kind) || typeof to !== 'string' || typeof callId !== 'string' || callId.length > 100 || !mongoose.Types.ObjectId.isValid(conversationId)) return
    const conversation = await memberConversation(conversationId, socket.userId)
    if (!conversation || conversation.isGroup || !conversation.members.some(member => member.toString() === to) || to === socket.userId) return socket.emit('call:error', { callId, message: 'This individual call is no longer available.' })
    const [sender, target] = await Promise.all([User.findById(socket.userId).select('displayName friends blockedUsers reconnectRequired'), User.findById(to).select('friends blockedUsers reconnectRequired messagePrivacy')])
    if (!sender || !target || !canUseFriendFeatures(sender, target)) {
      const current = activeDirectCalls.get(callId)
      if (current) { activeDirectCalls.delete(callId); pendingDirectIce.delete(callId); io.to(current.callerId).emit('call:signal', { from: socket.userId, kind: 'end', callId, conversationId: current.conversationId }); io.to(current.calleeId).emit('call:signal', { from: socket.userId, kind: 'end', callId, conversationId: current.conversationId }) }
      return socket.emit('call:error', { callId, message: 'Voice and video calls are available to accepted friends only. Send a new friend request to reconnect.' })
    }
    let call = activeDirectCalls.get(callId)
    let candidatesToFlush = []
    if (kind === 'ice' && !call) {
      const buffered = pendingDirectIce.get(callId) || []
      if (buffered.length < 32) buffered.push({ from: socket.userId, to, data, conversationId: conversation._id.toString(), expiresAt: Date.now() + 20_000 })
      pendingDirectIce.set(callId, buffered)
      setTimeout(() => { const queued = pendingDirectIce.get(callId); if (queued) { const fresh = queued.filter(candidate => candidate.expiresAt > Date.now()); if (fresh.length) pendingDirectIce.set(callId, fresh); else pendingDirectIce.delete(callId) } }, 20_100).unref?.()
      return
    }
    if (kind === 'offer') {
      if (call || !['audio','video'].includes(mode)) return
      const earlyEnd = pendingDirectEnds.get(callId)
      pendingDirectEnds.delete(callId)
      if (earlyEnd && earlyEnd.conversationId === conversation._id.toString() && ((earlyEnd.from === socket.userId && earlyEnd.to === to) || (earlyEnd.from === to && earlyEnd.to === socket.userId))) {
        void logCallMessage(conversation._id, socket.userId, callId, mode, 'missed').catch(error => console.error('Call log write failed:', error.message))
        pendingDirectIce.delete(callId)
        return
      }
      call = { id: callId, conversationId: conversation._id.toString(), callerId: socket.userId, calleeId: to, mode, answered: false }
      activeDirectCalls.set(callId, call)
      if (socket.userId === call.callerId) {
        const candidates = pendingDirectIce.get(callId) || []
        pendingDirectIce.delete(callId)
        candidatesToFlush = candidates.filter(candidate => candidate.expiresAt > Date.now() && candidate.from === call.callerId && candidate.to === call.calleeId && candidate.conversationId === call.conversationId)
      }
    } else {
      if (!call && kind === 'end') {
        pendingDirectEnds.set(callId, { from: socket.userId, to, conversationId: conversation._id.toString() })
        setTimeout(() => { if (pendingDirectEnds.get(callId)?.from === socket.userId) pendingDirectEnds.delete(callId) }, 20_000).unref?.()
        pendingDirectIce.delete(callId)
        return
      }
      if (!call || call.conversationId !== conversation._id.toString() || ![call.callerId, call.calleeId].includes(socket.userId) || (call.callerId === socket.userId ? call.calleeId : call.callerId) !== to) return
      if (kind === 'answer') {
        if (socket.userId !== call.calleeId) return
        call.answered = true
      }
      if (kind === 'mode') {
        if (mode !== 'video') return
        call.mode = 'video'
      }
      if (kind === 'renegotiate-offer' && socket.userId !== call.callerId && !call.answered) return
      if (kind === 'end') {
        activeDirectCalls.delete(callId)
        pendingDirectIce.delete(callId)
        pendingDirectEnds.delete(callId)
        void logCallMessage(call.conversationId, socket.userId, callId, call.mode, call.answered ? 'ended' : 'missed').catch(error => console.error('Call log write failed:', error.message))
      }
    }
    io.to(to).emit('call:signal', { from: socket.userId, kind, data, callId, conversationId: call.conversationId, mode: call.mode, ...(kind === 'offer' ? { displayName: sender.displayName } : {}) })
    for (const candidate of candidatesToFlush) io.to(to).emit('call:signal', { from: call.callerId, kind: 'ice', data: candidate.data, callId, conversationId: call.conversationId, mode: call.mode })
  })
  socket.on('group-call:start', async ({ conversationId, mode } = {}) => {
    if (!dbReady || !['audio','video'].includes(mode) || !mongoose.Types.ObjectId.isValid(conversationId)) return
    const conversation = await memberConversation(conversationId, socket.userId)
    if (!conversation?.isGroup || !await directConversationAllowed(conversation, socket.userId)) return socket.emit('group-call:error', { message: 'Group calls are only available inside an active group chat.' })
    const caller = await User.findById(socket.userId).select('displayName friends blockedUsers reconnectRequired')
    const candidates = conversation.members.map(id => id.toString()).filter(id => id !== socket.userId)
    const users = await User.find({ _id: { $in: candidates } }).select('_id friends blockedUsers reconnectRequired')
    const eligible = candidates.filter(id => {
      const target = users.find(user => user._id.toString() === id)
      return target && canUseFriendFeatures(caller, target)
    })
    if (!eligible.length) return socket.emit('group-call:error', { message: 'No available group members can join this call.' })
    const callId = randomUUID()
    const call = { id: callId, conversationId: conversation._id.toString(), mode, hostId: socket.userId, invited: new Set(eligible), participants: new Set([socket.userId]), expiryTimer: null }
    activeChatCalls.set(callId, call)
    call.expiryTimer = setTimeout(() => {
      const expiredInvitees = [...call.invited]
      call.invited.clear()
      for (const id of expiredInvitees) io.to(id).emit('group-call:ended', { callId: call.id })
      if (call.participants.size === 1) {
        void logCallMessage(call.conversationId, call.hostId, call.id, call.mode, 'missed').catch(error => console.error('Call log write failed:', error.message))
        for (const id of call.participants) io.to(id).emit('group-call:ended', { callId: call.id })
        activeChatCalls.delete(call.id)
      }
    }, 60_000)
    socket.emit('group-call:started', { callId, conversationId: call.conversationId, mode })
    const callMembers = await User.find({ _id: { $in: conversation.members } }).select('_id displayName')
    const memberNames = conversation.members.map(id => callMembers.find(member => member._id.toString() === id.toString())?.displayName).filter(Boolean)
    const payload = { callId, conversationId: call.conversationId, from: socket.userId, displayName: caller.displayName || 'A group member', groupName: conversation.groupName || 'Group call', memberNames, mode }
    for (const id of eligible) io.to(id).emit('group-call:incoming', payload)
  })
  socket.on('group-call:join', async ({ callId } = {}) => {
    const call = activeChatCalls.get(String(callId))
    const conversation = !dbReady || !call ? null : await memberConversation(call.conversationId, socket.userId)
    if (!call || !call.invited.has(socket.userId) || !conversation || !await directConversationAllowed(conversation, socket.userId) || !await canUseFriendFeaturesIds(call.hostId, socket.userId)) return socket.emit('group-call:error', { message: 'This group call is no longer available. Reconnect as friends before calling.' })
    call.invited.delete(socket.userId)
    call.participants.add(socket.userId)
    call.everJoined = true
    const peers = [...call.participants].filter(id => id !== socket.userId)
    socket.emit('group-call:joined', { callId: call.id, conversationId: call.conversationId, mode: call.mode, peers })
    for (const id of peers) io.to(id).emit('group-call:participant-joined', { callId: call.id, userId: socket.userId })
  })
  socket.on('group-call:decline', ({ callId } = {}) => {
    const call = activeChatCalls.get(String(callId))
    if (!call || !call.invited.delete(socket.userId)) return
    if (!call.invited.size && call.participants.size === 1 && call.participants.has(call.hostId)) {
      clearTimeout(call.expiryTimer)
      void logCallMessage(call.conversationId, call.hostId, call.id, call.mode, 'missed').catch(error => console.error('Call log write failed:', error.message))
      for (const id of call.participants) io.to(id).emit('group-call:ended', { callId: call.id })
      activeChatCalls.delete(call.id)
    }
  })
  socket.on('group-call:signal', async ({ callId, to, kind, data } = {}) => {
    const call = activeChatCalls.get(String(callId))
    if (!dbReady || !call || !['offer','answer','ice','mode','renegotiate-offer','renegotiate-answer'].includes(kind) || !call.participants.has(socket.userId) || !call.participants.has(String(to))) return
    if (!await canInteractWithoutBlockIds(socket.userId, String(to))) return socket.emit('group-call:error', { message: 'Calls between these members are unavailable until they reconnect.' })
    if (kind === 'mode') {
      if (data?.mode !== 'video') return
      call.mode = 'video'
      for (const id of call.invited) io.to(id).emit('group-call:mode', { callId: call.id, mode: 'video' })
    }
    io.to(String(to)).emit('group-call:signal', { callId: call.id, from: socket.userId, kind, data })
  })
  socket.on('group-call:leave', ({ callId } = {}) => {
    const call = activeChatCalls.get(String(callId))
    if (!call || !call.participants.delete(socket.userId)) return
    if (socket.userId === call.hostId) {
      clearTimeout(call.expiryTimer)
      void logCallMessage(call.conversationId, socket.userId, call.id, call.mode, call.everJoined ? 'ended' : 'missed').catch(error => console.error('Call log write failed:', error.message))
      for (const id of [...call.participants, ...call.invited]) io.to(id).emit('group-call:ended', { callId: call.id })
      activeChatCalls.delete(call.id)
      return
    }
    for (const id of call.participants) io.to(id).emit('group-call:participant-left', { callId: call.id, userId: socket.userId })
    if (call.everJoined && call.participants.size <= 1) {
      clearTimeout(call.expiryTimer)
      void logCallMessage(call.conversationId, socket.userId, call.id, call.mode, 'ended').catch(error => console.error('Call log write failed:', error.message))
      for (const id of [...call.participants, ...call.invited]) io.to(id).emit('group-call:ended', { callId: call.id })
      activeChatCalls.delete(call.id)
    } else if (!call.participants.size && !call.invited.size) { clearTimeout(call.expiryTimer); activeChatCalls.delete(call.id) }
  })
  socket.on('party:create', async ({ url, userIds } = {}) => {
    try {
      if (!dbReady || typeof url !== 'string' || url.length > 2048 || !/^https:\/\//i.test(url) || !Array.isArray(userIds)) return socket.emit('party:error', { message: 'Add a valid HTTPS video link and choose friends to invite.' })
      const host = await User.findById(socket.userId).select('username displayName friends')
      const invited = [...new Set(userIds.map(String))].filter(id => id !== socket.userId).slice(0, 30)
      if (!host || invited.some(id => !host.friends.some(friendId => friendId.toString() === id))) return socket.emit('party:error', { message: 'You can invite accepted friends only.' })
      const people = await User.find({ _id: { $in: [socket.userId, ...invited] } }).select('displayName username')
      const members = new Map(people.map(user => [user.id, { displayName: user.displayName, username: user.username }]))
      const session = { id: randomUUID(), url: url.trim(), hostId: socket.userId, hostName: host.displayName, invitedIds: invited, participantIds: [socket.userId], controllerIds: [socket.userId], members, status: 'open', currentTime: 0, playing: true, playbackUpdatedAt: Date.now(), messages: [], invites: [], voicePlayers: new Set() }
      activePartySessions.set(session.id, session)
      socket.join(`party:${session.id}`)
      socket.emit('party:session', partySessionPayload(session))
      await sendPartyInvites(session, host, invited)
    } catch (error) { console.error('Watch party create failed:', error); socket.emit('party:error', { message: 'Could not create the watch room.' }) }
  })
  socket.on('party:invite:add', async ({ sessionId, userIds } = {}) => {
    try {
      const session = activePartySessions.get(String(sessionId))
      if (!session || session.hostId !== socket.userId || session.status !== 'open' || !Array.isArray(userIds)) return
      const host = await User.findById(socket.userId).select('displayName friends')
      const additions = [...new Set(userIds.map(String))].filter(id => id !== socket.userId && !session.invitedIds.includes(id)).slice(0, 30 - session.invitedIds.length)
      if (!host || additions.some(id => !host.friends.some(friendId => friendId.toString() === id))) return socket.emit('party:error', { message: 'You can invite accepted friends only.' })
      const people = await User.find({ _id: { $in: additions } }).select('displayName username')
      people.forEach(user => session.members.set(user.id, { displayName: user.displayName, username: user.username }))
      session.invitedIds.push(...additions)
      await sendPartyInvites(session, host, additions)
      io.to(`party:${session.id}`).emit('party:session', partySessionPayload(session))
      await updatePartyInviteMessages(session)
    } catch (error) { console.error('Watch party invite failed:', error); socket.emit('party:error', { message: 'Could not send those invitations.' }) }
  })
  socket.on('party:join', async ({ sessionId } = {}) => {
    const session = activePartySessions.get(String(sessionId))
    if (!session || session.status !== 'open' || socket.userId !== session.hostId && !session.invitedIds.includes(socket.userId)) return socket.emit('party:error', { message: 'This watch room is closed or you were not invited.' })
    if (socket.userId !== session.hostId && !await canUseFriendFeaturesIds(session.hostId, socket.userId)) return socket.emit('party:error', { message: 'Reconnect as friends before joining this watch party.' })
    const isNewParticipant = !session.participantIds.includes(socket.userId)
    if (isNewParticipant) session.participantIds.push(socket.userId)
    socket.join(`party:${session.id}`)
    const startForRoom = !session.playing
    if (startForRoom) { session.playing = true; session.playbackUpdatedAt = Date.now() }
    if (isNewParticipant) {
      const memberName = session.members.get(socket.userId)?.displayName || 'A member'
      const joinMessage = { id: randomUUID(), sessionId: session.id, userId: 'system', displayName: '', text: `${memberName} joined the room`, createdAt: new Date().toISOString() }
      session.messages = [...session.messages, joinMessage].slice(-100)
      io.to(`party:${session.id}`).emit('party:chat:message', joinMessage)
    }
    io.to(`party:${session.id}`).emit('party:session', partySessionPayload(session))
    if (startForRoom) io.to(`party:${session.id}`).emit('party:sync', { sessionId: session.id, action: 'play', time: session.currentTime, playing: true, by: socket.userId, updatedAt: session.playbackUpdatedAt })
    void updatePartyInviteMessages(session)
  })
  socket.on('party:leave', ({ sessionId } = {}) => {
    const session = activePartySessions.get(String(sessionId))
    if (!session || !session.participantIds.includes(socket.userId)) return
    const departedName = session.members.get(socket.userId)?.displayName || 'A member'
    session.participantIds = session.participantIds.filter(id => id !== socket.userId)
    session.controllerIds = [...new Set([session.hostId, ...session.controllerIds.filter(id => id !== socket.userId)])]
    if (session.voicePlayers.delete(socket.userId)) io.to(`partyvoice:${session.id}`).emit('party:voice:peer-left', { sessionId: session.id, userId: socket.userId })
    socket.leave(`party:${session.id}`); socket.leave(`partyvoice:${session.id}`)
    const leaveMessage = { id: randomUUID(), sessionId: session.id, userId: 'system', displayName: '', text: `${departedName} left the room`, createdAt: new Date().toISOString() }
    session.messages = [...session.messages, leaveMessage].slice(-100)
    io.to(`party:${session.id}`).emit('party:chat:message', leaveMessage)
    io.to(`party:${session.id}`).emit('party:session', partySessionPayload(session))
    void updatePartyInviteMessages(session)
  })
  socket.on('party:end', ({ sessionId } = {}) => {
    const session = activePartySessions.get(String(sessionId))
    if (!session || session.hostId !== socket.userId || session.status !== 'open') return
    session.status = 'ended'; session.playing = false
    io.to(`party:${session.id}`).emit('party:session', partySessionPayload(session))
    void updatePartyInviteMessages(session)
  })
  socket.on('party:sync', async ({ sessionId, action, time } = {}) => {
    const session = activePartySessions.get(String(sessionId))
    const position = Number(time)
    if (!session || session.status !== 'open' || !session.participantIds.includes(socket.userId) || !['play','pause','seek'].includes(action) || !Number.isFinite(position) || position < 0 || position > 86400) return
    if (socket.userId !== session.hostId && !await canUseFriendFeaturesIds(session.hostId, socket.userId)) return socket.emit('party:error', { message: 'Reconnect as friends to use this watch party.' })
    // Resume from the room's saved position. A player's first Play event can
    // arrive late while its media initializes and report a falsely advanced time.
    const syncPosition = action === 'play' && !session.playing ? session.currentTime : position
    session.currentTime = syncPosition
    if (action === 'play') session.playing = true
    else if (action === 'pause') session.playing = false
    session.playbackUpdatedAt = Date.now()
    io.to(`party:${session.id}`).emit('party:sync', { sessionId: session.id, action, time: syncPosition, playing: session.playing, by: socket.userId, updatedAt: session.playbackUpdatedAt })
  })
  socket.on('party:chat:send', async ({ sessionId, text } = {}) => {
    const session = activePartySessions.get(String(sessionId)); const cleanText = typeof text === 'string' ? text.trim().slice(0, 500) : ''
    if (!session || session.status !== 'open' || !session.participantIds.includes(socket.userId) || !cleanText) return
    if (socket.userId !== session.hostId && !await canUseFriendFeaturesIds(session.hostId, socket.userId)) return
    const user = await User.findById(socket.userId).select('displayName')
    if (!user) return
    const message = { id: randomUUID(), sessionId: session.id, userId: socket.userId, displayName: user.displayName, text: cleanText, createdAt: new Date().toISOString() }
    session.messages = [...session.messages, message].slice(-100)
    io.to(`party:${session.id}`).emit('party:chat:message', message)
  })
  socket.on('party:voice:join', async ({ sessionId } = {}) => {
    const session = activePartySessions.get(String(sessionId))
    if (!session || session.status !== 'open' || !session.participantIds.includes(socket.userId)) return
    if (socket.userId !== session.hostId && !await canUseFriendFeaturesIds(session.hostId, socket.userId)) return
    const peers = [...session.voicePlayers].filter(id => id !== socket.userId)
    socket.join(`partyvoice:${session.id}`); session.voicePlayers.add(socket.userId)
    socket.emit('party:voice:peers', peers)
    socket.to(`partyvoice:${session.id}`).emit('party:voice:peer-joined', { userId: socket.userId })
  })
  socket.on('party:voice:leave', ({ sessionId } = {}) => {
    const session = activePartySessions.get(String(sessionId)); if (!session || !session.voicePlayers.delete(socket.userId)) return
    socket.leave(`partyvoice:${session.id}`); socket.to(`partyvoice:${session.id}`).emit('party:voice:peer-left', { userId: socket.userId })
  })
  socket.on('party:voice:signal', async ({ sessionId, to, kind, data } = {}) => {
    const session = activePartySessions.get(String(sessionId)); const target = String(to || '')
    if (!session || !['offer','answer','ice'].includes(kind) || !session.voicePlayers.has(socket.userId) || !session.voicePlayers.has(target)) return
    if (!await canInteractWithoutBlockIds(socket.userId, target)) return
    io.to(target).emit('party:voice:signal', { sessionId: session.id, from: socket.userId, kind, data })
  })
  socket.on('game:invite', async ({ game, userIds, quizDifficulty, quizTimeLimitMinutes } = {}) => {
    try {
      const limits = { 'tic-tac-toe': 2, chess: 2, ludo: 4, 'math-quiz': 2 }
      const maxPlayers = limits[game]
      if (!dbReady || !maxPlayers || !Array.isArray(userIds)) return socket.emit('game:error', { message: 'Choose a supported game and friends to invite.' })
      if (game === 'math-quiz' && (!['easy','medium','high','extreme'].includes(quizDifficulty) || ![1,2,3,4,5].includes(Number(quizTimeLimitMinutes)))) return socket.emit('game:error', { message: 'Choose a quiz difficulty and a game time from 1 to 5 minutes.' })
      const host = await User.findById(socket.userId).select('username displayName friends')
      const invited = [...new Set(userIds.map(String))].filter(id => id !== socket.userId).slice(0, maxPlayers - 1)
      if (!host || !invited.length || invited.some(id => !host.friends.some(friendId => friendId.toString() === id))) return socket.emit('game:error', { message: 'You can invite accepted friends only.' })
      const sessionId = randomUUID()
      const session = { id: sessionId, game, hostId: socket.userId, hostName: host.displayName, maxPlayers, invitedIds: invited, playerIds: [socket.userId], playerNames: { [socket.userId]: host.displayName }, leftPlayerIds: [], quizDifficulty: game === 'math-quiz' ? quizDifficulty : undefined, quizTimeLimitMinutes: game === 'math-quiz' ? Number(quizTimeLimitMinutes) : undefined, status: 'open', board: game === 'tic-tac-toe' ? Array(9).fill(null) : game === 'chess' ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR' : game === 'ludo' ? Array.from({length:4},()=>Array(4).fill(0)) : null, turn: 0, ludoRollCount: Array(4).fill(0), ludoSixBoostUsed: Array(4).fill(false), createdAt: new Date().toISOString(), invites: [], chatMessages: [], voicePlayers: new Set() }
      activeGameSessions.set(sessionId, session)
      socket.join(`game:${sessionId}`)
      for (const targetId of invited) {
        const members = [socket.userId, targetId].sort()
        const directKey = members.join(':')
        const conversation = await Conversation.findOneAndUpdate({ directKey }, { $setOnInsert: { members, directKey }, $pull: { archivedFor: targetId, hiddenFor: targetId } }, { upsert: true, new: true, setDefaultsOnInsert: true })
        const invite = { sessionId, game, status: 'open', hostId: socket.userId, hostName: host.displayName, maxPlayers, invitedIds: invited, playerIds: session.playerIds, quizDifficulty: session.quizDifficulty, quizTimeLimitMinutes: session.quizTimeLimitMinutes }
        const gameName = game === 'tic-tac-toe' ? 'Tic Tac Toe' : game === 'chess' ? 'Chess' : game === 'ludo' ? 'Ludo' : 'Math Quiz'
        const message = await Message.create({ conversation: conversation._id, sender: host._id, text: `Invited you to play ${gameName}${game === 'math-quiz' ? ` (${quizTimeLimitMinutes} min, ${quizDifficulty})` : ''}.`, gameInvite: invite })
        conversation.latestText = message.text; conversation.latestAt = message.createdAt; await conversation.save()
        const payload = { id: message.id, conversationId: conversation.id, senderId: socket.userId, text: message.text, gameInvite: invite, deliveredAt: null, readAt: null, createdAt: message.createdAt }
        session.invites.push({ userId: targetId, conversationId: conversation.id, messageId: message.id })
        io.to(conversation.id).emit('message:new', payload)
        io.to(targetId).emit('message:new', payload)
      }
      socket.emit('game:session', gameSessionPayload(session))
      socket.emit('game:chat:history', session.chatMessages)
    } catch (error) { console.error('Game invite failed:', error); socket.emit('game:error', { message: 'Could not send the game invite.' }) }
  })
  socket.on('game:invite:accept', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'open') return socket.emit('game:error', { message: 'This game is already closed to new players.' })
    if (!session.invitedIds.includes(socket.userId)) return socket.emit('game:error', { message: 'This invite was not sent to you.' })
    if (!await canUseFriendFeaturesIds(session.hostId, socket.userId)) return socket.emit('game:error', { message: 'Reconnect as friends before joining this game.' })
    if (session.playerIds.includes(socket.userId)) return session.leftPlayerIds?.includes(socket.userId) ? socket.emit('game:error', { message: 'You already left this game.' }) : socket.emit('game:session', gameSessionPayload(session))
    if (session.playerIds.length >= session.maxPlayers) return socket.emit('game:error', { message: 'This game already has all its players.' })
    session.playerIds.push(socket.userId)
    const arrivingPlayer = await User.findById(socket.userId).select('displayName')
    session.playerNames[socket.userId] = arrivingPlayer?.displayName || 'A friend'
    io.to(session.hostId).emit('game:player:arrived', { sessionId: session.id, userId: socket.userId, displayName: arrivingPlayer?.displayName || 'A friend', playerCount: session.playerIds.length })
    socket.join(`game:${session.id}`)
    socket.emit('game:chat:history', session.chatMessages)
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
    io.to(session.hostId).emit('game:session', gameSessionPayload(session))
    socket.emit('game:session', gameSessionPayload(session))
    await updateGameInviteMessages(session)
  })
  socket.on('game:invite:decline', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'open' || !session.invitedIds.includes(socket.userId)) return
    session.invitedIds = session.invitedIds.filter(id => id !== socket.userId)
    await updateGameInviteMessages(session)
    socket.emit('game:invite:declined', { sessionId })
  })
  socket.on('game:start', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    const activePlayerIds = session?.playerIds.filter(id => !session.leftPlayerIds?.includes(id)) || []
    if (!session || session.hostId !== socket.userId || session.status !== 'open' || activePlayerIds.length < 2) return socket.emit('game:error', { message: 'Wait for at least one friend to accept before starting.' })
    if (!(await Promise.all(activePlayerIds.filter(id => id !== session.hostId).map(id => canUseFriendFeaturesIds(session.hostId, id)))).every(Boolean)) return socket.emit('game:error', { message: 'Reconnect as friends before starting this game.' })
    session.status = 'started'; session.startedAt = new Date().toISOString()
    if (session.game === 'math-quiz') prepareMathQuiz(session)
    for (const playerId of session.playerIds) io.to(playerId).socketsJoin(`game:${session.id}`)
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
    await updateGameInviteMessages(session)
  })
  socket.on('game:join', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || !session.playerIds.includes(socket.userId) || session.leftPlayerIds?.includes(socket.userId)) return socket.emit('game:error', { message: 'You are not an active player in this game.' })
    socket.join(`game:${session.id}`); socket.emit('game:session', gameSessionPayload(session)); socket.emit('game:chat:history', session.chatMessages)
  })
  socket.on('game:quiz:ready', ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.game !== 'math-quiz' || session.status !== 'started' || session.quiz?.phase !== 'ready' || !session.playerIds.includes(socket.userId) || session.leftPlayerIds?.includes(socket.userId)) return
    session.quiz.readyBy = [...new Set([...(session.quiz.readyBy || []), socket.userId])]
    const activePlayers = session.playerIds.filter(id => !session.leftPlayerIds?.includes(id))
    if (activePlayers.length === 2 && activePlayers.every(id => session.quiz.readyBy.includes(id))) beginMathQuiz(session)
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
  })
  socket.on('game:action', async ({ sessionId, action } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'started' || !session.playerIds.includes(socket.userId) || session.leftPlayerIds?.includes(socket.userId) || !action || typeof action !== 'object') return
    if (session.game === 'math-quiz' && action.type === 'quiz-answer' && session.quiz?.phase === 'playing' && session.quiz.question && Date.now() < session.quiz.questionEndsAt && !Object.prototype.hasOwnProperty.call(session.quiz.answersBy, socket.userId) && Number.isInteger(action.answer) && session.quiz.question.options.includes(action.answer)) {
      session.quiz.answersBy[socket.userId] = action.answer
    } else if (session.game === 'tic-tac-toe' && action.type === 'place' && session.playerIds[session.turn] === socket.userId && Number.isInteger(action.index) && action.index >= 0 && action.index < 9 && session.board[action.index] === null) {
      const mark = session.playerIds.indexOf(socket.userId) === 0 ? 'X' : 'O'; session.board[action.index] = mark; const wins=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].some(line=>line.every(index=>session.board[index]===mark)); if(wins||session.board.every(Boolean)){session.status='ended';session.winner=wins?socket.userId:null;void updateGameInviteMessages(session)}else session.turn=1-session.turn
    } else if (session.game === 'chess' && action.type === 'move' && session.playerIds[session.turn] === socket.userId && Number.isInteger(action.from) && Number.isInteger(action.to) && action.from >= 0 && action.from < 64 && action.to >= 0 && action.to < 64 && action.from !== action.to) {
      const cells = session.board.split('/').flatMap(rank => [...rank].flatMap(char => /^[1-8]$/.test(char) ? Array(Number(char)).fill('') : char)); const fromRow=Math.floor(action.from/8),fromCol=action.from%8,toRow=Math.floor(action.to/8),toCol=action.to%8,dr=toRow-fromRow,dc=toCol-fromCol,piece=cells[action.from],target=cells[action.to],side=session.playerIds.indexOf(socket.userId);
      const own=char=>char&&(side===0?char===char.toUpperCase():char===char.toLowerCase()); const absR=Math.abs(dr),absC=Math.abs(dc); let legal=false;
      if(cells.length===64&&piece&&own(piece)&&!own(target)){const kind=piece.toLowerCase();if(kind==='p'){const dir=side===0?-1:1,start=side===0?6:1;legal=dc===0&&!target&&(dr===dir||(fromRow===start&&dr===2*dir&&!cells[(fromRow+dir)*8+fromCol]))||absC===1&&dr===dir&&!!target;if(legal&&(toRow===0||toRow===7))cells[action.from]=side===0?'Q':'q'}else if(kind==='n')legal=(absR===2&&absC===1)||(absR===1&&absC===2);else if(kind==='k')legal=absR<=1&&absC<=1;else{const straight=dr===0||dc===0,diagonal=absR===absC;legal=kind==='q'?(straight||diagonal):kind==='r'?straight:kind==='b'?diagonal:false;if(legal){const sr=Math.sign(dr),sc=Math.sign(dc);for(let r=fromRow+sr,c=fromCol+sc;r!==toRow||c!==toCol;r+=sr,c+=sc)if(cells[r*8+c]){legal=false;break}}}}
      if(legal){cells[action.to]=cells[action.from];cells[action.from]='';session.board=Array.from({length:8},(_,rank)=>{const row=cells.slice(rank*8,rank*8+8);let out='',empty=0;for(const cell of row){if(!cell)empty++;else{if(empty)out+=empty;empty=0;out+=cell}}if(empty)out+=empty;return out}).join('/');session.turn=1-session.turn}
    } else if (session.game === 'ludo' && action.type === 'roll' && !session.lastRoll && socket.userId === session.playerIds[session.turn % session.playerIds.length]) {
      const playerIndex = session.playerIds.indexOf(socket.userId)
      const pieces = session.board[playerIndex] || []
      const rollCount = session.ludoRollCount[playerIndex] || 0
      const boostForSix = !session.ludoSixBoostUsed[playerIndex] && !pieces.some(progress => progress > 0) && rollCount < 8
      session.lastRoll = boostForSix && Math.random() < 0.4 ? 6 : boostForSix ? 1 + Math.floor(Math.random() * 5) : 1 + Math.floor(Math.random() * 6)
      session.ludoRollCount[playerIndex] = rollCount + 1
      session.lastRollBy = socket.userId
      const rollResult = session.lastRoll
      const hasLegalMove = pieces.some(progress => progress === 0 ? rollResult === 6 : progress < 57 && progress + rollResult <= 57)
      if (!hasLegalMove) {
        session.noMoveTimer = setTimeout(() => {
          if (activeGameSessions.get(session.id) !== session || session.status !== 'started' || session.lastRollBy !== socket.userId || session.lastRoll !== rollResult) return
          session.lastRoll = null
          session.lastRollBy = null
          advanceGameTurn(session)
          io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
        }, 1100)
      }
    } else if (session.game === 'ludo' && action.type === 'move' && socket.userId === session.lastRollBy && Number.isInteger(action.piece) && action.piece >= 0 && action.piece < 4 && session.lastRoll) {
      const playerIndex=session.playerIds.indexOf(socket.userId);const progress=session.board[playerIndex][action.piece];if(progress===0&&session.lastRoll!==6)return;const nextProgress=progress===0?1:progress+session.lastRoll;if(nextProgress>57)return;if(progress===0)session.ludoSixBoostUsed[playerIndex]=true;session.board[playerIndex][action.piece]=nextProgress;let captured=false;if(nextProgress>0&&nextProgress<=51){const safe=[0,8,13,21,26,34,39,47];const trackPosition=([0,13,26,39][playerIndex]+nextProgress-1)%52;if(!safe.includes(trackPosition)){for(let opponent=0;opponent<session.playerIds.length;opponent++){if(opponent===playerIndex)continue;for(let enemy=0;enemy<4;enemy++){const enemyProgress=session.board[opponent][enemy];if(enemyProgress>0&&enemyProgress<=51&&([0,13,26,39][opponent]+enemyProgress-1)%52===trackPosition){session.board[opponent][enemy]=0;captured=true}}}}}const extraTurn=session.lastRoll===6||captured;if(session.board[playerIndex].every(value=>value===57)){session.status='ended';session.winner=socket.userId;void updateGameInviteMessages(session)}session.lastRoll=null;session.lastRollBy=null;if(session.status!=='ended'&&!extraTurn)advanceGameTurn(session)
    } else return
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
  })
  socket.on('game:resign', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'started' || session.game === 'math-quiz' || !session.playerIds.includes(socket.userId)) return
    if (!await canUseFriendFeaturesIds(session.hostId, socket.userId)) return
    session.status = 'ended'; session.resignedBy = socket.userId; session.winner = session.playerIds.find(id => id !== socket.userId) || null
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
    await updateGameInviteMessages(session)
  })
  socket.on('game:leave', ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || !session.playerIds.includes(socket.userId)) return
    markGamePlayerLeft(session, socket.userId)
    socket.leave(`game:${session.id}`)
    socket.leave(`gamevoice:${session.id}`)
    if (session.voicePlayers.delete(socket.userId)) socket.to(`gamevoice:${session.id}`).emit('game-audio:member-left', { sessionId: session.id, userId: socket.userId })
  })
  socket.on('game:chat:send', async ({ sessionId, text } = {}) => {
    const session = activeGameSessions.get(String(sessionId)); const cleanText = String(text || '').trim().slice(0, 500)
    if (!session || !['open','started'].includes(session.status) || !session.playerIds.includes(socket.userId) || session.leftPlayerIds?.includes(socket.userId) || !cleanText) return
    const activePeers = session.playerIds.filter(playerId => playerId !== socket.userId && !session.leftPlayerIds?.includes(playerId))
    if (!(await Promise.all(activePeers.map(playerId => canInteractWithoutBlockIds(socket.userId, playerId)))).every(Boolean)) return
    void User.findById(socket.userId).select('displayName username').then(user => {
      if (!user || !['open','started'].includes(session.status)) return
      const line = { id: randomUUID(), sessionId: session.id, userId: socket.userId, displayName: user.displayName, username: user.username, text: cleanText, createdAt: new Date().toISOString() }
      session.chatMessages.push(line); if (session.chatMessages.length > 100) session.chatMessages.shift()
      io.to(`game:${session.id}`).emit('game:chat:message', line)
    }).catch(error => console.error('Game chat failed:', error.message))
  })
  socket.on('game-audio:join', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'started' || !session.playerIds.includes(socket.userId) || session.leftPlayerIds?.includes(socket.userId)) return socket.emit('game:error', { message: 'Voice chat is only available to players in an active game.' })
    const activePeers = session.playerIds.filter(id => id !== socket.userId && !session.leftPlayerIds?.includes(id))
    if (!(await Promise.all(activePeers.map(id => canInteractWithoutBlockIds(socket.userId, id)))).every(Boolean)) return socket.emit('game:error', { message: 'Game voice is unavailable with a blocked player.' })
    const room = `gamevoice:${session.id}`
    socket.join(room)
    session.voicePlayers.add(socket.userId)
    const peers = [...new Set((await io.in(room).fetchSockets()).map(peer => peer.userId))].filter(id => id !== socket.userId)
    socket.emit('game-audio:roster', peers)
    socket.to(room).emit('game-audio:member', { sessionId: session.id, userId: socket.userId })
  })
  socket.on('game-audio:leave', ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session) return
    const room = `gamevoice:${session.id}`
    socket.leave(room)
    if (session.voicePlayers.delete(socket.userId)) socket.to(room).emit('game-audio:member-left', { sessionId: session.id, userId: socket.userId })
  })
  socket.on('game-audio:signal', async ({ sessionId, to, kind, data } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    const targetId = String(to || '')
    if (!session || session.status !== 'started' || !session.voicePlayers.has(socket.userId) || !session.playerIds.includes(targetId) || !session.voicePlayers.has(targetId) || !['offer','answer','ice'].includes(kind)) return
    if (!await canInteractWithoutBlockIds(socket.userId, targetId)) return
    io.to(targetId).emit('game-audio:signal', { sessionId: session.id, from: socket.userId, kind, data })
  })
  socket.on('game:end', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.hostId !== socket.userId || session.status === 'ended' || session.game === 'math-quiz' && session.status === 'started') return
    session.status = 'ended'; session.endedAt = new Date().toISOString()
    const payload = gameSessionPayload(session)
    for (const userId of new Set([session.hostId, ...session.invitedIds, ...session.playerIds])) io.to(String(userId)).emit('game:session', payload)
    await updateGameInviteMessages(session)
  })
  socket.on('game:restart', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'ended' || !session.playerIds.includes(socket.userId) || session.leftPlayerIds?.length || session.playerIds.length < 2) return socket.emit('game:error', { message: 'This match cannot be restarted because all of its players are not available.' })
    clearTimeout(session.quizTimer); clearTimeout(session.noMoveTimer)
    session.status = 'started'; session.startedAt = new Date().toISOString(); session.endedAt = null; session.winner = null; session.resignedBy = null; session.turn = 0; session.lastRoll = null; session.lastRollBy = null
    session.board = session.game === 'tic-tac-toe' ? Array(9).fill(null) : session.game === 'chess' ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR' : session.game === 'ludo' ? Array.from({length:4},()=>Array(4).fill(0)) : null
    session.ludoRollCount = Array(4).fill(0); session.ludoSixBoostUsed = Array(4).fill(false)
    if (session.game === 'math-quiz') prepareMathQuiz(session)
    else session.quiz = null
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
    await updateGameInviteMessages(session)
  })
  socket.on('disconnect', () => {
    const connections = onlineUserCounts.get(socket.userId) || 0
    if (connections <= 1) {
      onlineUserCounts.delete(socket.userId)
      const lastSeenAt = new Date()
      void User.updateOne({ _id: socket.userId }, { $set: { lastSeenAt } }).catch(err => console.error('Last-seen update failed:', err.message))
      if (dbReady) void emitPresenceUpdate(socket.userId, { online: false, lastSeenAt: lastSeenAt.toISOString() })
    } else onlineUserCounts.set(socket.userId, connections - 1)
    if (connections <= 1) for (const [callId, call] of activeDirectCalls) if (call.callerId === socket.userId || call.calleeId === socket.userId) {
      const otherId = call.callerId === socket.userId ? call.calleeId : call.callerId
      io.to(otherId).emit('call:signal', { from: socket.userId, kind: 'end', callId, conversationId: call.conversationId, mode: call.mode })
      void logCallMessage(call.conversationId, socket.userId, callId, call.mode, call.answered ? 'ended' : 'missed').catch(error => console.error('Call log write failed:', error.message))
      activeDirectCalls.delete(callId)
    }
    if (connections <= 1) for (const call of activeChatCalls.values()) {
      call.invited.delete(socket.userId)
      if (!call.participants.has(socket.userId)) continue
      if (socket.userId === call.hostId) {
        clearTimeout(call.expiryTimer)
        void logCallMessage(call.conversationId, socket.userId, call.id, call.mode, call.everJoined ? 'ended' : 'missed').catch(error => console.error('Call log write failed:', error.message))
        for (const id of [...call.participants].filter(id => id !== socket.userId).concat([...call.invited])) io.to(id).emit('group-call:ended', { callId: call.id })
        activeChatCalls.delete(call.id)
      } else {
        call.participants.delete(socket.userId)
        for (const id of call.participants) io.to(id).emit('group-call:participant-left', { callId: call.id, userId: socket.userId })
        if (call.everJoined && call.participants.size <= 1) {
          clearTimeout(call.expiryTimer)
          void logCallMessage(call.conversationId, socket.userId, call.id, call.mode, 'ended').catch(error => console.error('Call log write failed:', error.message))
          for (const id of [...call.participants, ...call.invited]) io.to(id).emit('group-call:ended', { callId: call.id })
          activeChatCalls.delete(call.id)
        } else if (!call.participants.size && !call.invited.size) { clearTimeout(call.expiryTimer); activeChatCalls.delete(call.id) }
      }
    }
    if (connections <= 1) for (const game of activeGameSessions.values()) markGamePlayerLeft(game, socket.userId)
    for (const game of activeGameSessions.values()) { if (game.voicePlayers.delete(socket.userId)) socket.to(`gamevoice:${game.id}`).emit('game-audio:member-left', { sessionId: game.id, userId: socket.userId }) }
    if (connections <= 1) for (const party of activePartySessions.values()) {
      const wasParticipant = party.participantIds.includes(socket.userId)
      if (party.voicePlayers.delete(socket.userId)) socket.to(`partyvoice:${party.id}`).emit('party:voice:peer-left', { sessionId: party.id, userId: socket.userId })
      if (wasParticipant) {
        party.participantIds = party.participantIds.filter(id => id !== socket.userId)
        party.controllerIds = [...new Set([party.hostId, ...party.controllerIds.filter(id => id !== socket.userId)])]
        io.to(`party:${party.id}`).emit('party:session', partySessionPayload(party))
        void updatePartyInviteMessages(party)
      }
    }
    for (const live of activeLives.values()) {
      if (live.hostId === socket.userId) endLiveSession(live.id, socket.userId)
      else if (live.viewers.delete(socket.userId)) { live.joinRequests.delete(socket.userId); if (live.cohostId === socket.userId) { live.cohostId = null; for (const viewerId of live.viewers) io.to(viewerId).emit('live:viewer-left', { liveId: live.id, viewerId: socket.userId }) } io.to(live.hostId).emit('live:viewer-left', { liveId: live.id, viewerId: socket.userId }); io.to(live.hostId).emit('live:viewer-count', { liveId: live.id, count: live.viewers.size }) }
    }
  })
})

app.use('/api', (err, req, res, next) => { console.error(err); if (res.headersSent) return next(err); if (err instanceof multer.MulterError) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files must be smaller than 50 MB.' : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'A post can contain up to 10 media files.' : 'The media upload could not be accepted.' }); if (err.message?.startsWith('Upload a JPG') || err.message?.startsWith('Upload a supported chat file')) return res.status(400).json({ error: err.message }); res.status(err.code === 11000 ? 409 : 500).json({ error: err.code === 11000 ? 'That username or email is already registered.' : 'Something went wrong. Please try again.' }) })
if (process.env.NODE_ENV === 'production') { const dist = path.resolve(__dirname, '../dist'); app.use(express.static(dist, { setHeaders: (res, filePath) => { const relativePath = path.relative(dist, filePath); if (relativePath.startsWith(`assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); else if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-cache') } })); app.get('/{*path}', (req,res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(dist,'index.html')) }) }
server.listen(PORT, () => console.log(`Social Land API listening on http://localhost:${PORT}`))
const moderationRecoveryTimer = setInterval(() => {
  if (!dbReady) return
  clearInterval(moderationRecoveryTimer)
  void Post.updateMany({ moderationStatus: 'processing', kind: { $in: ['post','reel'] } }, { $set: { moderationStatus: 'pending', moderationStartedAt: null } })
    .then(async () => { for await (const post of Post.find({ moderationStatus: 'pending', kind: { $in: ['post','reel'] } }).select('_id').cursor()) enqueuePostModeration(post._id) })
    .catch(error => console.error('Pending post moderation recovery failed:', error.message))
}, 1000)
moderationRecoveryTimer.unref()
if (process.env.MONGODB_URI) mongoose.connect(process.env.MONGODB_URI).then(async () => { try { for (const index of await Story.collection.indexes()) { if (index.expireAfterSeconds !== undefined && index.key?.expiresAt) await Story.collection.dropIndex(index.name) }; await Story.collection.createIndex({ expiresAt: 1 }); await secureActiveStoryMedia() } catch (err) { console.error('Story setup failed:', err.message) }; await Promise.all([Message.updateMany({ partyInvite: { $exists: true }, $or: [{ 'partyInvite.sessionId': { $exists: false } }, { 'partyInvite.sessionId': null }, { 'partyInvite.sessionId': '' }] }, { $unset: { partyInvite: 1 } }), Message.updateMany({ gameInvite: { $exists: true }, $or: [{ 'gameInvite.sessionId': { $exists: false } }, { 'gameInvite.sessionId': null }, { 'gameInvite.sessionId': '' }] }, { $unset: { gameInvite: 1 } })]); dbReady = true; console.log('MongoDB connected'); void Post.find({ kind: { $in: ['post', 'reel'] }, mediaItems: { $elemMatch: { type: 'video', $or: [{ 'playback.status': { $exists: false } }, { 'playback.status': { $in: ['queued', 'processing'] } }] } } }).select('_id mediaItems').limit(100).lean().then(posts => posts.forEach(post => post.mediaItems?.forEach((item, index) => { if (item.type === 'video' && (!item.playback?.status || ['queued','processing'].includes(item.playback.status))) scheduleVideoTranscode(post._id, item.url, index) }))).catch(err => console.error('Queued post video recovery failed:', err.message)); void cleanExpiredStories().catch(err => console.error('Story cleanup failed:', err.message)); const cleanupTimer = setInterval(() => void cleanExpiredStories().catch(err => console.error('Story cleanup failed:', err.message)), 60 * 1000); cleanupTimer.unref() }).catch(err => console.error('MongoDB connection failed:', err.message))
else console.warn('MongoDB is not configured. Copy .env.example to .env and add MONGODB_URI to enable accounts.')
