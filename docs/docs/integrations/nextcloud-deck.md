---
title: Nextcloud — Deck
---

# Nextcloud — Deck

[Nextcloud Deck](https://apps.nextcloud.com/apps/deck) is a kanban-board app. Bee Flow can read and write boards, stacks, cards, labels, comments.

| | |
|---|---|
| Integration ID | `nextcloud-deck` |
| Auth | NC session |
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
| `nextcloud_deck_update_card` | Edit title / description / due date / labels. |
| `nextcloud_deck_move_card` | Move between stacks (or boards). |
| `nextcloud_deck_assign_card` | Assign / unassign users. |
| `nextcloud_deck_add_comment` | Append a comment. |
| `nextcloud_deck_list_labels` | List labels on a board. |
| `nextcloud_deck_create_label` | Create a label. |

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
