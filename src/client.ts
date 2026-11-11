import { Http, sleep, ZapiError, type ZapiClientOptions } from './http.js'
import type {
  ContactCard,
  CreatedDevice,
  DeliveryStatus,
  Device,
  DeviceDetails,
  EventPage,
  EventType,
  GroupMetadata,
  GroupSettings,
  GroupSummary,
  MediaOptions,
  MediaSource,
  Message,
  NumberCheck,
  OutboundMessage,
  OutboundStatus,
  PresenceState,
  SendOptions,
  Webhook,
  WebhookDelivery,
  WebhookInput,
  WebhookTestResult,
  ZapiEvent,
} from './types.js'

const enc = encodeURIComponent

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function mediaPayload(source: MediaSource): { url: string } | { base64: string } {
  if (source instanceof Uint8Array) return { base64: toBase64(source) }
  if (source instanceof ArrayBuffer) return { base64: toBase64(new Uint8Array(source)) }
  return source
}

const newKey = () => globalThis.crypto.randomUUID()

/**
 * Entry point.
 *
 * ```ts
 * const zapi = new ZapiClient({ baseUrl: 'http://localhost:3000', apiKey: process.env.ZAPI_ADMIN_KEY! })
 * const created = await zapi.devices.create({ name: 'atendimento' })
 * const device = zapi.device(created.id)
 * await device.messages.sendText('5511999990000', 'Olá!')
 * ```
 */
export class ZapiClient {
  private readonly http: Http
  readonly devices: DevicesApi

  constructor(options: ZapiClientOptions) {
    this.http = new Http(options)
    this.devices = new DevicesApi(this.http)
  }

  /** Everything scoped to one device. No request is made until you call a method. */
  device(deviceId: string): DeviceClient {
    return new DeviceClient(this.http, deviceId)
  }

  /** true when the API and its dependencies (Postgres, Redis, storage) are up */
  async isReady(): Promise<boolean> {
    try {
      const res = await this.http.get<{ status: string }>('/ready')
      return res.status === 'ok'
    } catch {
      return false
    }
  }
}

export class DevicesApi {
  constructor(private readonly http: Http) {}

  /** Requires the admin key. `connect` defaults to true: the device starts producing QR codes right away. */
  create(input: { name: string; connect?: boolean; webhook?: Pick<WebhookInput, 'url' | 'secret' | 'events'> }): Promise<CreatedDevice> {
    return this.http.post('/v1/devices', input)
  }

  /** With a device key, lists only that device. */
  list(): Promise<Device[]> {
    return this.http.get('/v1/devices')
  }

  get(deviceId: string): Promise<DeviceDetails> {
    return this.http.get(`/v1/devices/${enc(deviceId)}`)
  }

  /** Finds a device by name, or creates it. Handy at application start-up. The apiKey is only present when it was just created. */
  async getOrCreate(name: string, input: Omit<Parameters<DevicesApi['create']>[0], 'name'> = {}): Promise<Device & { apiKey?: string; created: boolean }> {
    const existing = (await this.list()).find((d) => d.name === name)
    if (existing) return { ...existing, created: false }
    return { ...(await this.create({ name, ...input })), created: true }
  }

  /** Requires the admin key. Logs out of WhatsApp (if connected) and erases the device's data. */
  delete(deviceId: string): Promise<void> {
    return this.http.delete(`/v1/devices/${enc(deviceId)}`)
  }
}

export class DeviceClient {
  readonly messages: MessagesApi
  readonly webhooks: WebhooksApi
  readonly events: EventsApi
  readonly contacts: ContactsApi
  readonly groups: GroupsApi
  private readonly base: string

  constructor(
    private readonly http: Http,
    readonly id: string,
  ) {
    this.base = `/v1/devices/${enc(id)}`
    this.messages = new MessagesApi(http, this.base)
    this.webhooks = new WebhooksApi(http, this.base)
    this.events = new EventsApi(http, this.base)
    this.contacts = new ContactsApi(http, this.base)
    this.groups = new GroupsApi(http, this.base)
  }

  get(): Promise<DeviceDetails> {
    return this.http.get(this.base)
  }
  rename(name: string): Promise<Device> {
    return this.http.patch(this.base, { name })
  }
  /** Starts the connection. Without a saved session the device begins issuing QR codes. */
  connect(): Promise<Device> {
    return this.http.post(`${this.base}/connect`)
  }
  /** Closes the connection but keeps the session: `connect()` resumes without a new QR. */
  disconnect(): Promise<Device> {
    return this.http.post(`${this.base}/disconnect`)
  }
  restart(): Promise<Device> {
    return this.http.post(`${this.base}/restart`)
  }
  /** Unlinks from WhatsApp and erases the session; pairing is needed again. */
  async logout(): Promise<void> {
    await this.http.post(`${this.base}/logout`)
  }
  /** The previous device key stops working. */
  async rotateKey(): Promise<string> {
    return (await this.http.post<{ apiKey: string }>(`${this.base}/rotate-key`)).apiKey
  }

  /** Current QR. `image` is a PNG data URL ready for an <img src>. Throws ZapiError 404 while none is available yet. */
  qr(): Promise<{ qr: string; image: string; generatedAt: string }> {
    return this.http.get(`${this.base}/qr`)
  }
  /** Current QR as PNG bytes. */
  qrPng(): Promise<Uint8Array> {
    return this.http.get(`${this.base}/qr`, { query: { format: 'png' }, binary: true })
  }
  /** Pairing by code instead of QR. On the phone: Linked devices → Link with phone number. */
  async pairingCode(phone: string): Promise<string> {
    return (await this.http.post<{ code: string }>(`${this.base}/pairing-code`, { phone })).code
  }

  /**
   * Starts the device if needed and resolves with the QR once one is available
   * (or with `null` if the device turns out to be already connected).
   */
  async connectAndGetQr(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ qr: string; image: string; generatedAt: string } | null> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    await this.connect()
    for (;;) {
      try {
        return await this.qr()
      } catch (err) {
        if (!(err instanceof ZapiError) || (err.status !== 404 && err.status !== 409)) throw err
        if ((await this.get()).status === 'connected') return null
        if (Date.now() > deadline) throw new ZapiError('timed out waiting for a QR code', 0)
      }
      await sleep(1000, options.signal)
    }
  }

  /** Resolves when the device is connected to WhatsApp. Rejects on timeout, or if it ends up logged out. */
  async waitUntilConnected(options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<DeviceDetails> {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000)
    for (;;) {
      const device = await this.get()
      if (device.status === 'connected') return device
      if (device.status === 'logged_out') throw new ZapiError('device was logged out', 0, device)
      if (device.desiredState === 'stopped') throw new ZapiError(`device is stopped (${device.statusReason ?? 'call connect()'})`, 0, device)
      if (Date.now() > deadline) throw new ZapiError(`timed out waiting for connection (status: ${device.status})`, 0, device)
      await sleep(options.pollMs ?? 2000, options.signal)
    }
  }

  /** WhatsApp profile name and/or "about" text. */
  async updateProfile(profile: { name?: string; status?: string }): Promise<void> {
    await this.http.patch(`${this.base}/profile`, profile)
  }
  /** Typing/recording indicators need `to`; available/unavailable apply to the whole account. */
  async sendPresence(state: PresenceState, to?: string): Promise<void> {
    await this.http.post(`${this.base}/presence`, { state, to })
  }
  /** Use `id` and `from` of a `call.update` event. */
  async rejectCall(callId: string, from: string): Promise<void> {
    await this.http.post(`${this.base}/calls/reject`, { callId, from })
  }
}

export class MessagesApi {
  constructor(
    private readonly http: Http,
    private readonly base: string,
  ) {}

  /**
   * Queues any message type. Resolves once the API has durably stored it — delivery is asynchronous
   * (follow it with `outbound(id)`, `waitUntilSent(id)` or the message.* events).
   */
  send(body: { to: string; type: string; [key: string]: unknown }, options: SendOptions = {}): Promise<OutboundMessage> {
    const { idempotencyKey = newKey(), ...rest } = options
    return this.http.post(`${this.base}/messages`, { ...body, ...rest, idempotencyKey }, { idempotent: true })
  }

  sendText(to: string, text: string, options?: SendOptions) {
    return this.send({ to, type: 'text', text }, options)
  }
  sendImage(to: string, media: MediaSource, options: MediaOptions = {}) {
    return this.send({ to, type: 'image', media: mediaPayload(media) }, options)
  }
  sendVideo(to: string, media: MediaSource, options: MediaOptions & { gif?: boolean } = {}) {
    return this.send({ to, type: 'video', media: mediaPayload(media) }, options)
  }
  /** `ptt: true` sends it as a voice note (use ogg/opus). */
  sendAudio(to: string, media: MediaSource, options: Omit<MediaOptions, 'caption'> & { ptt?: boolean } = {}) {
    return this.send({ to, type: 'audio', media: mediaPayload(media) }, options)
  }
  sendDocument(to: string, media: MediaSource, options: MediaOptions & { fileName?: string } = {}) {
    return this.send({ to, type: 'document', media: mediaPayload(media) }, options)
  }
  sendSticker(to: string, media: MediaSource, options: SendOptions & { mimetype?: string } = {}) {
    return this.send({ to, type: 'sticker', media: mediaPayload(media) }, options)
  }
  sendLocation(to: string, location: { latitude: number; longitude: number; name?: string; address?: string }, options?: SendOptions) {
    return this.send({ to, type: 'location', ...location }, options)
  }
  sendContacts(to: string, contacts: ContactCard | ContactCard[], options?: SendOptions) {
    return this.send({ to, type: 'contact', contacts: Array.isArray(contacts) ? contacts : [contacts] }, options)
  }
  sendPoll(to: string, poll: { name: string; options: string[]; selectableCount?: number }, options?: SendOptions) {
    return this.send({ to, type: 'poll', poll }, options)
  }
  /** An empty emoji removes the reaction. */
  react(chat: string, messageId: string, emoji: string, options?: SendOptions) {
    return this.send({ to: chat, type: 'reaction', messageId, emoji }, options)
  }
  edit(chat: string, messageId: string, text: string, options?: SendOptions) {
    return this.send({ to: chat, type: 'edit', messageId, text }, options)
  }
  /** Deletes for everyone. */
  deleteForEveryone(chat: string, messageId: string, options?: SendOptions) {
    return this.send({ to: chat, type: 'delete', messageId }, options)
  }

  /** Status of a message queued through the API. */
  outbound(outboundId: string): Promise<OutboundMessage> {
    return this.http.get(`${this.base}/messages/outbound/${enc(outboundId)}`)
  }
  listOutbound(filter: { status?: OutboundStatus; limit?: number } = {}): Promise<OutboundMessage[]> {
    return this.http.get(`${this.base}/messages/outbound`, { query: filter })
  }
  /** Only works while the message is still queued. */
  cancel(outboundId: string): Promise<OutboundMessage> {
    return this.http.delete(`${this.base}/messages/outbound/${enc(outboundId)}`)
  }
  /** Re-queues a failed or cancelled message. */
  retry(outboundId: string): Promise<OutboundMessage> {
    return this.http.post(`${this.base}/messages/outbound/${enc(outboundId)}/retry`)
  }

  /** Polls until the message leaves the queue. Resolves when sent; rejects when it failed, was cancelled, or on timeout. */
  async waitUntilSent(outboundId: string, options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<OutboundMessage> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000)
    for (;;) {
      const message = await this.outbound(outboundId)
      if (message.status === 'sent') return message
      if (message.status === 'failed' || message.status === 'cancelled') {
        throw new ZapiError(`message ${message.status}: ${message.lastError ?? 'no details'}`, 0, message)
      }
      if (Date.now() > deadline) throw new ZapiError(`timed out waiting for message to be sent (status: ${message.status})`, 0, message)
      await sleep(options.pollMs ?? 1000, options.signal)
    }
  }

  /** Stored history (received and sent), newest first. */
  list(filter: { chat?: string; before?: string | Date; limit?: number } = {}): Promise<Message[]> {
    const before = filter.before instanceof Date ? filter.before.toISOString() : filter.before
    return this.http.get(`${this.base}/messages`, { query: { ...filter, before } })
  }
  get(messageId: string, options: { raw?: boolean } = {}): Promise<Message> {
    return this.http.get(`${this.base}/messages/${enc(messageId)}`, { query: { raw: options.raw } })
  }
  /** A fresh temporary URL for the message's media (the one inside events expires). */
  mediaUrl(messageId: string): Promise<{ url: string; mimetype?: string; size?: number; fileName?: string }> {
    return this.http.get(`${this.base}/messages/${enc(messageId)}/media`, { query: { redirect: false } })
  }
  /** `participant` (the author) is required for group messages. */
  async markRead(messages: { chat: string; id: string; participant?: string } | { chat: string; id: string; participant?: string }[]): Promise<void> {
    await this.http.post(`${this.base}/messages/read`, { messages: Array.isArray(messages) ? messages : [messages] })
  }
}

export class WebhooksApi {
  constructor(
    private readonly http: Http,
    private readonly base: string,
  ) {}

  list(): Promise<Webhook[]> {
    return this.http.get(`${this.base}/webhooks`)
  }
  create(input: WebhookInput): Promise<Webhook> {
    return this.http.post(`${this.base}/webhooks`, input)
  }
  /** `secret: null` removes the secret. */
  update(webhookId: string, changes: Partial<Omit<WebhookInput, 'secret'>> & { secret?: string | null }): Promise<Webhook> {
    return this.http.patch(`${this.base}/webhooks/${enc(webhookId)}`, changes)
  }
  delete(webhookId: string): Promise<void> {
    return this.http.delete(`${this.base}/webhooks/${enc(webhookId)}`)
  }
  /** Creates the webhook for this URL, or updates the existing one. Safe to call on every start-up. */
  async ensure(input: WebhookInput): Promise<Webhook> {
    const existing = (await this.list()).find((w) => w.url === input.url)
    return existing ? this.update(existing.id, input) : this.create(input)
  }
  /** Sends a `ping` event right now and reports how your endpoint answered. */
  test(webhookId: string): Promise<WebhookTestResult> {
    return this.http.post(`${this.base}/webhooks/${enc(webhookId)}/test`)
  }
  deliveries(filter: { status?: DeliveryStatus; webhookId?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
    return this.http.get(`${this.base}/webhook-deliveries`, { query: filter })
  }
  async retryDelivery(deliveryId: string): Promise<void> {
    await this.http.post(`${this.base}/webhook-deliveries/${enc(deliveryId)}/retry`)
  }
  /** Re-queues every delivery that exhausted its attempts. Returns how many. */
  async retryFailedDeliveries(): Promise<number> {
    return (await this.http.post<{ requeued: number }>(`${this.base}/webhook-deliveries/retry-failed`)).requeued
  }
}

export interface StreamOptions {
  /** resume after this seq (persist the last one you processed). Default 0 = from the beginning */
  after?: number
  types?: EventType[]
  /** wait between polls when caught up. Default 2000 */
  pollMs?: number
  /** page size. Default 200 */
  limit?: number
  signal?: AbortSignal
}

export class EventsApi {
  constructor(
    private readonly http: Http,
    private readonly base: string,
  ) {}

  /** One page of the device's event log, in order. */
  list(options: { after?: number; limit?: number; types?: EventType[] } = {}): Promise<EventPage> {
    return this.http.get(`${this.base}/events`, {
      query: { after: options.after, limit: options.limit, types: options.types?.join(',') },
    })
  }

  /** seq of the newest event — pass it as `after` to stream only what happens from now on. */
  async lastSeq(): Promise<number> {
    return (await this.http.get<{ lastEventSeq: number }>(this.base)).lastEventSeq
  }

  /**
   * Endless ordered stream of events by polling — the webhook-free way to consume the device.
   * Nothing is skipped or repeated as long as you resume from the last `seq` you processed.
   * Transient API failures are waited out. Stop it with the AbortSignal (the loop then ends quietly).
   *
   * ```ts
   * for await (const event of device.events.stream({ after: lastSeq })) {
   *   if (event.type === 'message.received') console.log(event.data.text)
   *   lastSeq = event.seq
   * }
   * ```
   */
  async *stream(options: StreamOptions = {}): AsyncGenerator<ZapiEvent, void, void> {
    let cursor = options.after ?? 0
    const pollMs = options.pollMs ?? 2000
    const signal = options.signal
    try {
      while (!signal?.aborted) {
        let page: EventPage
        try {
          // types are filtered here rather than on the server so the cursor always advances
          page = await this.http.get(`${this.base}/events`, { query: { after: cursor, limit: options.limit ?? 200 }, signal })
        } catch (err) {
          if (signal?.aborted) return
          // keep waiting through outages, but surface mistakes (bad key, unknown device)
          if (err instanceof ZapiError && err.status >= 400 && err.status < 500 && err.status !== 429) throw err
          await sleep(pollMs, signal)
          continue
        }
        for (const event of page.events) {
          cursor = event.seq
          if (!options.types || options.types.includes(event.type)) yield event
        }
        if (!page.hasMore) await sleep(pollMs, signal)
      }
    } catch (err) {
      if (signal?.aborted) return
      throw err
    }
  }
}

export class ContactsApi {
  constructor(
    private readonly http: Http,
    private readonly base: string,
  ) {}

  /** Which of these numbers have WhatsApp, and under which JID. */
  check(numbers: string | string[]): Promise<NumberCheck[]> {
    return this.http.post(`${this.base}/contacts/check`, { numbers: Array.isArray(numbers) ? numbers : [numbers] }, { idempotent: true })
  }
  async pictureUrl(jid: string): Promise<string | null> {
    return (await this.http.get<{ url: string | null }>(`${this.base}/contacts/${enc(jid)}/picture`)).url
  }
  status(jid: string): Promise<unknown> {
    return this.http.get(`${this.base}/contacts/${enc(jid)}/status`)
  }
  businessProfile(jid: string): Promise<Record<string, unknown> | null> {
    return this.http.get(`${this.base}/contacts/${enc(jid)}/business`)
  }
  async block(jid: string): Promise<void> {
    await this.http.post(`${this.base}/contacts/${enc(jid)}/block`, { action: 'block' })
  }
  async unblock(jid: string): Promise<void> {
    await this.http.post(`${this.base}/contacts/${enc(jid)}/block`, { action: 'unblock' })
  }
  /** Start receiving `presence.update` events for this contact. */
  async subscribePresence(jid: string): Promise<void> {
    await this.http.post(`${this.base}/contacts/${enc(jid)}/presence/subscribe`)
  }
}

export class GroupsApi {
  constructor(
    private readonly http: Http,
    private readonly base: string,
  ) {}

  list(): Promise<GroupSummary[]> {
    return this.http.get(`${this.base}/groups`)
  }
  get(groupJid: string): Promise<GroupMetadata> {
    return this.http.get(`${this.base}/groups/${enc(groupJid)}`)
  }
  create(subject: string, participants: string[]): Promise<GroupMetadata> {
    return this.http.post(`${this.base}/groups`, { subject, participants })
  }
  update(groupJid: string, settings: GroupSettings): Promise<GroupMetadata> {
    return this.http.patch(`${this.base}/groups/${enc(groupJid)}`, settings)
  }
  private participants(groupJid: string, action: string, participants: string[]): Promise<unknown> {
    return this.http.post(`${this.base}/groups/${enc(groupJid)}/participants`, { action, participants })
  }
  addParticipants(groupJid: string, participants: string[]) {
    return this.participants(groupJid, 'add', participants)
  }
  removeParticipants(groupJid: string, participants: string[]) {
    return this.participants(groupJid, 'remove', participants)
  }
  promote(groupJid: string, participants: string[]) {
    return this.participants(groupJid, 'promote', participants)
  }
  demote(groupJid: string, participants: string[]) {
    return this.participants(groupJid, 'demote', participants)
  }
  inviteLink(groupJid: string): Promise<{ code: string | null; url: string | null }> {
    return this.http.get(`${this.base}/groups/${enc(groupJid)}/invite-code`)
  }
  /** Invalidates the current link and returns the new one. */
  revokeInviteLink(groupJid: string): Promise<{ code: string | null; url: string | null }> {
    return this.http.post(`${this.base}/groups/${enc(groupJid)}/invite-code/revoke`)
  }
  /** Group data from an invite code or link, without joining. */
  inviteInfo(codeOrLink: string): Promise<GroupMetadata> {
    return this.http.get(`${this.base}/groups/invite/${enc(codeOrLink.split('/').pop()!.split('?')[0])}`)
  }
  async join(codeOrLink: string): Promise<string | null> {
    return (await this.http.post<{ jid: string | null }>(`${this.base}/groups/join`, { code: codeOrLink })).jid
  }
  async leave(groupJid: string): Promise<void> {
    await this.http.post(`${this.base}/groups/${enc(groupJid)}/leave`)
  }
}
