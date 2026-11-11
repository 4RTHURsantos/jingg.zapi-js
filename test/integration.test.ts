// Runs against a live API. Skipped unless ZAPI_URL and ZAPI_ADMIN_KEY are set.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZapiClient, ZapiError } from '../src/index.js'

const { ZAPI_URL, ZAPI_ADMIN_KEY } = process.env

test('live API round trip', { skip: !ZAPI_URL || !ZAPI_ADMIN_KEY }, async () => {
  const zapi = new ZapiClient({ baseUrl: ZAPI_URL!, apiKey: ZAPI_ADMIN_KEY! })
  assert.ok(await zapi.isReady())

  const created = await zapi.devices.create({ name: `sdk-js-${Date.now()}`, connect: false })
  assert.match(created.apiKey, /^zk_/)
  const device = zapi.device(created.id)
  try {
    const again = await zapi.devices.getOrCreate(created.name)
    assert.equal(again.id, created.id)
    assert.equal(again.created, false)

    // the device's own key works for its own routes
    const scoped = new ZapiClient({ baseUrl: ZAPI_URL!, apiKey: created.apiKey }).device(created.id)
    assert.equal((await scoped.get()).name, created.name)

    const hook = await device.webhooks.ensure({ url: 'http://127.0.0.1:9/none', secret: 'x', events: ['message.received'] })
    assert.equal((await device.webhooks.ensure({ url: 'http://127.0.0.1:9/none', enabled: false })).id, hook.id)
    assert.equal((await device.webhooks.list()).length, 1)
    assert.equal((await device.webhooks.test(hook.id)).ok, false)

    const qr = await device.connectAndGetQr()
    assert.ok(qr && qr.image.startsWith('data:image/png;base64,'))
    const png = await device.qrPng()
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47])

    const sent = await device.messages.sendText('5511999990000', 'teste', { idempotencyKey: 'k-1' })
    assert.equal(sent.status, 'queued')
    const dup = await device.messages.sendText('5511999990000', 'teste', { idempotencyKey: 'k-1' })
    assert.equal(dup.id, sent.id)
    assert.equal(dup.duplicate, true)
    assert.equal((await device.messages.cancel(sent.id)).status, 'cancelled')
    assert.equal((await device.messages.listOutbound({ status: 'cancelled' })).length, 1)

    const page = await device.events.list()
    assert.ok(page.events.some((e) => e.type === 'qr.updated'))
    const abort = new AbortController()
    const seqs: number[] = []
    for await (const event of device.events.stream({ signal: abort.signal, pollMs: 100 })) {
      seqs.push(event.seq)
      if (event.seq >= page.lastSeq) abort.abort()
    }
    assert.deepEqual(seqs.slice(0, page.events.length), page.events.map((e) => e.seq))

    await assert.rejects(device.groups.list(), (err: ZapiError) => err.isNotConnected)
    await assert.rejects(zapi.device('00000000-0000-4000-8000-000000000000').get(), (err: ZapiError) => err.isNotFound)
  } finally {
    await zapi.devices.delete(created.id)
  }
})
