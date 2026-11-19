---
title: 2BA
---

# 2BA

[2BA](https://www.2ba.nl) is a Dutch product and price data pool. Suppliers publish their articles there; a company that buys from them loads its condition files (its discount agreements) into the **2BA Online Condition Server (OCS)**, and 2BA then computes that company's **net purchase price** per article.

With this integration chat, agents, automations and apps look up articles at one supplier and get the net price 2BA computed, per line of a bill of materials. Bee Flow does not rebuild the discount rules: 2BA applies the conditions, Bee Flow reads the price per use unit, multiplies and flags the lines that need a look.

## What you need

- A **client id and client secret** from 2BA. 2BA issues them to software suppliers after registration; ask your Bee Flow supplier, or 2BA, for the ones to use.
- A **2BA account with the Online Condition Server**, with the condition files of your suppliers loaded (or upload them with `twoba_upload_conditions`, see below).
- The **GLN** of the supplier whose prices you want (13 digits, on the supplier's documents or in 2BA).

## Setup

1. In Bee Flow, go to **Settings → Connections → 2BA** and enter the client id and the client secret.
2. Choose how to sign in:
   - **2BA user name and password**: stored per user and encrypted at rest (AES-256-GCM), like the other connection secrets. Bee Flow asks 2BA for a new access token when the old one runs out.
   - **Sign in with 2BA**: save, register the redirect address the card shows with 2BA, and click **Sign in with 2BA**. You sign in at 2BA in a popup; Bee Flow keeps only the tokens (encrypted), never the password.
3. Click **Test connection**. It shows the 2BA company and the condition database the connection prices with.

The connection is per user and **not lendable**: prices come from one company's conditions, and the tools act as one 2BA user.

Access tokens of 2BA live about two minutes. Bee Flow reuses one until ten seconds before it expires and asks for one new token at a time, also when an automation prices many lines at once. A refresh token can be used once; when 2BA refuses it, the card says to sign in again.

## Tools

| Tool | Purpose |
|------|---------|
| `twoba_find_trade_items` | Price a bill of materials at one supplier: per line the article number and/or GTIN, quantity and unit. |
| `twoba_net_price` | The net price of one article, optionally for a project number and an order quantity. |
| `twoba_list_condition_databases` | The OCS databases of your company and the one the connection prices with. |
| `twoba_upload_conditions` | Upload a condition file (ICC 1.1 as `.txt`/`.icc`, or INSBOU/DICO `.xml`) into an OCS database. Writes; only inside an automation run. |

### Pricing a bill of materials

`twoba_find_trade_items` takes the supplier GLN, the lines and optionally a project number. Per line it returns:

- `status`: `matched`, `not_found`, `multiple` (more than one article for the code, for example several packagings) or `code_mismatch` (article number and GTIN point at different articles or packagings);
- the article with its units (use unit, order unit, price unit), packaging, status and successor;
- the price block from 2BA: gross and net price, `conditionId`, `scenario` (number and name) and `termsType`;
- `unitNetPrice`: the net price **per use unit** (per metre for a cable priced "per 100 m"), and `lineTotalExVat` = quantity × unit net price, rounded to cents once;
- `priceDate` (today) and `flags`;
- flat copies for a table or a sheet, where a nested object is one cell: `articleNumber`, `description`, `conditionId`, `scenarioName`, `termsType`, and `review`: the status when it is not `matched` and the flags as one text, empty when the line needs no look.

A line's unit (`m`, `mtr`, `st`, `stuks`, `pcs`, `rol`, `doos`, ...) is compared with the article's use unit. When it is unknown or another unit, the line is flagged and has no total: 2 "rol" of a cable sold per metre is not 2 metres.

| Flag | Meaning |
|------|---------|
| `no_price` | 2BA has no net price for the article. |
| `price_on_request`, `on_request` | Price on request (the article says so, or scenario 6). |
| `gross_only_no_condition` | Scenario 5: no condition matched, only the gross price applies. |
| `unit_unknown`, `unit_mismatch` | The line's unit is not recognised, or is not the use unit. |
| `multiple_matches`, `codes_disagree` | See the statuses above. |
| `discontinued` | Status 94E; the successor is on the article. |
| `price_calc_mismatch` | The price per use unit and the price per price unit ÷ units in the price basis differ by more than a cent. |
| `invalid_gtin`, `gtin_not_found`, `trade_item_id_not_found`, `price_lookup_failed` | A code was malformed or found nothing, or 2BA refused the price request for that line. |

The `summary` counts the lines per status and flag and adds up the priced lines.

### A bill of materials in an automation

A form with a file question (or an App Studio app that hands a file to an app trigger) starts the automation:

1. **Read table** on the uploaded file.
2. **Edit table**, **Select columns**: rename the list's columns to `ref` (the line number), `quantity`, `unit`, `tradeItemId` and `gtin`.
3. **Loop** over `steps.<edit>.output.table` with a batch size of 200 (the tool's `TWOBA_MAX_ITEMS`), with an action step `twoba_find_trade_items` whose `items` is `loop.<item>`. For a list of up to 200 lines the loop is not needed: bind `items` to `steps.<edit>.output.rows`.
4. **Edit table**, **Join** with `steps.<loop>.output.results[*].output.items` on `ref`, taking the columns you want (`description`, `unitNetPrice`, `lineTotalExVat`, `priceDate`, `conditionId`, `scenarioName`, `status`, `review`).
5. **Write table** as Excel, with **Mark rows** on `review`: the lines to check are coloured.

The App Studio template **Bill of materials pricing** records every calculation and its lines, offers the Excel download and keeps the history of condition file uploads. It runs two automations with an app trigger, which you connect after installing it (the app lists them as setup steps):

- **Price the list**: inputs `bom` (file), `supplierGln` and `projectNumber`; the steps above, ending with a step whose output has `items`, the priced lines (after a loop: `steps.<loop>.output.results[*].output.items`). The app records at most 200 lines per calculation.
- **Upload a condition file**: inputs `file` (file), `databaseId` (number) and `process`; its last step is `twoba_upload_conditions` with `sourceHandle` set to `trigger.output.file`.

### Which condition file was used

`twoba_upload_conditions` returns what 2BA reports per imported file and the **sha256** of the file sent. Store those in a data table to know later which condition file version priced a calculation; each priced line carries the `conditionId`, `scenario` and `termsType` that gave its price. 2BA does not say which import a condition came from, so when files are also uploaded in the 2BA portal, the last upload through Bee Flow is not necessarily the active one.

The file comes from the run: a form upload, a file an app handed to the run, or a file an earlier step made (`sourceHandle`). `process` is `DoNotProcess` (default: import only, check the result in 2BA), `ProcessIfAllOk` or `ProcessAlways`.

## Limits and privacy

- **Lines per call**: `TWOBA_MAX_ITEMS` (default 200, `0` = unlimited).
- **Condition file size**: `TWOBA_MAX_UPLOAD_BYTES` (default 25 MB, `0` = unlimited).
- **Busy 2BA**: a 429 or 503 is retried with back-off (Retry-After when 2BA sends it, at most 10 s per wait), `TWOBA_MAX_RETRIES` times (default 3).
- At most four lookups run at the same time per call.
- **What goes to 2BA**: only article data: the supplier GLN, article numbers, GTINs, quantities and a project number, plus the condition file you upload. Never a name, an e-mail address or your organisation's name. Log lines name the tool and the HTTP status only.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `2BA is not connected` | Client id, secret or sign-in missing | Fill them in under Settings → Connections → 2BA. |
| `2BA refused the user name or password` | Wrong account | Check the 2BA user name and password. |
| `2BA refused the client id or client secret` | Wrong or withdrawn client | Check the values 2BA issued. |
| `The 2BA sign-in has expired or was revoked` | "Sign in with 2BA" needs a new sign-in | Click **Sign in with 2BA again**. |
| `supplierGln must be the 13-digit GLN` | The GLN is mistyped (check digit) | Use the supplier's GLN from 2BA. |
| `This 2BA account may not do this` | No Online Condition Server, or no right on that database | Ask 2BA or your 2BA administrator. |
