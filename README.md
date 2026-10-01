# Foundry Claude Code Proxy

Claude Code speaks the Anthropic Messages API. It does not speak OpenAI's Chat Completions or Responses APIs, so it cannot call the GPT models you deploy in Microsoft Foundry. This process sits on `127.0.0.1` and translates. Claude Code keeps its tools, sessions, and model picker. Foundry runs the model.

```
Claude Code  →  127.0.0.1:8081  →  your Foundry resource
```

You bring the resource, the deployments, and the key. This repository does not point at a live account.

## Why

Foundry exposes GPT models through OpenAI-compatible HTTP. Claude Code will not send that shape of request. Pointing `ANTHROPIC_BASE_URL` at a Foundry URL fails, because the paths, bodies, and tool format are different.

The gap shows up as soon as Claude Code does real work. It always sends function tools. On GPT-6, Foundry's Chat Completions API rejects function tools combined with reasoning and returns HTTP 400. The same models accept both on the Responses API. The proxy detects that case and sends it there, with reasoning left on. A request that has no tools can stay on Chat Completions.

## Configure

The resource group is only an Azure billing boundary. The proxy has no resource-group setting. The project endpoint already identifies the resource.

| Value | Variable | Where you copy it from |
| --- | --- | --- |
| API key | `AZURE_OPENAI_API_KEY` | Foundry resource → Keys and Endpoint → Key |
| Endpoint | `AZURE_OPENAI_ENDPOINT` | Project endpoint, including `/openai/v1` |
| Allowed host | `AZURE_OPENAI_ALLOW_HOSTS` | Hostname only, the same host as the endpoint |
| Default deployment | `AZURE_OPENAI_DEPLOYMENT` | Deployment name in your Foundry project |
| Haiku and Sonnet | `AZURE_OPENAI_DEPLOYMENT_HAIKU`, `AZURE_OPENAI_DEPLOYMENT_SONNET` | Deployment used when Claude Code selects those families |
| Opus and Fable | `AZURE_OPENAI_DEPLOYMENT_OPUS`, `AZURE_OPENAI_DEPLOYMENT_FABLE` | Deployment used when Claude Code selects those families |

Put them in `.env` in this directory. The first `npm start` creates that file from `.env.example`. It is gitignored.

```bash
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_ENDPOINT=https://YOUR_RESOURCE.services.ai.azure.com/openai/v1
AZURE_OPENAI_ALLOW_HOSTS=YOUR_RESOURCE.services.ai.azure.com
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
AZURE_OPENAI_DEPLOYMENT_HAIKU=your-deployment-name
AZURE_OPENAI_DEPLOYMENT_SONNET=your-deployment-name
AZURE_OPENAI_DEPLOYMENT_OPUS=your-deployment-name
AZURE_OPENAI_DEPLOYMENT_FABLE=your-deployment-name
```

A Foundry resource uses `services.ai.azure.com`. A classic Azure OpenAI resource uses `openai.azure.com`. Use the endpoint the portal shows. The path stays `/openai/v1`. If the allowlist is omitted, the proxy allows the hostname of that endpoint and no other host. `YOUR_RESOURCE` and `your-deployment-name` are rejected at startup so a copied template cannot run by accident.

Deployment names are the names you chose when you deployed a model. They can differ from the model id. An example, if those deployments exist in your project:

| Claude Code family | Example Foundry deployment |
| --- | --- |
| Haiku, Sonnet | `gpt-6-luna` |
| Opus, Fable | `gpt-6.1-sol` |

Optional variables:

| Variable | Default |
| --- | --- |
| `AZURE_PORT` | `8081` |
| `AZURE_DAILY_TOKEN_CEILING` | `20000000` tokens per UTC day |
| `AZURE_MAX_OUTPUT_TOKENS` | `128000` |
| `AZURE_REASONING_EFFORT` | empty; the request's effort is used |
| `API_KEY` | empty; set it only to require a bearer token on this proxy |

`config.example.json` can replace `.env` for everything except the key. Copy it to `~/.config/foundry-claude-proxy/config.json`. Do not put the key in that file.

## Models

Current Claude API aliases, from the [models overview](https://platform.claude.com/docs/en/models/overview):

| Family | API id | Claude Code pin |
| --- | --- | --- |
| Fable 5.1 | `claude-fable-5-1` | `ANTHROPIC_DEFAULT_FABLE_MODEL` |
| Opus 5.5 | `claude-opus-5-5` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| Sonnet 5.5 | `claude-sonnet-5-5` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| Haiku 4.5 | `claude-haiku-4-5` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |

Haiku 4.5 is still the current Haiku. Opus 5.5 needs Claude Code v2.1.280 or later. Sonnet 5.5 needs v2.1.284 or later. Fable 5.1 needs v2.1.257 or later. See [Claude Code model configuration](https://code.claude.com/docs/en/model-config).

On a custom base URL, Claude Code can otherwise keep an older alias. Set the four variables so `/model opus` and the family aliases resolve to these ids. The proxy still accepts the previous ids (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-fable-5`, and the `[1m]` suffix). A name is routed by family: `fable`, then `opus`, then `sonnet`, then `haiku`. Any other non-empty name is sent through as a deployment name. The response echoes the model string Claude Code sent.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8081",
    "ANTHROPIC_AUTH_TOKEN": "local",
    "ANTHROPIC_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable-5-1"
  }
}
```

Put that in `~/.claude/settings.json`. Set `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, not both. `local` is a label for this proxy. It is not the Foundry key.

`/effort low`, `medium`, `high`, and `xhigh` are forwarded on the next request as Foundry `reasoning.effort`. `max` is not. `AZURE_REASONING_EFFORT` overrides the request and needs a restart of the proxy.

The usage page Models tab lists the four models in Claude Code’s picker: Haiku 4.5, Sonnet 5.5, Opus 5.5, and Fable 5.1. Each one can be pointed at GPT-6 Luna, GPT-6 Sol, GPT-6.1 Sol, or GPT-6 Astra. Deploy that model in your Foundry project before you select it. Confirm the change, then restart Claude Code. The proxy applies the mapping immediately. The open Claude Code session keeps the previous choice until it restarts. Exact ids win over the family default, so Sonnet 4.6 can use a different deployment from Sonnet 5.5.

## Run

Node.js 18 or newer.

```bash
npm install
npm start
```

The first start writes `.env` and exits until the key, endpoint, and deployment names are real. Later sessions are only `npm start`. Values already exported in that shell are saved into `.env` for the next window.

Bind address is `127.0.0.1`. If Claude Code runs in WSL, run the proxy in that same WSL. Stop it with Ctrl+C.

## What the translation does

Claude Code posts to `/v1/messages`. The proxy does not call Google, and it does not use Azure login. The Foundry key goes out once, as the `api-key` header.

A GPT-6 deployment with tools is posted to `{endpoint}/responses`. The body uses `reasoning.effort`, flattened function tools, `function_call` and `function_call_output` items, and `max_output_tokens`. That is the combination Chat Completions rejects. Other calls use `{endpoint}/chat/completions`. On `gpt-5.6`, tools force `reasoning_effort` to `none`, because that model rejects tools any other way on Chat Completions.

Effort is chosen in this order: `AZURE_REASONING_EFFORT`, then `output_config.effort` (also `effort` or `effort_level`) when it is `none`, `low`, `medium`, `high`, or `xhigh`, then the thinking budget (`low` under 8,000, `high` at 32,000 or more, otherwise `medium`). Temperature, `top_p`, and `top_k` are omitted. Claude Code thinking blocks are removed on the way in and are not invented on the way back. Reasoning tokens stay inside output usage.

Tool names longer than 64 characters are shortened on the way out and restored when the model calls them. Anthropic server tools such as web search are dropped so the turn still runs. JSON Schema is reduced to the fields Foundry accepts. `cache_control` is removed. Foundry's own cache reads and cache writes are mapped back onto the Anthropic usage fields. Image bytes are sent as data URLs. Remote image URLs are not fetched.

`/v1/messages/count_tokens` is a local estimate. It does not call Foundry. If the client disconnects, the upstream request is aborted. Heartbeats to `/` and `/api/event_logging/batch` stay local.

The daily ceiling counts Azure `total_tokens` for the UTC day, including cache reads. Over the ceiling the proxy returns HTTP 429 and does not call Foundry. Usage files live in `~/.config/foundry-claude-proxy`.

## Usage page

[http://127.0.0.1:8081/](http://127.0.0.1:8081/)

Requests shows fresh input, cache read, cache write, output, and reasoning. Graphs plots those same UTC days for request count, token split, and estimated cost. Cost estimates USD from the published OpenAI Standard list rates for known GPT-6 names. It is not the Azure invoice. Above 272,000 input tokens, the long-context rate applies to the whole request. A cache-write token is charged at the write rate instead of the fresh-input rate. The month is UTC, from the 1st through today.

An Azure budget on the resource group sends mail. It does not stop spend. The token ceiling here, and the deployment's tokens-per-minute quota, are the limits that stop a call.

## Security

The key is not logged, not stored on the usage page, and not accepted in a URL. Redirects are rejected. Details are in [SECURITY.md](SECURITY.md).

## Development

```bash
npm test
```

Tests talk to a local mock. They do not call Foundry and they do not need a key.

## License

[MIT](LICENSE). Copyright (c) 2026 Deepam Tater.
