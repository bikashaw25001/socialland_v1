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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: process.env.NODE_ENV === 'production' ? (process.env.CLIENT_ORIGIN || 'http://localhost:5173') : true, credentials: true } })
const PORT = Number(process.env.PORT || 3001)
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me-before-deploying'
let dbReady = false

app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }))
app.use(express.json({ limit: '4mb' }))
const uploadsDir = path.join(__dirname, 'uploads')
const storyUploadsDir = path.join(__dirname, 'story-media')
const chatUploadsDir = path.join(__dirname, 'chat-media')
fs.mkdirSync(uploadsDir, { recursive: true })
fs.mkdirSync(storyUploadsDir, { recursive: true })
fs.mkdirSync(chatUploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', immutable: true, dotfiles: 'deny' }))
const allowedMedia = new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['video/mp4','mp4'],['video/webm','webm'],['video/quicktime','mov']])
const upload = multer({ storage: multer.diskStorage({ destination: uploadsDir, filename: (_req, file, cb) => cb(null, `${randomUUID()}.${allowedMedia.get(file.mimetype) || 'bin'}`) }), limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(allowedMedia.has(file.mimetype) ? null : new Error('Upload a JPG, PNG, WebP, MP4, or WebM file.'), allowedMedia.has(file.mimetype)) })
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
  passwordHash: { type: String, required: true, select: false },
  bio: { type: String, default: '', maxlength: 250 },
  avatarUrl: { type: String, default: '', maxlength: 700000 },
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
  reconnectRequired: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  storyAudiencePrivacy: { type: String, enum: ['everyone','friends','selected'], default: 'everyone' },
  storyAudienceFriendIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  passwordResetTokenHash: { type: String, select: false },
  passwordResetCodeHash: { type: String, select: false },
  passwordResetAttempts: { type: Number, default: 0, select: false },
  passwordResetExpires: { type: Date, select: false },
  sessionVersion: { type: Number, default: 0 },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followRequestsIncoming: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followRequestsOutgoing: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  incoming: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  outgoing: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true })
const User = mongoose.model('User', userSchema)
const emailVerificationSchema = new mongoose.Schema({ email: { type: String, required: true, unique: true, lowercase: true, trim: true }, codeHash: { type: String, required: true }, attempts: { type: Number, default: 0 }, expiresAt: { type: Date, required: true }, verifiedAt: { type: Date, default: null } }, { timestamps: true })
emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
const EmailVerification = mongoose.model('EmailVerification', emailVerificationSchema)
const messageSchema = new mongoose.Schema({ conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true }, sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, senderName: { type: String, default: '' }, system: { type: Boolean, default: false }, replyTo: { type: new mongoose.Schema({ messageId: String, senderId: String, senderName: String, text: String, mediaType: String }, { _id: false }), default: undefined }, text: { type: String, default: '', maxlength: 4000, trim: true }, deliveredAt: { type: Date, default: null }, readAt: { type: Date, default: null }, hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], mediaFilename: { type: String, default: '' }, mediaOriginalName: { type: String, default: '' }, mediaType: { type: String, enum: ['image','video','file'] }, storyContext: { storyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Story' }, authorName: String, mediaType: { type: String, enum: ['image','video'] }, caption: String, action: { type: String, enum: ['reply','like'] } }, partyInvite: { type: new mongoose.Schema({ sessionId: String, url: String, hostId: String, hostName: String, invitedIds: [String], participantIds: [String], controllerIds: [String], status: { type: String, enum: ['open','ended'], default: 'open' } }, { _id: false }), default: undefined }, gameInvite: { type: new mongoose.Schema({ sessionId: String, game: { type: String, enum: ['tic-tac-toe','chess','ludo'] }, status: { type: String, enum: ['open','started','ended','declined'], default: 'open' }, hostId: String, hostName: String, maxPlayers: Number, invitedIds: [String], playerIds: [String] }, { _id: false }), default: undefined }, callLog: { type: new mongoose.Schema({ callId: { type: String, required: true }, mode: { type: String, enum: ['audio','video'], required: true }, event: { type: String, enum: ['started','ended','missed'], required: true } }, { _id: false }), default: undefined } }, { timestamps: true })
messageSchema.index({ conversation: 1, _id: -1 })
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
const Conversation = mongoose.model('Conversation', conversationSchema)
const groupInvitationSchema = new mongoose.Schema({ conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true }, inviter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, invitee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, status: { type: String, enum: ['pending','accepted','rejected'], default: 'pending' } }, { timestamps: true })
groupInvitationSchema.index({ conversation: 1, invitee: 1, status: 1 })
const GroupInvitation = mongoose.model('GroupInvitation', groupInvitationSchema)
const reportSchema = new mongoose.Schema({ reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, target: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, reason: { type: String, required: true, maxlength: 500 }, conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' } }, { timestamps: true })
const Report = mongoose.model('Report', reportSchema)
const postSchema = new mongoose.Schema({ author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, caption: { type: String, default: '', maxlength: 2200 }, mediaUrl: { type: String, default: '' }, mediaType: { type: String, enum: ['image','video'], default: 'image' }, mediaItems: { type: [{ url: { type: String, required: true }, type: { type: String, enum: ['image','video'], required: true } }], default: undefined }, kind: { type: String, enum: ['post','reel','note'], default: 'post', index: true }, likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], commentCount: { type: Number, default: 0 }, shareCount: { type: Number, default: 0 } }, { timestamps: true })
const Post = mongoose.model('Post', postSchema)
const profileNoteSchema = new mongoose.Schema({ author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, text: { type: String, required: true, trim: true, maxlength: 500 } }, { timestamps: true })
const ProfileNote = mongoose.model('ProfileNote', profileNoteSchema)
const commentSchema = new mongoose.Schema({ post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, index: true }, author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, text: { type: String, required: true, trim: true, maxlength: 1000 } }, { timestamps: true })
const Comment = mongoose.model('Comment', commentSchema)
const activitySchema = new mongoose.Schema({ recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, type: { type: String, enum: ['friend_request','friend_accepted','follow_request','like','comment','share','message','story_like'], required: true }, post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' }, postKind: { type: String, enum: ['post','reel'] }, read: { type: Boolean, default: false } }, { timestamps: true })
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

const publicUser = user => ({ id: user._id.toString(), username: user.username, displayName: user.displayName, bio: user.bio || '', avatarUrl: user.avatarUrl || '', location: user.location || '', website: user.website || '', pronouns: user.pronouns || '', gender: user.gender || '', age: user.age ?? null, hobbies: user.hobbies || '', relationWith: user.relationWith || '', relationshipStatus: user.relationshipStatus || '', favoriteGame: user.favoriteGame || '', messagePrivacy: user.messagePrivacy || 'friends' })
const publicProfileUser = user => ({ ...publicUser(user), bannerUrl: user.bannerUrl || '', privateProfile: !!user.privateProfile, followerCount: user.followers?.length || 0, followingCount: user.following?.length || 0, friendCount: user.friends?.length || 0 })
const publicActivity = activity => ({ id: activity._id.toString(), type: activity.type, actor: publicUser(activity.actor), postId: activity.post?._id?.toString() || activity.post?.toString() || '', postKind: activity.postKind || 'post', read: activity.read, createdAt: activity.createdAt })
const publicStory = (story, viewerId) => { const id = story._id.toString(); const mediaToken = jwt.sign({ purpose: 'story-media', storyId: id, viewerId: viewerId.toString() }, JWT_SECRET, { expiresIn: '24h' }); const owner = story.author._id?.toString() === viewerId.toString() || story.author.toString?.() === viewerId.toString(); return { id, author: publicUser(story.author), mediaUrl: `/api/stories/${id}/media?token=${mediaToken}`, mediaType: story.mediaType, caption: story.caption || '', privacy: story.privacy || 'everyone', likesCount: (story.likes || []).length, likedByMe: (story.likes || []).some(userId => userId.toString() === viewerId.toString()), seenByMe: !owner && (story.views || []).some(view => view.user?.toString() === viewerId.toString()), ...(owner ? { selectedFriendIds: (story.selectedFriends || []).map(id => id._id?.toString() || id.toString()), viewsCount: (story.views || []).length } : {}), createdAt: story.createdAt, expiresAt: story.expiresAt } }
const canViewStory = async (story, user) => {
  const authorId = story.author._id || story.author
  if (authorId.toString() === user._id.toString()) return true
  const author = await User.findById(authorId).select('privateProfile followers')
  if (!author) return false
  const follower = (author.followers || []).some(id => id.equals(user._id))
  const friend = isFriend(user, authorId)
  if (author.privateProfile && !follower && !friend) return false
  return !story.privacy || story.privacy === 'everyone' || story.privacy === 'friends' && friend || story.privacy === 'selected' && friend && (story.selectedFriends || []).some(id => id.equals(user._id))
}
const createActivity = async (recipientId, actorId, type, postId, postKind) => {
  if (!recipientId || recipientId.toString() === actorId.toString()) return
  const activity = await Activity.create({ recipient: recipientId, actor: actorId, type, ...(postId ? { post: postId, postKind } : {}) })
  await activity.populate('actor', 'username displayName bio avatarUrl location website pronouns')
  const payload = publicActivity(activity)
  io.to(recipientId.toString()).emit('activity:new', payload)
  return payload
}
const MESSAGE_NOTIFICATION_IDLE_MS = 3 * 24 * 60 * 60 * 1000
const shouldNotifyMessage = async conversationId => {
  const latestMessage = await Message.findOne({ conversation: conversationId }).sort({ createdAt: -1 }).select('createdAt').lean()
  return !latestMessage || Date.now() - new Date(latestMessage.createdAt).getTime() >= MESSAGE_NOTIFICATION_IDLE_MS
}
const tokenFor = user => jwt.sign({ sub: user._id.toString(), ver: user.sessionVersion || 0 }, JWT_SECRET, { expiresIn: '7d' })
const auth = async (req, res, next) => {
  if (!dbReady) return res.status(503).json({ error: 'Database is not connected yet. Add MONGODB_URI to .env and restart the server.' })
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Please log in to continue.' })
  try { const claims = jwt.verify(token, JWT_SECRET); req.user = await User.findById(claims.sub); if (!req.user) return res.status(401).json({ error: 'Account no longer exists.' }); if ((claims.ver || 0) !== (req.user.sessionVersion || 0)) return res.status(401).json({ error: 'Your password changed. Please log in again.' }); next() }
  catch { return res.status(401).json({ error: 'Your session expired. Please log in again.' }) }
}
const dbOnly = (req, res, next) => dbReady ? next() : res.status(503).json({ error: 'Database is not connected yet. Add MONGODB_URI to .env and restart the server.' })
const handle = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const isFriend = (a, b) => a.friends.some(id => id.toString() === b.toString())
const acceptedFriendship = (a, b) => !!a && !!b && isFriend(a, b._id) && isFriend(b, a._id)
const pairRequiresReconnect = (first, second) => (first?.reconnectRequired || []).some(id => id.toString() === String(second?._id)) || (second?.reconnectRequired || []).some(id => id.toString() === String(first?._id))
const pairIsBlocked = (first, second) => (first?.blockedUsers || []).some(id => id.toString() === String(second?._id)) || (second?.blockedUsers || []).some(id => id.toString() === String(first?._id))
const canUseFriendFeatures = (first, second) => !!first && !!second && !pairIsBlocked(first, second) && !pairRequiresReconnect(first, second) && acceptedFriendship(first, second)
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
  const profile = await User.findById(authorId).select('privateProfile')
  return !!profile && !profile.privateProfile
}

app.get('/api/health', (req, res) => res.json({ ok: true, database: dbReady ? 'connected' : 'not-configured' }))
app.post('/api/auth/register', dbOnly, handle(async (req, res) => {
  const { username, displayName, email, password } = req.body || {}
  const normalized = String(username || '').trim().toLowerCase()
  if (!/^[a-z0-9_]{3,24}$/.test(normalized)) return res.status(400).json({ error: 'Username must be 3–24 characters using letters, numbers, or underscores.' })
  if (!String(displayName || '').trim() || String(displayName).trim().length > 50) return res.status(400).json({ error: 'Please enter a display name under 50 characters.' })
  if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) return res.status(400).json({ error: 'Enter a valid email address.' })
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8–72 characters.' })
  const normalizedEmail = String(email).trim().toLowerCase()
  if (await User.exists({ email: normalizedEmail })) return res.status(409).json({ error: 'An account with that email already exists.' })
  if (await User.exists({ username: normalized })) return res.status(409).json({ error: 'That username is already taken.' })
  if (!await EmailVerification.exists({ email: normalizedEmail, verifiedAt: { $ne: null }, expiresAt: { $gt: new Date() } })) return res.status(403).json({ error: 'Verify your email address before creating your account.' })
  const user = await User.create({ username: normalized, displayName: String(displayName).trim(), email: normalizedEmail, passwordHash: await bcrypt.hash(password, 12) })
  await EmailVerification.deleteOne({ email: normalizedEmail })
  res.status(201).json({ token: tokenFor(user), user: publicUser(user) })
}))
app.post('/api/auth/login', dbOnly, handle(async (req, res) => {
  const identity = String(req.body?.identity || '').trim().toLowerCase()
  const user = await User.findOne({ $or: [{ email: identity }, { username: identity }] }).select('+passwordHash')
  if (!user || !await bcrypt.compare(String(req.body?.password || ''), user.passwordHash)) return res.status(401).json({ error: 'That login didn’t work. Check your details and try again.' })
  res.json({ token: tokenFor(user), user: publicUser(user) })
}))
const mailTransport = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') } })
  : null
const hashResetToken = token => createHash('sha256').update(token).digest('hex')
const registrationCodeLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false })
app.post('/api/auth/register/send-code', registrationCodeLimit, dbOnly, handle(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase()
  const displayName = String(req.body?.displayName || '').trim()
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–24 characters using letters, numbers, or underscores.' })
  if (!displayName || displayName.length > 50) return res.status(400).json({ error: 'Please enter a display name under 50 characters.' })
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' })
  if (await User.exists({ email })) return res.status(409).json({ error: 'An account with that email already exists.' })
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
  res.json({ ok: true, token: tokenFor(resetUser), user: publicUser(resetUser) })
}))
app.post('/api/auth/change-password', auth, handle(async (req, res) => {
  const currentPassword = req.body?.currentPassword
  const newPassword = req.body?.newPassword
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) return res.status(400).json({ error: 'New password must be 8–72 characters.' })
  const user = await User.findById(req.user._id).select('+passwordHash')
  if (!user || !await bcrypt.compare(String(currentPassword || ''), user.passwordHash)) return res.status(400).json({ error: 'Your current password is incorrect.' })
  user.passwordHash = await bcrypt.hash(newPassword, 12)
  user.sessionVersion += 1
  user.set('passwordResetTokenHash', undefined)
  user.set('passwordResetExpires', undefined)
  await user.save()
  io.in(user._id.toString()).disconnectSockets(true)
  res.json({ token: tokenFor(user), user: publicUser(user) })
}))
app.get('/api/me', auth, (req, res) => res.json({ user: publicProfileUser(req.user), groupAddPrivacy: req.user.groupAddPrivacy || 'anyone', messagePrivacy: req.user.messagePrivacy || 'friends', storyAudience: { privacy: req.user.storyAudiencePrivacy || 'everyone', selectedFriendIds: (req.user.storyAudienceFriendIds || []).map(id => id.toString()) } }))
app.patch('/api/me/story-audience', auth, handle(async (req, res) => {
  const privacy = req.body?.privacy
  if (!['everyone','friends','selected'].includes(privacy)) return res.status(400).json({ error: 'Choose everyone, friends, or selected friends.' })
  const selected = privacy === 'selected' ? selectedStoryFriends(req.body?.selectedFriendIds, req.user) : []
  if (selected === null) return res.status(400).json({ error: 'Selected audience members must be your accepted friends.' })
  req.user.storyAudiencePrivacy = privacy
  req.user.storyAudienceFriendIds = selected
  await req.user.save()
  res.json({ storyAudience: { privacy, selectedFriendIds: selected.map(id => id.toString()) } })
}))
app.get('/api/notifications', auth, handle(async (req, res) => {
  const activities = await Activity.find({ recipient: req.user._id }).sort({ createdAt: -1 }).limit(60).populate('actor', 'username displayName bio avatarUrl location website pronouns').lean()
  res.json({ notifications: activities.map(publicActivity), unreadCount: activities.filter(activity => !activity.read).length })
}))
app.post('/api/notifications/read', auth, handle(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => typeof id === 'string').slice(0, 60) : []
  const filter = { recipient: req.user._id, read: false, ...(ids.length ? { _id: { $in: ids } } : {}) }
  await Activity.updateMany(filter, { $set: { read: true } })
  res.json({ ok: true })
}))
app.get('/api/stories', auth, handle(async (req, res) => {
  const foundStories = await Story.find({ expiresAt: { $gt: new Date() }, $or: [{ author: req.user._id }, { privacy: { $in: ['everyone', null] } }, { privacy: 'friends', author: { $in: req.user.friends } }, { privacy: 'selected', author: { $in: req.user.friends }, selectedFriends: req.user._id }] }).sort({ createdAt: 1 }).limit(500).populate('author', 'username displayName bio avatarUrl location website pronouns').lean()
  const stories = []
  for (const story of foundStories) if (await canViewStory(story, req.user)) stories.push(story)
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
  const story = await Story.create({ author: req.user._id, mediaUrl: `/story-media/${path.basename(req.file.path)}`, mediaType: req.file.mimetype.startsWith('video/') ? 'video' : 'image', caption, privacy, selectedFriends, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
  await story.populate('author', 'username displayName bio avatarUrl location website pronouns')
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
  res.status(201).json({ message: payload, conversation: { id: conversation.id, user: { ...publicUser(author), lastSeenAt: author.lastSeenAt || null }, latestText: conversation.latestText, latestAt: conversation.latestAt } })
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
  const story = await Story.findOne({ _id: req.params.id, author: req.user._id, expiresAt: { $gt: new Date() } }).populate('views.user', 'username displayName bio avatarUrl location website pronouns').populate('likes', 'username displayName bio avatarUrl location website pronouns').lean()
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
  await story.populate('author', 'username displayName bio avatarUrl location website pronouns')
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
  const username = String(req.body?.username ?? req.user.username).trim().toLowerCase()
  const displayName = String(req.body?.displayName ?? req.user.displayName).trim()
  const bio = String(req.body?.bio ?? req.user.bio).trim()
  const avatarUrl = String(req.body?.avatarUrl ?? req.user.avatarUrl).trim()
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
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–24 characters using letters, numbers, or underscores.' })
  if (!displayName || displayName.length > 50 || bio.length > 250 || location.length > 80 || website.length > 200 || pronouns.length > 40 || gender.length > 40 || hobbies.length > 200 || relationWith.length > 160 || relationshipStatus.length > 40 || favoriteGame.length > 80) return res.status(400).json({ error: 'One or more profile details are too long.' })
  if (age !== null && (!Number.isInteger(age) || age < 13 || age > 120)) return res.status(400).json({ error: 'Age must be a whole number between 13 and 120.' })
  if (username !== req.user.username && await User.exists({ username, _id: { $ne: req.user._id } })) return res.status(409).json({ error: 'That username is already taken.' })
  if (avatarUrl && (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(avatarUrl) || avatarUrl.length > 700000)) return res.status(400).json({ error: 'Choose a smaller JPG, PNG, or WebP profile photo.' })
  if (bannerUrl && (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(bannerUrl) || bannerUrl.length > 1800000)) return res.status(400).json({ error: 'Choose a smaller JPG, PNG, or WebP banner image.' })
  if (website) { try { const parsed = new URL(website); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error() } catch { return res.status(400).json({ error: 'Enter a valid website address, including https://.' }) } }
  Object.assign(req.user, { username, displayName, bio, avatarUrl, bannerUrl, location, website, pronouns, gender, age, hobbies, relationWith, relationshipStatus, favoriteGame })
  if (typeof req.body?.privateProfile === 'boolean') req.user.privateProfile = req.body.privateProfile
  if (req.body?.groupAddPrivacy !== undefined) {
    if (!['anyone','approval'].includes(req.body.groupAddPrivacy)) return res.status(400).json({ error: 'Choose anyone or approve before adding.' })
    req.user.groupAddPrivacy = req.body.groupAddPrivacy
  }
  if (req.body?.messagePrivacy !== undefined) {
    if (!['friends','everyone'].includes(req.body.messagePrivacy)) return res.status(400).json({ error: 'Choose Friends or Everyone for message privacy.' })
    req.user.messagePrivacy = req.body.messagePrivacy
  }
  await req.user.save()
  res.json({ user: publicProfileUser(req.user) })
}))
const publicPost = (post, viewerId) => ({ id: post._id.toString(), author: publicUser(post.author), caption: post.caption, mediaUrl: post.mediaUrl, mediaType: post.mediaType, mediaItems: post.mediaItems?.length ? post.mediaItems.map(item => ({ url: item.url, type: item.type })) : (post.mediaUrl ? [{ url: post.mediaUrl, type: post.mediaType }] : []), kind: post.kind, createdAt: post.createdAt, likesCount: post.likes.length, commentCount: post.commentCount, shareCount: post.shareCount, likedByMe: post.likes.some(id => id.toString() === viewerId.toString()) })
const publicComment = comment => ({ id: comment._id.toString(), author: publicUser(comment.author), text: comment.text, createdAt: comment.createdAt })
const publicProfileNote = note => ({ id: note._id.toString(), authorId: note.author.toString(), text: note.text, createdAt: note.createdAt })
app.get('/api/me/notes', auth, handle(async (req, res) => {
  const notes = await ProfileNote.find({ author: req.user._id }).sort({ createdAt: -1 }).limit(100).lean()
  res.json({ notes: notes.map(publicProfileNote) })
}))
app.post('/api/me/notes', auth, handle(async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text || text.length > 500) return res.status(400).json({ error: 'Notes must be between 1 and 500 characters.' })
  const note = await ProfileNote.create({ author: req.user._id, text })
  res.status(201).json({ note: publicProfileNote(note) })
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
  for (const live of activeLives.values()) if (live.hostId === target.id) {
    live.audienceIds.add(req.user.id)
    io.to(req.user.id).emit('live:available', { id: live.id, host: live.host, startedAt: live.startedAt })
  }
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
  for (const live of activeLives.values()) if (live.hostId === target.id && !isFriend(req.user, target._id)) {
    live.audienceIds.delete(req.user.id)
    if (live.viewers.delete(req.user.id)) {
      live.joinRequests.delete(req.user.id)
      if (live.cohostId === req.user.id) live.cohostId = null
      io.to(target.id).emit('live:viewer-left', { liveId: live.id, viewerId: req.user.id })
      io.to(target.id).emit('live:viewer-count', { liveId: live.id, count: live.viewers.size })
    }
    io.to(req.user.id).emit('live:ended', { liveId: live.id, hostId: target.id })
  }
  res.json({ following: false, followerCount: target.followers.length, followingCount: req.user.following.length })
}))
app.delete('/api/users/:id/follower', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || target._id.equals(req.user._id)) return res.status(404).json({ error: 'That profile could not be found.' })
  req.user.followers.pull(target._id)
  target.following.pull(req.user._id)
  await Promise.all([req.user.save(), target.save()])
  res.json({ removed: true, followerCount: req.user.followers.length, followingCount: target.following.length })
}))
app.get('/api/me/follow-requests', auth, handle(async (req, res) => {
  const users = await User.find({ _id: { $in: req.user.followRequestsIncoming || [] } }).select('username displayName bio avatarUrl bannerUrl location website pronouns followers following friends').sort({ username: 1 })
  res.json({ users: users.map(user => ({ ...publicProfileUser(user), relationship: isFriend(req.user, user._id) ? 'friend' : 'none' })) })
}))
app.post('/api/me/follow-requests/:id/approve', auth, handle(async (req, res) => {
  const requester = await User.findById(req.params.id)
  if (!requester || !req.user.followRequestsIncoming.some(id => id.equals(requester._id))) return res.status(404).json({ error: 'Follow request not found.' })
  req.user.followRequestsIncoming.pull(requester._id); requester.followRequestsOutgoing.pull(req.user._id)
  req.user.followers.addToSet(requester._id); requester.following.addToSet(req.user._id)
  await Promise.all([req.user.save(), requester.save()])
  res.json({ ok: true, followerCount: req.user.followers.length })
}))
app.post('/api/me/follow-requests/approve-all', auth, handle(async (req, res) => {
  const ids = [...(req.user.followRequestsIncoming || [])]
  if (ids.length) {
    await User.updateMany({ _id: { $in: ids } }, { $addToSet: { following: req.user._id }, $pull: { followRequestsOutgoing: req.user._id } })
    req.user.followers.addToSet(...ids); req.user.followRequestsIncoming = []
    await req.user.save()
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
  const users = await User.find({ _id: { $in: target[list] || [] } }).select('username displayName bio avatarUrl location website pronouns').sort({ username: 1 })
  res.json({ users: users.map(publicUser) })
}))
app.get('/api/users/:username/profile', auth, handle(async (req, res) => {
  const username = String(req.params.username || '').toLowerCase()
  const user = await User.findOne({ username }).select('username displayName bio avatarUrl bannerUrl location website pronouns gender age hobbies relationWith relationshipStatus favoriteGame privateProfile followers following friends incoming outgoing followRequestsIncoming blockedUsers reconnectRequired messagePrivacy')
  if (!user) return res.status(404).json({ error: 'That profile could not be found.' })
  const blockedByViewer = (req.user.blockedUsers || []).some(id => id.equals(user._id))
  const blockedViewer = (user.blockedUsers || []).some(id => id.equals(req.user._id))
  if (blockedByViewer || blockedViewer) return res.json({ user: { id: user.id, username: 'user', displayName: '@user', bio: '', avatarUrl: '', bannerUrl: '', relationship: 'none', followerCount: 0, followingCount: 0, friendCount: 0, postCount: 0, reelCount: 0, noteCount: 0, blockedProfile: true, canViewContent: false }, posts: [], reels: [], notes: [] })

  const relationship = isFriend(req.user, user._id) ? 'friend' : req.user.outgoing.some(id => id.equals(user._id)) ? 'sent' : req.user.incoming.some(id => id.equals(user._id)) ? 'received' : 'none'
  const isFollowing = user.followers.some(id => id.equals(req.user._id))
  const canViewContent = user._id.equals(req.user._id) || !user.privateProfile || isFollowing || relationship === 'friend'
  const [posts, reels, legacyNotes, notePosts, postCount, reelCount, legacyNoteCount, notePostCount] = await Promise.all([
    canViewContent ? Post.find({ author: user._id, kind: 'post' }).sort({ createdAt: -1 }).limit(60).populate('author', 'username displayName bio avatarUrl bannerUrl location website pronouns').lean() : [],
    canViewContent ? Post.find({ author: user._id, kind: 'reel' }).sort({ createdAt: -1 }).limit(60).populate('author', 'username displayName bio avatarUrl bannerUrl location website pronouns').lean() : [],
    canViewContent ? ProfileNote.find({ author: user._id }).sort({ createdAt: -1 }).limit(100).lean() : [],
    canViewContent ? Post.find({ author: user._id, kind: 'note' }).sort({ createdAt: -1 }).limit(100).lean() : [],
    Post.countDocuments({ author: user._id, kind: 'post' }),
    Post.countDocuments({ author: user._id, kind: 'reel' }),
    ProfileNote.countDocuments({ author: user._id }),
    Post.countDocuments({ author: user._id, kind: 'note' }),
  ])
  const notes = [...legacyNotes.map(note => ({ ...publicProfileNote(note), legacy: true })), ...notePosts.map(note => ({ id: note._id.toString(), authorId: note.author.toString(), text: note.caption, createdAt: note.createdAt, legacy: false }))].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const isFollowRequested = (user.followRequestsIncoming || []).some(id => id.equals(req.user._id))
  res.json({ user: { ...publicProfileUser(user), relationship, requiresFriendReconnect: pairRequiresReconnect(req.user, user), followerCount: user.followers.length, followingCount: user.following.length, postCount, reelCount, noteCount: legacyNoteCount + notePostCount, isFollowing, isFollowRequested, pendingFollowRequestCount: user._id.equals(req.user._id) ? (user.followRequestsIncoming || []).length : undefined, canViewContent }, posts: posts.map(post => publicPost(post, req.user._id)), reels: reels.map(post => publicPost(post, req.user._id)), notes })
}))
app.get('/api/posts', auth, handle(async (req, res) => {
  const kind = ['post','reel','note'].includes(req.query.kind) ? req.query.kind : 'post'
  const allowedAuthors = [...new Set([req.user._id.toString(), ...(req.user.following || []).map(id => id.toString()), ...(req.user.friends || []).map(id => id.toString())])]
  const posts = await Post.find({ kind, author: { $in: allowedAuthors } }).sort({ createdAt: -1 }).limit(40).populate('author', 'username displayName bio avatarUrl location website pronouns').lean()
  res.json({ posts: posts.map(post => publicPost(post, req.user._id)) })
}))
app.post('/api/posts', auth, upload.array('media', 10), handle(async (req, res) => {
  const caption = String(req.body?.caption || '').trim()
  const kind = ['post','reel','note'].includes(req.body?.kind) ? req.body.kind : 'post'
  const files = req.files || []
  const discardFiles = () => files.forEach(file => fs.unlink(file.path, () => {}))
  if (kind === 'note' && (files.length || !caption || caption.length > 500)) { discardFiles(); return res.status(400).json({ error: 'Notes must contain text only and be no longer than 500 characters.' }) }
  if (caption.length > 2200) { discardFiles(); return res.status(400).json({ error: 'Captions can be up to 2,200 characters.' }) }
  if (kind === 'post' && !files.length) return res.status(400).json({ error: 'Add at least one photo or video to publish a post. For text only, share a Note.' })
  if (kind === 'reel' && (files.length !== 1 || !files[0].mimetype.startsWith('video/'))) { discardFiles(); return res.status(400).json({ error: 'Choose a single video to publish a Reel.' }) }
  if (files.length > 10 || files.reduce((total, file) => total + file.size, 0) > 200 * 1024 * 1024) { discardFiles(); return res.status(400).json({ error: 'A post can contain up to 10 media files and 200 MB total.' }) }
  if (kind === 'note' && !caption) return res.status(400).json({ error: 'Add text to publish a Note.' })
  const mediaItems = files.map(file => ({ url: `/uploads/${path.basename(file.path)}`, type: file.mimetype.startsWith('video/') ? 'video' : 'image' }))
  const post = await Post.create({ author: req.user._id, caption, kind, mediaUrl: mediaItems[0]?.url || '', mediaType: mediaItems[0]?.type || 'image', mediaItems })
  await post.populate('author', 'username displayName bio avatarUrl location website pronouns')
  res.status(201).json({ post: publicPost(post, req.user._id) })
}))
app.post('/api/posts/:id/like', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id)
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!await User.exists({ _id: post.author })) return res.status(404).json({ error: 'Post author not found.' })
  if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'Follow this account to interact with its posts.' })
  const liked = post.likes.some(id => id.equals(req.user._id))
  await Post.updateOne({ _id: post._id }, liked ? { $pull: { likes: req.user._id } } : { $addToSet: { likes: req.user._id } })
  const count = await Post.findById(post._id).select('likes').lean()
  if (!liked) await createActivity(post.author, req.user._id, 'like', post._id, post.kind)
  res.json({ liked: !liked, likesCount: count.likes.length })
}))
app.get('/api/posts/:id/comments', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id).select('author')
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'Follow this account to view its post comments.' })
  const comments = await Comment.find({ post: req.params.id }).sort({ createdAt: 1 }).limit(100).populate('author', 'username displayName bio avatarUrl location website pronouns').lean()
  res.json({ comments: comments.map(publicComment) })
}))
app.post('/api/posts/:id/comments', auth, handle(async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text || text.length > 1000) return res.status(400).json({ error: 'Comments must be 1–1,000 characters.' })
  const post = await Post.findById(req.params.id)
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'Follow this account to interact with its posts.' })
  const comment = await Comment.create({ post: post._id, author: req.user._id, text })
  await Post.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } })
  await comment.populate('author', 'username displayName bio avatarUrl location website pronouns')
  await createActivity(post.author, req.user._id, 'comment', post._id, post.kind)
  res.status(201).json({ comment: publicComment(comment) })
}))
app.post('/api/posts/:id/share', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id).select('shareCount author kind')
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!await canViewUserContent(req.user, post.author)) return res.status(403).json({ error: 'Follow this account to interact with its posts.' })
  await Post.updateOne({ _id: post._id }, { $inc: { shareCount: 1 } })
  post.shareCount += 1
  await createActivity(post.author, req.user._id, 'share', post._id, post.kind)
  res.json({ shareCount: post.shareCount })
}))
app.delete('/api/posts/:id', auth, handle(async (req, res) => {
  const post = await Post.findById(req.params.id)
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  if (!post.author.equals(req.user._id)) return res.status(403).json({ error: 'You can only delete your own post.' })
  await Promise.all([Comment.deleteMany({ post: post._id }), Activity.deleteMany({ post: post._id }), post.deleteOne()])
  const mediaUrls = new Set([post.mediaUrl, ...(post.mediaItems || []).map(item => item.url)].filter(url => url?.startsWith('/uploads/')))
  mediaUrls.forEach(url => fs.unlink(path.join(uploadsDir, path.basename(url)), () => {}))
  res.json({ ok: true })
}))
app.get('/api/users', auth, handle(async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const select = 'username displayName bio avatarUrl location website pronouns gender age hobbies relationWith friends incoming outgoing followers followRequestsIncoming privateProfile blockedUsers reconnectRequired messagePrivacy'
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
  const [friends, requests] = await Promise.all([User.find({ _id: { $in: req.user.friends } }).select('username displayName bio avatarUrl location website pronouns'), User.find({ _id: { $in: req.user.incoming } }).select('username displayName bio avatarUrl location website pronouns')])
  res.json({ friends: friends.map(publicUser), requests: requests.map(publicUser) })
}))
app.post('/api/friends/:id/request', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'That profile could not be found.' })
  if (req.user.blockedUsers.some(id => id.equals(target._id)) || target.blockedUsers.some(id => id.equals(req.user._id))) return res.status(403).json({ error: 'This person is unavailable because of a block.' })
  if (isFriend(req.user, target._id)) return res.status(409).json({ error: 'You are already friends.' })
  if (req.user.incoming.some(x => x.equals(target._id))) return res.status(409).json({ error: 'They already sent you a request. Accept it in Friends.' })
  if (!req.user.outgoing.some(x => x.equals(target._id))) { req.user.outgoing.push(target._id); target.incoming.push(req.user._id); await Promise.all([req.user.save(), target.save()]); io.to(target.id).emit('friend:request', publicUser(req.user)); await createActivity(target._id, req.user._id, 'friend_request') }
  res.json({ ok: true })
}))
app.post('/api/friends/:id/accept', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || !req.user.incoming.some(x => x.equals(target._id))) return res.status(404).json({ error: 'No pending request from that person.' })
  req.user.incoming.pull(target._id); target.outgoing.pull(req.user._id); req.user.reconnectRequired.pull(target._id); target.reconnectRequired.pull(req.user._id); req.user.friends.addToSet(target._id); target.friends.addToSet(req.user._id)
  await Promise.all([req.user.save(), target.save()]); io.to(target.id).emit('friend:accepted', publicUser(req.user)); io.to(req.user.id).emit('friend:accepted', publicUser(target)); await createActivity(target._id, req.user._id, 'friend_accepted'); res.json({ ok: true })
}))
app.delete('/api/friends/:id', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || !isFriend(req.user, target._id)) return res.status(404).json({ error: 'Friend not found.' })
  req.user.friends.pull(target._id); target.friends.pull(req.user._id)
  req.user.incoming.pull(target._id); req.user.outgoing.pull(target._id)
  target.incoming.pull(req.user._id); target.outgoing.pull(req.user._id)
  await Promise.all([req.user.save(), target.save()])
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
  res.json({ conversation: { id: conversation.id, user: { ...publicUser(target), lastSeenAt: target.lastSeenAt || null }, latestText: conversation.latestText, latestAt: conversation.latestAt } })
}))
app.get('/api/group-invitations', auth, handle(async (req, res) => {
  const invitations = await GroupInvitation.find({ invitee: req.user._id, status: 'pending' }).sort({ createdAt: -1 }).populate('conversation', 'groupName groupImage isGroup').populate('inviter', 'username displayName bio avatarUrl').lean()
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
  const users = await User.find({ _id: { $in: rows.flatMap(c => c.members).filter(id => !id.equals(req.user._id)) } }).select('username displayName bio avatarUrl lastSeenAt location website pronouns friends blockedUsers reconnectRequired messagePrivacy').lean()
  const byId = new Map(users.map(u => [u._id.toString(), u]))
  const visibleRows = []
  for (const conversation of rows) {
    if (conversation.isGroup) { if (await directConversationAllowed(conversation, req.user._id)) visibleRows.push(conversation); continue }
    const peerId = conversation.members.find(id => !id.equals(req.user._id)), peer = byId.get(peerId?.toString())
    if (canDirectlyInteract(req.user, peer) || canDirectlyInteract(peer, req.user)) visibleRows.push(conversation)
  }
  const previews = await Promise.all(visibleRows.map(async c => {
    const [latest, unreadCount] = await Promise.all([
      Message.findOne({ conversation: c._id, hiddenFor: { $ne: req.user._id } }).sort({ createdAt: -1, _id: -1 }).lean(),
      Message.countDocuments({ conversation: c._id, sender: { $ne: req.user._id }, readAt: null, hiddenFor: { $ne: req.user._id } })
    ])
    return [c._id.toString(), messagePreview(latest), latest?.createdAt || c.latestAt, unreadCount]
  }))
  const previewById = new Map(previews.map(([id, text, at, unreadCount]) => [id, { text, at, unreadCount }]))
  res.json({ conversations: visibleRows.map(c => { const other = c.members.find(id => !id.equals(req.user._id)); const user = c.isGroup ? { _id: c._id, username: 'group', displayName: c.groupName || 'Group chat', bio: '', avatarUrl: c.groupImage || '', lastSeenAt: null } : byId.get(other.toString()); const preview = previewById.get(c._id.toString()); return { id: c._id.toString(), isGroup: !!c.isGroup, groupName: c.groupName || '', groupImage: c.groupImage || '', members: c.members.map(id => id.toString()), user: { ...publicUser(user), lastSeenAt: (req.user.blockedUsers || []).some(id => id.equals(user._id)) || (user.blockedUsers || []).some(id => id.equals(req.user._id)) ? null : user.lastSeenAt || null }, latestText: preview?.text || '', latestAt: preview?.at || c.latestAt, unreadCount: preview?.unreadCount || 0, muted: (c.mutedFor || []).some(id => id.equals(req.user._id)), blocked: !!user && (req.user.blockedUsers || []).some(id => id.equals(user._id)), unavailable: !!user && ((req.user.blockedUsers || []).some(id => id.equals(user._id)) || (user.blockedUsers || []).some(id => id.equals(req.user._id))) } }) })
}))
app.get('/api/conversations/search', auth, handle(async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 120)
  if (query.length < 2) return res.json({ results: [] })
  const conversations = await Conversation.find({ members: req.user._id, hiddenFor: { $ne: req.user._id } }).select('_id members isGroup groupName groupImage latestText latestAt').lean()
  const rows = await Message.find({ conversation: { $in: conversations.map(item => item._id) }, hiddenFor: { $ne: req.user._id }, text: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }).sort({ createdAt: -1 }).limit(100).lean()
  const peerIds = conversations.flatMap(c => c.members).filter(id => !id.equals(req.user._id))
  const users = await User.find({ _id: { $in: peerIds } }).select('username displayName bio avatarUrl lastSeenAt friends blockedUsers reconnectRequired messagePrivacy').lean()
  const byId = new Map(users.map(user => [user._id.toString(), user]))
  const visibleConversations = []
  for (const conversation of conversations) {
    if (conversation.isGroup) { if (await directConversationAllowed(conversation, req.user._id)) visibleConversations.push(conversation); continue }
    const peerId = conversation.members.find(id => !id.equals(req.user._id)), peer = byId.get(peerId?.toString())
    if (canDirectlyInteract(req.user, peer) || canDirectlyInteract(peer, req.user)) visibleConversations.push(conversation)
  }
  const byConversation = new Map(visibleConversations.map(c => { const peer = c.members.find(id => !id.equals(req.user._id)); const person = c.isGroup ? { _id: c._id, username: 'group', displayName: c.groupName || 'Group chat', bio: '', avatarUrl: c.groupImage || '', lastSeenAt: null } : byId.get(peer?.toString()); return [c._id.toString(), { id: c._id.toString(), isGroup: !!c.isGroup, groupName: c.groupName || '', groupImage: c.groupImage || '', members: c.members.map(id => id.toString()), user: { ...publicUser(person), lastSeenAt: person.lastSeenAt || null }, latestText: c.latestText || '', latestAt: c.latestAt }] }))
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
  const message = await Message.findOne({ conversation: req.params.id, mediaFilename: filename, hiddenFor: { $ne: req.user._id } }).select('_id')
  if (!message) return res.status(404).json({ error: 'Media not found.' })
  res.sendFile(path.join(chatUploadsDir, filename), err => { if (err && !res.headersSent) res.status(404).json({ error: 'Media not found.' }) })
}))
app.get('/api/conversations/:id/media', auth, handle(async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user._id)
  if (!conversation || !await directConversationAllowed(conversation, req.user._id)) return res.status(404).json({ error: 'Conversation not found.' })
  const rows = await Message.find({ conversation: req.params.id, hiddenFor: { $ne: req.user._id }, mediaFilename: { $ne: '' } }).sort({ createdAt: -1 }).limit(500).select('mediaFilename mediaOriginalName mediaType createdAt').lean()
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
  res.json({ hasMore, messages: messages.map(m => ({ id: m._id.toString(), conversationId: m.conversation.toString(), senderId: m.sender.toString(), senderName: m.senderName || senderNames.get(m.sender.toString()) || 'Member', ...(m.system ? { system: true } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), text: m.text, ...(m.mediaFilename ? { mediaUrl: `/api/conversations/${m.conversation}/media/${encodeURIComponent(m.mediaFilename)}`, mediaType: m.mediaType, fileName: m.mediaOriginalName || m.mediaFilename } : {}), ...(m.storyContext ? { storyContext: { ...m.storyContext, storyId: m.storyContext.storyId?.toString() || '' } } : {}), ...(m.partyInvite ? { partyInvite: m.partyInvite } : {}), ...(m.gameInvite ? { gameInvite: m.gameInvite } : {}), ...(m.callLog ? { callLog: m.callLog } : {}), deliveredAt: m.deliveredAt || null, readAt: m.readAt || null, createdAt: m.createdAt })) })
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
app.post('/api/conversations/:id/messages', auth, chatUpload.single('media'), handle(async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user._id)
  const text = String(req.body?.text || '').trim()
  if (!conversation) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Conversation not found.' }) }
  if (conversation.isGroup && !await directConversationAllowed(conversation, req.user._id, 'send')) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: 'This group chat is unavailable because of a block. Reconnect with the group member before continuing.' }) }
  if ((!text && !req.file) || text.length > 4000) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: text.length > 4000 ? 'Messages can be up to 4,000 characters.' : 'Write a message or attach a file.' }) }
  const chatMime = req.file ? chatMimeForFile(req.file) : ''
  const mediaType = !req.file ? undefined : chatMime.startsWith('video/') ? 'video' : chatMime.startsWith('image/') ? 'image' : 'file'
  const recipientIds = conversation.members.filter(id => !id.equals(req.user._id))
  if (!conversation.isGroup) {
    const target = await User.findById(recipientIds[0]).select('_id friends blockedUsers reconnectRequired messagePrivacy')
    if (!canDirectlyInteract(req.user, target)) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: req.user.blockedUsers.some(id => id.equals(recipientIds[0])) || target?.blockedUsers.some(id => id.equals(req.user._id)) ? 'Message could not be sent because one of you blocked the other.' : 'You need an accepted friend connection to message this person.' }) }
  }
  const mediaFilename = req.file ? path.basename(req.file.path) : ''
  const mediaOriginalName = req.file ? path.basename(req.file.originalname).replace(/[^A-Za-z0-9_.() -]/g, '_').slice(0, 160) : ''
  let replyTo
  if (req.body?.replyTo) {
    let requestedReplyId = String(req.body.replyTo)
    try { const parsed = JSON.parse(requestedReplyId); requestedReplyId = String(parsed?.messageId || '') } catch {}
    if (!mongoose.Types.ObjectId.isValid(requestedReplyId)) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'That reply is no longer available.' }) }
    const original = await Message.findOne({ _id: requestedReplyId, conversation: conversation._id, hiddenFor: { $ne: req.user._id } }).select('sender senderName text mediaType').lean()
    if (!original) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'That reply is no longer available.' }) }
    const originalSender = await User.findById(original.sender).select('displayName').lean()
    replyTo = { messageId: requestedReplyId, senderId: original.sender.toString(), senderName: original.senderName || originalSender?.displayName || 'Member', text: String(original.text || '').slice(0, 300), mediaType: original.mediaType || '' }
  }
  const notifyConversation = await shouldNotifyMessage(conversation._id)
  const message = await Message.create({ conversation: conversation._id, sender: req.user._id, senderName: req.user.displayName || '', ...(replyTo ? { replyTo } : {}), text, mediaFilename, mediaOriginalName, ...(mediaType ? { mediaType } : {}) })
  const latestText = text || (mediaType === 'video' ? 'Video' : mediaType === 'file' ? mediaOriginalName : 'Photo')
  conversation.latestText = latestText; conversation.latestAt = message.createdAt; await conversation.save()
  const payload = { id: message.id, conversationId: conversation.id, senderId: req.user.id, senderName: message.senderName || req.user.displayName || 'Member', ...(message.replyTo ? { replyTo: message.replyTo } : {}), text, deliveredAt: null, readAt: null, ...(mediaFilename ? { mediaUrl: `/api/conversations/${conversation.id}/media/${encodeURIComponent(mediaFilename)}`, mediaType, fileName: mediaOriginalName } : {}), createdAt: message.createdAt }
  await Conversation.updateOne({ _id: conversation._id }, { $pullAll: { archivedFor: [...recipientIds, req.user._id], hiddenFor: [...recipientIds, req.user._id] } })
  io.to(conversation.id).emit('message:new', payload)
  const recipients = await User.find({ _id: { $in: recipientIds } }).select('blockedUsers')
  for (const recipientId of recipientIds) {
    const recipient = recipients.find(user => user._id.equals(recipientId))
    if (recipient?.blockedUsers.some(id => id.equals(req.user._id))) continue
    io.to(recipientId.toString()).emit('message:new', payload)
    if (notifyConversation && !conversation.mutedFor.some(id => id.equals(recipientId))) await createActivity(recipientId, req.user._id, 'message')
  }
  res.status(201).json({ message: payload })
}))

io.use(async (socket, next) => {
  try { const token = socket.handshake.auth?.token; const claims = jwt.verify(token, JWT_SECRET); const user = await User.findById(claims.sub).select('sessionVersion'); if (!dbReady || !user || (claims.ver || 0) !== (user.sessionVersion || 0)) return next(new Error('Authentication required')); socket.userId = claims.sub; next() }
  catch { next(new Error('Authentication required')) }
})
const activeLives = new Map()
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
  const users = await User.find({ _id: { $in: userIds } }).select('_id blockedUsers').lean()
  const byId = new Map(users.map(user => [user._id.toString(), user]))
  for (const viewerId of onlineUserCounts.keys()) {
    if (viewerId !== String(subjectId) && !usersBlockEachOther(viewerId, subjectId, byId)) io.to(viewerId).emit('presence:update', { userId: String(subjectId), ...payload })
  }
}
const presenceSnapshot = async viewerId => {
  const onlineIds = [...onlineUserCounts.keys()]
  const users = await User.find({ _id: { $in: [String(viewerId), ...onlineIds] } }).select('_id blockedUsers').lean()
  const byId = new Map(users.map(user => [user._id.toString(), user]))
  return onlineIds.filter(subjectId => subjectId !== String(viewerId) && !usersBlockEachOther(viewerId, subjectId, byId))
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
const gameSessionPayload = session => ({ id: session.id, game: session.game, status: session.status, hostId: session.hostId, hostName: session.hostName, maxPlayers: session.maxPlayers, invitedIds: session.invitedIds, playerIds: session.playerIds, board: session.board, turn: session.turn, lastRoll: session.lastRoll ?? null, lastRollBy: session.lastRollBy ?? null, winner: session.winner || null })
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
    const invite = { sessionId: session.id, game: session.game, status: session.status, hostId: session.hostId, hostName: session.hostName, maxPlayers: session.maxPlayers, invitedIds: session.invitedIds, playerIds: session.playerIds }
    const message = await Message.findByIdAndUpdate(inviteRef.messageId, { $set: { gameInvite: invite } }, { new: true })
    if (!message) continue
    const payload = { id: message.id, conversationId: inviteRef.conversationId, senderId: message.sender.toString(), text: message.text, gameInvite: invite, deliveredAt: message.deliveredAt || null, readAt: message.readAt || null, createdAt: message.createdAt }
    io.to(inviteRef.conversationId).emit('game:invite:update', payload)
    io.to(inviteRef.userId).emit('game:invite:update', payload)
  }
}

io.on('connection', async socket => {
  socket.join(socket.userId)
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
    const host = await User.findById(socket.userId).select('username displayName bio avatarUrl location website pronouns friends followers')
    if (!host) return
    const existing = [...activeLives.values()].find(live => live.hostId === socket.userId)
    if (existing) return socket.emit('live:started', { id: existing.id, host: existing.host, startedAt: existing.startedAt })
    const audienceIds = new Set([...host.friends, ...host.followers].map(id => id.toString()))
    const live = { id: randomUUID(), hostId: socket.userId, host: publicUser(host), startedAt: new Date().toISOString(), audienceIds, viewers: new Set(), joinRequests: new Map(), cohostId: null }
    activeLives.set(live.id, live)
    const payload = { id: live.id, host: live.host, startedAt: live.startedAt }
    socket.emit('live:started', payload)
    for (const audienceId of live.audienceIds) io.to(audienceId).emit('live:available', payload)
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
    const requester = await User.findById(socket.userId).select('username displayName bio avatarUrl location website pronouns')
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
      const session = { id: randomUUID(), url: url.trim(), hostId: socket.userId, hostName: host.displayName, invitedIds: invited, participantIds: [socket.userId], controllerIds: [socket.userId], members, status: 'open', currentTime: 0, playing: false, playbackUpdatedAt: Date.now(), messages: [], invites: [], voicePlayers: new Set() }
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
    if (!session.participantIds.includes(socket.userId)) session.participantIds.push(socket.userId)
    socket.join(`party:${session.id}`)
    io.to(`party:${session.id}`).emit('party:session', partySessionPayload(session))
    void updatePartyInviteMessages(session)
  })
  socket.on('party:leave', ({ sessionId } = {}) => {
    const session = activePartySessions.get(String(sessionId))
    if (!session || !session.participantIds.includes(socket.userId)) return
    session.participantIds = session.participantIds.filter(id => id !== socket.userId)
    session.controllerIds = [...new Set([session.hostId, ...session.controllerIds.filter(id => id !== socket.userId)])]
    if (session.voicePlayers.delete(socket.userId)) io.to(`partyvoice:${session.id}`).emit('party:voice:peer-left', { sessionId: session.id, userId: socket.userId })
    socket.leave(`party:${session.id}`); socket.leave(`partyvoice:${session.id}`)
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
  socket.on('game:invite', async ({ game, userIds } = {}) => {
    try {
      const limits = { 'tic-tac-toe': 2, chess: 2, ludo: 4 }
      const maxPlayers = limits[game]
      if (!dbReady || !maxPlayers || !Array.isArray(userIds)) return socket.emit('game:error', { message: 'Choose a supported game and friends to invite.' })
      const host = await User.findById(socket.userId).select('username displayName friends')
      const invited = [...new Set(userIds.map(String))].filter(id => id !== socket.userId).slice(0, maxPlayers - 1)
      if (!host || !invited.length || invited.some(id => !host.friends.some(friendId => friendId.toString() === id))) return socket.emit('game:error', { message: 'You can invite accepted friends only.' })
      const sessionId = randomUUID()
      const session = { id: sessionId, game, hostId: socket.userId, hostName: host.displayName, maxPlayers, invitedIds: invited, playerIds: [socket.userId], status: 'open', board: game === 'tic-tac-toe' ? Array(9).fill(null) : game === 'chess' ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR' : Array.from({length:4},()=>Array(4).fill(0)), turn: 0, createdAt: new Date().toISOString(), invites: [], chatMessages: [], voicePlayers: new Set() }
      activeGameSessions.set(sessionId, session)
      for (const targetId of invited) {
        const members = [socket.userId, targetId].sort()
        const directKey = members.join(':')
        const conversation = await Conversation.findOneAndUpdate({ directKey }, { $setOnInsert: { members, directKey }, $pull: { archivedFor: targetId, hiddenFor: targetId } }, { upsert: true, new: true, setDefaultsOnInsert: true })
        const invite = { sessionId, game, status: 'open', hostId: socket.userId, hostName: host.displayName, maxPlayers, invitedIds: invited, playerIds: session.playerIds }
        const message = await Message.create({ conversation: conversation._id, sender: host._id, text: `Invited you to play ${game === 'tic-tac-toe' ? 'Tic Tac Toe' : game === 'chess' ? 'Chess' : 'Ludo'}.`, gameInvite: invite })
        conversation.latestText = message.text; conversation.latestAt = message.createdAt; await conversation.save()
        const payload = { id: message.id, conversationId: conversation.id, senderId: socket.userId, text: message.text, gameInvite: invite, deliveredAt: null, readAt: null, createdAt: message.createdAt }
        session.invites.push({ userId: targetId, conversationId: conversation.id, messageId: message.id })
        io.to(conversation.id).emit('message:new', payload)
        io.to(targetId).emit('message:new', payload)
      }
      socket.emit('game:session', gameSessionPayload(session))
    } catch (error) { console.error('Game invite failed:', error); socket.emit('game:error', { message: 'Could not send the game invite.' }) }
  })
  socket.on('game:invite:accept', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'open') return socket.emit('game:error', { message: 'This game is already closed to new players.' })
    if (!session.invitedIds.includes(socket.userId)) return socket.emit('game:error', { message: 'This invite was not sent to you.' })
    if (!await canUseFriendFeaturesIds(session.hostId, socket.userId)) return socket.emit('game:error', { message: 'Reconnect as friends before joining this game.' })
    if (session.playerIds.includes(socket.userId)) return socket.emit('game:session', gameSessionPayload(session))
    if (session.playerIds.length >= session.maxPlayers) return socket.emit('game:error', { message: 'This game already has all its players.' })
    session.playerIds.push(socket.userId)
    const arrivingPlayer = await User.findById(socket.userId).select('displayName')
    io.to(session.hostId).emit('game:player:arrived', { sessionId: session.id, userId: socket.userId, displayName: arrivingPlayer?.displayName || 'A friend', playerCount: session.playerIds.length })
    socket.join(`game:${session.id}`)
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
    if (!session || session.hostId !== socket.userId || session.status !== 'open' || session.playerIds.length < 2) return socket.emit('game:error', { message: 'Wait for at least one friend to accept before starting.' })
    if (!(await Promise.all(session.playerIds.filter(id => id !== session.hostId).map(id => canUseFriendFeaturesIds(session.hostId, id)))).every(Boolean)) return socket.emit('game:error', { message: 'Reconnect as friends before starting this game.' })
    session.status = 'started'; session.startedAt = new Date().toISOString()
    for (const playerId of session.playerIds) io.to(playerId).socketsJoin(`game:${session.id}`)
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
    await updateGameInviteMessages(session)
  })
  socket.on('game:join', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || !session.playerIds.includes(socket.userId)) return socket.emit('game:error', { message: 'You are not a player in this game.' })
    if (!await canUseFriendFeaturesIds(session.hostId, socket.userId)) return socket.emit('game:error', { message: 'Reconnect as friends before returning to this game.' })
    socket.join(`game:${session.id}`); socket.emit('game:session', gameSessionPayload(session)); socket.emit('game:chat:history', session.chatMessages)
  })
  socket.on('game:action', async ({ sessionId, action } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'started' || !session.playerIds.includes(socket.userId) || !action || typeof action !== 'object') return
    if (!await canUseFriendFeaturesIds(session.hostId, socket.userId)) return socket.emit('game:error', { message: 'Reconnect as friends before continuing this game.' })
    if (session.game === 'tic-tac-toe' && action.type === 'place' && session.playerIds[session.turn] === socket.userId && Number.isInteger(action.index) && action.index >= 0 && action.index < 9 && session.board[action.index] === null) {
      const mark = session.playerIds.indexOf(socket.userId) === 0 ? 'X' : 'O'; session.board[action.index] = mark; const wins=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].some(line=>line.every(index=>session.board[index]===mark)); if(wins||session.board.every(Boolean)){session.status='ended';session.winner=wins?socket.userId:null;void updateGameInviteMessages(session)}else session.turn=1-session.turn
    } else if (session.game === 'chess' && action.type === 'move' && session.playerIds[session.turn] === socket.userId && Number.isInteger(action.from) && Number.isInteger(action.to) && action.from >= 0 && action.from < 64 && action.to >= 0 && action.to < 64 && action.from !== action.to) {
      const cells = session.board.split('/').flatMap(rank => [...rank].flatMap(char => /^[1-8]$/.test(char) ? Array(Number(char)).fill('') : char)); const fromRow=Math.floor(action.from/8),fromCol=action.from%8,toRow=Math.floor(action.to/8),toCol=action.to%8,dr=toRow-fromRow,dc=toCol-fromCol,piece=cells[action.from],target=cells[action.to],side=session.playerIds.indexOf(socket.userId);
      const own=char=>char&&(side===0?char===char.toUpperCase():char===char.toLowerCase()); const absR=Math.abs(dr),absC=Math.abs(dc); let legal=false;
      if(cells.length===64&&piece&&own(piece)&&!own(target)){const kind=piece.toLowerCase();if(kind==='p'){const dir=side===0?-1:1,start=side===0?6:1;legal=dc===0&&!target&&(dr===dir||(fromRow===start&&dr===2*dir&&!cells[(fromRow+dir)*8+fromCol]))||absC===1&&dr===dir&&!!target;if(legal&&(toRow===0||toRow===7))cells[action.from]=side===0?'Q':'q'}else if(kind==='n')legal=(absR===2&&absC===1)||(absR===1&&absC===2);else if(kind==='k')legal=absR<=1&&absC<=1;else{const straight=dr===0||dc===0,diagonal=absR===absC;legal=kind==='q'?(straight||diagonal):kind==='r'?straight:kind==='b'?diagonal:false;if(legal){const sr=Math.sign(dr),sc=Math.sign(dc);for(let r=fromRow+sr,c=fromCol+sc;r!==toRow||c!==toCol;r+=sr,c+=sc)if(cells[r*8+c]){legal=false;break}}}}
      if(legal){cells[action.to]=cells[action.from];cells[action.from]='';session.board=Array.from({length:8},(_,rank)=>{const row=cells.slice(rank*8,rank*8+8);let out='',empty=0;for(const cell of row){if(!cell)empty++;else{if(empty)out+=empty;empty=0;out+=cell}}if(empty)out+=empty;return out}).join('/');session.turn=1-session.turn}
    } else if (session.game === 'ludo' && action.type === 'roll' && !session.lastRoll && socket.userId === session.playerIds[session.turn % session.playerIds.length]) {
      session.lastRoll = 1 + Math.floor(Math.random() * 6); session.lastRollBy = socket.userId; const p=session.board[session.turn]; if(session.lastRoll!==6&&!p.some(progress=>progress>0&&progress<57)){session.lastRoll=null;session.lastRollBy=null;session.turn=(session.turn+1)%session.playerIds.length}
    } else if (session.game === 'ludo' && action.type === 'move' && socket.userId === session.lastRollBy && Number.isInteger(action.piece) && action.piece >= 0 && action.piece < 4 && session.lastRoll) {
      const playerIndex=session.playerIds.indexOf(socket.userId);const progress=session.board[playerIndex][action.piece];if(progress===0&&session.lastRoll!==6)return;const nextProgress=progress===0?1:progress+session.lastRoll;if(nextProgress>57)return;session.board[playerIndex][action.piece]=nextProgress;let captured=false;if(nextProgress>0&&nextProgress<=51){const safe=[0,8,13,21,26,34,39,47];const trackPosition=([0,13,26,39][playerIndex]+nextProgress-1)%52;if(!safe.includes(trackPosition)){for(let opponent=0;opponent<session.playerIds.length;opponent++){if(opponent===playerIndex)continue;for(let enemy=0;enemy<4;enemy++){const enemyProgress=session.board[opponent][enemy];if(enemyProgress>0&&enemyProgress<=51&&([0,13,26,39][opponent]+enemyProgress-1)%52===trackPosition){session.board[opponent][enemy]=0;captured=true}}}}}const extraTurn=session.lastRoll===6||captured;if(session.board[playerIndex].every(value=>value===57)){session.status='ended';session.winner=socket.userId;void updateGameInviteMessages(session)}session.lastRoll=null;session.lastRollBy=null;if(session.status!=='ended'&&!extraTurn)session.turn=(session.turn+1)%session.playerIds.length
    } else return
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
  })
  socket.on('game:resign', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'started' || !session.playerIds.includes(socket.userId)) return
    if (!await canUseFriendFeaturesIds(session.hostId, socket.userId)) return
    session.status = 'ended'; session.resignedBy = socket.userId; session.winner = session.playerIds.find(id => id !== socket.userId) || null
    io.to(`game:${session.id}`).emit('game:session', gameSessionPayload(session))
    await updateGameInviteMessages(session)
  })
  socket.on('game:leave', ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || !session.playerIds.includes(socket.userId)) return
    socket.leave(`game:${session.id}`)
    socket.leave(`gamevoice:${session.id}`)
    if (session.voicePlayers.delete(socket.userId)) socket.to(`gamevoice:${session.id}`).emit('game:voice:peer-left', { sessionId: session.id, userId: socket.userId })
  })
  socket.on('game:chat:send', async ({ sessionId, text } = {}) => {
    const session = activeGameSessions.get(String(sessionId)); const cleanText = String(text || '').trim().slice(0, 500)
    if (!session || session.status !== 'started' || !session.playerIds.includes(socket.userId) || !cleanText) return
    if (!await canUseFriendFeaturesIds(session.hostId, socket.userId)) return
    void User.findById(socket.userId).select('displayName username').then(user => {
      if (!user || session.status !== 'started') return
      const line = { id: randomUUID(), sessionId: session.id, userId: socket.userId, displayName: user.displayName, username: user.username, text: cleanText, createdAt: new Date().toISOString() }
      session.chatMessages.push(line); if (session.chatMessages.length > 100) session.chatMessages.shift()
      io.to(`game:${session.id}`).emit('game:chat:message', line)
    }).catch(error => console.error('Game chat failed:', error.message))
  })
  socket.on('game:voice:join', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'started' || !session.playerIds.includes(socket.userId)) return socket.emit('game:error', { message: 'Voice chat is only available to players in an active game.' })
    if (!await canUseFriendFeaturesIds(session.hostId, socket.userId)) return socket.emit('game:error', { message: 'Reconnect as friends before joining game voice chat.' })
    const room = `gamevoice:${session.id}`
    socket.join(room); session.voicePlayers.add(socket.userId)
    const peers = [...new Set((await io.in(room).fetchSockets()).map(peer => peer.userId))].filter(id => id !== socket.userId)
    socket.emit('game:voice:peers', peers)
    socket.to(room).emit('game:voice:peer-joined', { userId: socket.userId })
  })
  socket.on('game:voice:leave', ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session) return
    const room = `gamevoice:${session.id}`
    socket.leave(room)
    if (session.voicePlayers.delete(socket.userId)) socket.to(room).emit('game:voice:peer-left', { sessionId: session.id, userId: socket.userId })
  })
  socket.on('game:voice:signal', async ({ sessionId, to, kind, data } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.status !== 'started' || !session.voicePlayers.has(socket.userId) || !session.playerIds.includes(String(to)) || !session.voicePlayers.has(String(to)) || !['offer','answer','ice'].includes(kind)) return
    if (!await canInteractWithoutBlockIds(socket.userId, String(to))) return
    io.to(String(to)).emit('game:voice:signal', { sessionId: session.id, from: socket.userId, kind, data })
  })
  socket.on('game:end', async ({ sessionId } = {}) => {
    const session = activeGameSessions.get(String(sessionId))
    if (!session || session.hostId !== socket.userId || session.status === 'ended') return
    session.status = 'ended'; session.endedAt = new Date().toISOString()
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
    for (const game of activeGameSessions.values()) { if (game.voicePlayers.delete(socket.userId)) socket.to(`gamevoice:${game.id}`).emit('game:voice:peer-left', { sessionId: game.id, userId: socket.userId }) }
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
if (process.env.NODE_ENV === 'production') { const dist = path.resolve(__dirname, '../dist'); app.use(express.static(dist)); app.get('/{*path}', (req,res) => res.sendFile(path.join(dist,'index.html'))) }
server.listen(PORT, () => console.log(`Social Land API listening on http://localhost:${PORT}`))
if (process.env.MONGODB_URI) mongoose.connect(process.env.MONGODB_URI).then(async () => { try { for (const index of await Story.collection.indexes()) { if (index.expireAfterSeconds !== undefined && index.key?.expiresAt) await Story.collection.dropIndex(index.name) }; await Story.collection.createIndex({ expiresAt: 1 }); await secureActiveStoryMedia() } catch (err) { console.error('Story setup failed:', err.message) }; await Promise.all([Message.updateMany({ partyInvite: { $exists: true }, $or: [{ 'partyInvite.sessionId': { $exists: false } }, { 'partyInvite.sessionId': null }, { 'partyInvite.sessionId': '' }] }, { $unset: { partyInvite: 1 } }), Message.updateMany({ gameInvite: { $exists: true }, $or: [{ 'gameInvite.sessionId': { $exists: false } }, { 'gameInvite.sessionId': null }, { 'gameInvite.sessionId': '' }] }, { $unset: { gameInvite: 1 } })]); dbReady = true; console.log('MongoDB connected'); void cleanExpiredStories().catch(err => console.error('Story cleanup failed:', err.message)); const cleanupTimer = setInterval(() => void cleanExpiredStories().catch(err => console.error('Story cleanup failed:', err.message)), 60 * 1000); cleanupTimer.unref() }).catch(err => console.error('MongoDB connection failed:', err.message))
else console.warn('MongoDB is not configured. Copy .env.example to .env and add MONGODB_URI to enable accounts.')
