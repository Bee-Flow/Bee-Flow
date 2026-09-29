---
title: vPlan
---

# vPlan

[vPlan](https://www.vplan.com/) is a planning and work-preparation platform: boards with stages, collections (jobs) that get planned into cards, resources with schedules, orders and time tracking.

The Bee Flow integration is **read-only**. Every tool issues a `GET` against the vPlan API — nothing is created, changed or deleted. That is enforced in the tool set itself (`server/integrations/vplanTools.js`) and asserted by its unit test.

## Setup

vPlan issues **two** values that are needed together — the API key *and* the API env. Both are shown once, side by side.

1. In vPlan, open **Settings → Developers** and click the **+** next to *API keys*. (API access is available from the **Basic** plan.)
2. Give the key a name and save. vPlan now shows the **API key** and the **API env** — copy both.
3. In Bee Flow, go to **Settings → Integrations → vPlan**, paste the API env and the API key, and save.

The pair is stored per user and encrypted at rest (AES-256-GCM). vPlan recommends rotating the key at least every 6 months.

The integration is deliberately **not lendable**: a vPlan API key unlocks the whole environment, so each user connects their own — the same rule as AFAS Profit and NMBRS.

## Tools

| Tool | Purpose |
|------|---------|
| `vplan_whoami` | Which vPlan environment the key is connected to; also the connection test. |
| `vplan_list_boards` | Boards with their stages, statuses, labels and custom fields. **Start here** — this is where the other tools' IDs come from. |
| `vplan_list_resources` | Plannable employees, machines and cells, with working hours per weekday. |
| `vplan_get_resource_availability` | Day-by-day hours available / worked / leave / absence for one resource, plus overlapping absences. |
| `vplan_list_activities` | Services and operations, with default duration, billable flag and hourly rate. |
| `vplan_list_collections` | Jobs, orders and projects — planned or waiting in the backlog. |
| `vplan_get_collection` | One collection in full, optionally with its cards, attachments, comments and checklists. |
| `vplan_list_cards` | The planned work items: dates, stage, status, resources. The main planning tool. |
| `vplan_get_card` | One card in full, plus its checklists and its relations to other cards. |
| `vplan_list_orders` | Sales, production, purchase, quotation and project orders. |
| `vplan_get_order` | One order plus its order rows. |
| `vplan_list_time_tracking` | Individual time entries. |
| `vplan_time_tracking_summary` | Aggregated hours, grouped by day, week, activity, collection, board, status or user. |
| `vplan_get_capacity` | Planned vs. available capacity per stage, resource, group or resource type. Times are in minutes. |
| `vplan_list_master_data` | Projects, items, relations, warehouses, users, groups and spaces. |

## Filtering and sorting

Every list tool accepts structured `filters` and `sort`, which Bee Flow translates into vPlan's own query syntax:

```
filters: [{ field: "start_date", operator: "gte", value: "2026-08-01" }]
   →  ?filter=start_date:gte:'2026-08-01'
```

Operators: `eq`, `not`, `gt`, `gte`, `lt`, `lte`, `has`, `contains`, `starts_with`, `ends_with`. Multiple filters combine with AND.

Sorting only works on the object's own fields, not on eager-loaded relations — that is a vPlan limitation.

## Use cases

- "What is planned on the Assembly board this week, and who is on it?"
- "Which resources have leave in September?"
- "Are we overbooked on the paint stage next month?"
- "How many hours did we write on order 10199, split per activity?"
- (Automation) Every Monday, post next week's planned cards per board to a Nextcloud Talk room.

## Limits and behaviour

- **Page size** is capped at 100 records per call (vPlan itself allows 1000). Large pages blow the model's context and are the documented cause of vPlan's own *memory exhausted* error. Ask for a narrower filter rather than a bigger page.
- **Rate limits** are reported by vPlan in the `RateLimit-*` headers. A rate-limited request is retried once, then reported as an error.
- **Maintenance**: vPlan answers with HTTP 303 or 503 during a release. Bee Flow reports this as "temporarily unavailable" and never follows the 303 (following it returns an HTML page with status 200).
- An unknown collection id makes vPlan return an **empty card list, not a 404**. `vplan_list_cards` says so explicitly in its result.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `the vPlan API key or environment is invalid or has been revoked` | Wrong or rotated key, or the env of a different environment | Re-copy both values from Settings → Developers. |
| `not allowed to read that data` | The key's permission set excludes that board or object | Check the key's board permission set in vPlan. |
| `rejected the request (check the filter fields and values)` | Filtering on a field that does not exist on that object | List the object first and filter on a field you can see in the result. |
| `temporarily unavailable` | vPlan release or maintenance | Retry later. |

## Not included

Writing to vPlan (creating or updating cards, collections, orders, time entries), uploading attachments, and registering webhooks are out of scope for this integration. Webhooks are vPlan's recommended mechanism for pushing changes into another system and would be the natural next step.
