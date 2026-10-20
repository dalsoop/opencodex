---
title: Model Routing
description: How opencodex decides which provider serves a given model id.
---

When Codex asks for a model, `router.ts` resolves it to exactly one configured provider. The rules are
checked **in order**; the first match wins.

For OpenAI, a configured `<selector>/gpt-*` id maps through `codexAccountNamespaces` to exactly one
stored Codex account before combo or provider namespaces are considered. Bare `gpt-*` ids select
the canonical `openai` provider instead. Its `codexAccountMode` chooses Pool (default, main plus
added accounts) or Direct (current caller/main bearer) without changing the model id.
`openai-apikey/<model>` explicitly selects API-key transport. These credential routes do not fall
through to one another.

## Precedence

1. **Exact Codex account selector** — if the id is
   `<selector>/<native-openai-model>` and the selector is configured in `codexAccountNamespaces`,
   the request uses only the mapped stored account and sends the bare native model upstream.
   Unavailable exact targets fail closed instead of continuing through Pool, Direct, or provider
   routing.

   ```text
   side/gpt-5.6-sol → provider "openai", model "gpt-5.6-sol", account selector "side"
   ```

2. **Combo id or alias** — while at least one combo is configured, a canonical `combo/<id>` or
   configured combo alias selects its concrete target before provider namespaces are checked. With
   no configured combos, a legacy physical provider literally named `combo` remains a normal
   provider namespace. See [Combos](/guides/combos/) for target selection and failover behavior.

3. **Explicit `provider/model`** — if the id contains `/` and the part before it is the name of a
   configured provider, that provider is used and the id is stripped to the part after the slash.

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   This is the explicit routed-provider form, and the one Codex's model picker uses for routed
   models. If the same public id is a configured combo alias, rule 2 wins. If the named provider is
   disabled, this explicit form throws instead of routing.

4. **Bare native OpenAI-family id** — an id such as `gpt-*`, `o1-*`, `o3-*`, or `o4-*` uses the
   canonical enabled `openai` provider and its configured Pool or Direct account mode.

5. **A provider's `defaultModel`** — if any provider's `defaultModel` equals the id, that provider
   is used (id passed through unchanged).

6. **Built-in prefix patterns** — the id is matched against known model-family prefixes, then routed
   to a configured provider of that name (or name-prefix):

   | Prefixes | Provider |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

   This matcher is name-based and, unlike the `defaultModel` / `models[]` scans, currently does not
   filter a matching provider whose `disabled` flag is true.

7. **A provider's `models[]`** — if no prefix rule won and an active provider lists the id in its
   `models[]`, that provider is used. Rule 4 already sends a bare `gpt-*` id to the canonical enabled
   `openai` provider before another provider's `models[]` claim can match.

8. **Default provider** — if nothing matched, the id is sent to `config.defaultProvider` unchanged.
   (If no default provider is configured, or it is disabled, routing throws.)

## API keys and environment variables

Whatever route is chosen, the provider's `apiKey` is resolved through `resolveEnvValue()`: a value of
`${OPENAI_API_KEY}` or `$OPENAI_API_KEY` is expanded from the environment at request time, so secrets
never need to live in `config.json`.

## Catalog visibility and context caps

Routing and catalog visibility are separate controls:

- `disabledModels` hides namespaced routed ids from the Codex catalog and `/v1/models`; a bare native
  GPT slug is kept in the catalog with `visibility: "hide"`. It does **not** reject a direct request
  for that model.
- A provider's non-empty `selectedModels` is another catalog allowlist. Live discovery and direct
  routing still work; only catalog and `/v1/models` emission are narrowed.
- `modelDiscovery.newModelPolicy` defaults to `"off"`, including when omitted in an existing configuration. On the first successful live discovery, only the configured `defaultModel` starts visible; without a matching default, enable the models you need in **Models**. Saved model selections, per-model switches and short existing baselines are preserved. An existing unselected live catalog with at least 20 models and a configured default is narrowed to that default once; existing baselines without a default retain their visibility; later manual changes are not reset. Static/manual catalogs are unchanged. Later arrivals remain hidden until enabled. Explicit `"on"` opts into automatic exposure. This policy applies before `/v1/models`, client exports and Codex catalog publication; failed discovery changes no choices. Use `ocx models new-policy off` (optionally `--provider <name>`) and `ocx models new-arrivals --json`.
- `provider.disabled: true` removes that provider from catalog discovery. Explicit
  `provider/model` requests fail, and `defaultModel` / `models[]` scans skip it.
- Routed catalog rows are cloned from the Codex-native template, so native-only delivery flags are
  stripped during normalization: `supports_websockets`, `supports_reasoning_summaries`, and
  `supports_experimental_context`. A routed provider never inherits the experimental-context
  contract; inheriting it made Codex compact after nearly every step on long routed threads.
- `providerContextCaps` applies per-provider Codex-visible context caps. `contextCapValue` is the
  dashboard default (350,000 by default), but it does nothing by itself until a provider is
  present in `providerContextCaps`. Changing the dashboard value updates every enabled cap
  only when "apply to every routed provider" is toggled on; otherwise each provider keeps its own
  cap. Ordinary known windows can only be lowered; native models that support a longer window
  can expand up to their own supported ceiling. Caps never change the upstream model's actual limit.
  Switching a cap off retains its selection in `providerContextCapValues`, including after reload;
  switching it on restores that selection. A remembered selection never applies a limit while disabled.
  Sending `{ "setAll": true }` without `value` enables all configured providers at the current
  global value and replaces their remembered selections.
- A GitHub Copilot model that supports the upstream long-context tier can opt in with
  `providers.github-copilot.modelContextTiers.<model> = "long_context"` or
  `ocx provider edit github-copilot --model-context-tier <model>=long_context`.
  The tier sends `contextTier: "long_context"` on Copilot Chat and Responses requests.
  It raises the advertised window only when that exact model has a known per-model window
  in `modelContextWindows` (for example, `1000000`); an unknown model keeps its live window.
  An explicit per-model window wins, then the existing provider cap applies.
  Saved windows and tier selections survive startup and OAuth re-login. OAuth presets fill
  missing per-model defaults while keeping your configured entries, including on xAI.
  The `"default"` tier retains normal live context metadata.
  The dashboard control is planned separately.

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

## Tips

- **Target a Codex account explicitly** with `<selector>/<native-openai-model>` (rule 1). That route
  is exact and fails closed; it never silently switches to another account.
- **Be explicit for routed models.** Prefer `provider/model` (rule 3) when that exact public id is
  not a combo alias. It directly names the provider and matches what Codex shows in its picker after
  a catalog sync.
- **Seed `models[]` or `defaultModel`** on a provider so short ids (rules 5/7) resolve without the
  `provider/` prefix.
- **Prefix patterns are a convenience**, not a guarantee: they only resolve if a provider with that
  name (e.g. `anthropic` or `groq`) is actually configured.

See [Configuration](/reference/configuration/) for the provider fields these rules read.


## Structured output on Cursor routes

Cursor routes translate Responses `text.format` (`json_object` or `json_schema`) into explicit
final-answer instructions in the system context and active request, including tool-result
continuations. This is a prompt fallback: Cursor does not provide native constrained JSON decoding
on this transport, and models can still return an invalid answer. The adapter does not turn prose
into an approval decision. Auto-review callers should validate the returned JSON and use a
structured-output-capable route when strict enforcement is required. Ordinary text requests and
intermediate tool calls keep their existing behavior.
