---
title: Reliable AI steps
---

# Reliable AI steps

An **AI step** asks a model to read some data and answer. A model is good at that, and also
sometimes wrong in small ways: a category that is not on your list, a summary that quotes a
figure that was never in the table, a reply in the wrong alphabet, one item missing from a
long list. When a person reads the answer they notice. When the next step of an automation
reads it, nobody does.

The settings on this page make the answer something a later step can rely on. They do
three things:

- **Hold the model to a shape** before it answers (structured answers, allowed values).
- **Check the answer** after it arrives, against the data of the run itself.
- **Decide what happens** when the answer still is not right: one automatic repair round,
  then either a clear failure you can route, or a safe value you chose in advance.

Everything here is optional. A step that uses none of it behaves exactly as it always did.

**Tier:** the same as Automations, the free Community core.

## Structured answers

Give the step an **output schema** (the **Structured output** section of the step: the fields
the answer must have, with their types: `category` as text, `tags` as a list, and so on). A step that has a schema and
offers the model no tools gets its answer back as *structured output*: the model provider is
held to the schema while the answer is written, instead of being asked politely in the
prompt. You do not need "reply with JSON only" in the prompt and you do not need a step to
tidy the reply afterwards. Later steps read the fields directly, for example
`steps.sort.output.category`.

A step that is allowed to use tools (web search, an app, an agent with tools, skills) cannot
use this route, because the model must be free to call a tool in between. Its reply is read
from text, as before, and everything below still applies to it.

How the provider is held to the schema depends on the model and is chosen for you; see
[Per-provider notes](#per-provider-notes).

## How varied the answers are

**How varied the answers are** (the step's *temperature*, 0 to 2, default 0.2) sets how much
the answers vary between runs on the same input. The form offers *Exact (0)*, *Balanced
(0.2, default)*, *Creative (0.7)* and *Custom…*.

| Work | Suggested value |
| --- | --- |
| Sorting, picking from a list, copying figures, extraction | `0` |
| Most steps | leave the default, `0.2` |
| Drafting text that may be phrased in different ways | up to about `0.7` |
| Above `1` | answers differ a lot from run to run; rarely what an automation wants |

Lower is not "smarter", only steadier. Leave the field alone unless you have a reason; a
data extraction step always works at 0.

## Answer checks

Checks run **after** the model has answered. They are never sent to the model, so they
cannot be talked around by the prompt. In the step's **Answer checks** section, **Add a check**
and pick one of four kinds. Each check names a **Field of the answer**, a field of the output
schema:

- `category`: a field.
- `tags[]`: every item of a list field.
- `items[].category`: a field inside each item of a list.

### Must be one of the values in a list

Use this when the answer must be one of the values in a list the automation already has:
the categories in a table, the names of the people in a team, the statuses a system knows.

Pick the **List of allowed values** (a list from an earlier step, the trigger, or a variable)
and, when its items are records, the **Part of each item** that holds the value (for example
`name`). With **Show the list to the AI (recommended)** ticked, the values are **shown to
the model** as the only allowed ones and **checked afterwards**: the model picks from them
and an answer outside the list fails. This is the `enumFrom` setting. Untick it and the
list stays private: the answer is only checked afterwards (a check of kind `allowedFrom`),
which is the right choice for values the prompt already contains, such as the ids of the
items you handed in. **Ignore upper and lower case** is on by default and a matching answer is
written back in the list's own spelling. An empty answer fails unless **May be left empty**
is ticked.

```json
{
  "outputSchema": { "type": "object", "properties": { "category": { "type": "string" } } },
  "enumFrom": [{ "field": "category", "ref": "steps.categories.output.rows", "value": "name" }]
}
```

A list longer than 500 values is checked but not shown to the model (the limit is
`AUTOMATION_AI_ENUM_MAX_VALUES`, see [Environment variables](../self-hosting/env.md)).

### Numbers must come from the data

For a short summary that may only quote figures from a table. Every number in the text
must also appear in the **Data the numbers must come from**.

```json
{
  "checks": [{ "kind": "numbersFrom", "field": "summary", "ref": "steps.totals.output.rows", "ignoreUpTo": 10 }]
}
```

- **Allowed difference**: how far a number may differ from the data (absolute, default 0;
  0.5 allows a rounding of half a unit).
- **Ignore small whole numbers up to**: numbers like the 3 in "3 reasons" are not worth
  checking (default 0, so every number is checked).
- **Check percentages too** (a percentage may be written as a share or as a number) and
  **Ignore dates and years** (numbers that are part of a date are skipped). Both are on by
  default.

A number the model computed itself (a sum it worked out) is not in the source, so it fails
this check. Compute figures in a step and let the model write around them.

### Written in one alphabet

For a reply that must be in the Latin alphabet (or Cyrillic, Greek, Arabic, Hebrew, Chinese
characters, Japanese, Korean, Devanagari or Thai), picked as the **Alphabet**. The check
looks at the letters of the text and counts how many belong to that writing system; digits,
spaces and punctuation do not count. Through the builder tools a `minRatio` below 1 lets a
text mix in a few words written elsewhere.

```json
{ "checks": [{ "kind": "script", "field": "reply", "script": "latin" }] }
```

This is about the alphabet, not the language: it does not tell English from French.

### Number of items

For a **List in the answer**: **At least** this many, **At most** this many, and optionally
the **Same number as the list** of an earlier step (one result per input row).

```json
{ "checks": [{ "kind": "items", "field": "tags", "minItems": 1, "maxItems": 5 }] }
```

## When the answer still fails

When a check fails, the model gets **one repair round**. It is told which field broke which
rule and what it wrote there, and it answers again. The repair message never contains the
reference lists or the restored data, and it passes the same Privacy Shield input guard as
the prompt. If the second answer passes, the step carries on as if nothing happened (the
step's result notes `repaired`).

If the second answer fails as well, the fallback decides. It is set under **If the answer
still fails after one automatic retry**:

| Choice | What happens |
| --- | --- |
| **Stop the run with an error (default)** | The step stops with the error class `ai_check_failed`. The message names at most five failing places and never a data value. Wire an error branch to route it: notify someone, or ask for approval. |
| **Use these values instead** | Each field of the structured output gets a value you chose (a fixed value such as `Other`, or data from an earlier step) and a warning is noted on the run. The values **replace the whole answer**, so fill in every field later steps read. |

```json
{ "fallback": { "kind": "value", "fields": { "category": { "kind": "literal", "value": "Other" } } } }
```

For sorting, a catch-all value such as *Other* keeps one odd message from stopping a long
list. For figures or text that a person will read, failing and routing to a person is
usually better than a quiet substitute.

The step's result carries a `checkReport` (`passed`, `repaired`, `fallbackUsed` and the
failing places), so a later step or a person reading the run can see what happened.

## Reusing answers

When an automation asks the model the same thing again (the same prompt, data, model and
settings), the second answer can come from memory instead of a new model call. Turn on
the step's *Reuse the answer when the input is the same* option (`askOnce`). It is meant for steps that run over
a list that repeats itself: a hundred messages with twenty distinct subjects need twenty
answers, not a hundred.

- **Within a run** (the default) the answer lives only in the memory of that run and is gone
  when the run ends. A window of 1 to 900 seconds can be set.
- **Across runs**: *…and keep the answer for later runs too* (`acrossRuns`) stores the answer so
  that a later run can use it. This only works when an administrator allowed it for the
  organisation; until then the step reuses within the run only.
- Never when the step may use tools, because a tool call has effects and its result depends
  on the world, not only on the prompt.
- Never in a **test run**: a test run always asks the model.
- The answer is reused only after it passed its checks. A fallback value is never stored.
  A reused answer goes through exactly the same output guard and checks as a fresh one.

### The organisation setting

Administrators find it in the organisation's admin settings, in the **Reusing answers
between runs** section, under **What may be kept**: **Answers from AI steps**. It is off by default, separate from the two
other choices (*Answers from connected apps* and *Answers from web service calls*), and
only has an effect while *Keep answers for a short while* is on.

Why this is safe for personal data:

- The key under which an answer is stored is made from the request **after** the Privacy
  Shield has rewritten it. With *tokenize* the model sees `<PERSON_1>` and nothing else,
  in both runs, so the stored answer holds no real value.
- What is stored is the model's own answer in that protected form, **encrypted**. Real values
  are put back when the answer is read, inside the run that reads it.
- The window is the organisation's setting, up to **one hour**, and a step can only shorten it.
- Turning the setting off stops reading at once; stored answers expire within the window.
- An operator can switch the whole thing off: `AUTOMATION_ASK_ONCE_DISABLED` (all reuse) or
  `INTEGRATION_CACHE_DISABLED` (only the stored tier).

## Many items at once, and provider limits

A step that runs once per item of a list ("Run this step once for each item", `forEach`) runs
the items one by one by default. An AI step **without tools**, and a **data extraction**
step, can run several items at the same time: set **Items at the same time** (`concurrency`,
1 to 1000) on the step; empty uses the platform default. The results keep the order of the list, whatever order the model
answers in. A failed item is recorded for that item and the others carry on, as before.

Two limits stand between that number and the provider, and neither breaks the run:

- **The server cap**, `AUTOMATION_FOREACH_MAX_CONCURRENCY` (default 4): a step asking for 50
  runs 4 at a time. `0` removes the cap.
- **The provider limit**: Bee Flow counts the requests and the estimated tokens it sends to one
  model connection (`LLM_PROVIDER_RPM`, default 600 per minute, and `LLM_PROVIDER_TPM`,
  default 2,000,000 per minute). A request over the limit waits for room. When the
  provider itself answers "too many requests", Bee Flow waits as long as the provider asks
  (at most `LLM_RATE_LIMIT_MAX_WAIT_MS`, default 60 seconds) and tries again up to
  `LLM_RATE_LIMIT_RETRIES` times (default 4). A cancelled run stops waiting at once.

An AI step that may use tools stays one by one, whatever number is set.

All variables are listed in [Environment variables](../self-hosting/env.md).

## Long lists in batches

Do not put hundreds of items into one prompt: the answer gets long, the model drops items,
and one bad answer costs the whole list. Work in batches instead:

1. Add a **Loop** over the list and set its **Batch size** to, say, 20. Inside the loop,
   `loop.<name>` is then a *slice*: an array of up to 20 items (not one item), and
   `loop._index` counts the slices.
2. In the loop, add an AI step that gets `loop.<name>` as an input and returns
   `{ "results": [ { "id": …, "category": … } ] }`. The items need an id.
3. Add two checks to that step so a batch cannot lose or invent items: *Number of items* on
   `results` with **Same number as the list** `loop.<name>`, and *Must be one of the values in
   a list* on the id of each result, with the list `loop.<name>`, the part `id`, and **Show the
   list to the AI** unticked (the ids are already in the prompt).
4. If the categories come from a table, add *Must be one of the values in a list* on the
   category of each result, with **Show the list to the AI** ticked.

```json
{
  "inputs": { "batch": { "kind": "ref", "path": "loop.batch" } },
  "temperature": 0,
  "outputSchema": { "type": "object", "properties": { "results": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "category": { "type": "string" } } } } } },
  "enumFrom": [{ "field": "results[].category", "ref": "steps.categories.output.rows", "value": "name" }],
  "checks": [
    { "kind": "items", "field": "results", "sameCountAs": "loop.batch" },
    { "kind": "allowedFrom", "field": "results[].id", "ref": "loop.batch", "value": "id" }
  ]
}
```

After the loop, `steps.<loop>.output.results[*].output.results` is one flat list of the
answers of all batches, in order. Match them back to your records on `id`.

A loop stops at its first failing batch, so leave the fallback on *Stop the run with an error* here:
a fixed value would hide a lost batch. The two checks catch a missing, an extra or an invented
id; they cannot tell a repeated id that replaces a missing one, so join on `id` downstream
rather than on position.

A loop with a batch size runs its batches one after another. For many small independent
items with a short answer each, a step with *Run this step once for each item* and a
concurrency is simpler.

## Per-provider notes

You do not choose how a structured answer is produced; Bee Flow picks the strongest way the
selected model supports:

- Where the provider can enforce a JSON schema itself, the schema is sent that way.
- Where it can only enforce a tool call, the schema is sent as the parameters of a tool the
  model must call.
- A model that supports neither, or a step with tools, uses the text route: the reply is
  read as JSON. On a step that has allowed values, checks or a fallback, a reply that
  cannot be read gets the same repair round as a failed check.

Self-hosted models (Ollama, vLLM, llama.cpp and others) usually take the text route or the
tool-call route, depending on the runtime. Their answers benefit most from an *allowed values*
list and a low temperature. Provider limits are counted per connection (URL and key), so
two models on the same account share one allowance and a local runtime has its own.

## Privacy

- Allowed values are shown to the model, so they go through the Privacy Shield exactly like
  the prompt: under *tokenize* the model sees tokens, and the check compares the restored answer
  with the real list afterwards.
- Checks run inside Bee Flow on the answer and the run's data. Nothing is sent out for a
  check; the repair message quotes only what the model itself wrote.
- Error messages and the `checkReport` name the failing field and the rule, never the value.

## Building it with the MCP tools

The builder tools (`builder_add_ai_step`, `builder_update_step`, see
[Automations MCP](automations-mcp.md)) take the same settings as fields: `temperature`,
`enumFrom`, `checks`, `fallback` and `askOnce` on the AI step, and `forEach.concurrency`. The
guide that `automations_get_guide` returns has a "Reliable AI steps" section with the same
examples. The loop's batch size is the one setting here that is set in the editor, not by the
MCP builder tools.
