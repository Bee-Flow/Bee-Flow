---
title: Sanctions lists
---

# Sanctions lists

Screen the name of a client, a director or an ultimate beneficial owner against the official
sanctions lists, and check whether a job title is a prominent public function (PEP), for the
client due diligence of the Wwft and the Sanctiewet. Everything runs **on your Bee Flow server**:
the server keeps its own copy of the public lists, and a name you screen never leaves it.

The integration is part of the Enterprise licence (feature `sanctions_screening`) and is **off by
default**: an organisation admin switches the **Sanctions lists** integration on for the
organisation, like any other integration.

## The lists

| List | Publisher | Format | Address |
|------|-----------|--------|---------|
| EU consolidated financial sanctions list | European Commission (Financial Sanctions Files) | XML | `https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content`, with the Commission's published public `token` parameter |
| UN Security Council consolidated list | United Nations Security Council | XML | `https://scsanctions.un.org/resources/xml/en/consolidated.xml` |
| Nationale sanctielijst terrorisme | Government of the Netherlands | OpenDocument spreadsheet | `https://www.rijksoverheid.nl/site/binaries/site-content/collections/documents/2015/08/27/nationale-terrorismelijst/ned-terrorismelijst.ods` |
| OFAC Specially Designated Nationals (SDN) | US Department of the Treasury | CSV (`SDN.CSV` and `ALT.CSV`) | `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV` |
| UK Sanctions List | UK Foreign, Commonwealth and Development Office | XML | `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml` |

The UK Sanctions List replaced the OFSI Consolidated List, which stopped being published in
January 2026.

The server refreshes the lists once a day while at least one organisation has the integration on
(see [environment variables](../self-hosting/env.md#sanctions-lists)). A list is replaced in one
transaction. A failed download, a file that cannot be read or a download with far fewer entries
than expected never empties a list: the previous copy stays, and the error shows on the status
page. A platform admin sees each list's last refresh, number of entries and last error under
Admin dashboard → Platform services → **Sanctions lists**, with **Refresh now**.

## PEP functions

The Dutch list of prominent public functions (article 2 of the Uitvoeringsbesluit Wwft 2018, as
worked out by the Ministry of Finance) and the EU list (Directive (EU) 2015/849 article 3(9) and
the Commission's list of prominent public functions, including the EU institutions) are bundled
with Bee Flow as data: functions only, never names of people. A job title matches a function when
the function's words appear in it (case, accents and punctuation do not matter). A function at an
international organisation, or at a state-owned enterprise, is reported as *possible*: those
organisations keep their own lists. A title that says *former*, *oud-* or *voormalig* is flagged
as former; a PEP keeps that status for at least twelve months after leaving the function.

## Where you use it

- **Automations**: the actions `sanctions_screen` and `sanctions_pep_function_check` of the
  Sanctions lists integration.
- **Agents**: the same two tools, when the agent has the integration on.
- **App Studio**: the step **Screen against sanctions lists** (`sanctions_screen`), with bindings
  for the name, birth date, country and job title. Not on a public page.

## What a screening returns

```json
{
  "candidates": [
    {
      "score": 0.92, "nameScore": 0.88, "listId": "eu_fsf", "entityId": "20", "kind": "person",
      "primaryName": "Qoussaï Saddam Hussein Al-Tikriti", "matchedName": "Qusay Saddam Hussein Al-Tikriti",
      "birthDates": ["1965", "1966"], "countries": ["IQ"], "programmes": ["IRQ"],
      "reference": "EU.39.56", "url": "http://eur-lex.europa.eu/…", "reasons": ["birth year within one year"]
    }
  ],
  "candidateCount": 1,
  "pep": { "isPep": false, "possiblePep": false, "former": false, "matches": [] },
  "lists": [{ "id": "eu_fsf", "label": "EU consolidated financial sanctions list", "status": "ok", "lastSuccessAt": "…", "entityCount": 5800 }],
  "missingLists": [],
  "checkedAt": "…"
}
```

The score compares the names after folding case, accents and transliterating Cyrillic and Greek;
word order does not matter, and spelling variants (Mohammed, Muhammad) are found. A matching birth
date or country raises the score a little, a different birth year lowers it. The default threshold
is 0.85 (`minScore`, 0.5 to 1).

**A candidate is a possible match, not a finding.** Have a person compare it with the list entry
(the `reference` and `url`) and record the decision. `missingLists` names lists that hold no data
yet, for example on a new server before its first refresh.

## Privacy

- Only the downloads of the public lists go out, from the server to the addresses above.
- A screening is a local tool: it is not recorded as data leaving the platform, and the
  organisation's rules for personal data in outside tools do not block it.
- The server does not store or log the names it screens. Store the result yourself where your
  client file needs it (an App Studio table, an automation step).
