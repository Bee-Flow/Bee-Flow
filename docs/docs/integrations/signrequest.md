---
title: SignRequest
---

# SignRequest

[SignRequest](https://signrequest.com) (now part of Box) for legally-binding e-signatures.

## Setup

1. Get an API token from your SignRequest dashboard.
2. Set environment:
   ```bash
   SIGNREQUEST_API_KEY=<token>
   ```
3. Restart server.

## Tools

| Tool | Purpose |
|------|---------|
| `signrequest_send` | Send a document for signing. |
| `signrequest_list_documents` | List recent SignRequests. |
| `signrequest_get_status` | Check signing status. |
| `signrequest_cancel` | Cancel a pending signing. |
| `signrequest_download_signed` | Download the signed PDF. |

## Typical flow

```
nextcloud_read_file → "Contract.pdf"
signrequest_send → with signers[{email, name}]
(later) signrequest_get_status → completed
signrequest_download_signed → signed.pdf
nextcloud_upload_file → /Contracts/signed-Contract.pdf
```

## Use cases

- "Send the NDA in `/Legal/NDA-acme.pdf` to bob@acme.com for signing."
- (Automation) On a Deck card moved to `Ready to sign`, send the attached contract.

## Webhooks

SignRequest fires webhooks on completion. Configure the webhook URL to `https://your-host/webhook/signrequest` to receive completion events as automation triggers (Pro+).

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Unauthorized` | API key invalid | Re-issue. |
| `Document too large` | >25 MB SignRequest cap | Split or compress. |
| `Signer email rejected` | Bounced address | Verify recipient. |
