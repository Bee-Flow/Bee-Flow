# playwright-tests

Standalone Playwright UI tests for the **Agent Hub** (`http://localhost:5176/app`), written against
the running local stack. Start here for new UI checks; the selectors and gate handling below were
verified in a real browser session, not guessed.

> Related: the repo also has [`e2e/`](../e2e), a larger CI smoke harness where specs are *generated*
> from Markdown scenarios (`npm run gen`) and must not be hand-edited. This folder is the plain,
> hand-written alternative — edit the specs directly.

## Run

```bash
cd playwright-tests
npm install                 # once
npm run install:browsers    # once, if chromium isn't downloaded yet
npm test                    # headless
npm run test:headed         # watch it click (auto-paces at 300ms/action)
npm run test:ui             # Playwright UI mode
npm run report              # open the HTML report of the last run
```

The stack must be up (`docker compose up -d` from the repo root; `/api/health` must answer).

Pace a headed run yourself with `SLOW_MO` (milliseconds per action, `0` = full speed):

```powershell
$env:SLOW_MO='450'; npx playwright test --headed --workers=1
```

`SLOW_MO` is an env var on purpose: worker processes re-evaluate `playwright.config.ts` with their
own argv, so a `--headed` check alone only reaches the main process.

## Configuration

Defaults target the local stack and the shared test account. Override with real environment
variables or by copying `.env.example` to `.env`:

| Variable | Default |
|---|---|
| `BASE_URL` | `http://localhost:5176` |
| `TEST_USER` | `testuser` |
| `TEST_PASSWORD` | `test123` |

`.env` and `.auth/` are gitignored — never commit a real password.

## Layout

```
playwright.config.ts   desktop viewport, storageState, timeouts, reporters
global-setup.ts        logs in once → .auth/user.json (reused by every spec)
support/env.ts         BASE_URL / credentials / viewport
support/login.ts       login through the real UI (no /login route exists)
support/gates.ts       first-login gates + tour skip helper
support/fixtures.ts    tour suppression + auto-dismiss — import test/expect from here
support/chat.ts        DirectChat page object (composer, messages, reply wait)
support/search.ts      SearchOverlay page object (Ctrl+K)
tests/direct-chat.spec.ts
tests/regression/      one spec per resolved YouTrack issue — see TEST-CASES.md
```

[TEST-CASES.md](TEST-CASES.md) maps each resolved BFSF issue to its spec, and writes up the resolved
issues that are **not** automated yet (routines, notebooks, cross-user webpages) as manual cases so
the gap is explicit.

**Import `test` and `expect` from `../support/fixtures`, not from `@playwright/test`** — that is what
wires in the onboarding-tour defences described below.

## The onboarding tour (read this before writing a new spec)

The 12-step tour is the single biggest source of flakiness in this app's UI tests. It auto-starts on
the chat home, renders a portal overlay across the entire app, and that overlay both **swallows
pointer events** and **eats keystrokes**. Symptoms:

```
locator.click: Timeout 15000ms exceeded
  - <div aria-hidden="true"> from <div aria-live="polite"> subtree intercepts pointer events
```

...or a silently wrong value, e.g. `Shift+Enter` never inserting its newline.

It is a pure race — the tour mounts about a second after the chat home renders. At full speed a test
usually types first and passes, then fails on a slower machine, in `--headed`, or in CI. Both spec
tests in this folder failed exactly this way the first time they were run headed.

`support/fixtures.ts` defends twice, so one upstream change cannot quietly bring the flake back:

1. **Suppression** — an init script pre-seeds the `hasSeenIntroTour` localStorage flag before app
   boot, so the tour never auto-starts. `scopedStorage` namespaces keys per user
   (`beeflow:<userId>:<key>`) but falls back to the legacy *unscoped* key, so this works without
   knowing the user id.
2. **Auto-dismiss** — a `page.addLocatorHandler` clicks "Skip tour" if a tour appears anyway (it can
   still be started explicitly from the Learning Center).

Neither changes the account's server-side state, so runs stay repeatable and the real first-run
experience is untouched for humans.

## Things this app does that will bite you

These were all hit while building the first spec:

- **No `/login` route.** An unauthenticated `/app` URL renders the login form in place. The session
  is an HTTP cookie, which is why one login in `global-setup` can be shared by all specs.
- **Viewport must be desktop.** Below 768px the app switches to mobile mode and redirects most
  routes back to `/app`. The config pins 1440×900 — don't lower it.
- **Three one-time gates stand after login** on a fresh account, in this order: the "Save Your
  Recovery Key" screen, the "Our terms have been updated" re-consent screen (its button stays
  disabled until the checkbox is ticked), and the 12-step onboarding tour. All are stored
  server-side, so they disappear after the first run — `support/gates.ts` handles them anyway so the
  suite also works on a brand-new account.
- **The onboarding tour silently blocks clicks and keystrokes** — see the dedicated section above.
- **`send-message-button` is disabled while the composer is empty**, and is *replaced* by
  `stop-generating-button` while the reply streams. Waiting for the stop button to disappear is the
  reliable "reply finished" signal — never `waitForTimeout`.
- **Messages share one testid pattern for both roles** (`message-<id>`). Tell them apart by the
  layout class on that same element: `.items-end` = user, `.items-start` = assistant.
- **The URL rewrites itself** to `/d/<8 chars>` after the first reply, and the conversation appears
  in the sidebar as `conv-row-<uuid>`.

## Note on test data

Every run of the chat test leaves a real conversation behind on the test account (and costs one
model call). There is no cleanup step; delete old chats from the sidebar if they pile up.
