/**
 * Unit tests for the pure parts of dsh-jev.
 *
 * Run: node --test test/
 *
 * These cover the request shape, the provider resolution, the validation
 * messages a model will actually see, and the retry policy — the places where a
 * mistake turns into a silent wrong answer or a hung turn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROVIDERS,
  formatAnswers,
  isLoopbackRequest,
  resolveEndpoint,
  resolveApiKey,
  validateQuestions,
  callJev,
  RETRY_DELAYS_MS,
} from '../lib/index.js'

test('resolveEndpoint picks the documented endpoint per provider', () => {
  assert.equal(resolveEndpoint({ provider: 'typesafe' }).url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(resolveEndpoint({ provider: 'typesafe' }).model, 'jev-latest')
  assert.equal(
    resolveEndpoint({ provider: 'vercel-gateway' }).url,
    'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
  )
  assert.equal(resolveEndpoint({ provider: 'vercel-gateway' }).model, 'typesafe-ai/jev')
})

test('resolveEndpoint defaults to typesafe when unset', () => {
  assert.equal(resolveEndpoint({}).id, 'typesafe')
  assert.equal(resolveEndpoint(undefined).id, 'typesafe')
})

test('resolveEndpoint honours a model override but keeps the provider model otherwise', () => {
  assert.equal(resolveEndpoint({ provider: 'typesafe', model: 'jev-1.13.0' }).model, 'jev-1.13.0')
  assert.equal(resolveEndpoint({ provider: 'typesafe', model: '   ' }).model, 'jev-latest')
})

test('resolveEndpoint rejects an unknown provider with a usable message', () => {
  const result = resolveEndpoint({ provider: 'nope' })
  assert.match(result.error, /unknown provider "nope"/)
  assert.match(result.error, /typesafe/)
})

test('resolveEndpoint requires a usable URL for the custom provider', () => {
  assert.match(resolveEndpoint({ provider: 'custom' }).error, /needs a base URL/)
  assert.match(resolveEndpoint({ provider: 'custom', baseUrl: 'ftp://x' }).error, /http/)
  assert.equal(
    resolveEndpoint({ provider: 'custom', baseUrl: 'https://jev.internal/v1/systemone' }).url,
    'https://jev.internal/v1/systemone',
  )
})

test('validateQuestions normalises each question type', () => {
  const out = validateQuestions({
    a: { type: 'noul', instructions: 'Did it fail?' },
    b: { type: 'choice', instructions: 'Which?', criteria: { x: 'one', y: 'two' } },
    c: { type: 'score', instructions: 'How bad?', criteria: ['low', 'mid', 'high'] },
  })
  assert.deepEqual(Object.keys(out), ['a', 'b', 'c'])
  assert.equal(out.a.type, 'noul')
  assert.deepEqual(out.b.criteria, { x: 'one', y: 'two' })
  assert.deepEqual(out.c.criteria, ['low', 'mid', 'high'])
})

test('validateQuestions names the offending path', () => {
  assert.throws(() => validateQuestions({ q: { type: 'boolean', instructions: 'x' } }), /questions\.q\.type/)
  assert.throws(() => validateQuestions({ q: { type: 'noul' } }), /questions\.q\.instructions/)
  assert.throws(() => validateQuestions({ q: { type: 'choice', instructions: 'x' } }), /criteria must be an object/)
  assert.throws(
    () => validateQuestions({ q: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } }),
    /at least two options/,
  )
  assert.throws(
    () => validateQuestions({ q: { type: 'score', instructions: 'x', criteria: ['only'] } }),
    /at least two ordered labels/,
  )
})

test('validateQuestions rejects an empty, non-object or oversized map', () => {
  assert.throws(() => validateQuestions({}), /at least one question/)
  assert.throws(() => validateQuestions(null), /must be an object/)
  assert.throws(() => validateQuestions([]), /must be an object/)
  assert.throws(() => validateQuestions({ a: {}, b: {} }, 1), /too many questions \(2\)/)
})

test('formatAnswers renders every answer type and a usage footer', () => {
  const text = formatAnswers(
    {
      model: 'typesafe-ai/jev',
      answers: {
        n: { type: 'noul', noul: 0.9 },
        c: { type: 'choice', choice: 'billing', confidence: 0.31, probabilities: { billing: 0.54, tech: 0.46 } },
        s: { type: 'score', score: 2.5, confidence: 0.8, probabilities: { '0': 0, '1': 0.5, '2': 0.5 } },
      },
      usage: { input_tokens: 434, output_tokens: 97 },
    },
    ['n', 'c', 's'],
  )
  assert.match(text, /^n: 0\.9 \(yes\)/m)
  assert.match(text, /^c: billing \| confidence 0\.31/m)
  assert.match(text, /^s: 2\.5 \| confidence 0\.8/m)
  assert.match(text, /3 questions \| 434 input tokens \| model typesafe-ai\/jev/)
})

test('formatAnswers reports a missing answer instead of dropping it', () => {
  const text = formatAnswers({ answers: {} }, ['gone'])
  assert.match(text, /^gone: \(no answer\)/m)
})

test('formatAnswers accepts the gateway camelCase usage field', () => {
  const text = formatAnswers({ answers: {}, usage: { inputTokens: 12 } }, [])
  assert.match(text, /12 input tokens/)
})

test('resolveApiKey prefers the credentials store, then settings, then the environment', async () => {
  const credentials = { resolve: async (ref) => (ref === 'TYPESAFE_API_KEY' ? { value: 'from-store' } : undefined) }
  assert.equal(await resolveApiKey(credentials, 'TYPESAFE_API_KEY', 'from-settings'), 'from-store')
  assert.equal(await resolveApiKey({ resolve: async () => undefined }, 'TYPESAFE_API_KEY', 'from-settings'), 'from-settings')

  process.env.JEV_TEST_KEY = 'from-env'
  assert.equal(await resolveApiKey(undefined, 'JEV_TEST_KEY', undefined), 'from-env')
  assert.equal(await resolveApiKey(undefined, 'JEV_TEST_KEY', ''), 'from-env')
  delete process.env.JEV_TEST_KEY
})

test('resolveApiKey survives a credentials store that throws', async () => {
  const broken = {
    resolve: async () => {
      throw new Error('store unavailable')
    },
  }
  assert.equal(await resolveApiKey(broken, 'TYPESAFE_API_KEY', 'from-settings'), 'from-settings')
})

test('callJev sends the TypeSafe body shape', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ model: 'jev-latest', answers: {}, usage: {} }), { status: 200 })
  }
  await callJev({
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    apiKey: 'k',
    state: 'hello',
    questions: { q: { type: 'noul', instructions: 'x' } },
    fetchImpl,
  })
  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(seen.init.headers.authorization, 'Bearer k')
  assert.equal(seen.body.model, 'jev-latest')
  assert.equal(seen.body.state, 'hello')
  assert.deepEqual(Object.keys(seen.body.questions), ['q'])
})

test('callJev retries a 429 and succeeds on the second attempt', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) {
      return new Response('{"error":"busy"}', { status: 429, headers: { 'retry-after': '0' } })
    }
    return new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 1 } } }), { status: 200 })
  }
  const payload = await callJev({
    url: 'https://x/v1/systemone',
    model: 'm',
    apiKey: 'k',
    state: 's',
    questions: { q: { type: 'noul', instructions: 'x' } },
    fetchImpl,
  })
  assert.equal(calls, 2)
  assert.equal(payload.answers.q.noul, 1)
})

test('callJev does not retry a 400', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response('{"message":"bad question"}', { status: 400 })
  }
  await assert.rejects(
    callJev({
      url: 'https://x/v1/systemone',
      model: 'm',
      apiKey: 'k',
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
      fetchImpl,
    }),
    /HTTP 400/,
  )
  assert.equal(calls, 1)
})

test('callJev explains a rejected credential in terms the model can relay', async () => {
  const fetchImpl = async () => new Response('{"error":"invalid key"}', { status: 401 })
  await assert.rejects(
    callJev({
      url: 'https://x/v1/systemone',
      model: 'm',
      apiKey: 'bad',
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
      fetchImpl,
    }),
    /Settings → Jev/,
  )
})

test('the retry ladder is bounded and increasing', () => {
  assert.ok(RETRY_DELAYS_MS.length >= 3 && RETRY_DELAYS_MS.length <= 6)
  for (let i = 1; i < RETRY_DELAYS_MS.length; i++) {
    assert.ok(RETRY_DELAYS_MS[i] > RETRY_DELAYS_MS[i - 1])
  }
})

test('isLoopbackRequest accepts only loopback peers', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.100' } }), false)
  assert.equal(isLoopbackRequest({ socket: {} }), false)
  assert.equal(isLoopbackRequest({}), false)
})

test('every provider declares a credential name and a URL (except custom)', () => {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    assert.equal(provider.id, id)
    assert.ok(provider.credential.length > 0, `${id} needs a credential name`)
    assert.ok(provider.label.length > 0, `${id} needs a label`)
    if (id !== 'custom') assert.match(provider.url, /^https:\/\//, `${id} needs an https URL`)
  }
})
