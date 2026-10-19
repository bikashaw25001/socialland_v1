import 'dotenv/config'
import express from 'express'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
const chatUpload = multer({ storage: multer.diskStorage({ destination: chatUploadsDir, filename: (_req, file, cb) => cb(null, `${randomUUID()}.${allowedChatFiles.get(file.mimetype) || 'bin'}`) }), limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(allowedChatFiles.has(file.mimetype) ? null : new Error('Upload a supported chat file (JPG, PNG, WebP, MP4, WebM, PDF, Office, TXT, CSV, or ZIP).'), allowedChatFiles.has(file.mimetype)) })
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 35, standardHeaders: 'draft-8', legacyHeaders: false }))
const passwordResetLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false })

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true, minlength: 3, maxlength: 24 },
  displayName: { type: String, required: true, trim: true, maxlength: 50 },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  bio: { type: String, default: '', maxlength: 160 },
  avatarUrl: { type: String, default: '', maxlength: 700000 },
  bannerUrl: { type: String, default: '', maxlength: 1800000 },
  lastSeenAt: { type: Date, default: null },
  location: { type: String, default: '', maxlength: 80 },
  website: { type: String, default: '', maxlength: 200 },
  pronouns: { type: String, default: '', maxlength: 40 },
  privateProfile: { type: Boolean, default: false },
  storyAudiencePrivacy: { type: String, enum: ['everyone','friends','selected'], default: 'everyone' },
  storyAudienceFriendIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  passwordResetTokenHash: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  sessionVersion: { type: Number, default: 0 },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followRequestsIncoming: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followRequestsOutgoing: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  incoming: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  outgoing: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true })
const User = mongoose.model('User', userSchema)
const messageSchema = new mongoose.Schema({ conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true }, sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, text: { type: String, default: '', maxlength: 4000, trim: true }, deliveredAt: { type: Date, default: null }, readAt: { type: Date, default: null }, hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], mediaFilename: { type: String, default: '' }, mediaOriginalName: { type: String, default: '' }, mediaType: { type: String, enum: ['image','video','file'] }, storyContext: { storyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Story' }, authorName: String, mediaType: { type: String, enum: ['image','video'] }, caption: String, action: { type: String, enum: ['reply','like'] } } }, { timestamps: true })
messageSchema.index({ conversation: 1, _id: -1 })
const Message = mongoose.model('Message', messageSchema)
const conversationSchema = new mongoose.Schema({ members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }], archivedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], directKey: { type: String, unique: true }, latestText: { type: String, default: '' }, latestAt: { type: Date, default: Date.now } }, { timestamps: true })
const Conversation = mongoose.model('Conversation', conversationSchema)
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

const publicUser = user => ({ id: user._id.toString(), username: user.username, displayName: user.displayName, bio: user.bio || '', avatarUrl: user.avatarUrl || '', location: user.location || '', website: user.website || '', pronouns: user.pronouns || '' })
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
  if (await User.exists({ $or: [{ username: normalized }, { email: String(email).trim().toLowerCase() }] })) return res.status(409).json({ error: 'That username or email is already registered.' })
  const user = await User.create({ username: normalized, displayName: String(displayName).trim(), email: String(email).trim().toLowerCase(), passwordHash: await bcrypt.hash(password, 12) })
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
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter the email address you used to create your account.' })
  const user = await User.findOne({ email })
  if (!user) return res.json({ ok: true, development: !mailTransport && process.env.NODE_ENV !== 'production' })
  const appUrl = process.env.PUBLIC_APP_URL || (process.env.NODE_ENV !== 'production' ? developmentAppOrigin(req) : process.env.CLIENT_ORIGIN)
  let resetUrl
  try { resetUrl = new URL('/', appUrl); resetUrl.searchParams.set('resetToken', randomBytes(32).toString('hex')) }
  catch { return res.status(503).json({ error: 'Password reset email is not configured yet. Please contact support.' }) }
  const rawToken = resetUrl.searchParams.get('resetToken')
  user.passwordResetTokenHash = hashResetToken(rawToken)
  user.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000)
  await user.save()
  if (mailTransport) {
    await mailTransport.sendMail({
      from: process.env.EMAIL_FROM || `Social Land <${process.env.GMAIL_USER}>`,
      to: user.email,
      subject: 'Reset your Social Land password',
      text: `We received a request to reset your Social Land password. Open this link within 30 minutes:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>We received a request to reset your Social Land password.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>`,
    })
  } else if (process.env.NODE_ENV !== 'production') {
    console.log(`Social Land development password reset link for ${user.email}: ${resetUrl}`)
  } else {
    user.passwordResetTokenHash = undefined
    user.passwordResetExpires = undefined
    await user.save()
    return res.status(503).json({ error: 'Password reset email is not configured yet. Please contact support.' })
  }
  res.json({ ok: true, development: !mailTransport && process.env.NODE_ENV !== 'production' })
}))
app.post('/api/auth/reset-password', passwordResetLimit, dbOnly, handle(async (req, res) => {
  const token = String(req.body?.token || '')
  const password = req.body?.password
  if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ error: 'This password reset link is invalid or has expired.' })
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8–72 characters.' })
  const passwordHash = await bcrypt.hash(password, 12)
  const user = await User.findOneAndUpdate(
    { passwordResetTokenHash: hashResetToken(token), passwordResetExpires: { $gt: new Date() } },
    { $set: { passwordHash }, $inc: { sessionVersion: 1 }, $unset: { passwordResetTokenHash: 1, passwordResetExpires: 1 } },
    { new: true },
  )
  if (!user) return res.status(400).json({ error: 'This password reset link is invalid or has expired. Request a new one.' })
  io.in(user._id.toString()).disconnectSockets(true)
  res.json({ ok: true })
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
app.get('/api/me', auth, (req, res) => res.json({ user: publicProfileUser(req.user), storyAudience: { privacy: req.user.storyAudiencePrivacy || 'everyone', selectedFriendIds: (req.user.storyAudienceFriendIds || []).map(id => id.toString()) } }))
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
  if (!author || !isFriend(req.user, author._id)) return res.status(403).json({ error: 'You can reply to a story after becoming friends.' })
  const members = [req.user._id, author._id].sort((a, b) => a.toString().localeCompare(b.toString()))
  const directKey = members.map(user => user.toString()).join(':')
  const conversation = await Conversation.findOneAndUpdate({ directKey }, { $setOnInsert: { members, directKey }, $pull: { archivedFor: req.user._id, hiddenFor: req.user._id } }, { upsert: true, new: true, setDefaultsOnInsert: true })
  const storyContext = { storyId: story._id, authorName: author.displayName, mediaType: story.mediaType, caption: story.caption || '', action: 'reply' }
  const message = await Message.create({ conversation: conversation._id, sender: req.user._id, text, storyContext })
  await Conversation.updateOne({ _id: conversation._id }, { $pullAll: { archivedFor: [author._id, req.user._id], hiddenFor: [author._id, req.user._id] } })
  conversation.latestText = `Story reply: ${text}`; conversation.latestAt = message.createdAt; await conversation.save()
  const payload = { id: message.id, conversationId: conversation.id, senderId: req.user.id, text, deliveredAt: null, readAt: null, storyContext: { ...storyContext, storyId: story._id.toString() }, createdAt: message.createdAt }
  io.to(conversation.id).emit('message:new', payload)
  io.to(author.id).emit('message:new', payload)
  await createActivity(author._id, req.user._id, 'message')
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
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–24 characters using letters, numbers, or underscores.' })
  if (!displayName || displayName.length > 50 || bio.length > 160 || location.length > 80 || website.length > 200 || pronouns.length > 40) return res.status(400).json({ error: 'One or more profile details are too long.' })
  if (username !== req.user.username && await User.exists({ username, _id: { $ne: req.user._id } })) return res.status(409).json({ error: 'That username is already taken.' })
  if (avatarUrl && (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(avatarUrl) || avatarUrl.length > 700000)) return res.status(400).json({ error: 'Choose a smaller JPG, PNG, or WebP profile photo.' })
  if (bannerUrl && (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(bannerUrl) || bannerUrl.length > 1800000)) return res.status(400).json({ error: 'Choose a smaller JPG, PNG, or WebP banner image.' })
  if (website) { try { const parsed = new URL(website); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error() } catch { return res.status(400).json({ error: 'Enter a valid website address, including https://.' }) } }
  Object.assign(req.user, { username, displayName, bio, avatarUrl, bannerUrl, location, website, pronouns })
  if (typeof req.body?.privateProfile === 'boolean') req.user.privateProfile = req.body.privateProfile
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
for (const list of ['followers','following']) app.get(`/api/users/:username/${list}`, auth, handle(async (req, res) => {
  const target = await User.findOne({ username: String(req.params.username || '').toLowerCase() }).select('followers following privateProfile friends')
  if (!target) return res.status(404).json({ error: 'That profile could not be found.' })
  const isFollower = (target.followers || []).some(id => id.equals(req.user._id))
  if (target.privateProfile && !isFollower && !isFriend(req.user, target._id) && !target._id.equals(req.user._id)) return res.status(403).json({ error: 'Follow this private profile to view its connections.' })
  const users = await User.find({ _id: { $in: target[list] || [] } }).select('username displayName bio avatarUrl location website pronouns').sort({ username: 1 })
  res.json({ users: users.map(publicUser) })
}))
app.get('/api/users/:username/profile', auth, handle(async (req, res) => {
  const username = String(req.params.username || '').toLowerCase()
  const user = await User.findOne({ username }).select('username displayName bio avatarUrl bannerUrl location website pronouns privateProfile followers following friends incoming outgoing followRequestsIncoming')
  if (!user) return res.status(404).json({ error: 'That profile could not be found.' })
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
  res.json({ user: { ...publicProfileUser(user), relationship, followerCount: user.followers.length, followingCount: user.following.length, postCount, reelCount, noteCount: legacyNoteCount + notePostCount, isFollowing, isFollowRequested, pendingFollowRequestCount: user._id.equals(req.user._id) ? (user.followRequestsIncoming || []).length : undefined, canViewContent }, posts: posts.map(post => publicPost(post, req.user._id)), reels: reels.map(post => publicPost(post, req.user._id)), notes })
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
  const select = 'username displayName bio avatarUrl location website pronouns friends incoming outgoing followers followRequestsIncoming privateProfile'
  const relationshipFor = u => isFriend(req.user, u._id) ? 'friend' : req.user.outgoing.some(x => x.equals(u._id)) ? 'sent' : req.user.incoming.some(x => x.equals(u._id)) ? 'received' : 'none'
  const followStateFor = u => ({ isFollowing: (u.followers || []).some(id => id.equals(req.user._id)), isFollowRequested: (u.followRequestsIncoming || []).some(id => id.equals(req.user._id)), privateProfile: !!u.privateProfile })
  if (q.length >= 2) {
    const users = await User.find({ _id: { $ne: req.user._id }, $or: [{ username: new RegExp(q, 'i') }, { displayName: new RegExp(q, 'i') }] }).select(select).limit(20)
    return res.json({ users: users.map(u => ({ ...publicUser(u), ...followStateFor(u), relationship: relationshipFor(u) })) })
  }
  const excluded = new Set([req.user._id.toString(), ...req.user.friends, ...req.user.incoming, ...req.user.outgoing].map(id => id.toString()))
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
  if (isFriend(req.user, target._id)) return res.status(409).json({ error: 'You are already friends.' })
  if (req.user.incoming.some(x => x.equals(target._id))) return res.status(409).json({ error: 'They already sent you a request. Accept it in Friends.' })
  if (!req.user.outgoing.some(x => x.equals(target._id))) { req.user.outgoing.push(target._id); target.incoming.push(req.user._id); await Promise.all([req.user.save(), target.save()]); io.to(target.id).emit('friend:request', publicUser(req.user)); await createActivity(target._id, req.user._id, 'friend_request') }
  res.json({ ok: true })
}))
app.post('/api/friends/:id/accept', auth, handle(async (req, res) => {
  const target = await User.findById(req.params.id)
  if (!target || !req.user.incoming.some(x => x.equals(target._id))) return res.status(404).json({ error: 'No pending request from that person.' })
  req.user.incoming.pull(target._id); target.outgoing.pull(req.user._id); req.user.friends.addToSet(target._id); target.friends.addToSet(req.user._id)
  await Promise.all([req.user.save(), target.save()]); io.to(target.id).emit('friend:accepted', publicUser(req.user)); await createActivity(target._id, req.user._id, 'friend_accepted'); res.json({ ok: true })
}))
app.post('/api/conversations', auth, handle(async (req, res) => {
  const target = await User.findById(req.body?.userId)
  if (!target || !isFriend(req.user, target._id)) return res.status(403).json({ error: 'You can start a chat after becoming friends.' })
  const members = [req.user._id, target._id].sort((a,b) => a.toString().localeCompare(b.toString()))
  const directKey = members.map(x => x.toString()).join(':')
  const conversation = await Conversation.findOneAndUpdate({ directKey }, { $setOnInsert: { members, directKey }, $pull: { archivedFor: req.user._id, hiddenFor: req.user._id } }, { upsert: true, new: true, setDefaultsOnInsert: true })
  res.json({ conversation: { id: conversation.id, user: { ...publicUser(target), lastSeenAt: target.lastSeenAt || null }, latestText: conversation.latestText, latestAt: conversation.latestAt } })
}))
app.get('/api/conversations', auth, handle(async (req, res) => {
  const rows = await Conversation.find({ members: req.user._id, hiddenFor: { $ne: req.user._id }, archivedFor: { $ne: req.user._id } }).sort({ latestAt: -1 }).lean()
  const users = await User.find({ _id: { $in: rows.flatMap(c => c.members).filter(id => !id.equals(req.user._id)) } }).select('username displayName bio avatarUrl lastSeenAt location website pronouns').lean()
  const byId = new Map(users.map(u => [u._id.toString(), u]))
  const previews = await Promise.all(rows.map(async c => {
    const [latest, unreadCount] = await Promise.all([
      Message.findOne({ conversation: c._id, hiddenFor: { $ne: req.user._id } }).sort({ createdAt: -1, _id: -1 }).lean(),
      Message.countDocuments({ conversation: c._id, sender: { $ne: req.user._id }, readAt: null, hiddenFor: { $ne: req.user._id } })
    ])
    return [c._id.toString(), latest ? (latest.text || (latest.mediaType === 'video' ? 'Video' : latest.mediaType === 'file' ? latest.mediaOriginalName : 'Photo')) : '', latest?.createdAt || c.latestAt, unreadCount]
  }))
  const previewById = new Map(previews.map(([id, text, at, unreadCount]) => [id, { text, at, unreadCount }]))
  res.json({ conversations: rows.map(c => { const other = c.members.find(id => !id.equals(req.user._id)); const user = byId.get(other.toString()); const preview = previewById.get(c._id.toString()); return { id: c._id.toString(), user: { ...publicUser(user), lastSeenAt: user.lastSeenAt || null }, latestText: preview?.text || '', latestAt: preview?.at || c.latestAt, unreadCount: preview?.unreadCount || 0 } }) })
}))
const memberConversation = async (id, userId) => Conversation.findOne({ _id: id, members: userId })
app.delete('/api/conversations/:id', auth, handle(async (req, res) => {
  const action = req.body?.action
  if (!['archive', 'delete'].includes(action)) return res.status(400).json({ error: 'Choose archive or delete.' })
  const conversation = await memberConversation(req.params.id, req.user._id)
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' })
  if (action === 'archive') {
    await Conversation.updateOne({ _id: conversation._id }, { $addToSet: { archivedFor: req.user._id }, $pull: { hiddenFor: req.user._id } })
  } else {
    await Conversation.updateOne({ _id: conversation._id }, { $addToSet: { hiddenFor: req.user._id }, $pull: { archivedFor: req.user._id } })
    await Message.updateMany({ conversation: conversation._id }, { $addToSet: { hiddenFor: req.user._id } })
  }
  res.json({ ok: true })
}))
app.get('/api/conversations/:id/media/:filename', auth, handle(async (req, res) => {
  const filename = path.basename(req.params.filename)
  if (filename !== req.params.filename || !await memberConversation(req.params.id, req.user._id)) return res.status(404).json({ error: 'Media not found.' })
  const message = await Message.findOne({ conversation: req.params.id, mediaFilename: filename, hiddenFor: { $ne: req.user._id } }).select('_id')
  if (!message) return res.status(404).json({ error: 'Media not found.' })
  res.sendFile(path.join(chatUploadsDir, filename), err => { if (err && !res.headersSent) res.status(404).json({ error: 'Media not found.' }) })
}))
app.get('/api/conversations/:id/messages', auth, handle(async (req, res) => {
  if (!await memberConversation(req.params.id, req.user._id)) return res.status(404).json({ error: 'Conversation not found.' })
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 50))
  const before = req.query.before
  if (before && !mongoose.Types.ObjectId.isValid(before)) return res.status(400).json({ error: 'Invalid message cursor.' })
  const filter = { conversation: req.params.id, hiddenFor: { $ne: req.user._id }, ...(before ? { _id: { $lt: before } } : {}) }
  const rows = await Message.find(filter).sort({ _id: -1 }).limit(limit + 1).lean()
  const hasMore = rows.length > limit
  const messages = rows.slice(0, limit).reverse()
  res.json({ hasMore, messages: messages.map(m => ({ id: m._id.toString(), conversationId: m.conversation.toString(), senderId: m.sender.toString(), text: m.text, ...(m.mediaFilename ? { mediaUrl: `/api/conversations/${m.conversation}/media/${encodeURIComponent(m.mediaFilename)}`, mediaType: m.mediaType, fileName: m.mediaOriginalName || m.mediaFilename } : {}), ...(m.storyContext ? { storyContext: { ...m.storyContext, storyId: m.storyContext.storyId?.toString() || '' } } : {}), deliveredAt: m.deliveredAt || null, readAt: m.readAt || null, createdAt: m.createdAt })) })
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
  conversation.latestText = latest ? (latest.text || (latest.mediaType === 'video' ? 'Video' : latest.mediaType === 'file' ? latest.mediaOriginalName : 'Photo')) : ''
  conversation.latestAt = latest?.createdAt || new Date()
  await conversation.save()
  io.to(conversation.id).emit('message:deleted', { conversationId: conversation.id, id: message.id })
  res.json({ ok: true })
}))
app.post('/api/conversations/:id/messages', auth, chatUpload.single('media'), handle(async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user._id)
  const text = String(req.body?.text || '').trim()
  if (!conversation) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Conversation not found.' }) }
  if ((!text && !req.file) || text.length > 4000) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: text.length > 4000 ? 'Messages can be up to 4,000 characters.' : 'Write a message or attach a file.' }) }
  const mediaType = !req.file ? undefined : req.file.mimetype.startsWith('video/') ? 'video' : req.file.mimetype.startsWith('image/') ? 'image' : 'file'
  const mediaFilename = req.file ? path.basename(req.file.path) : ''
  const mediaOriginalName = req.file ? path.basename(req.file.originalname).replace(/[^A-Za-z0-9_.() -]/g, '_').slice(0, 160) : ''
  const message = await Message.create({ conversation: conversation._id, sender: req.user._id, text, mediaFilename, mediaOriginalName, ...(mediaType ? { mediaType } : {}) })
  const latestText = text || (mediaType === 'video' ? 'Video' : mediaType === 'file' ? mediaOriginalName : 'Photo')
  conversation.latestText = latestText; conversation.latestAt = message.createdAt; await conversation.save()
  const payload = { id: message.id, conversationId: conversation.id, senderId: req.user.id, text, deliveredAt: null, readAt: null, ...(mediaFilename ? { mediaUrl: `/api/conversations/${conversation.id}/media/${encodeURIComponent(mediaFilename)}`, mediaType, fileName: mediaOriginalName } : {}), createdAt: message.createdAt }
  const recipientId = conversation.members.find(id => !id.equals(req.user._id))
  await Conversation.updateOne({ _id: conversation._id }, { $pullAll: { archivedFor: [recipientId, req.user._id], hiddenFor: [recipientId, req.user._id] } })
  io.to(conversation.id).emit('message:new', payload)
  io.to(recipientId.toString()).emit('message:new', payload)
  await createActivity(recipientId, req.user._id, 'message')
  res.status(201).json({ message: payload })
}))

io.use(async (socket, next) => {
  try { const token = socket.handshake.auth?.token; const claims = jwt.verify(token, JWT_SECRET); const user = await User.findById(claims.sub).select('sessionVersion'); if (!dbReady || !user || (claims.ver || 0) !== (user.sessionVersion || 0)) return next(new Error('Authentication required')); socket.userId = claims.sub; next() }
  catch { next(new Error('Authentication required')) }
})
const activeLives = new Map()
const liveChatLastSent = new Map()
const onlineUserCounts = new Map()
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
io.on('connection', socket => {
  socket.join(socket.userId)
  const wasOnline = onlineUserCounts.has(socket.userId)
  onlineUserCounts.set(socket.userId, (onlineUserCounts.get(socket.userId) || 0) + 1)
  socket.emit('presence:snapshot', [...onlineUserCounts.keys()])
  if (!wasOnline) io.emit('presence:update', { userId: socket.userId, online: true })
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
    if (!dbReady || !mongoose.Types.ObjectId.isValid(id) || !await memberConversation(conversationId, socket.userId)) return
    const message = await Message.findOneAndUpdate({ _id: id, conversation: conversationId, sender: { $ne: socket.userId }, deliveredAt: null }, { $set: { deliveredAt: new Date() } }, { new: true }).select('_id sender deliveredAt readAt')
    if (message) io.to(message.sender.toString()).emit('message:status', { conversationId: String(conversationId), ids: [message.id], status: 'delivered', deliveredAt: message.deliveredAt })
  })
  socket.on('messages:read', async ({ conversationId } = {}) => {
    if (!dbReady || !await memberConversation(conversationId, socket.userId)) return
    const now = new Date()
    const rows = await Message.find({ conversation: conversationId, sender: { $ne: socket.userId }, readAt: null }).select('_id sender').lean()
    if (!rows.length) { socket.emit('messages:read:done', { conversationId: String(conversationId) }); return }
    const ids = rows.map(row => row._id)
    await Message.updateMany({ _id: { $in: ids } }, { $set: { deliveredAt: now, readAt: now } })
    const senderIds = [...new Set(rows.map(row => row.sender.toString()))]
    for (const senderId of senderIds) io.to(senderId).emit('message:status', { conversationId: String(conversationId), ids: ids.map(id => id.toString()), status: 'read', deliveredAt: now, readAt: now })
    socket.emit('messages:read:done', { conversationId: String(conversationId) })
  })
  socket.on('conversation:join', async id => { if (dbReady && await memberConversation(id, socket.userId)) socket.join(id) })
  socket.on('conversation:leave', async id => { if (dbReady && await memberConversation(id, socket.userId)) socket.leave(id) })
  socket.on('call:signal', async ({ to, kind, data }) => {
    if (!['offer','answer','ice','end'].includes(kind) || !dbReady) return
    const sender = await User.findById(socket.userId).select('friends')
    if (!sender?.friends.some(x => x.toString() === String(to))) return
    io.to(String(to)).emit('call:signal', { from: socket.userId, kind, data })
  })
  socket.on('party:join', async roomId => { if (dbReady && await memberConversation(roomId, socket.userId)) { socket.join(`party:${roomId}`); socket.to(`party:${roomId}`).emit('party:participant', { userId: socket.userId, joined: true }) } })
  socket.on('party:source', async ({ roomId, url }) => {
    if (!dbReady || typeof url !== 'string' || url.length > 2048 || !/^https:\/\//i.test(url)) return
    const conversation = await memberConversation(roomId, socket.userId)
    if (!conversation) return
    socket.join(`party:${roomId}`)
    const otherIds = conversation.members.filter(id => id.toString() !== socket.userId).map(id => id.toString())
    for (const id of otherIds) io.to(id).emit('party:source', { roomId, url, from: socket.userId })
  })
  socket.on('party:sync', async ({ roomId, action, time }) => {
    if (!['play','pause','seek'].includes(action) || !dbReady || !await memberConversation(roomId, socket.userId)) return
    socket.to(`party:${roomId}`).emit('party:sync', { action, time, by: socket.userId })
  })
  socket.on('game:move', async ({ roomId, index, mark }) => {
    if (!dbReady || !Number.isInteger(index) || index < 0 || index > 8 || !['X','O'].includes(mark) || !await memberConversation(roomId, socket.userId)) return
    socket.to(roomId).emit('game:move', { index, mark, by: socket.userId })
  })
  socket.on('disconnect', () => {
    const connections = onlineUserCounts.get(socket.userId) || 0
    if (connections <= 1) {
      onlineUserCounts.delete(socket.userId)
      const lastSeenAt = new Date()
      void User.updateOne({ _id: socket.userId }, { $set: { lastSeenAt } }).catch(err => console.error('Last-seen update failed:', err.message))
      io.emit('presence:update', { userId: socket.userId, online: false, lastSeenAt: lastSeenAt.toISOString() })
    } else onlineUserCounts.set(socket.userId, connections - 1)
    for (const live of activeLives.values()) {
      if (live.hostId === socket.userId) endLiveSession(live.id, socket.userId)
      else if (live.viewers.delete(socket.userId)) { live.joinRequests.delete(socket.userId); if (live.cohostId === socket.userId) { live.cohostId = null; for (const viewerId of live.viewers) io.to(viewerId).emit('live:viewer-left', { liveId: live.id, viewerId: socket.userId }) } io.to(live.hostId).emit('live:viewer-left', { liveId: live.id, viewerId: socket.userId }); io.to(live.hostId).emit('live:viewer-count', { liveId: live.id, count: live.viewers.size }) }
    }
  })
})

app.use('/api', (err, req, res, next) => { console.error(err); if (res.headersSent) return next(err); if (err instanceof multer.MulterError) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files must be smaller than 50 MB.' : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'A post can contain up to 10 media files.' : 'The media upload could not be accepted.' }); if (err.message?.startsWith('Upload a JPG') || err.message?.startsWith('Upload a supported chat file')) return res.status(400).json({ error: err.message }); res.status(err.code === 11000 ? 409 : 500).json({ error: err.code === 11000 ? 'That username or email is already registered.' : 'Something went wrong. Please try again.' }) })
if (process.env.NODE_ENV === 'production') { const dist = path.resolve(__dirname, '../dist'); app.use(express.static(dist)); app.get('/{*path}', (req,res) => res.sendFile(path.join(dist,'index.html'))) }
server.listen(PORT, () => console.log(`Social Land API listening on http://localhost:${PORT}`))
if (process.env.MONGODB_URI) mongoose.connect(process.env.MONGODB_URI).then(async () => { try { for (const index of await Story.collection.indexes()) { if (index.expireAfterSeconds !== undefined && index.key?.expiresAt) await Story.collection.dropIndex(index.name) }; await Story.collection.createIndex({ expiresAt: 1 }); await secureActiveStoryMedia() } catch (err) { console.error('Story setup failed:', err.message) }; dbReady = true; console.log('MongoDB connected'); void cleanExpiredStories().catch(err => console.error('Story cleanup failed:', err.message)); const cleanupTimer = setInterval(() => void cleanExpiredStories().catch(err => console.error('Story cleanup failed:', err.message)), 60 * 1000); cleanupTimer.unref() }).catch(err => console.error('MongoDB connection failed:', err.message))
else console.warn('MongoDB is not configured. Copy .env.example to .env and add MONGODB_URI to enable accounts.')
