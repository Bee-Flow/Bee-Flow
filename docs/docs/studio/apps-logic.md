---
title: Logic and steps in apps
---

# Logic and steps in apps

An action is a list of steps that run when something happens: a click, a form submit, a screen
opening. This page covers the steps and settings added to the ones in [App Studio](./apps.md):
control flow, running a little code, calling a web service, steps that work on the page,
variables, and the triggers that start actions inside the app. Everything here is optional.

Steps are in the action flow editor. The AI builder can add and change them too, one step at a
time (`app_update_step`), without sending the whole action again.

## Control flow

| Step | What it does |
|------|--------------|
| **While** (`while`) | Repeats its steps while a formula is true, at most `maxIterations` rounds (1 to 200, 200 when left out). The formula is checked before every round, so the steps must change what it reads. Reaching the limit is not an error: check the condition again afterwards when it matters. There is no `item` or `index`; keep your own counter in a variable. For the rows of a list use a loop. |
| **Break** and **Continue** | Leave the nearest loop or while at once, or skip to its next round. Only valid inside one (a condition, switch or try in between is fine). |
| **Return** (`return`) | Ends the action here and hands back an optional value. The action still counts as succeeded. Inside an action run through *Run another action*, only that action ends. |
| **Raise error** (`raise_error`) | Stops the action with a message you choose, and an optional short `code` a catch can read. Nothing that already ran is undone, so put writes that belong together in *All or nothing*. |
| **Try** (`try`) | Runs steps and, when one fails, runs `catch` instead of stopping. `finally` always runs last. With a catch (even an empty one) the failure is handled and the action goes on. Inside the catch, read `error.message`, `error.step` and `error.code`. A declined confirmation is not a failure. |
| **Parallel** (`parallel`) | Runs 1 to 8 lists of steps side by side and goes on when all have ended. Each branch starts with the variables as they were before and does not see what another branch writes, so give each its own result variable. A branch that fails ends the action after the others finish (`failFast` stops them sooner). In the browser at most 4 branches run at once; on the server the cap is `STUDIO_APP_PARALLEL_MAX` (default 4, 0 = unlimited). Not allowed inside a branch: navigate, confirm, open a dialog, *All or nothing*, send e-mail and another parallel. |

## Guards and checks

- **Guard.** Every step that works on the server can carry a `guard`: a formula the server works
  out before it runs the step. When it gives false, nothing, or cannot be worked out, the step is
  skipped, nothing is written or sent, and the action goes on. Use it for a rule the browser must
  not be able to switch off. A **condition** step decides in the browser, a guard decides on the
  server. Decide who may do something with `currentUser` (a role), never with a variable or form
  value, because the browser sends those.
- **AI checks.** *Ask the AI* and *Read a document* steps can carry `checks`: rules every answer
  must pass before the step succeeds (the answer is one of a list, every number appears in the
  data, the text is in a given script, a list has the right length). A failing answer goes back to
  the AI with what failed. `repairRounds` (0 to 3, 1 when left out) sets how many extra calls may fix
  it; after that the step fails with `ai_check_failed`. `temperature` (0 to 2) sets how much an
  answer may vary: 0 to 0.3 for extraction and anything checked.
- **Text from a formula.** A toast, a confirmation, *Go to a screen* and *Open a link* can take
  their text, title, button labels or target from a formula. *Open a link* from a formula only opens an https address on a
  host the app owner listed under **Allowed link hosts** in the app settings (up to 50). The
  builder cannot write that list.
- **Several actions on one event.** Any event can run a list of up to 5 actions in order
  (**Then also run another action**). If one fails, the ones after it do not run.
- **Per action.** A sequence can show a toast and/or open a screen when it ends well
  (`onSuccess`) or fails (`onError`).
- **Formula inputs.** *Run an automation* can fill an input from a formula, worked out on the server
  when the automation starts.

## Run code

The **Run code** step (`code`) works out a value with a few lines of JavaScript, for logic a
formula cannot say: a loop with running state, a parse of pasted text, a custom score over many
rows. Do not use it for what a formula or an ordinary step already does.

You write `function main(inputs, ctx) { … }` and return a value. It lands in the result variable
for the steps after it.

```js
function main(inputs) {
  const total = inputs.lines.reduce((s, l) => s + l.qty * l.price, 0);
  return { total, vat: Math.round(total * inputs.rate) / 100 };
}
```

**What the code can reach.** Only what you hand it as **inputs**. Each input is a value, a
formula or the rows of a table. Every input is read before the code starts, with the row access
of the person running the action, so the code only ever sees rows that person could read. It
sees plain values (`inputs.lines` is a list of rows). `ctx.log(…)` writes a line the run report
shows.

**What it cannot do.** There is no network, no database, no connected tool and no secret:
`ctx.http`, `ctx.integrations` and `ctx.db` are refused, and the validator names such a use. To
save a result, use an ordinary step after it (add or change a row with a formula over the result
variable). Personal data still leaves Bee Flow only by e-mail.

**Limits.** Code up to 20,000 characters, up to 20 inputs, a rows input reads 50 rows unless you set a limit (at most 200),
and the result may be up to 1 MB. By default a run gets 1 second of computing within 5 seconds;
the step's time limit (100 to 30,000 ms) changes both, with at most 10 seconds of computing. Per
viewer and app there are 120 runs a minute (`STUDIO_APP_CODE_RPM`, 0 = no limit), and the inputs
of one run may total 1,024 KB as JSON (`STUDIO_APP_CODE_INPUT_KB`, 0 = no limit). Inside a loop
the code runs once per row, so pass the list as one input and loop in the code instead. A server
without the code sandbox fails the step with `code_unavailable`.

The step can run on a click, in a background or server run, in an action a trigger starts, in a
mailbox hook, and on a public page. A visitor's browser never receives the code or the input
bindings, only that the step exists.

## Call a web service

The **Call a web service** step (`http_request`) calls an HTTPS service through a **REST
connector** that a person made under Data → Connectors. There is no address field. You pick the
connector, a method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), a path on its host, and optional
query, headers and body. The request goes to the connector's host with its stored credential and
fixed headers. Neither you nor the AI builder can create the connector or see its credential.

- The answer lands in the result variable as `{ status, body }`. A status outside 200 to 299 fails the
  step with the error code `http_status`; handle it with *If it fails*. The answer is at most 1 MB.
- Everything the step sends passes the organisation's privacy check first. If it finds personal
  data, the step fails with `pii_blocked` and nothing is sent. Send ids and amounts, not names
  or e-mail addresses.
- A write is never repeated on its own. *If it fails, try again* on a write needs an
  `idempotencyKey`.
- It runs on a click, in a background run and in an action a schedule trigger starts. It does not run on a
  public page, from a mailbox hook, in an action a webhook starts, or in a run that a row written
  by a webhook run starts.
- In a dry run a read (`GET`) is really sent; a write is only described.

## Steps that work on the page

These steps run only in the browser. A background run, a mailbox hook and a test run through
MCP do not run them.

| Step | What it does |
|------|--------------|
| **Back** (`back`) | Goes back to the previous screen with the params it had. |
| **Focus** (`focus`) | Moves the keyboard focus to the first field, button or link in a component. |
| **Scroll to** (`scroll_to`) | Scrolls to a component, or to the top. |
| **Copy to clipboard** (`copy_to_clipboard`) | Copies a text. When the browser refuses, the step fails, so put the confirmation after it. |
| **Set a form field** (`set_form_field`) | Puts a value into one field of a form on the screen, as if typed. |
| **Set the interface** (`set_ui`) | Switches a tab, opens or closes a dialog, or sets the selection of a data grid. The same state is readable in formulas as `ui.tabs.<id>.active`, `ui.modals.<id>.open` and `ui.selection.<id>`. The `ui` root is empty on the server. |

## Variables

An app has variables you set with *Set a variable* and read as `vars.<name>`. Three kinds are
new, set per variable:

- **Screen** (`scope: "screen"`): starts from its default each time a screen opens, so a search
  box or a selected tab of one screen is not still set on the next.
- **Kept** (`persist`): `session` keeps the value until the browser tab closes, `local` until the
  browser data is cleared, so a reload starts where the viewer was. It is kept for the same
  signed-in viewer of the live app and goes when they sign out. An anonymous visitor of a public
  page, the editor and the server always start from the default. All kept values of an app share
  16 KB. The value stays on that device, so never keep personal data or a secret in it.
- **Derived** (`derived`): worked out from a formula each time what it reads changes
  (`vars.price * vars.quantity`). A step that writes it changes nothing. Two derived variables
  that read each other are an error. A server step works it out again on the server and never
  takes the value the browser sends.

A variable can be only one of the three. Set them in the Logic tab, or ask the builder
(`app_set_variables`).

**Server steps and the page.** Formulas in a server step see `form`, `vars`, `item`, `index`,
`value`, `params`, `currentUser`, `now` and `today`. The roots `screen`, `forms` and `actions`
are empty there, unless the app owner switches on **Server steps** in the Theme panel
(`serverScope: "wide"`). Then the browser sends them with each server step of a click. They are
viewer input like a form field: never use them as proof of who someone is. A public page, a
background run and the phone app do not send them.

## Triggers in the app

These start an action from inside the open app. They run in the live app only, never in the
editor or in a screenshot.

- **When the screen opens** (`onOpen`): runs each time someone opens the screen, also after a
  navigate to it with other params. Use it to prepare the screen, for example to reset a filter.
  On a public page it only runs actions the public screens already run.
- **Timers**: up to 3 per screen, each running an action every 5 to 3600 seconds while the screen
  is open. A timer pauses while the browser tab is hidden and skips a tick while its previous run
  is still busy. To only reload the data on screen, use the screen's refresh interval instead.
- **Watchers**: up to 10 per app, each running an action every time the value of a formula
  changes. The first value is only remembered. `debounceMs` (0 to 10,000) waits for that much
  quiet first, which suits a value someone is still typing. A watcher that runs more than 10
  times in a minute is switched off for the rest of the visit, so never let the action change
  the value it watches. Add watchers in the Logic tab; the builder has no tool for them yet.

To start an action on the server by itself, with nobody at the page, see
[Server runs and triggers](./apps-server-runs.md).
