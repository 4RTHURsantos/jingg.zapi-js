export type EventType =
  | 'connection.update'
  | 'qr.updated'
  | 'message.received'
  | 'message.sent'
  | 'message.status'
  | 'message.receipt'
  | 'message.edited'
  | 'message.deleted'
  | 'message.reaction'
  | 'message.poll_vote'
  | 'message.failed'
  | 'group.updated'
  | 'group.participants'
  | 'group.join_request'
  | 'call.update'
  | 'presence.update'

export type DeviceStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'reconnecting' | 'logged_out'

export interface DeviceSettings {
  /**
   * Emit `presence.update` (typing, recording, online) for every chat that writes to the device.
   * The account then shows as online, and the phone stops notifying new messages.
   */
  presenceEvents?: boolean
}

export interface Reaction {
  emoji: string
  sender: string
  senderAlt?: string | null
  fromMe: boolean
  timestamp: string
}

export interface Device {
  settings: DeviceSettings
  id: string
  name: string
  desiredState: 'started' | 'stopped'
  status: DeviceStatus
  statusReason: string | null
  jid: string | null
  lid: string | null
  phone: string | null
  profileName: string | null
  workerId: string | null
  lastEventSeq: number
  createdAt: string
  updatedAt: string
  connectedAt: string | null
}

export interface DeviceDetails extends Device {
  /** true when a worker currently holds this device */
  running: boolean
  outbound: { queued: number; failed: number }
  webhookDeliveries: { pending: number; failed: number }
}

export interface CreatedDevice extends Device {
  /** the device's own key — returned only once */
  apiKey: string
}

export interface WebhookInput {
  url: string
  secret?: string
  /** empty/omitted = every event */
  events?: EventType[]
  headers?: Record<string, string>
  enabled?: boolean
}

export interface Webhook {
  id: string
  url: string
  events: EventType[]
  headers: Record<string, string>
  enabled: boolean
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

export interface WebhookTestResult {
  ok: boolean
  statusCode: number | null
  durationMs: number
  responseBody?: string
  error?: string
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed'

export interface WebhookDelivery {
  id: string
  webhookId: string
  eventId: string
  eventType: EventType
  eventSeq: number
  status: DeliveryStatus
  attempts: number
  lastStatusCode: number | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  deliveredAt: string | null
}

export type OutboundStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled'

export interface OutboundMessage {
  /** id of the queued message in the API (use it to track status) */
  id: string
  to: string
  type: string
  status: OutboundStatus
  /** delivery progress reported by WhatsApp: sent → delivered → read → played */
  ack: string | null
  /** WhatsApp message id, once assigned */
  messageId: string | null
  attempts: number
  lastError: string | null
  idempotencyKey: string | null
  createdAt: string
  sentAt: string | null
  nextAttemptAt: string | null
  deviceStatus?: DeviceStatus
  /** true when the idempotency key matched an earlier message, which is what was returned */
  duplicate?: boolean
}

export interface MediaInfo {
  /** stored | failed | too_large | not_downloaded | pending */
  status: string
  mimetype?: string
  size?: number
  fileName?: string
  seconds?: number
  width?: number
  height?: number
  ptt?: boolean
  /** sticker: it moves */
  animated?: boolean
  /** sticker: vector (Lottie) — the stored file is a .was archive, not a WebP */
  lottie?: boolean
  key?: string
  /** presigned URL; expires — use device.messages.mediaUrl(id) for a fresh one */
  url?: string
  error?: string
}

export interface Message {
  id: string
  chat: string
  chatAlt?: string
  sender: string
  senderAlt?: string
  fromMe: boolean
  isGroup: boolean
  pushName?: string
  timestamp: string
  /** text, image, video, audio, document, sticker, sticker_pack, location, contact, poll, button_reply, list_reply, group_invite, event, unknown */
  type: string
  contentType: string
  text?: string
  media?: MediaInfo
  location?: { latitude?: number; longitude?: number; name?: string; address?: string; live?: boolean }
  contacts?: { name?: string; vcard?: string }[]
  poll?: { name?: string; options: string[]; selectableCount?: number }
  selection?: { id?: string; text?: string }
  /** set when type is sticker_pack */
  stickerPack?: { id?: string; name?: string; publisher?: string; count?: number }
  /** the message this one replies to; `type` and `text` describe the quoted message */
  quoted?: { id: string; sender?: string; fromMe?: boolean; type?: string; text?: string }
  mentions?: string[]
  viewOnce?: boolean
  forwarded?: boolean
  outboundId?: string
  status?: string | null
  /** current reactions; present on messages fetched from the API, not on events */
  reactions?: Reaction[]
  raw?: unknown
}

export interface EventDataMap {
  'connection.update': { status: DeviceStatus; reason?: string; jid?: string; name?: string }
  'qr.updated': { qr: string }
  'message.received': Message
  'message.sent': Message
  'message.status': { id: string; chat: string; fromMe: boolean; status: string; outboundId?: string }
  'message.receipt': { messageId: string; chat: string; user: string; status: string }
  'message.edited': { id: string; chat: string; fromMe: boolean; text?: string }
  'message.deleted': { id: string; chat: string; fromMe: boolean }
  'message.reaction': {
    messageId: string
    chat: string
    /** whether the message reacted to was sent by the device */
    messageFromMe: boolean
    /** null when the reaction was removed */
    emoji: string | null
    previousEmoji?: string
    removed: boolean
    /** whether the device itself reacted */
    fromMe: boolean
    sender: string
    senderAlt?: string
    timestamp: string
  }
  'message.poll_vote': { id: string; chat: string; fromMe: boolean; votes: { name: string; voters: string[] }[] }
  'message.failed': { outboundId: string; to: string; type?: string; error: string; attempts?: number }
  'group.updated': Record<string, unknown>
  'group.participants': Record<string, unknown> & { group: string; action: string }
  'group.join_request': Record<string, unknown> & { group: string }
  'call.update': Record<string, unknown>
  'presence.update': {
    chat: string
    chatAlt?: string
    /** who is typing — the chat itself in a 1:1 conversation, a member in a group */
    participant: string
    participantAlt?: string
    isGroup: boolean
    state: PresenceState
    typing: boolean
    recording: boolean
    lastSeen?: string
    timestamp: string
  }
}

/** Discriminated union: narrowing on `type` gives a typed `data`. */
export type ZapiEvent = {
  [T in EventType]: {
    /** unique per event — deduplicate on this */
    id: string
    /** gapless and monotonic per device — order on this */
    seq: number
    deviceId: string
    type: T
    timestamp: string
    data: EventDataMap[T]
  }
}[EventType]

export interface EventPage {
  events: ZapiEvent[]
  lastSeq: number
  hasMore: boolean
}

/** A URL the worker downloads, inline base64, or raw bytes (encoded for you). */
export type MediaSource = { url: string } | { base64: string } | Uint8Array | ArrayBuffer

export interface StickerOptions extends SendOptions {
  /** pack name shown when the recipient taps the sticker */
  pack?: string
  author?: string
  emojis?: string[]
}

export interface SendOptions {
  /** reply quoting this message id */
  quotedMessageId?: string
  /** numbers/JIDs to mention (also write @number in the text) */
  mentions?: string[]
  mentionAll?: boolean
  /**
   * Sending twice with the same key delivers once. When omitted the client generates one per call,
   * which is what makes its automatic retries safe.
   */
  idempotencyKey?: string
}

export interface MediaOptions extends SendOptions {
  caption?: string
  mimetype?: string
  viewOnce?: boolean
}

export interface ContactCard {
  name: string
  phone: string
  organization?: string
}

export interface NumberCheck {
  input: string
  exists: boolean
  jid: string | null
  lid: string | null
}

export interface GroupSummary {
  id: string
  subject: string
  owner?: string
  size?: number
  creation?: number
  announce?: boolean
  restrict?: boolean
  isCommunity?: boolean
}

export interface GroupMetadata {
  id: string
  subject: string
  owner?: string
  desc?: string
  announce?: boolean
  restrict?: boolean
  size?: number
  participants: { id: string; admin?: 'admin' | 'superadmin' | null; [key: string]: unknown }[]
  [key: string]: unknown
}

export interface GroupSettings {
  subject?: string
  /** empty string clears it */
  description?: string
  /** true = only admins can send messages */
  announce?: boolean
  /** true = only admins can edit group info */
  locked?: boolean
  /** disappearing messages, in seconds (0 turns it off) */
  ephemeral?: number
  memberAddMode?: 'admin_add' | 'all_member_add'
  joinApprovalMode?: boolean
}

export type PresenceState = 'composing' | 'recording' | 'paused' | 'available' | 'unavailable'
