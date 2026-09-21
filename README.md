# dsh-jev

Ask [Jev](https://typesafe.ai), a System One decision model, typed questions from
DeepSeek Harness and get structured answers with probabilities.

Jev returns **judgements, not prose**: every question is evaluated in parallel
against the same block of text, so a request carrying 50 questions costs about
the same and takes about as long as one carrying 1. That makes it a good fit for
the judgements a coding agent has to repeat over many items — log lines, tool
outputs, failing tests, search results, candidate files, review comments —
without pulling them all into the model's context or spawning a subagent to read
them.

## What it registers

| Surface | What it does |
| --- | --- |
| The `jev` tool | Sends `state` + `questions` and returns the typed answers, probabilities and confidence. |
| Settings → Plugins → **Jev** | Per-user provider choice, model override, custom endpoint, API key, and a **Test connection** button. |

## Install

The plugin is a DSH bundle: add the package and its patch to your profile, then
restart the service.

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: jev
      name: dsh-jev
      config:
        enabled: true
        provider: typesafe
```

Nothing else is required — the API key is entered in the UI, not here.

## Configure

Open **Settings → Plugins → Jev**.

1. **Provider** — where Jev is served from (see below).
2. **Model override** — optional; empty means the provider's default.
3. **Base URL** — only for the *Custom* provider.
4. **API key** — stored in the DSH **credentials store**, never in
   `settings.yaml`. The field shows whether a key is already configured.
5. **Test connection** — performs one real round trip and reports the resolved
   provider, model, latency, input tokens and the answers.

### Providers

| Provider | Endpoint | Default model | Credential / env fallback |
| --- | --- | --- | --- |
| TypeSafe (direct) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| Custom | your own URL | `jev-latest` | `JEV_API_KEY` |

Each provider has its own key, so switching provider switches which credential is
used. If you already exported the matching environment variable, no key needs to
be saved.

> **Evaluation is not served through the OpenAI- or Anthropic-compatible
> endpoints.** Both providers above expose a TypeSafe-compatible
> `POST …/v1/systemone`; a custom endpoint must implement the same contract.

## Using the tool

```jsonc
{
  "state": "### ITEM 1\nTypeError: x is undefined\n\n### ITEM 2\nAll 42 tests passed in 1.2s",
  "questions": {
    "item1_failed": { "type": "noul",   "instructions": "Does ITEM 1 report a failure?" },
    "item2_failed": { "type": "noul",   "instructions": "Does ITEM 2 report a failure?" },
    "worst": {
      "type": "choice",
      "instructions": "Which item is the failure?",
      "criteria": { "item1": "a code exception", "item2": "a passing run" }
    }
  }
}
```

| Question type | Answer |
| --- | --- |
| `noul` | `noul` — the probability of *yes*, 0–1 |
| `choice` | `choice`, `probabilities`, `confidence` |
| `score` | `score` (an ordered rubric, may fall between rungs), `probabilities`, `confidence` |

**Ask atomic questions.** Reference each item by a stable label (`### ITEM 7`)
and ask one question per item; a question about a whole document invites a guess.
Instructions and criteria are written in English; the state may be in any
language.

**Read the probabilities, not just the pick.** A flat distribution means it is
guessing; `confidence` between roughly 0.4 and 0.6 on a `noul` carries little
information. Measure `confidence` against your own workload before gating an
action on it — it is a statistic derived from the distribution, not a guarantee.

### When not to use it

- Writing, summarising, translating or reformatting text — it cannot generate.
- Exact string or arithmetic work — it is not a regex engine or a calculator.
- Anything needing extended multi-step reasoning — decompose into atomic
  questions and combine the answers in code instead.

## Configuration reference

The `jev` settings namespace accepts:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register the `jev` tool. |
| `provider` | `typesafe` | `typesafe`, `vercel-gateway` or `custom`. |
| `model` | *(provider default)* | Model id override. |
| `baseUrl` | — | Required by the `custom` provider. |
| `timeoutMs` | `60000` | Per-attempt request deadline. |
| `maxStateChars` | `40000` | Rejects oversized `state` with a message naming the limit. |
| `maxQuestions` | `200` | Rejects oversized question maps. |

Provider, model and limit fields can also be set directly in
`~/.dsh/settings.yaml`; the API key cannot, by design.

## Operational notes

- **The upstream answers `429` under load** ("the upstream provider is currently
  experiencing high demand"). The plugin retries with a 1s → 25s backoff and
  honours `Retry-After`; expect occasional slow calls and do not treat a retry as
  a failure.
- A rejected credential (401/403) is reported with a pointer to
  Settings → Jev rather than a raw status code.
- The Settings bridge is same-origin and **loopback-only**.

## Development

```bash
node --test test/
```

The suite covers endpoint resolution, question validation messages, answer
formatting, key precedence and the retry policy. `lib/index.js` has no runtime
dependency other than `@deepseek-ai/schemastery`.

## Licence

MIT.
