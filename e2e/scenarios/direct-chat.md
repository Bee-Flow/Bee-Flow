---
id: direct-chat
title: Direct chat sends a message and receives a real LLM reply
mode: generated+agentic-fallback
tags: [smoke, chat, llm]
requires: [llm]
timeout: 120000
auth: admin
cleanup: ""
---

## Steps

1. Navigate to `/app` (agents home). The chat composer
   (`chat-message-input`) is available for a new direct conversation.
2. Type exactly: `Reply with only the single word PONG and nothing else.`
3. Send the message (`send-message-button`).
4. Wait for the assistant to finish responding. While the answer streams, the
   stop button (`stop-generating-button`) may be visible; the response is
   complete when it disappears.

## Expected

- A user message bubble containing the sent text appears in the conversation.
- Within the timeout an assistant message appears whose text contains "PONG"
  (case-insensitive). Do not assert an exact match — models may add
  whitespace or punctuation.
- No error toast/banner is shown.
- The chat input is enabled again after the response completes.

## Notes for generation

- The response streams via SSE: use `expect(...).toContainText(...)` with the
  scenario timeout, never `waitForTimeout`.
- Use the composer and message testids from the app map.
