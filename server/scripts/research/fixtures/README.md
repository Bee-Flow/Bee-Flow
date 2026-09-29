# S3 fixture content

Synthetic documents for the borrowed-phone study. Everything here is invented:
the companies, the people, the amounts and the dates. Nothing in this directory
came from a customer, and nothing here may be replaced with anything that did —
the whole reason the study can use a screen-recorded device is that the account
it is signed into holds no real data.

## What each file is for

| File | Goes in | Why it exists |
|------|---------|---------------|
| `raamovereenkomst-van-dijk-2025.md` | the clean KB | The answer to S3's second task. States a notice period in a clause a person has to actually read, not in the title. |
| `raamovereenkomst-van-dijk-2023.md` | the messy KB | A superseded version with a *different* notice period, marked as superseded in its own text. A retrieval path that cites this one has failed in the way that matters. |
| `onderhoudscontract-brouwer.md` | the clean KB | A second contract, so "find the contract" is a search rather than a lucky single hit. |
| `inkoopvoorwaarden-2024.md` | the clean KB | Longer, duller, and mentions notice periods generically — the plausible wrong answer. |
| `notulen-mt-2025-03.md` | the messy KB | A meeting note that mentions Van Dijk without answering anything. Noise with the right keywords in it. |
| `beleid-thuiswerken.md` | the messy KB | Unrelated policy. A KB with nothing irrelevant in it is not a KB anybody has. |

## The task these support

> "Somewhere in here is our contract with Van Dijk BV — how much notice must we
> give?"

Correct answer: **three calendar months**, from article 12.2 of the 2025
framework agreement. The 2023 document says one month and says on its face that
it was replaced; the purchasing conditions say "unless otherwise agreed", which
is true and useless.
