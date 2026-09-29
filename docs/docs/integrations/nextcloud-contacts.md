---
title: Nextcloud — Contacts
---

# Nextcloud — Contacts

CardDAV-backed contact lookup.

| | |
|---|---|
| Integration ID | `nextcloud-contacts` |
| Auth | NC session |
| Required scope | `CONTACTS`, `DAV` |
| Source | `server/integrations/nextcloudContactsTools.js` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_contacts_list` | List address books. |
| `nextcloud_contacts_search` | Search by name / email / phone / org. |
| `nextcloud_contacts_get` | Fetch one contact by UID. |
| `nextcloud_contacts_create` | Add a new contact. |
| `nextcloud_contacts_update` | Update fields. |
| `nextcloud_contacts_delete` | Delete. |

## Endpoints (CardDAV)

```
PROPFIND /remote.php/dav/addressbooks/users/{uid}/
REPORT   /remote.php/dav/addressbooks/users/{uid}/{book}/
GET      /remote.php/dav/addressbooks/users/{uid}/{book}/{card}.vcf
PUT      /remote.php/dav/addressbooks/users/{uid}/{book}/{card}.vcf
DELETE   /remote.php/dav/addressbooks/users/{uid}/{book}/{card}.vcf
```

## vCard fields exposed

`FN`, `N`, `EMAIL`, `TEL`, `ORG`, `TITLE`, `BDAY`, `ADR`, `URL`, `NOTE`, `PHOTO`, `CATEGORIES`. Custom `X-*` fields are read but not written.

## Privacy

Contact details (email, phone, name, address) are exactly what the Privacy Shield redacts. With Standard mode, the assistant sees `[email_1]`, `[phone_1]` etc. when reading contacts, and you see real values on screen. With Strict mode, names and organisations also tokenise.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `404 Not found` | UID changed (NC re-imported a vCard) | Re-search by name. |
| `412 Precondition failed` | ETag stale | Re-fetch and retry. |
