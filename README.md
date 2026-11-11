# @jingg/zapi

Cliente TypeScript/JavaScript para a [Jingg Zapi](https://github.com/4RTHURsantos/jingg.zapi) — API de WhatsApp multi-dispositivo. Você informa a
URL e a chave; a biblioteca cuida de autenticação, retentativas, idempotência dos envios, tipagem dos eventos e
validação de webhooks.

Sem dependências. ESM e CommonJS, com tipos. Node 20+, Bun, Deno e runtimes edge (usa `fetch` e WebCrypto).

## Instalação

```bash
npm install github:4RTHURsantos/jingg.zapi-js      # direto do GitHub (compila na instalação)
# ou a partir de um clone local:
npm run build && npm pack                          # gera jingg-zapi-0.1.0.tgz
npm install ../jingg.zapi-js/jingg-zapi-0.1.0.tgz  # no projeto consumidor
```

## Uso

```ts
import { ZapiClient } from '@jingg/zapi'

const zapi = new ZapiClient({ baseUrl: 'http://localhost:3000', apiKey: process.env.ZAPI_ADMIN_KEY! })

// acha o dispositivo pelo nome ou cria — pode rodar a cada inicialização
const found = await zapi.devices.getOrCreate('atendimento')
const device = zapi.device(found.id)

// pareamento: mostre o QR e aguarde
const qr = await device.connectAndGetQr()        // null se já estiver conectado
if (qr) {
  console.log(qr.image)                          // data URL pronta para <img src>
  await device.waitUntilConnected({ timeoutMs: 120_000 })
}

// envio
const sent = await device.messages.sendText('5511999990000', 'Olá!')
await device.messages.sendImage('5511999990000', { url: 'https://exemplo.com/foto.jpg' }, { caption: 'Veja' })
await device.messages.sendDocument('5511999990000', await fs.readFile('boleto.pdf'), { fileName: 'boleto.pdf' })

// figurinha: PNG, JPEG, WebP, GIF ou vídeo curto — a API converte (animada quando a origem é)
await device.messages.sendSticker('5511999990000', { url: 'https://exemplo.com/gato.gif' }, { pack: 'Meu Pacote', author: 'Minha Empresa' })

await device.messages.waitUntilSent(sent.id)     // opcional: aguarda sair da fila
```

A chave pode ser a de administrador (acesso a tudo) ou a de um dispositivo (só `zapi.device(id)` daquele dispositivo).
Mídia aceita `{ url }`, `{ base64 }` ou bytes (`Uint8Array`/`Buffer`/`ArrayBuffer`).

## Recebendo eventos

**Por webhook** — registre uma vez e valide cada chamada com o corpo **bruto**:

```ts
import express from 'express'
import { parseWebhook, WebhookSignatureError } from '@jingg/zapi'

await device.webhooks.ensure({ url: 'https://meu-sistema/webhooks/whatsapp', secret: SECRET })

app.post('/webhooks/whatsapp', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = await parseWebhook(req.body, { secret: SECRET, signature: req.get('x-zapi-signature') })
    if (event.type === 'message.received') console.log(event.data.pushName, event.data.text)   // data é tipado
    if (event.type === 'message.failed') console.error(event.data.error)
    res.sendStatus(200)          // qualquer coisa fora de 2xx faz a API reenviar
  } catch (err) {
    res.sendStatus(err instanceof WebhookSignatureError ? 401 : 500)
  }
})
```

A entrega é *ao menos uma vez*: deduplique por `event.id` e ordene por `event.seq`. Para um processo único há o
`EventDeduplicator` (em memória); com várias instâncias, grave o `id` no seu banco.

**Sem webhook** — um fluxo ordenado por polling, que retoma de onde parou:

```ts
for await (const event of device.events.stream({ after: ultimoSeq, signal })) {
  await processar(event)
  ultimoSeq = event.seq         // persista: é o seu cursor
}
```

## O que a biblioteca faz por você

- **Retentativas** com backoff em falha de rede, timeout e respostas 429/502/503/504 — em `GET`, `DELETE` e nos envios de mensagem.
- **Idempotência nos envios**: cada `send…` leva uma chave única (ou a sua, em `idempotencyKey`), então repetir o POST
  após uma queda de rede não duplica a mensagem. Demais `POST`s não são repetidos automaticamente.
- **Erros** viram `ZapiError` com `status` e a mensagem da API (`isNotConnected`, `isNotFound`); `status === 0` significa
  que a API não respondeu.
- **Eventos tipados**: `ZapiEvent` é uma união discriminada por `type`.

## Superfície

| | |
|---|---|
| `zapi.devices` | `create`, `list`, `get`, `getOrCreate`, `delete` |
| `zapi.device(id)` | `connect`, `disconnect`, `restart`, `logout`, `qr`, `qrPng`, `pairingCode`, `connectAndGetQr`, `waitUntilConnected`, `rotateKey`, `updateProfile`, `sendPresence`, `rejectCall` |
| `.messages` | `sendText/Image/Video/Audio/Document/Sticker/Location/Contacts/Poll`, `react`, `edit`, `deleteForEveryone`, `send`, `outbound`, `listOutbound`, `cancel`, `retry`, `waitUntilSent`, `list`, `get`, `mediaUrl`, `markRead` |
| `.webhooks` | `list`, `create`, `update`, `delete`, `ensure`, `test`, `deliveries`, `retryDelivery`, `retryFailedDeliveries` |
| `.events` | `list`, `lastSeq`, `stream` |
| `.contacts` | `check`, `pictureUrl`, `status`, `businessProfile`, `block`, `unblock`, `subscribePresence` |
| `.groups` | `list`, `get`, `create`, `update`, `add/removeParticipants`, `promote`, `demote`, `inviteLink`, `revokeInviteLink`, `inviteInfo`, `join`, `leave` |
| funções | `parseWebhook`, `verifyWebhookSignature`, `EventDeduplicator` |

## Testes

```bash
npm test                                         # unitários (servidor HTTP local)
ZAPI_URL=http://localhost:3000 ZAPI_ADMIN_KEY=... npm test   # inclui a ida-e-volta contra uma API real
```
