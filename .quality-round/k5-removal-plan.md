# K5 removal: delete the Component Designer (user- and AI-written component code)

Owner decision (2026-10-13): the Component Designer is no longer used; the code goes.
Runs as ONE commit on `ccr-8c0edf67-243f59` AFTER phase 5 (its lanes touch
`server/index.js` and `agent-hub/.../ComponentBuilder.jsx`) and BEFORE phase 6
(whose COMPONENTS-GATES and CORE-LOOSE items touch `components/` and `core/executionEngine.js`).

## What goes and what stays

Goes (the feature that let a person or the AI write component code onto the server disk):
- The Component Studio UI (`/app/components`), the AI Component Designer chat, the
  `component_designer` capability, the `system-component-designer` starter agent, the
  component write tools, the component CRUD/test routes, the runtime `npm install` of
  body-supplied dependencies.

Stays (the shipped, repo-tracked components that agents and automations use as tools):
- `components/*` (afas-customer-data, email-sender-smtp, get-date-time, get-organization,
  n8n-webhook-header-auth, random-number, tavily-search, update-organization,
  webpage-to-markdown, website-sitemap-fetcher, youtrack-read-items),
  `core/cms/componentManager.js` read side (`initialize`, `getComponents`,
  `getComponentPath`, `reloadComponent`, `reloadAll`, `installDependencies` at boot for the
  shipped components), `core/executionEngine.js` (`runComponent` with the phase-1 env
  allow-list, timeout and output cap), `execute_component` for agents and workflows,
  `getAvailableComponents`, `componentVisibleTo`, `GET /agents/meta/components`,
  `POST /execute` and `POST /subworkflow/:id` in `routes/execute.js`.

## Server

1. Delete `routes/ai/agentChat.js` (+ `agentChat.auth.test.js`, `agentChat.validation.test.js`)
   and its mount in `server/index.js`; delete `core/cms/componentDesignerAgent.js`
   (+ test) and `prompts/`/seed text for the designer if any lives outside the registry.
2. Delete `routes/components.js` (+ `components.authz.test.js`,
   `components.validation.test.js`) and the `/components` mount in `index.js`; drop the
   `'/components'` row from `license/featureMap.js` (and its test expectations).
3. `routes/execute.js`: delete `POST /test-component` (only the studio called it). Keep
   `/execute` and `/subworkflow/:workflowId`.
4. `core/tools/toolExecution.js`: delete the designer-only `SYSTEM_TOOLS`
   (`read_component_files`, `update_component`, `update_component_outputs`,
   `configure_outputs_interaction`) and their handlers; keep `execute_component`.
   `agentRuntime/agentTools.js`: remove the `system-component-designer` injection block;
   `agentRuntime/index.js`: stop re-exporting `SYSTEM_TOOLS`; `auth/mfaRoutes.js:348`
   comment. If `SYSTEM_TOOLS` becomes empty, delete the constant and its check at :242.
5. `core/cms/componentManager.js`: delete the write side (`installComponent` with
   body-supplied deps, `removeComponent`, `updateComponent`, `readComponentFiles`,
   `ALLOWED_DEPENDENCIES`/`disallowedDependencies` if only the write side used them)
   and their tests (`componentManager.deps.test.js` if it only covers the write side;
   `componentManager.dir.test.js` stays if it covers boot loading). Keep the boot path.
6. Capability `component_designer`:
   - `core/entitlements/capabilityRegistry.js` USER_FACING_CORE → `['notebooks','projects']`
     (and its registry entry); `license/tiers.js` list; `stores/user/schema.js` DEFAULT and
     backfill → `'["notebooks","projects"]'`; `license/featureMap.js`.
   - A new migration `server/migrations/<date>-drop-component-designer.js` that removes
     `"component_designer"` from every `organizations.org_granted_capabilities` JSON array
     and deletes the `system-component-designer` row from the agents table (system agent,
     not user data). Register it where the existing migrations are listed. Keep
     `org-granted-capabilities-2026-09.js` as history; adjust its integration test only
     where it asserts the default value.
   - Tests that name the capability: `featureAccessRoutes.everyoneRevoked.test.js`,
     `entitlements.test.js`, `communityEnforcement.test.js`, `tiers.test.js`,
     `org-granted-capabilities-2026-09.integration.test.js`, `agentTools.agentEnabled.test.js`,
     `projects/myProjectChats.pg.test.js`: switch the sample capability to `notebooks`
     where the test is about the mechanism; delete the assertion where it is about the
     designer itself.
7. `stores/agent/systemAgentRegistry.js`: remove the Component Designer starter agent
   (the wizard then seeds 9 starter agents; update any count in tests and docs).
8. `core/executionEngine.js:22` header comment; `modules/catalog.js:62` comment.
9. i18n: delete `server/i18n/defaults/en/component_studio.js`, remove it from
   `en/index.js`, append its 182 keys to `removed-keys.txt` (same format as the file),
   run `npm run i18n:gen` and commit `agent-hub/src/i18n/en-defaults.js`.

## agent-hub

10. Delete `src/components/admin/component-studio/` (ComponentBuilder, AIComponentDesigner,
    their tests and any split-out modules phase 5 created under it).
11. `AuthedApp.jsx`: the lazy import (:45) and the `RequireTier feature="component_designer"`
    page (:563-564); `authedApp/appRoutes.js:40` `components: '/app/components'` and every
    nav/menu entry that points at it (grep `navigateToPage('components')`, `'components'`
    page ids, Sidebar, Studio rail, command palette, onboarding checklists).
12. `components/licensing/LicenseContext.jsx` feature table if it lists
    `component_designer` (keep TIER_HIERARCHY in sync with `license/tiers.js`).
13. Ratchets: run `--update` on the ones that now have slack (big-file, ts-ratchet,
    style, fire-event, module-mock, authfetch-effect, i18n-ratchet, unchecked-mutation,
    file-budget, eslint-budget); never raise.

## docs and README

14. Delete `docs/docs/studio/components.md` and its `sidebars.ts` entry (:122, keep
    `sidebars.test.mjs` green); edit `studio/index.md:119`, `licensing/tiers.md:39,:155`,
    `getting-started/tiers.md:37`, `getting-started/wizard.md:84` (starter agents),
    `features/chat.md:41`, `admin/chat-signals.md:66`, `self-hosting/upgrades.md:108-115`
    and `README.md:140-146` (the "components/ must be writable or the Component Designer
    cannot save" notes: the folder still has to be readable by uid 1000 for the shipped
    components; say that instead).
15. `docs/docs/licensing/tiers.md` capability table: drop the row.

## Verification (the orchestrator runs the suites)

- `npm run check:fast`, `npm run test:scripts`, `npm run lint:i18n-gen`,
  `node scripts/i18n-key-guard.mjs --base origin/main` (removed keys listed).
- `cd server && npm test` (no reference to the deleted modules: `node importPaths.test.js`
  and `auth/routeSurfaceSweep` cover index.js), `npm run typecheck`.
- `cd agent-hub && npx vitest related --run <changed>` + `npm run typecheck` + eslint;
  `npm run lint:dead` (knip) must not list a now-orphaned file.
- `cd docs && npm run build` only if the docs lane changed sidebars (or the sidebars test).
- `node --test 'components/**/*.test.js'`: the shipped components still pass.

## Out of scope (say so in the commit message)

- Moving the shipped components into a sandbox: not needed once no untrusted code can be
  written; the phase-1 env allow-list, timeout and output cap stay.
- Removing `docker.sock` from the compose files: it serves the hub-module scan runner and
  the docker kit, not the components.
