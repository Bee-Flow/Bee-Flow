---
title: Frappe CRM
---

# Frappe CRM

[Frappe CRM](https://frappe.io/crm) is an open-source CRM built on the Frappe framework, available on Frappe Cloud or self-hosted. With this integration chat, agents, automations and apps can read and update leads, deals, contacts, organisations, tasks and notes.

The integration works with an **API key and secret of one Frappe user**. Bee Flow acts as that user, so Frappe's own roles and permissions decide what it may see and change. It **never deletes** records: the tool set has no delete operation, and its unit tests assert that.

## Setup

1. In Frappe, open the user Bee Flow should act as. A dedicated API user with a CRM role (Sales User or Sales Manager) is recommended, so you can see in Frappe what Bee Flow changed and narrow its access.
2. Go to **Settings → API Access** of that user and click **Generate Keys**. Frappe shows the API secret **once**: copy it together with the API key.
3. In Bee Flow, go to **Settings → Connections → Frappe CRM**, enter the address of your site (for example `https://yourcompany.frappe.cloud` or `https://crm.example.com`), the API key and the API secret, click **Test connection** and save. The test shows which Frappe user the key logs in as.

The values are stored per user and encrypted at rest (AES-256-GCM). The secret is never shown again, never written to a log and never sent to the model. The connection is deliberately **not lendable**: a key writes as one Frappe user, so it is never shared between Bee Flow users. Each user connects their own key.

### Self-hosted Frappe on a private network

- On a **self-hosted Bee Flow** (`DEPLOYMENT_MODE` other than `cloud`), a Frappe site on a private or LAN address works as is.
- In **cloud mode** a private address is refused. The operator can allow it with `FRAPPE_CRM_ALLOW_PRIVATE_HOSTS=1`, or allow specific hosts by listing them in `FRAPPE_CRM_ALLOWED_HOSTS` (comma-separated).
- When `FRAPPE_CRM_ALLOWED_HOSTS` is set, **only** the listed hosts can be used.
- Link-local and cloud metadata addresses (such as `169.254.169.254`) are refused in every mode.
- On a private address Bee Flow does not follow redirects: enter the final address of the site, usually the one starting with `https://`.

## Tools

| Tool | Purpose |
|------|---------|
| `frappe_crm_list_leads` | List or search leads; filter by status or owner. |
| `frappe_crm_get_lead` | One lead with all its fields. |
| `frappe_crm_list_deals` | List or search deals; filter by status, organisation or owner. |
| `frappe_crm_get_deal` | One deal with all its fields. |
| `frappe_crm_list_contacts` / `frappe_crm_get_contact` | Contacts (people). |
| `frappe_crm_list_organizations` / `frappe_crm_get_organization` | Organisations (companies). |
| `frappe_crm_list_tasks` | Tasks, optionally only those of one lead or deal. |
| `frappe_crm_list_notes` | The notes of one lead or deal. |
| `frappe_crm_list_statuses` | The statuses a lead or a deal can have, in pipeline order. |
| `frappe_crm_create_lead` / `frappe_crm_update_lead` | Create a lead; change fields of a lead, its status included. |
| `frappe_crm_create_deal` / `frappe_crm_update_deal` | Create a deal; change fields of a deal, its status and value included. |
| `frappe_crm_add_note` | Add a note to a lead or a deal. |
| `frappe_crm_create_task` | Create a task, optionally linked to a lead or a deal. |

The list tools return a small default set of fields; pass `fields` with Frappe field names (custom fields such as `custom_region` included) to get others. Use the names from `frappe_crm_list_statuses` as status values.

In automations the write tools count as side effects: a dry run simulates them, and the first unattended run asks for confirmation.

## Use cases

- "Which deals in Negotiation have an expected closure date this month?"
- "Create a lead for the person who wrote this e-mail, and add a note with the summary."
- "Move deal CRM-DEAL-2025-00012 to Won and create a follow-up task for next Monday."
- (Automation) Every morning, list yesterday's new leads and post a summary to a team chat.

## Limits and behaviour

- **Page size**: 20 records by default per call, at most `FRAPPE_CRM_MAX_PAGE_SIZE` (default 500; `0` means unlimited). When more records exist the result says `has_more: true` and names the `offset` for the next page.
- **Output budget**: about 60,000 characters per call (`FRAPPE_CRM_MAX_OUTPUT_CHARS`, `0` means unlimited); records beyond that are left out with a message. Long text values are cut at 4,000 characters.
- **Timeout**: 30 seconds per request (`FRAPPE_CRM_TIMEOUT_MS`).
- **Record types**: only leads, deals, contacts, organisations, tasks and notes (and the two status lists). The tools cannot reach other Frappe DocTypes.
- **Writes**: only the fields each tool lists are sent. Frappe validates them as it does for a user in the CRM.
- **Personal data**: CRM records hold names, e-mail addresses and phone numbers. They are handled like any other tool result, including the Privacy Shield. Log lines name the tool and the HTTP status only, never record content.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Frappe CRM is not connected` | Site address, API key or secret is missing | Fill in all three in Settings → Connections. |
| `the API key and secret were refused (HTTP 401)` | Wrong key or secret, or the keys were regenerated | Generate new keys in Frappe and enter both again. |
| `not permitted (HTTP 403)` | The Frappe user lacks a CRM role or access to that record type | Give the user a CRM role in Frappe. |
| `not found (HTTP 404)` | Wrong record name, or the site does not run Frappe CRM | Check the record name; check that the CRM app is installed. |
| `HTTP 417: ...` | Frappe refused the values, for example an unknown status | Use a status from `frappe_crm_list_statuses` and check the fields. |
| `private network address` | The site is on a private address and the server runs in cloud mode | See "Self-hosted Frappe on a private network" above. |
| `answered with a redirect` | The address redirects (for example `http://` to `https://`) | Enter the final address of the site. |

## Not included

Deleting records, other Frappe DocTypes, call logs, e-mail and WhatsApp messages, and Frappe webhooks as automation triggers are out of scope for now.
