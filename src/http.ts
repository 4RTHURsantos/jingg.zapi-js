export interface ZapiClientOptions {
  /** e.g. http://localhost:3000 */
  baseUrl: string
  /** admin key (full access) or a device key (that device only) */
  apiKey: string
  /** per-request timeout. Default 30s */
  timeoutMs?: number
  /** extra attempts after a transient failure (network error, 429, 502, 503, 504). Default 3 */
  maxRetries?: number
  /** custom fetch (tests, proxies). Defaults to the global fetch */
  fetch?: typeof fetch
}

/** Any non-2xx answer from the API, or a failure to reach it (status 0). */
export class ZapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ZapiError'
  }

  /** the device is not running / not connected to WhatsApp */
  get isNotConnected(): boolean {
    return this.status === 409
  }
  get isNotFound(): boolean {
    return this.status === 404
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  /** POSTs are only retried when the caller says the call is idempotent */
  idempotent?: boolean
  /** return the raw bytes instead of parsing JSON */
  binary?: boolean
}

const RETRYABLE = new Set([429, 502, 503, 504])

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export class Http {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch

  constructor(options: ZapiClientOptions) {
    if (!options?.baseUrl) throw new Error('ZapiClient: baseUrl is required')
    if (!options.apiKey) throw new Error('ZapiClient: apiKey is required')
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxRetries = options.maxRetries ?? 3
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    const canRetry = method === 'GET' || method === 'DELETE' || options.idempotent === true
    const headers: Record<string, string> = { 'x-api-key': this.apiKey, accept: 'application/json', ...options.headers }
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    if (body !== undefined) headers['content-type'] = 'application/json'

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      let response: Response
      try {
        response = await this.fetchImpl(url, { method, headers, body, signal, redirect: 'manual' })
      } catch (err: any) {
        if (options.signal?.aborted) throw options.signal.reason
        if (canRetry && attempt < this.maxRetries) {
          await sleep(backoff(attempt), options.signal)
          continue
        }
        const reason = err?.name === 'TimeoutError' ? `timeout after ${this.timeoutMs}ms` : (err?.cause?.message ?? err?.message ?? String(err))
        throw new ZapiError(`${method} ${path} failed: ${reason}`, 0)
      }

      if (response.ok || (response.status >= 300 && response.status < 400)) {
        if (options.binary) return new Uint8Array(await response.arrayBuffer()) as T
        if (response.status === 204) return undefined as T
        const text = await response.text()
        return (text ? JSON.parse(text) : undefined) as T
      }

      if (canRetry && RETRYABLE.has(response.status) && attempt < this.maxRetries) {
        await response.arrayBuffer().catch(() => {})
        await sleep(backoff(attempt), options.signal)
        continue
      }

      const text = await response.text().catch(() => '')
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {}
      throw new ZapiError(parsed?.message ?? (text || `HTTP ${response.status}`), response.status, parsed ?? text)
    }
  }

  get = <T>(path: string, options?: RequestOptions) => this.request<T>('GET', path, options)
  post = <T>(path: string, body?: unknown, options?: RequestOptions) => this.request<T>('POST', path, { ...options, body: body ?? {} })
  patch = <T>(path: string, body: unknown, options?: RequestOptions) => this.request<T>('PATCH', path, { ...options, body })
  delete = <T>(path: string, options?: RequestOptions) => this.request<T>('DELETE', path, options)
}

const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250)
