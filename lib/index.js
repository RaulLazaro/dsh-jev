/**
 * dsh-jev — ask Jev (TypeSafe System One) typed questions from DeepSeek Harness.
 *
 * The model returns judgements, not prose: every question is evaluated in
 * parallel against the same state, so a request carrying 50 questions costs
 * about the same and takes about as long as one carrying 1.
 *
 * This half owns the tool, the settings namespace and the Settings bridge.
 * Each user brings their own key: it is written to the DSH credentials store
 * (not to settings.yaml), and may also come from the provider's environment
 * variable. The provider is chosen in Settings and decides endpoint + model.
 *
 * @module dsh-jev
 */
import z from '@deepseek-ai/schemastery'

export const name = 'jev'
export const inject = ['tools']

/** Settings namespace owned by this plugin. */
export const NS = 'jev'
/** Same-origin bridge the browser half calls; loopback-only. */
export const BRIDGE_PREFIX = '/api/dsh-jev-settings'

const MAX_JSON_BODY_BYTES = 1 << 20
const QUESTION_TYPES = ['noul', 'choice', 'score']

/**
 * Supported providers. Jev is served by TypeSafe directly, or through Vercel's
 * AI Gateway (which exposes a TypeSafe-compatible endpoint), or by any endpoint
 * that implements the same `POST /v1/systemone` contract.
 *
 * `credential` is the credentials-store key AND the env fallback name: the same
 * string is used for both, so a user who already exported TYPESAFE_API_KEY
 * needs to configure nothing.
 */
export const PROVIDERS = {
  typesafe: {
    id: 'typesafe',
    label: 'TypeSafe (direct)',
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    credential: 'TYPESAFE_API_KEY',
    keyHint: 'console.typesafe.ai → API keys',
  },
  'vercel-gateway': {
    id: 'vercel-gateway',
    label: 'Vercel AI Gateway',
    url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
    model: 'typesafe-ai/jev',
    credential: 'AI_GATEWAY_API_KEY',
    keyHint: 'Vercel → AI Gateway → API keys (vck_…)',
  },
  custom: {
    id: 'custom',
    label: 'Custom TypeSafe-compatible endpoint',
    url: '',
    model: 'jev-latest',
    credential: 'JEV_API_KEY',
    keyHint: 'any endpoint implementing POST /v1/systemone',
  },
}

/** Provider ids accepted by the settings field. */
export const PROVIDER_IDS = Object.keys(PROVIDERS)

/** Loader schema. Secrets never live here; the key goes to the credentials store. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default('typesafe'),
  model: z.string(),
  baseUrl: z.string(),
  timeoutMs: z.number().default(60000),
  maxStateChars: z.number().default(40000),
  maxQuestions: z.number().default(200),
})

/** Resolved endpoint for the configured provider, or a descriptive error. */
export function resolveEndpoint(config) {
  const cfg = config ?? {}
  const id = typeof cfg.provider === 'string' && cfg.provider.length > 0 ? cfg.provider : 'typesafe'
  const provider = PROVIDERS[id]
  if (provider === undefined) {
    return {
      error: `unknown provider "${id}"; expected one of ${PROVIDER_IDS.join(', ')}`,
    }
  }
  const url = id === 'custom' ? String(cfg.baseUrl ?? '').trim() : provider.url
  if (url.length === 0) {
    return { error: 'the custom provider needs a base URL (Settings → Jev → Base URL)' }
  }
  if (!/^https?:\/\//.test(url)) {
    return { error: `base URL must start with http:// or https:// (got "${url}")` }
  }
  const model = String(cfg.model ?? '').trim() || provider.model
  return { id, url, model, credential: provider.credential }
}

/**
 * Validate the caller's question map. Returns a normalised map or throws with a
 * message that names the offending path, so a bad question surfaces as a tool
 * error the model can act on rather than as a provider rejection.
 */
export function validateQuestions(questions, maxQuestions = 200) {
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new Error('`questions` must be an object of {type, instructions, criteria?}')
  }
  const names = Object.keys(questions)
  if (names.length === 0) throw new Error('at least one question is required')
  if (names.length > maxQuestions) {
    throw new Error(`too many questions (${names.length}); this plugin allows ${maxQuestions}`)
  }
  const out = {}
  for (const key of names) {
    const q = questions[key]
    if (q === null || typeof q !== 'object' || Array.isArray(q)) {
      throw new Error(`questions.${key} must be an object`)
    }
    if (!QUESTION_TYPES.includes(q.type)) {
      throw new Error(
        `questions.${key}.type: expected one of 'noul', 'choice', 'score' (got ${JSON.stringify(q.type)})`,
      )
    }
    const instructions = q.instructions
    if (instructions === undefined || instructions === null) {
      throw new Error(`questions.${key}.instructions is required`)
    }
    const entry = { type: q.type, instructions }
    if (q.type === 'choice') {
      if (q.criteria === null || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) {
        throw new Error(`questions.${key}.criteria must be an object of label → description for a choice`)
      }
      if (Object.keys(q.criteria).length < 2) {
        throw new Error(`questions.${key}.criteria needs at least two options`)
      }
      entry.criteria = q.criteria
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        throw new Error(
          `questions.${key}.criteria must be an array of at least two ordered labels for a score`,
        )
      }
      entry.criteria = q.criteria
    } else if (q.criteria !== undefined && q.criteria !== null) {
      entry.criteria = q.criteria
    }
    out[key] = entry
  }
  return out
}

/** One human-readable line per answer, plus a usage footer. */
export function formatAnswers(payload, names) {
  const answers = payload?.answers ?? {}
  const lines = []
  for (const key of names) {
    const a = answers[key]
    if (a === undefined) {
      lines.push(`${key}: (no answer)`)
    } else if (a.type === 'noul') {
      lines.push(`${key}: ${a.noul}${a.noul >= 0.5 ? ' (yes)' : ' (no)'}`)
    } else if (a.type === 'choice') {
      lines.push(`${key}: ${a.choice} | confidence ${a.confidence} | ${JSON.stringify(a.probabilities)}`)
    } else if (a.type === 'score') {
      lines.push(`${key}: ${a.score} | confidence ${a.confidence} | ${JSON.stringify(a.probabilities)}`)
    } else {
      lines.push(`${key}: ${JSON.stringify(a)}`)
    }
  }
  const usage = payload?.usage ?? {}
  const inputTokens = usage.input_tokens ?? usage.inputTokens
  const model = payload?.model ?? '?'
  lines.push(`--- ${names.length} questions | ${inputTokens} input tokens | model ${model}`)
  return lines.join('\n')
}

/**
 * Retry policy for the upstream. Jev answers 429 under load ("the upstream
 * provider is currently experiencing high demand"), which is common enough that
 * a single attempt is not viable for a tool that runs inside a turn.
 */
export const RETRY_DELAYS_MS = [1000, 3000, 8000, 15000, 25000]

/** POST the questions and return the parsed TypeSafe payload. */
export async function callJev({ url, model, apiKey, state, questions, timeoutMs, signal, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const body = JSON.stringify({ model, state, questions })
  let lastError = 'no attempt was made'
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 60000))
    const relay = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', relay, { once: true })
    }
    let response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      })
    } catch (error) {
      lastError = controller.signal.aborted ? 'the request timed out' : String(error?.message ?? error)
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((done) => setTimeout(done, RETRY_DELAYS_MS[attempt]))
        continue
      }
      throw new Error(`jev request failed: ${lastError}`)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', relay)
    }

    const text = await response.text()
    if (response.ok) {
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`jev returned a non-JSON body: ${text.slice(0, 200)}`)
      }
    }
    lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`
    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      const after = Number(response.headers.get('retry-after')) * 1000
      await new Promise((done) =>
        setTimeout(done, Number.isFinite(after) && after > 0 ? after : RETRY_DELAYS_MS[attempt]),
      )
      continue
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `jev rejected the credential (${lastError}). Check the API key for the selected provider in Settings → Jev.`,
      )
    }
    throw new Error(`jev request failed: ${lastError}`)
  }
  throw new Error(`jev request failed after retries: ${lastError}`)
}

const TOOL_DESCRIPTION = [
  'Ask Jev, a fast decision model, one or more typed questions about a block of text and get structured answers with probabilities.',
  'It returns judgements, not prose: every question is evaluated in parallel against the same state, so a request carrying 50 questions costs about the same and takes about as long as one carrying 1.',
  'USE THIS when you must make the same kind of call about MANY items at once - log lines, tool outputs, test failures, search results, candidate files, review comments - instead of pulling them all into your own context or spawning a subagent to read them.',
  'Also useful as a cheap second opinion before an irreversible action, or to grade options against a rubric.',
  'WHEN NOT TO USE: to write, summarise, translate or reformat text (it cannot generate); for exact string or arithmetic work (it is not a regex engine or calculator); or for anything needing extended multi-step reasoning - decompose into atomic questions instead.',
  'Question types: {type:"noul", instructions} answers yes/no as `noul`, the probability of yes, 0-1. {type:"choice", instructions, criteria:{label: description}} picks one option and returns `choice`, `probabilities`, `confidence`. {type:"score", instructions, criteria:["low","mid","high"]} rates on an ordered rubric and returns `score`, `probabilities`, `confidence`.',
  'Write the instructions and criteria in English; the state may be in any language.',
  'Reference items by a stable label inside the state (for example "### ITEM 7") and ask one atomic question per item; a question about a whole document invites a guess.',
  'Read `probabilities` when `confidence` is low: a flat distribution means it is guessing. Values between roughly 0.4 and 0.6 on a noul carry little information.',
  'The answers are only as good as the questions you wrote: a badly scoped question returns a badly scoped answer.',
  'The endpoint, model and API key come from the user\'s Settings → Jev; when the tool reports a credential or configuration problem, tell the user to open that page.',
].join(' ')

/**
 * Build the model-facing tool schema.
 *
 * `getCredentials` is the lazy accessor, not the credentials service itself:
 * the service can mount after this plugin (cross-bundle order), so the tool
 * reads it on every call. Passing the service here instead of the accessor
 * made every call fail with "no API key" — `resolve` is undefined on a
 * function, and that throw is swallowed by the resolution fallback chain.
 */
export function makeTool(getCredentials, getConfig) {
  return {
    name: 'jev',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          description:
            'The text to judge. Plain text, or a JSON string if the material is structured. Label items ("> ## ITEM 3") when asking per-item questions.',
        },
        questions: {
          type: 'object',
          description:
            'Questions keyed by the name you want back in `answers`. Each value is {type:"noul"|"choice"|"score", instructions, criteria?}. `criteria` is required for choice (an object of label to description) and score (an array of at least two ordered labels). Example: {"item3_failed":{"type":"noul","instructions":"Does ITEM 3 report a failure?"}}',
          additionalProperties: true,
        },
      },
      required: ['state', 'questions'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cfg = getConfig()
      if (cfg?.enabled === false) {
        throw new Error('the jev tool is disabled in Settings → Jev')
      }
      const state = args?.state
      if (typeof state !== 'string' || state.length === 0) {
        throw new Error('`state` must be a non-empty string')
      }
      const maxStateChars = Number(cfg?.maxStateChars) || 40000
      if (state.length > maxStateChars) {
        throw new Error(
          `state is ${state.length} characters; this plugin allows ${maxStateChars}. Split it into several calls.`,
        )
      }
      const questions = validateQuestions(args?.questions, Number(cfg?.maxQuestions) || 200)

      const endpoint = resolveEndpoint(cfg)
      if (endpoint.error) throw new Error(endpoint.error)

      const apiKey = await resolveApiKey(getCredentials?.(), endpoint.credential, cfg?.apiKey)
      if (!apiKey) {
        throw new Error(
          `no API key for provider "${endpoint.id}". Open Settings → Jev and save one, or export ${endpoint.credential}.`,
        )
      }

      const payload = await callJev({
        url: endpoint.url,
        model: endpoint.model,
        apiKey,
        state,
        questions,
        timeoutMs: Number(cfg?.timeoutMs) || 60000,
        signal: exec?.signal,
      })
      return { text: formatAnswers(payload, Object.keys(questions)), answers: payload.answers ?? {} }
    },
  }
}

/**
 * Credentials-first, then the legacy settings field, then the environment.
 * The credentials store is DSH's own secret home, so it wins.
 */
export async function resolveApiKey(credentials, credentialKey, settingsValue) {
  if (credentials !== undefined && credentials !== null) {
    try {
      const resolved = await credentials.resolve(credentialKey)
      if (resolved?.value) return resolved.value
    } catch {
      // fall through: an unavailable store must not break an env-configured setup
    }
  }
  if (typeof settingsValue === 'string' && settingsValue.length > 0) return settingsValue
  return process.env[credentialKey] ?? ''
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** The bridge is same-origin only; anything else must not read or write secrets. */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Settings + credentials bridge for the browser half.
 * Every route is POST, loopback-only, and shapes its own JSON.
 */
export function makeBridgeRoutes(deps) {
  const { getSettings, getConfig, getCredentials, probe } = deps

  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback requests only' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `POST only (got ${req.method ?? ''})` })
      return false
    }
    return true
  }

  const view = async () => {
    const settings = getSettings()
    const cfg = getConfig()
    const credentials = getCredentials()
    const descriptor = settings
      ?.describe?.({ redactSecrets: true })
      ?.find((candidate) => String(candidate.ns) === NS)
    const endpoint = resolveEndpoint(cfg)
    const credential = endpoint.credential ?? PROVIDERS.typesafe.credential
    let keyConfigured = false
    if (credentials) {
      try {
        const info = await credentials.describe(credential)
        keyConfigured = info?.configured === true
      } catch {
        keyConfigured = false
      }
    }
    return {
      ns: NS,
      revision: descriptor?.revision ?? 0,
      value: cfg ?? {},
      providers: Object.values(PROVIDERS).map((p) => ({
        id: p.id,
        label: p.label,
        keyHint: p.keyHint,
        credential: p.credential,
        url: p.url,
        model: p.model,
      })),
      credential,
      keyConfigured,
      envFallback: process.env[credential] ? true : false,
      endpointError: endpoint.error ?? null,
      writable: settings?.writable !== false,
    }
  }

  return [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        writeJson(res, 200, { ok: true, value: await view() })
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/mutate`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const settings = getSettings()
        if (!settings) {
          writeJson(res, 200, { ok: false, code: 'settings-unavailable', message: 'the settings service is not available' })
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined || !Array.isArray(body.ops)) {
          writeJson(res, 400, { ok: false, code: 'malformed', message: 'expected { ops: [...] }' })
          return
        }
        try {
          await settings.mutate(NS, body.ops, body.expectedRevision)
        } catch (error) {
          const conflict = error?.code === 'SETTINGS_CONFLICT'
          writeJson(res, 200, {
            ok: false,
            code: conflict ? 'settings-conflict' : 'settings-rejected',
            message: String(error?.message ?? error),
          })
          return
        }
        writeJson(res, 200, { ok: true, value: await view() })
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/key-set`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const credentials = getCredentials()
        if (!credentials) {
          writeJson(res, 200, { ok: false, code: 'credentials-unavailable', message: 'the credentials service is not available' })
          return
        }
        const body = await readJsonBody(req)
        const value = typeof body?.value === 'string' ? body.value.trim() : ''
        if (value.length === 0) {
          writeJson(res, 400, { ok: false, code: 'malformed', message: 'value is required' })
          return
        }
        const endpoint = resolveEndpoint(getConfig())
        const ref = endpoint.credential ?? PROVIDERS.typesafe.credential
        try {
          await credentials.set(ref, value)
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'credentials-write-failed', message: String(error?.message ?? error) })
          return
        }
        writeJson(res, 200, { ok: true, value: await view() })
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/key-unset`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const credentials = getCredentials()
        if (!credentials) {
          writeJson(res, 200, { ok: false, code: 'credentials-unavailable', message: 'the credentials service is not available' })
          return
        }
        const endpoint = resolveEndpoint(getConfig())
        const ref = endpoint.credential ?? PROVIDERS.typesafe.credential
        try {
          await credentials.unset(ref)
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'credentials-write-failed', message: String(error?.message ?? error) })
          return
        }
        writeJson(res, 200, { ok: true, value: await view() })
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/test`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, { ok: true, value: await probe() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'probe-failed', message: String(error?.message ?? error) })
        }
      },
    },
  ]
}

export function apply(ctx, config) {
  let current = () => config ?? {}
  const logger = ctx.logger
  // The credentials service can mount after this plugin (cross-bundle order),
  // so read it lazily instead of caching it during apply.
  const getCredentials = () => ctx.get('credentials')

  const probe = async () => {
    const cfg = current()
    const endpoint = resolveEndpoint(cfg)
    if (endpoint.error) throw new Error(endpoint.error)
    const apiKey = await resolveApiKey(getCredentials(), endpoint.credential, cfg.apiKey)
    if (!apiKey) throw new Error(`no API key configured for "${endpoint.id}"`)
    const started = Date.now()
    const payload = await callJev({
      url: endpoint.url,
      model: endpoint.model,
      apiKey,
      state: 'The build failed with exit code 1.',
      questions: {
        passed: { type: 'noul', instructions: 'Did the build succeed?' },
        severity: {
          type: 'choice',
          instructions: 'How severe is this failure?',
          criteria: { none: 'no failure at all', fatal: 'the build did not produce output' },
        },
      },
      timeoutMs: Number(cfg?.timeoutMs) || 60000,
    })
    return {
      provider: endpoint.id,
      model: payload?.model ?? endpoint.model,
      latencyMs: Date.now() - started,
      inputTokens: payload?.usage?.input_tokens ?? payload?.usage?.inputTokens ?? null,
      answers: payload?.answers ?? {},
    }
  }

  ctx.inject(['settings'], (sctx) => {
    if (typeof sctx.settings.installSection !== 'function') {
      sctx.logger?.warn?.('jev: this dsh-settings build has no installSection; Settings → Jev will not appear')
      return
    }
    sctx.settings.installSection(ctx, NS, Config, config ?? {}, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {},
    })
  })

  ctx.inject(['webServer', 'settings'], (sctx) => {
    sctx.effect(() => {
      const disposers = makeBridgeRoutes({
        getSettings: () => sctx.settings,
        getConfig: () => current(),
        getCredentials,
        probe,
      }).map((route) => sctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-jev: settings bridge')
  })

  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => sctx.tools.register(makeTool(getCredentials, () => current())), 'dsh-jev: tool')
    logger?.info?.('jev: the `jev` tool is registered')
  })
}

export default { name, inject, apply, Config }
