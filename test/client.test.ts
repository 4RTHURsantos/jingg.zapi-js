import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { EventDeduplicator, parseWebhook, verifyWebhookSignature, WebhookSignatureError, ZapiClient, ZapiError } from '../src/index.js'

interface Call {
  method: string
  url: string
  body: any
  headers: IncomingMessage['headers']
}
type Handler = (req: IncomingMessage, res: ServerResponse) => void

async function withServer(handler: Handler, run: (zapi: ZapiClient, calls: Call[]) => Promise<void>) {
  const calls: Call[] = []
  const server = createServer((req, res) => {
    let text = ''
    req
      .on('data', (c) => (text += c))
      .on('end', () => {
        calls.push({ method: req.method!, url: req.url!, body: text ? JSON.parse(text) : undefined, headers: req.headers })
        handler(req, res)
      })
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as AddressInfo).port
  try {
    await run(new ZapiClient({ baseUrl: `http://127.0.0.1:${port}/`, apiKey: 'k', maxRetries: 3 }), calls)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}
const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

test('sends the key and builds device-scoped paths', async () => {
  await withServer(
    (_req, res) => json(res, 202, { id: 'o1', status: 'queued' }),
    async (zapi, calls) => {
      const out = await zapi.device('dev 1').messages.sendText('5511999990000', 'oi', { quotedMessageId: 'Q' })
      assert.equal(out.id, 'o1')
      assert.equal(calls[0].url, '/v1/devices/dev%201/messages')
      assert.equal(calls[0].headers['x-api-key'], 'k')
      const { idempotencyKey, ...rest } = calls[0].body
      assert.deepEqual(rest, { to: '5511999990000', type: 'text', text: 'oi', quotedMessageId: 'Q' })
      assert.match(idempotencyKey, /^[0-9a-f-]{36}$/)
    },
  )
})

test('a send is retried through 503s with the SAME idempotency key', async () => {
  let n = 0
  await withServer(
    (_req, res) => (++n < 3 ? json(res, 503, { message: 'down' }) : json(res, 202, { id: 'o1', status: 'queued' })),
    async (zapi, calls) => {
      await zapi.device('d').messages.sendText('1', 'x')
      assert.equal(calls.length, 3)
      assert.equal(new Set(calls.map((c) => c.body.idempotencyKey)).size, 1)
    },
  )
})

test('non-idempotent POSTs are not retried; errors carry status and API message', async () => {
  await withServer(
    (_req, res) => json(res, 503, { statusCode: 503, message: 'nope' }),
    async (zapi, calls) => {
      await assert.rejects(
        zapi.device('d').groups.create('g', ['1']),
        (err: ZapiError) => err instanceof ZapiError && err.status === 503 && err.message === 'nope',
      )
      assert.equal(calls.length, 1)
    },
  )
  await withServer(
    (_req, res) => json(res, 409, { message: 'device is not connected to WhatsApp' }),
    async (zapi, calls) => {
      await assert.rejects(zapi.device('d').groups.list(), (err: ZapiError) => err.isNotConnected)
      assert.equal(calls.length, 1, '4xx is never retried')
    },
  )
})

test('binary media is base64-encoded; 204 resolves to undefined', async () => {
  await withServer(
    (req, res) => (req.method === 'DELETE' ? res.writeHead(204).end() : json(res, 202, { id: 'o' })),
    async (zapi, calls) => {
      await zapi.device('d').messages.sendDocument('1', new TextEncoder().encode('ola mundo'), { fileName: 'a.txt' })
      assert.deepEqual(calls[0].body.media, { base64: 'b2xhIG11bmRv' })
      assert.equal(calls[0].body.fileName, 'a.txt')
      await zapi.device('d').messages.sendSticker('1', { url: 'https://exemplo.com/gato.gif' }, { pack: 'Gatos', quotedMessageId: 'Q' })
      await zapi.device('d').messages.sendSticker('1', { url: 'https://exemplo.com/gato.gif' })
      assert.equal(calls[1].body.type, 'sticker')
      assert.deepEqual(calls[1].body.sticker, { pack: 'Gatos' })
      assert.equal(calls[1].body.pack, undefined)
      assert.equal(calls[1].body.quotedMessageId, 'Q')
      assert.equal(calls[2].body.sticker, undefined)
      const m = zapi.device('d').messages
      await m.replyText('MSG 1', 'Combinado', { mentions: ['1'] })
      await m.reactTo('MSG 1', '👍')
      await m.removeReaction('MSG 1')
      const [reply, react, unreact] = calls.slice(3)
      assert.equal(reply.url, '/v1/devices/d/messages/MSG%201/reply')
      assert.equal(reply.body.text, 'Combinado')
      assert.deepEqual(reply.body.mentions, ['1'])
      assert.ok(reply.body.idempotencyKey)
      assert.equal(react.url, '/v1/devices/d/messages/MSG%201/reaction')
      assert.equal(react.body.emoji, '👍')
      assert.deepEqual([unreact.method, unreact.url], ['DELETE', '/v1/devices/d/messages/MSG%201/reaction'])
      assert.equal(await zapi.devices.delete('d'), undefined)
    },
  )
})

test('event stream follows the cursor across pages, filters types, and stops on abort', async () => {
  const all = Array.from({ length: 5 }, (_, i) => ({
    id: `e${i + 1}`,
    seq: i + 1,
    deviceId: 'd',
    type: i % 2 ? 'message.status' : 'message.received',
    timestamp: '',
    data: {},
  }))
  await withServer(
    (req, res) => {
      const after = Number(new URL(req.url!, 'http://x').searchParams.get('after'))
      const events = all.filter((e) => e.seq > after).slice(0, 2)
      json(res, 200, { events, lastSeq: events.at(-1)?.seq ?? after, hasMore: events.length === 2 })
    },
    async (zapi, calls) => {
      const abort = new AbortController()
      const seen: number[] = []
      const stream = zapi.device('d').events.stream({ after: 1, types: ['message.received'], pollMs: 20, limit: 2, signal: abort.signal })
      for await (const event of stream) {
        seen.push(event.seq)
        if (event.seq === 5) abort.abort()
      }
      assert.deepEqual(seen, [3, 5])
      assert.deepEqual(
        calls.map((c) => new URL(c.url, 'http://x').searchParams.get('after')),
        ['1', '3'],
      )
    },
  )
})

test('unreachable API surfaces as ZapiError status 0 after retries', async () => {
  const zapi = new ZapiClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', maxRetries: 1 })
  await assert.rejects(zapi.devices.list(), (err: ZapiError) => err instanceof ZapiError && err.status === 0)
})

test('webhook signature: verify, parse, reject tampering', async () => {
  const body = JSON.stringify({ id: 'e1', seq: 1, deviceId: 'd', type: 'message.received', timestamp: 't', data: { text: 'olá' } })
  const signature = 'sha256=' + createHmac('sha256', 's3gr3do').update(body).digest('hex')
  assert.ok(await verifyWebhookSignature('s3gr3do', body, signature))
  assert.ok(await verifyWebhookSignature('s3gr3do', Buffer.from(body), signature))
  assert.ok(!(await verifyWebhookSignature('outro', body, signature)))
  assert.ok(!(await verifyWebhookSignature('s3gr3do', body, undefined)))
  const event = await parseWebhook(body, { secret: 's3gr3do', signature })
  assert.equal(event.type, 'message.received')
  if (event.type === 'message.received') assert.equal(event.data.text, 'olá')
  await assert.rejects(parseWebhook(body + ' ', { secret: 's3gr3do', signature }), WebhookSignatureError)
})

test('deduplicator', () => {
  const d = new EventDeduplicator(2)
  assert.ok(d.firstTime('a'))
  assert.ok(!d.firstTime('a'))
  d.firstTime('b')
  d.firstTime('c')
  assert.ok(d.firstTime('a'), 'evicted once over capacity')
})
