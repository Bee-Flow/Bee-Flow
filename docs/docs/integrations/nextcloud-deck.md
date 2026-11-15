---
title: Nextcloud — Deck
---

# Nextcloud — Deck

[Nextcloud Deck](https://apps.nextcloud.com/apps/deck) is a kanban-board app. Bee Flow can read and write boards, stacks, cards, labels, comments.

| | |
|---|---|
| Integration ID | `nextcloud-deck` |
| Auth | NC session (through the connector), or an app password. An OAuth sign-in alone is not enough for Deck: see [No Docker on your Nextcloud host?](nextcloud.md#no-docker) |
| Required NC app | `deck` |
| Source | `server/integrations/nextcloudDeckTools.js` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_deck_list_boards` | All boards visible to the user. |
| `nextcloud_deck_get_board` | Board details + stacks + cards. |
| `nextcloud_deck_list_cards` | Cards in a board (or a stack). |
| `nextcloud_deck_get_card` | Card detail (title, description, labels, attachments, comments). |
| `nextcloud_deck_create_card` | Add a card to a stack. |
| `nextcloud_deck_update_card` | Update fields on a Deck card. Only provided fields change. Pass `targetStackId` to move the card between columns. |
| `nextcloud_deck_search_cards` | Search cards on a board by case-insensitive substring match against title and description. |
| `nextcloud_deck_archive_card` | Archive (or unarchive) a Deck card. |
| `nextcloud_deck_delete_card` | Delete a Deck card permanently. |
| `nextcloud_deck_add_comment` | Append a comment. |
| `nextcloud_deck_list_comments` | List comments on a Deck card (newest first). |
| `nextcloud_deck_assign_label` | Attach a label (by id) to a card. |
| `nextcloud_deck_remove_label` | Detach a label from a card. |
| `nextcloud_deck_list_stacks` | List the columns ("stacks") of a Deck board. Each stack carries the cards currently in that column. |
| `nextcloud_deck_create_stack` | Create a new column ("stack") on a Deck board. |
| `nextcloud_deck_update_stack` | Rename a stack or change its order. Only provided fields change. |
| `nextcloud_deck_delete_stack` | Delete a stack (column) from a Deck board. This also removes the stack's cards. |

## Endpoints

```
GET    /index.php/apps/deck/api/v1.0/boards
GET    /index.php/apps/deck/api/v1.0/boards/{id}
GET    /index.php/apps/deck/api/v1.0/boards/{id}/stacks/{sid}/cards/{cid}
POST   /index.php/apps/deck/api/v1.0/boards/{id}/stacks/{sid}/cards
PUT    /index.php/apps/deck/api/v1.0/boards/{id}/stacks/{sid}/cards/{cid}
DELETE /index.php/apps/deck/api/v1.0/boards/{id}/stacks/{sid}/cards/{cid}
POST   /ocs/v2.php/apps/deck/api/v1.0/cards/{cid}/comments
```

Deck's own API uses both `/index.php/apps/deck/api/v1.0` and `/ocs/v2.php/apps/deck/api/v1.0` for different endpoints — Bee Flow handles both transparently.

## Use cases

- "Move all cards labelled `bug` from `In Progress` back to `Triage`."
- "Summarise the Engineering board's open cards."
- "Create a card on the Marketing board for next week's release."
- (Automation) "Every Friday 17:00, post a Talk message listing cards completed this week."

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `403 Forbidden` on board | User isn't a member | Board owner shares with `Edit` access. |
| `Card not found` | Card was archived | Use `nextcloud_deck_list_cards` with `archived=true`. |
