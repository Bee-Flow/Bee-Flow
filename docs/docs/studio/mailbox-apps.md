---
title: Mailbox apps
---

# Mailbox apps

An app can read a Gmail or Outlook mailbox and show it as a work queue: a table of
conversations, a table of messages, a table of attachments, and a reading pane. This page
covers what the connector writes, how the reading pane shows it, and how an app can
process new mail by itself.

## The connector

Add a **Mailbox** connector in **Data → Connectors**. It reads with the Google or Microsoft
account you signed in with (no separate sign-in), as the app owner, on a schedule. With
**group into conversations** switched on it fills three tables:

| Table | One row per | Key columns |
|-------|-------------|-------------|
| Conversations | conversation | `thread_key`, `subject`, `requester_email`, `last_message_at` |
| Messages | message | `provider_message_id`, `thread_key`, `direction`, `body_text`, `body_html` |
| Attachments | attachment | `provider_attachment_id`, `filename`, `mime_type`, `is_inline`, `content_id`, `file` |

The shipped table shapes are offered when you create the tables. A sync writes only the
columns a table has, so a table you trimmed or built by hand keeps working.

Attachments are stored as a pending descriptor: nothing is downloaded during the sync.
The first person who opens a file (or an AI step that reads it) fetches it, and it is
scanned and stored in the app owner's storage like any other upload.

## Showing a conversation

The `message_thread` component is the reading pane. For a mailbox:

- `attachmentsSource` is a records binding on the attachments table, `attachmentMatchKey`
  is `provider_message_id` (the id both tables carry), and `attachmentLabelKey` is `filename`.
- `attachmentFileKey` is the file column of an attachment row (`file`). A chip with a file
  opens it in a new tab. The **onAttachmentClick** event fires instead when it is wired,
  with `{ item: <the attachment row> }`, for example to fill a `file_preview`.
- `inlineContentIdKey` is the column holding the Content-ID (`content_id`). With
  `attachmentFileKey` set, the `cid:` images in an HTML mail are shown from the app's own
  files instead of being blocked.

### Inline images

A logo in a signature or a pasted screenshot is an inline image. It is stored as an
attachment row with `is_inline` true and its Content-ID in `content_id`. The materialize
endpoint (`POST /api/studio-apps/:id/data/attachments/materialize`) refuses inline images
unless the body says `"inline": true`, and then only for png, jpeg, gif and webp; an
inline SVG stays refused. The bytes are checked against the file type as for any
attachment.

### Apps built before `content_id` existed

The sync fills `content_id` only when the attachments table has that column. An existing
app keeps syncing without it; inline images then stay blocked in the reading pane. To
turn them on, add a **text** column with the key `content_id` to the attachments table
(Data → Tables, or `app_upsert_table` over MCP). The next sync fills it for the
attachments it sees again.

## Processing new mail automatically

By default an app acts only on a click. A mailbox connector can also run **one app action
for every new row** after a sync, on the server, with the new row in scope as `item`:
summarise an incoming request with an AI step, set a status, log it to another table.

Set it in the connector editor under **When new mail arrives**, or over MCP with
`app_set_mailbox_hook`. The setting on the connector is:

```json
"onNewRecord": { "actionId": "act_triage", "target": "inbound_message" }
```

- **`target: "thread"`** runs once for each new conversation (needs **group into
  conversations**). A new message in a conversation you already have does not run it.
- **`target: "inbound_message"`** runs for each new message that came **in**; mail the
  team sent does not run it.

It is **off** by default. Clear it by choosing *Nothing* (or `actionId: null` over MCP).

### What the action may contain

The action runs without anybody pressing a button, so it may only hold steps that run on
the server and do not reach a person: `create_record`, `update_record`, `ai_generate`,
`ai_extract`, `kb_query`, `dataset_query`, `file_intake`, `generate_file`, `fill_document`,
`generate_presentation` and `redact_pdf`, with `condition` and `switch` around them. Results
pass from step to step through `resultVar`, as in a click.

**`send_email` is never allowed**, so nothing mails automatically by accident. The same goes
for `run_automation`, `request_approval`, `delete_record`, `ai_browse` and the steps that only
make sense in a browser. Replies stay a button that a person presses. This is checked when
the app is published (an action with a refused step fails validation, naming the step), when
the hook is set over MCP, and again right before every run, because the action may have been
edited after the connector was saved.

### How it runs

- After the sync, once its claim is released, so a slow model call never holds the connector.
- As the app owner, through the same executor as a click: row access, quotas and the AI
  budget apply. The live (published) copy of the app is used when there is one.
- Rows are processed one at a time. A failing step ends that row's run; the next row still
  runs. An error never fails the sync.
- Only **new** rows count. Mail already in the table when you switch the hook on is not
  processed. The first sync of a new connector counts the whole lookback window as new,
  within the caps below.

### Limits

| Variable | Default | Meaning |
|----------|---------|---------|
| `STUDIO_MAILBOX_HOOK_MAX_PER_SYNC` | 50 | Most runs one sync of one connector starts |
| `STUDIO_MAILBOX_HOOK_MAX_PER_MINUTE` | 60 | Most runs one app starts within a minute |

`0` means unlimited. A row over a cap is **not** retried, because a later sync no longer
finds it new; it is recorded as `skipped_limit`.

### The run log

Every run leaves one line in the audit log: `studio_app_mailbox_hook_ok`, `_failed`,
`_refused` (the action was not allowed at run time) or `_skipped_limit`, with the app, the
connector, the action, the id of the row and a short error. The mail itself is never
copied into the log. The steps leave their own usage records (for example the AI calls), as
they do on a click.
