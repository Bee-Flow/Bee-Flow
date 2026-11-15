---
title: SignRequest
---

# SignRequest

[SignRequest](https://signrequest.com) (now part of Box) for legally-binding e-signatures.

## Setup

1. Get an API token from your SignRequest dashboard.
2. In Bee Flow, open **Settings → Connections → SignRequest** and enter your SignRequest subdomain and the API token. They are stored per user as encrypted secrets.

## Tools

| Tool | Purpose |
|------|---------|
| `signrequest_send_document` | Send a document for e-signature via SignRequest. You can send a document by providing a publicly accessible URL to the file. The signers will receive an email with a link to sign the document. |
| `signrequest_list_documents` | List recent SignRequests. |
| `signrequest_check_status` | Check the signing status of a specific document by its UUID. Returns whether the document has been signed, declined, or is still pending. |
| `signrequest_cancel` | Cancel a pending signing. |

## Typical flow

```
signrequest_send_document → fileUrl (a public link to Contract.pdf) + signers[{email, first_name, last_name}]
(later) signrequest_check_status → signed
```

## Use cases

- "Send the NDA in `/Legal/NDA-acme.pdf` to bob@acme.com for signing."
- (Automation) On a Deck card moved to `Ready to sign`, send the attached contract.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Unauthorized` | API key invalid | Re-issue. |
| `Document too large` | >25 MB SignRequest cap | Split or compress. |
| `Signer email rejected` | Bounced address | Verify recipient. |
