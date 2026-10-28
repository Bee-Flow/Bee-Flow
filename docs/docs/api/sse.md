---
title: Streaming (SSE)
---

# Streaming (SSE)

Chat responses stream over Server-Sent Events. The connection stays open until the assistant finishes its turn (including tool calls).

## Request

Authentication is the same as for any other call: the session cookie, or a bridge token in
`X-Session-Token` (see [Authentication](auth.md)). The browser's `EventSource` cannot send a body,
so chat is a `POST` read with `fetch`. An agent that has embedding switched on also answers without a session.

```http
POST /agents/asst_default/chat/stream
Accept: text/event-stream
Content-Type: application/json

{
  "message": "Summarise yesterday's emails.",
  "conversationId": "conv_abc"
}
```

The agent id is in the path. `message` is the new user message and is required; `conversationId`
continues an existing conversation (leave it out to start one). The schema of every field the route
accepts is in the [endpoint reference](reference/agents.md).

For direct (no-agent) chat, `POST /ai/chat/direct/stream` with the same kind of body. The
[endpoint reference](reference/ai.md) lists the other streaming chat routes (notebooks, web pages,
templates).

## Event types

Events the chat streams emit, by their `event:` name. The set differs a little per chat surface, and
a client should ignore names it does not know.

| Event | Payload | When |
|-------|---------|------|
| `content` | `{"text": "..."}` | A chunk of the visible reply. Append them in order. |
| `thinking` | `{"text": "..."}` | A chunk of the model's reasoning, when the model shows it. |
| `tool_start` | `{"name": "...", "args": {...}}` | The model calls a tool. |
| `tool_end` | `{"name": "...", "result": ...}` | The tool returned (or was blocked by a privacy rule; the result then says so). |
| `conversation_created` | `{"conversationId": "..."}` | Direct chat: a new conversation was started for this turn. |
| `title_generated` | `{"title": "..."}` | Agent chat: a title was generated for the conversation. |
| `dlp_preview` | `{"decisionId":"dlp_...", "findings":[...], "redactedText":"...", "provider":{...}}` | Privacy Shield paused the stream and wants the user to confirm `redact`/`block`/`allow` for sensitive content. |
| `dlp_resolved` | `{"appliedChoice":"redact","redactedCount": 3, "categories":["email","phone"]}` | Privacy Shield applied a decision (either user-supplied or `auto_redact`). |
| `dlp_blocked` | `{"reason":"policy_block", "findings":[...]}` | Privacy Shield rejected the prompt — stream ends. |
| `privacy_token_map` | `{"tokenMap":{"[email_1]":"alice@..."}, "source":"dlp"}` | Token-to-original map for the redacted prompt (debug; only when `showRawPayload=true`). |
| `done` | the finished turn (the exact fields differ per chat surface) | Turn complete. |
| `error` | `{"error": "...", "code": "..."}` | Fatal error; stream closes. |

The connection closes after `done` or `error`.

## Example transcript

```
event: content
data: {"text": "Looking"}

event: content
data: {"text": " for"}

event: tool_start
data: {"name": "nc_files_search", "args": {"query": "Q3 report"}}

event: tool_end
data: {"name": "nc_files_search", "result": [{"path":"/Reports/Q3.pdf"}]}

event: content
data: {"text": " I found the Q3 report."}

event: done
data: {...}
```

## Cancelling

Abort the request on the client (`AbortController.abort()` on the `fetch`, or closing the
connection). The server notices the closed connection and stops the turn.

## Privacy Shield interactive flow

When Privacy Shield is configured with `piiAction: "ask"` and the user prompt contains sensitive content, the stream pauses and emits a `dlp_preview` event with a `decisionId`:

```
event: dlp_preview
data: {"decisionId":"dlp_lq3xz0_a1b2c3","findings":[{"label":"email","category":"email","source":"azure"}],"redactedText":"Email [email_1] about the contract.","provider":{"displayName":"Azure PII"}}
```

The client must resolve the decision:

```http
POST /api/chat/dlp-decision
Content-Type: application/json

{ "decisionId": "dlp_lq3xz0_a1b2c3", "choice": "redact", "rememberForConversation": true }
```

`choice` is `redact` / `block` / `allow`. The decision queue resolves the paused promise and the original SSE stream resumes with the chosen action — emitting `dlp_resolved` on success or `dlp_blocked` (with `reason: "user_blocked"`) when the user picks `block`. Pending decisions time out after 60 seconds (fails closed → treated as `block`).

## Reconnection

The chat streams do not resume. If the connection drops mid-turn, the turn is lost on the client:
fetch the conversation again (`GET /agents/:id/conversations/:convId`) to see what was saved, and
send the message again if needed. (Some other streams, such as the project activity feed, do
accept `Last-Event-ID` and replay what you missed.)

## JavaScript client

`EventSource` only does `GET`, so read the response of a `fetch` and split it into SSE frames yourself:

```js
const res = await fetch('/agents/asst_default/chat/stream', {
  method: 'POST',
  credentials: 'include', // the session cookie
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({ message: 'Summarise yesterday’s emails.' }),
});

const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buffer = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += value;
  let end;
  while ((end = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const event = /^event: (.*)$/m.exec(frame)?.[1];
    const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? 'null');
    if (event === 'content') appendToOutput(data.text);
    else if (event === 'tool_start') console.log('tool', data.name, data.args);
    else if (event === 'error') throw new Error(data.error);
  }
}
```

## Python client

A script has no browser session. Sign in with `POST /auth/admin-login` (the session cookie is kept
by `requests.Session`), or use the connector's signed JWT as described in
[Authentication](auth.md#scripted--server-to-server-access).

```python
import requests, json

s = requests.Session()
s.post("https://beeflow.example.com/auth/admin-login",
       json={"username": "alice@example.com", "password": "..."}).raise_for_status()

r = s.post(
    "https://beeflow.example.com/agents/asst_default/chat/stream",
    headers={"Accept": "text/event-stream"},
    json={"message": "Summarise yesterday's emails."},
    stream=True,
)

event = None
for line in r.iter_lines(decode_unicode=True):
    if line.startswith("event: "):
        event = line[len("event: "):]
    elif line.startswith("data: "):
        data = json.loads(line[len("data: "):])
        if event == "content":
            print(data["text"], end="", flush=True)
        elif event == "tool_start":
            print(f"\n[tool] {data['name']}")
        elif event in ("done", "error"):
            print(f"\n[{event}]", data)
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

## Chunks, not words

- `content` events carry **whatever the model streamed** — usually a few characters per event for fast models, longer chunks for slower models.
- The client should accumulate the chunks into the visible reply as they arrive. Don't apply Markdown rendering until all chunks have arrived (or use a streaming-safe Markdown renderer).

## Where to next

- [REST reference](rest.md) — the non-streaming endpoints.
- [Authentication](auth.md) — sessions and tokens.
