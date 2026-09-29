---
title: Streaming (SSE)
---

# Streaming (SSE)

Chat responses stream over Server-Sent Events. The connection stays open until the assistant finishes its turn (including tool calls).

## Request

```http
POST /ai/chat
Accept: text/event-stream
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "agentId": "asst_default",
  "messages": [
    { "role": "user", "content": "Summarise yesterday's emails." }
  ],
  "conversationId": "conv_abc",
  "stream": true
}
```

For direct (no-agent) chat, POST to `/ai/chat/direct/stream` with the same payload shape (minus `agentId`).

## Event types

The full set of events the chat stream can emit:

| Event | Payload | When |
|-------|---------|------|
| `token` | `{"text": "..."}` | A model token (or chunk) for the visible reply. |
| `tool_call` | `{"id": "tc_1", "name": "...", "args": {...}}` | The model decides to call a tool. |
| `tool_result` | `{"id": "tc_1", "result": ...}` | The tool returned. |
| `tool_error` | `{"id": "tc_1", "error": "..."}` | The tool errored (timeout, 4xx, etc.). |
| `progress` | `{"label": "Reading file...", "percent": 33}` | Long-running tool gives progress. |
| `dlp_preview` | `{"decisionId":"dlp_...", "findings":[...], "redactedText":"...", "provider":{...}}` | Privacy Shield paused the stream and wants the user to confirm `redact`/`block`/`allow` for sensitive content. |
| `dlp_resolved` | `{"appliedChoice":"redact","redactedCount": 3, "categories":["email","phone"]}` | Privacy Shield applied a decision (either user-supplied or `auto_redact`). |
| `dlp_blocked` | `{"reason":"policy_block", "findings":[...]}` | Privacy Shield rejected the prompt — stream ends. |
| `privacy_token_map` | `{"tokenMap":{"[email_1]":"alice@..."}, "source":"dlp"}` | Token-to-original map for the redacted prompt (debug; only when `showRawPayload=true`). |
| `citation` | `{"sourceId": "...", "title": "...", "snippet": "..."}` | KB citation for the answer (when `includeSourceReferences=true`). |
| `done` | `{"messageId": "msg_abc", "usage": {"input": 1234, "output": 567}, "model": "claude-..."}` | Turn complete. |
| `error` | `{"code": "...", "message": "..."}` | Fatal error; stream closes. |

The connection always closes after `done` or `error`.

## Example transcript

```
event: token
data: {"text": "Looking"}

event: token
data: {"text": " for"}

event: tool_call
data: {"id": "tc_1", "name": "nc_files_search", "args": {"query": "Q3 report"}}

event: progress
data: {"label": "Searching files...", "percent": 50}

event: tool_result
data: {"id": "tc_1", "result": [{"path":"/Reports/Q3.pdf"}]}

event: token
data: {"text": " I found"}

event: token
data: {"text": " the Q3 report."}

event: citation
data: {"sourceId": "doc_123", "title": "Q3-2025-Report.pdf", "snippet": "..."}

event: done
data: {"messageId": "msg_abc", "usage": {"input": 1234, "output": 567}}
```

## Cancelling

Close the EventSource client-side — the browser sends a TCP FIN, and the server tears down the stream.

## Privacy Shield interactive flow

When Privacy Shield is configured with `piiAction: "ask"` and the user prompt contains sensitive content, the stream pauses and emits a `dlp_preview` event with a `decisionId`:

```
event: dlp_preview
data: {"decisionId":"dlp_lq3xz0_a1b2c3","findings":[{"label":"email","category":"email","source":"azure"}],"redactedText":"Email [email_1] about the contract.","provider":{"displayName":"Azure PII"}}
```

The client must resolve the decision:

```http
POST /api/chat/dlp-decision
Authorization: Bearer <jwt>
Content-Type: application/json

{ "decisionId": "dlp_lq3xz0_a1b2c3", "choice": "redact", "rememberForConversation": true }
```

`choice` is `redact` / `block` / `allow`. The decision queue resolves the paused promise and the original SSE stream resumes with the chosen action — emitting `dlp_resolved` on success or `dlp_blocked` (with `reason: "user_blocked"`) when the user picks `block`. Pending decisions time out after 60 seconds (fails closed → treated as `block`).

## Reconnection

The client should reconnect with `Last-Event-ID` to resume a turn:

```http
POST /ai/chat HTTP/1.1
Last-Event-ID: msg_abc:42
```

The server replays missed events from event 42 onward. Reconnects are best-effort — the model can't always re-emit identical tokens, but tool calls and citations are deterministic and replay perfectly.

## JavaScript client

```js
const eventSource = new EventSource('/ai/chat?token=' + jwt);

eventSource.addEventListener('token', e => {
  const { text } = JSON.parse(e.data);
  appendToOutput(text);
});

eventSource.addEventListener('tool_call', e => {
  const tc = JSON.parse(e.data);
  console.log('🛠', tc.name, tc.args);
});

eventSource.addEventListener('citation', e => {
  const cit = JSON.parse(e.data);
  showCitationCard(cit);
});

eventSource.addEventListener('done', e => {
  console.log('done', JSON.parse(e.data));
  eventSource.close();
});

eventSource.addEventListener('error', e => {
  console.error('stream error', e);
});
```

For non-EventSource clients (Node, fetch), use `fetch` with `Response.body.getReader()` and parse SSE chunks manually.

## Python client

```python
import requests, json
from sseclient import SSEClient

r = requests.post(
    "https://beeflow.example.com/ai/chat",
    headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
    json={"agentId": "asst_default", "messages": [...]},
    stream=True,
)

for event in SSEClient(r).events():
    if event.event == "token":
        print(json.loads(event.data)["text"], end="", flush=True)
    elif event.event == "tool_call":
        print(f"\n[tool_call] {json.loads(event.data)}")
    elif event.event == "done":
        print("\n[done]", json.loads(event.data))
        break
    elif event.event == "error":
        print("\n[error]", json.loads(event.data))
        break
```

## Buffering caveat

Reverse proxies often buffer SSE by default, which kills first-token latency. Configure them:

| Proxy | Setting |
|-------|---------|
| Nginx | `proxy_buffering off; proxy_read_timeout 600s;` |
| Caddy | nothing — Caddy never buffers SSE |
| Traefik | `--providers.docker.network=traefik` and disable buffering middleware |
| Cloudflare | Not always SSE-friendly — prefer non-buffering tier or self-hosted reverse proxy |

## Tokens vs text vs words

- `token` events carry **whatever the model streamed** — usually a few characters per event for fast models, longer chunks for slower models.
- The client should accumulate tokens into the visible reply as they arrive. Don't apply Markdown rendering until all tokens have arrived (or use a streaming-safe Markdown renderer).
- The total `usage.input` / `usage.output` counts in `done` are **token counts** as the provider counts them (per-model conventions vary).

## Where to next

- [REST reference](rest.md) — the non-streaming endpoints.
- [Authentication](auth.md) — token handling.
