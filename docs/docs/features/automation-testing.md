---
title: Testing automations
---

# Testing automations

[Automations](automations.md) can be tested without sending anything. This page covers the five tools that help you check a change before it goes live:

| Tool | Use it to |
|------|-----------|
| Test cases | Check that one code step or custom node gives the right answer for a given input. |
| Version changes | See exactly what changed in a step between two versions, line by line. |
| Compare runs | See, step by step, what is different between two runs. |
| Golden runs | Keep runs you trust and replay them after a change. |
| Form scenarios | Try a form-triggered automation with saved answers instead of typing them again. |

None of these tools needs code, except writing the code step itself. Every test runs in **test mode**: nothing is sent, written or called outside Bee Flow.

## Tests on code steps and custom nodes

Open a code step or a custom node and go to its **Tests** tab. A test case has:

- **A name**, so you can recognise it later.
- **An input.** Type the values yourself, or capture the input of a step from a real run ("Use the input of this run"). A captured input is a copy of what that step received.
- **What you expect.** The code should finish normally, or it should stop with an error. A test that expects an error passes only when the code stops.
- **Checks on the result.** Each check looks at one field of the result (leave the field empty to look at the whole result).

| Check | Passes when |
|-------|-------------|
| equals / does not equal | the field is, or is not, the value you give |
| contains | a text includes your words, a list includes your item, or a record includes your fields |
| has the field | a record has a field with that name |
| is of type | the field is a text, number, yes/no, record, list or empty |
| has a count | a list or text has exactly, at least or at most that many items or characters (for a record: fields) |

When a test expects an error, the checks look at the error message.

**What test mode means.** The code runs in the same isolated sandbox as always, with the same time and memory limits. Every call to the outside (an app, a web address) is recorded and answered with a placeholder, so nothing leaves Bee Flow. You can test the code you are typing without saving it first.

Each test shows one of four results:

- **Pass.** Everything matched.
- **Fail.** The code ran, but the outcome or a check did not match. The message names the field and what was found.
- **Error.** The code could not run to the end in a way the test expected (for example it was blocked by a safety rule, or it has a syntax error).
- **Unusable.** The captured input is no longer available, because the run it came from was cleaned up. Capture it again from a newer run, or type the values.

## Seeing what changed in a version

In the version history, open two versions and pick a step. Settings that hold longer text, such as code, prompts, instructions and messages, are shown **line by line**: removed lines on one side, added lines on the other, unchanged lines in between. Very long texts are shortened with a note. The shortening limit is set by `AUTOMATION_VERSION_DIFF_TEXT_MAX_BYTES`.

## Comparing two runs

Open a run in the **Runs** tab and choose **Compare with…**. Pick another run of the same automation; the previous run is already selected. You can also open a comparison from a golden run (see below).

The top of the comparison names the two runs, their version and how they were started, and gives a verdict in plain words:

- **Same result.** Every step produced the same output.
- **Only AI answers differ.** The remaining differences are in steps that ask a model, or in steps that a test run only simulates.
- **Different.** Something else changed.

Below that, every step has a row with a badge. By default only steps with a difference are listed ("Show only differences"). Open a row to see a table with the field, what it was in run A and what it becomes in run B.

**Hard and soft differences.** A *soft* difference is one you should expect:

- *AI answer: may vary between runs.* A model rarely words things the same way twice.
- *Simulated in a test run.* One of the two runs was a test run, which answers outside calls with a placeholder.

Soft differences are shown, but they do not turn the verdict to "Different". Everything else is a *hard* difference. A step that ran in only one run reads *Only in run A* or *Only in run B*. A step whose data is hidden from you, or was too large to keep, reads *Cannot compare* and does not decide the verdict.

**Files.** A file made by a step (a document, a presentation, a spreadsheet) is compared by what is inside, not by its name or id. For a presentation you see per slide what changed (the title, the length of the text); for a spreadsheet per sheet the number of rows and columns. A file that is made again with identical content counts as the same.

Only runs of the same automation can be compared. You can only compare what you are allowed to read: a run that used the connections of the person who started it can be opened only by that person.

## Golden runs

A **golden run** is a run you trust, kept as a reference. After you change the automation, you replay the golden runs: each one runs the same input again as a test run, and the result is compared with the golden run.

**Mark a run.** Open a finished run and choose **Mark as golden**. Optionally add a label, and a list of fields to ignore when comparing, for values that are different every time, such as a date or a reference number. Only a run that finished successfully, and that ran the whole automation (not a single step), can be golden.

**Replay.** Open **Testing** in the Runs tab. Choose **Replay goldens**, or tick some and replay only those. For each golden you see a badge:

| Badge | Meaning |
|-------|---------|
| Same | Nothing differs. |
| Only AI differs | Only soft differences. |
| Different | A hard difference. Choose **See differences** to open the comparison. |
| Error | The replay could not run, for example because the saved run is gone. |
| Interrupted | The replay was cut off, for example by a restart. Run it again. |

While a replay runs the list refreshes by itself. Only one replay runs at a time per automation.

**AI answers.** For each replay you choose:

- *Ask the AI again.* Steps that use a model call it again. This is the real check, but the answers vary.
- *Reuse stored answers where available.* Steps that keep their answers for later runs use the stored answer, so the replay is faster and steadier. Steps that keep nothing ask the AI again. Stored answers are only read, never changed, by a replay.

The ignored fields of a golden run decide its badge. The comparison you open from it still lists those fields, with a note saying which ones the verdict left out.

## Form scenarios

A **form scenario** is a saved set of answers for the form pages of an automation, taken from a run. It lets you test a form-triggered automation, with every page, without typing the answers again.

**Save one.** Test the form with **Test this form**. When the run is done, choose **Save these answers as a scenario** and give it a name. Answers to the start form and to every later page are saved by page. Files and app picks are not saved: they stay empty in a scenario, and the scenario lists them.

**Use one in the test form.** When you open the test form, **Fill from a saved scenario** offers the scenarios that answered the page on screen. Choosing one fills the page; you can still change anything before you submit.

**Dry run.** In **Testing**, a scenario has **Dry run**. Bee Flow starts the automation as a test run, fills every form page from the scenario, and sends nothing. The resulting run opens in the Runs tab, where you can look at each step. If the form changed so that a saved answer no longer fits, the run stops at that page and names the questions by their label.

**Rename and delete** a scenario in the same place.

### Over MCP

Two tools are available to the connected assistants of an automation's owner:

- `automations_list_form_scenarios` lists the scenarios of an automation: name, which pages are answered, how many fields were left out. It never returns an answer.
- `automations_dry_run_form_scenario` runs the dry run and returns, per step, the status, the time, a cleaned error and the **shape** of the output (field names, types, list lengths). Values are not returned. To look closer, use `automations_get_step_output`, which follows the organisation's setting for reading raw data and leaves an audit row.

Scenarios can be listed and run over MCP, but not created or changed.

## Privacy and retention

Test data is **run data**:

- It follows the same access as the run it comes from. Whoever cannot read a run cannot see its test data.
- It is deleted together with the run, when the run is cleaned up under run retention. A golden run, a captured test input and a form scenario all disappear with their run.
- It is **never exported**, and never part of a release or a deployment to another stage. Exports, releases and stage deployments leave out test cases, captured inputs, golden runs and scenarios.
- It **cannot be captured** from a run that used the connections of the person who started it, and it cannot be captured in a production (PRD) stage.
- Comparisons and replays show values cut to a short length, and only to people who can read the runs.

## Limits

Each limit is an environment variable on the server. A value of `0` means no limit.

| Variable | Default | What it limits |
|----------|---------|----------------|
| `AUTOMATION_TEST_CASES_PER_STEP_MAX` | 50 | Test cases on one code step or custom node. |
| `AUTOMATION_TEST_ASSERTIONS_MAX` | 50 | Checks in one test case. |
| `AUTOMATION_TEST_FIXTURE_MAX_BYTES` | 1048576 | Size of an input captured from a run (1 MB). |
| `AUTOMATION_TEST_RUN_RPM` | 20 | Test-case runs per user per minute. |
| `AUTOMATION_GOLDENS_MAX` | 50 | Golden runs per automation. |
| `AUTOMATION_GOLDEN_REPLAY_CONCURRENCY` | 2 | Golden runs replayed at the same time. |
| `AUTOMATION_GOLDEN_REPLAY_RPM` | 6 | Replay requests per user per minute. |
| `AUTOMATION_GOLDEN_REPLAY_STALE_MS` | 1800000 | After this time a replay that never finished shows as interrupted (30 minutes). |
| `AUTOMATION_RUN_COMPARE_MAX_STEPS` | 2000 | Steps compared when two runs are compared. |
| `AUTOMATION_RUN_COMPARE_MAX_CHANGES` | 200 | Differences listed per step. |
| `AUTOMATION_RUN_COMPARE_MAX_FILES` | 50 | Files compared. |
| `AUTOMATION_RUN_COMPARE_FILE_MAX_BYTES` | 20971520 | Largest file opened for a comparison (20 MB). |
| `AUTOMATION_FORM_SCENARIOS_MAX` | 50 | Form scenarios per automation. |
| `AUTOMATION_FORM_SCENARIO_MAX_BYTES` | 262144 | Size of the answers in one scenario (256 KB). |
| `AUTOMATION_VERSION_DIFF_TEXT_MAX_BYTES` | 204800 | Longest text shown on each side of a line-by-line version comparison (200 KB). |
