import type { ZapiEvent } from './types.js'

const encoder = new TextEncoder()

async function hmacHex(secret: string, body: string | Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const data = typeof body === 'string' ? encoder.encode(body) : body
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, data as BufferSource))
  return Array.from(signature, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Checks the `X-Zapi-Signature` header against the RAW request body (the bytes as received —
 * not a re-serialised object). Constant-time comparison. Works in Node, Bun, Deno and edge runtimes.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (!signatureHeader) return false
  const expected = 'sha256=' + (await hmacHex(secret, rawBody))
  if (expected.length !== signatureHeader.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i)
  return diff === 0
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('invalid webhook signature')
    this.name = 'WebhookSignatureError'
  }
}

/**
 * Verifies (when a secret is given) and parses a webhook call into a typed event.
 *
 * ```ts
 * app.post('/webhooks/whatsapp', express.raw({ type: 'application/json' }), async (req, res) => {
 *   const event = await parseWebhook(req.body, { secret: SECRET, signature: req.get('x-zapi-signature') })
 *   if (event.type === 'message.received') ...
 *   res.sendStatus(200)
 * })
 * ```
 */
export async function parseWebhook(
  rawBody: string | Uint8Array,
  options: { secret?: string; signature?: string | null } = {},
): Promise<ZapiEvent> {
  if (options.secret && !(await verifyWebhookSignature(options.secret, rawBody, options.signature))) {
    throw new WebhookSignatureError()
  }
  const text = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody)
  return JSON.parse(text) as ZapiEvent
}

/**
 * Remembers recently seen event ids so at-least-once deliveries are handled once.
 * In-memory: enough for a single process; with several instances, deduplicate in your database instead.
 */
export class EventDeduplicator {
  private seen = new Set<string>()
  constructor(private readonly capacity = 10_000) {}

  /** true the first time an id is seen, false for repeats */
  firstTime(eventId: string): boolean {
    if (this.seen.has(eventId)) return false
    this.seen.add(eventId)
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value!)
    return true
  }
}
