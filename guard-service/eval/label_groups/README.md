# Candidate label-group partitions

Each file is a JSON list-of-lists of GLiNER labels, passed to
`run_eval --label-groups`. They exist as committed config so the Phase 5
grouping sweep is reproducible and reviewable, rather than living in an
ad-hoc script.

## Why grouping matters more than it looks

GLiNER's attention is divided across the label list it receives, so the same
span scores differently depending on what it is asked alongside. Measured on
this corpus:

* **Dilution.** `"api key"` alone scores P/R 1.000 on ApiKeyOrSecret. The same
  label combined with four other secret-ish labels drops to **P 0.475**.
* **Cannibalisation.** In a 4-label financial group
  (`iban, bank account number, credit card number, tax identification number`),
  85 gold IBANs were tagged: 43 BankAccountNumber, 13 TaxIdentificationNumber,
  7 api-key, 5 NationalIdentificationNumber, 2 CreditCardNumber, 15 nothing —
  and only a handful as `iban`. Mutually-confusable categories in one group
  destroy each other.
* **Cost is linear in group count, and chunk count is flat.** Measured
  2,985 / 949 / 652 chars-per-second at 1 / 3 / 5 groups. `_label_prompt_tokens`
  sizes the per-chunk text budget from the LARGEST group, so keeping the widest
  group at today's 6 labels leaves chunking unchanged; only the number of
  forward passes grows.

So the partition is a real recall-vs-latency trade and has to be swept, not
guessed.

## Invariant

`g1_g2_frozen` is not a style choice. Groups 1 and 2 —
`[person, organization, address]` and the healthcare group — are the only two
with calibrated per-category floors today. Holding them byte-identical to
production means any movement in Person/Address/MedicalCondition during the
cutover is attributable to something other than relabelling. Change them and
the control group is gone.

## Files

| file | groups | notes |
|---|---|---|
| `current.json` | 3 | production today; the 12 regex-owned labels appear in NO group, so those categories are undetectable |
| `candidate6.json` | 6 | G1/G2 frozen; confusable financial + government-id categories separated |

Labels only take effect if they exist in `GLINER_LABELS_TO_CATEGORY`
(`app/services/pii.py`). A label in a group but not in that map is silently
dropped by `_accept`, so adding e.g. `"api key"` or `"IBAN"` requires the map
change too.
