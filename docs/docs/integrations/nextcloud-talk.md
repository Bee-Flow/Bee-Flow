---
title: Nextcloud — Talk
---

# Nextcloud — Talk

[Nextcloud Talk](https://apps.nextcloud.com/apps/spreed) (Spreed) is the chat / video-meeting app. Bee Flow can list rooms, post messages, react.

| | |
|---|---|
| Integration ID | `nextcloud-talk` |
| Auth | NC session |
| Required NC app | `spreed` |
| Required scope | `TALK` |
| Source | `server/integrations/nextcloudTalkTools.js` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_talk_list_rooms` | List rooms the user is in. |
| `nextcloud_talk_get_room` | Room details + participant list. |
| `nextcloud_talk_send_message` | Post a message. |
| `nextcloud_talk_list_messages` | Fetch the most recent messages from a Talk room. |
| `nextcloud_talk_search_messages` | Full-text search across rooms. |
| `nextcloud_talk_add_reaction` | Add an emoji reaction to a message. |
| `nextcloud_talk_remove_reaction` | Remove your own emoji reaction from a message. |
| `nextcloud_talk_delete_message` | Delete (soft-delete) a Talk message you sent. |
| `nextcloud_talk_mark_read` | Mark a Talk room as read up to the given message id. |
| `nextcloud_talk_share_file` | Share a file from Nextcloud Files into a Talk conversation, so it appears as an attachment rather than a link. |
| `nextcloud_talk_create_room` | Create a new public / group / one-to-one room. |
| `nextcloud_talk_list_participants` | List the participants of a Talk room (display names, actor ids, participant type, in-call flags). |
| `nextcloud_talk_create_poll` | Create a poll in a Talk conversation. |
| `nextcloud_talk_get_poll` | Read a poll's question, options and current results. |
| `nextcloud_talk_vote_poll` | Cast a vote on a Talk poll, as the connected user. |
| `nextcloud_talk_close_poll` | Close a poll so no further votes are accepted and the final result is published. |
| `nextcloud_talk_start_recording` | Start recording the active call in a Talk room. Moderator/owner only; requires the recording backend. |
| `nextcloud_talk_stop_recording` | Stop the active call recording in a Talk room. Moderator/owner only. |

## Endpoints

```
GET  /ocs/v2.php/apps/spreed/api/v4/room
POST /ocs/v2.php/apps/spreed/api/v4/room
GET  /ocs/v2.php/apps/spreed/api/v1/chat/{token}
POST /ocs/v2.php/apps/spreed/api/v1/chat/{token}
POST /ocs/v2.php/apps/spreed/api/v1/reaction/{token}/{messageId}
```

## Use cases

- "Post a message in `#engineering` thanking @alice for the PR."
- "Summarise yesterday's chat in `#general`."
- "Create a one-to-one room with bob and post 'are you free for 5 min?'."
- (Automation) On NC `UserCreatedEvent`, post a welcome in `#welcome`.

## Bots

Bee Flow can run as a Talk bot — give it a service account, set up a dedicated room, and route automation outputs there. See [Automations](../features/automations.md) for the trigger setup.

## Privacy

Message bodies are scanned by the Privacy Shield. In Strict mode, message author names tokenise as `[person_N]` to the model.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Room is read-only` | Talk room locked by mod | Mod unlocks. |
| `Cannot send to one-to-one with self` | Trying to message yourself | Use `nextcloud_notes_create` for self-notes. |
