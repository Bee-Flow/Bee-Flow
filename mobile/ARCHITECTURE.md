# Mobile architecture

How the Android app's source is organised, and the rules that keep it that way.
Most rules are enforced by `eslint.config.js`, `quality-budget.json` and the
tests under `src/meta/`; the rest are review rules.

## Layers

```
app/            routes (expo-router). Thin: read params, render a screen.
src/core/       app-wide plumbing: api, auth, crypto, i18n, theme, access, providers, diagnostics
src/shared/     domain-free building blocks: ui, patterns, stream, markdown, navigation, device, lib
src/features/   one folder per domain (chat, automations, org, …)
src/meta/       tests about the repository itself (CI filters, native deps, routes)
```

Imports only point down the stack: `app → features → shared → core`.

- `core` never imports `shared` or `features`.
- `shared` never imports `features`.
- A feature imports another feature only through that feature's `index.ts`,
  never from its internals.
- No two features import each other at runtime (type-only imports aside):
  an index loads its whole feature, so a two-way edge is a module cycle. A
  screen that composes several features (the Library hub, the Cowork hub,
  the list of every conversation, the drawer in `shell`) is a feature of its
  own above them.
  `src/meta/featureCycles.test.ts` fails on a cycle.
- `shared/lib` has no dependencies at all, so any layer may import it.

Cross-area imports use the `@/` alias (`@/core/api/client`,
`@/features/chat`). Imports inside one area are relative. `../../` is not
allowed: a file two folders deep in a large feature reaches a sibling folder
of its own feature through the alias instead
(`@/features/flow-editor/model/…` from `flow-editor/components/outline/`).
That is the one alias path into a feature's internals, and only for the
feature itself.

## A feature folder

```
src/features/<domain>/
  api/          endpoints.ts   one function per server call, returning validated data
                readers.ts     contract specs (core/api/contract) for every response shape
                keys.ts        react-query key factory
  hooks/        queries.ts / mutations.ts (or one file per entity): useX(), useUpdateX()
  model/        types.ts, format.ts and pure logic (unit-tested), plus the
                feature's device-side state (AsyncStorage, zustand, files);
                never a server call, which is api/
  components/   one component per file
  screens/      <Name>Screen.tsx, composed from components; this is what app/ renders
  index.ts      the public surface; everything else is internal
```

A small feature can skip the folders it does not need. A folder with one file
may be a single file instead (`api.ts` rather than `api/endpoints.ts`).

A large feature may split `api/` by resource (one file per group of calls,
readers beside them) and keep substantial device-side state in its own
`state/` folder rather than in `model/`: the flow editor's draft store (one
zustand store per open routine, its undo history and its debounced,
single-flight autosave) lives in `features/flow-editor/state/`, and its hooks
hand it to screens.

## Size limits

Code lines exclude comments and blank lines.

| Where | Per file | Per function |
|---|---|---|
| `src/**` | 300 code lines | 120 (components) / 80 (other) |
| `app/**` | 60 code lines (150 for `app/_layout.tsx`) | as `src/**` |

Also: complexity 15, depth 4, parameters 4. Tests are exempt.

`npm run lint` (`eslint . --max-warnings 0`) enforces these limits and the
import rules below (`../../`, layering, `expo/fetch` outside `core/api`) as
errors. The numbers live in `eslint.quality.js`.

A file that is over a limit is listed in `quality-budget.json` at its
measured size, and ESLint holds it there. `src/meta/qualityBudget.test.ts`
fails when an entry is stale (the file shrank, was split or is gone), so the
budget only shrinks. If you touch a budgeted file, split it. The same file
records the count of inline style objects, exactly: every object literal
written into a `style` or `…Style` prop, including one inside a style array.

## Data

- Only `core/api` talks HTTP (`expo/fetch`, XHR). Features call
  `api.get/post/…` from `core/api/client`; an upload a person watches
  declares an `UploadTarget` (path, multer field, cap, extra text parts) and
  hands it to `uploadFile` in `core/api/xhrUpload`.
- One function per server call. When two features need the same call, one
  owns it and the other adapts its answer (the flow editor re-reads the
  automations feature's row into its strict definition).
- Every response is read through a contract reader (`shapeOf`, `field.*` in
  `core/api/contract`). Casting with `api.get<T>()` and trusting the server
  shape is not allowed: the server is JS, and a renamed field has to fail in
  a test, not render `undefined`.
- Screens never call `useQuery`/`useMutation` directly. They use the
  feature's hooks, which own the query keys, the invalidation and any
  optimistic update.
- By default only GET/HEAD retry. A write retries only when it opts in (see
  `RequestOptions.retry`).
- Streams go through `shared/stream`: one SSE framer, one chat frame reducer,
  and per-surface adapters.

## UI

- Build screens from `@/shared/ui` primitives (one per file, imported from
  the barrel) and `@/shared/patterns`:
  - `QueryList` for a searchable, refreshable list;
  - `QueryScreen` for a detail screen's loading, error and refresh;
  - `FormSheet` with `useForm` (and the `validators`, which trim: a password
    brings its own rules);
  - `useConfirm()` instead of `Alert.alert` (`ConfirmProvider` is mounted at
    the root);
  - `GuardedDeleteSheet` for server-guarded deletes.
- The kit paints the web's recipes (agent-hub/src/components/shared), not its
  own: `Button` primary is the accent (`accentPrimary` under
  `accentPrimaryFg`), never an ink fill, and danger/warning are tinted;
  `Badge` is the status chip (the tone at 15% under its ink). A status
  colour is a pair from `tones.ts`: the raw colour for fills, borders and
  stripes, the `-ink` colour for words and glyphs. `tint(colour, n)` is
  `color-mix(… n%, transparent)`.
- A Studio object's screen opens with `ObjectHeader` (kind tile, name,
  status chip, one primary action, `TabBar` sections); its kind's colour,
  glyph and tile shape come from `kinds.ts`, the port of the web's
  `kindColors.js`. Tables are `DataList`, overflow menus `ActionMenu`,
  navigation `nav/NavRow` under `nav/SectionLabel`.
- `ScreenHeader` renders the global header actions (search, the bell) that
  `app/_layout.tsx` supplies through `HeaderAccessoryProvider`; the kit itself
  makes no API calls.
- Error wording comes from `describeError` in `core/api/errors`; `ErrorState`
  and `FormSheet` render it.
- Icons are Lucide, the web's set: `<Icon name="MessageSquare" />` from
  `@/shared/ui` (stroke 1.75, `ACTIVE_STROKE` 2.25 for the selected item).
  A stored icon value (`app.icon`, `project.icon`, …) goes through
  `<AppIcon>`, which draws a Lucide name or an emoji. The names live in
  `shared/ui/icons/registry.generated.ts`: add one to `MOBILE_ICONS` in
  `scripts/sync-web-icons.mjs` and rerun it. It imports one module per icon,
  because the package barrel would bundle all of Lucide.
- Styles go in `StyleSheet.create`, or themed via `useThemedStyles`. Inline
  style objects (`style={{…}}`, or one inside `style={[…]}`) are counted by a
  ratchet that may only go down. A themed sheet that every row of a list or
  every node of the canvas asks for is wrapped in `perTheme`, so a row that
  mounts while scrolling reads the sheet instead of building it.
- Every user-facing string goes through `t(key, 'English fallback')`:
  - Borrow the web's key when it exists in both dictionaries.
  - Otherwise use `mobile.<area>.<key>`. A `mobile.*` fallback whose English
    is already a web sentence fails `i18nGuard.test.ts` unless its ledger
    says why the meaning differs.
  - `src/core/i18n/i18nGuard.test.ts` holds the ledger of areas that still
    have hard-coded text; it may only go down.

## Navigation

The shell mirrors the web sidebar (agent-hub `components/shell/Sidebar.jsx`),
natively:

```
app/_layout.tsx                 root Stack: (onboarding), (drawer), and every
                                detail screen — they push over the whole drawer
app/(drawer)/_layout.tsx        Drawer (features/shell DrawerLayout): 288dp,
                                bgSecondary, black 50% scrim, edge swipe
app/(drawer)/(tabs)/_layout.tsx bottom bar (features/shell TabsLayout): Chat,
                                Studio, and Meeting Notes behind that Studio
                                section's gate (model/tabs.ts)
```

- Route groups never change a URL. Only the tab roots (`/`, `/studio`,
  `/record`) live inside the drawer; a new screen goes in the root Stack
  (Cowork at `/cowork` and the Apps directory at `/apps` are pushed screens).
  A header inside the drawer shows the drawer toggle (`HeaderMenuProvider`),
  a pushed one shows Back.
- An address that may be a tab root — a link, a notification, a search hit,
  a sitemap row — is opened with `openRoute` (`@/shared/navigation`), never
  `router.push`/`navigate`: from a pushed screen both of those stack a second
  copy of the drawer. `openRoute` pops back to the drawer instead.
- The drawer's fixed rows come from the web's `coreNav`/`secondaryNav`
  (`features/shell/model/nav.ts`, pinned by `sidebarNav.lockstep.test.ts`),
  but the phone draws only New Chat, Approvals, Search and Agents above
  Projects, My Agents and the chats. Cowork, Studio, Apps, Forms and Notebooks
  open from the Studio tab: its Workspace group (`useWorkspaceLinks`, each row
  on the drawer row's old terms in `model/gates.ts`) and its sections.
  On the Studio tab the drawer's middle is Studio's menu instead
  (`components/StudioMenu`, chosen by `model/drawerMenu.ts`), as the web's
  StudioRail replaces the sidebar: back to Chat, Start, Search, the Workspace
  group and the sections from `studioMenuGroups` (the hub's own list), and
  Approvals. The header and profile footer stay.
- Studio is `features/studio`: `registry.ts` ports the web's `STUDIO_APPS`
  (pinned by `studioSections.lockstep.test.ts`) and says where each section
  opens on the phone: a native screen, every one. Nothing in Studio opens the
  web in a browser tab: the tab does not share the app's session, and the web
  sends a phone-sized screen from Studio to the Agents chat (agent-hub
  `authedApp/guards.jsx`). The Studio tab (the shell's `StudioTabScreen`
  around `StudioScreen`) and the New menu resolve their rows through
  `model/resolve.ts`; someone the web would not show Studio to gets the
  Workspace group only.
- Every screen is listed in the sitemap (`features/sitemap/nav/destinations`),
  which the A–Z map and the global search read; `src/meta/routes.test.ts`
  fails on a screen it does not list. A detail screen (`[param]`) is reached
  from its list, and a `…/new` screen is its list's New action (and the
  Studio's New menu), so neither needs a row of its own while its list has
  one. A web link (`/app/...`) is translated
  by `features/notifications/model/route.ts` (Studio in `routeStudio.ts`,
  held to the registry by `routeStudio.lockstep.test.ts`).

## Performance

- Lists that can grow are virtualised (`FlatList`/`SectionList`), with
  `renderItem` and separators declared outside the render function. Never
  `ScrollView` plus `.map()` over data that has no upper bound.
- A streaming answer re-renders only the streaming cell. Everything else
  subscribes to stable state.
- The React Compiler is on, so manual `useMemo`/`useCallback`/`memo` belong
  only where a measurement or a list cell needs them.
- Images load by URL through `expo-image`, not as base64 held in state.

## Access

What a session may be OFFERED comes from `@/core/access`, the port of the
web's three gates (licence, entitlements, permissions) plus the admin roles.
It decides what to render, never what to allow: the server answers 403 on its
own.

- Screens ask a hook: `useGate({ … })` for a row or button, `useCan`,
  `useHasLicenseFeature`, `useHasPermission`, `useIsOrgAdmin`,
  `useIsSuperAdmin`. A list that gates many rows takes one `useAccess()`
  snapshot and calls `evaluateGate` per row.
- A person gate (permission, admin role, Simple Mode, feature flag) hides.
  A licence or capability gate hides, or with `lockOn: 'disable'` shows the
  row locked with `lockHint(reason, t)` — but only once the entitlements
  have answered, so nothing flashes "upgrade" on start-up.
- `useIsOrgAdmin` is the server's org-admin predicate (super admin, an
  `org_admin`/`admin` orgRole, or the `org_admin` permission). `manage_users`
  on its own is not an org admin; ask `useHasPermission('manage_users')`.
- New gating goes through these, not through `user.isAdmin` or
  `permissions` read in a screen.

## Sharing logic with the web app

Metro cannot import from `agent-hub/` or `server/`, so shared logic is ported
to TypeScript here and pinned to the original by a test that reads the source:

- **byte** tests, for files vendored verbatim (e.g. the expression engine);
- **differential** tests, which run the web module and the port on the same
  fixtures;
- **textual** lockstep tests, which compare ids, order or keys (e.g.
  `catalogLockstep`, `statusLockstep`);
- **generated** files, which a script writes from the web source and a test
  regenerates to compare: the design tokens (`npm run sync:tokens`, from
  `agent-hub/src/index.css` into `core/theme/generated/`) and the icon
  registry (`scripts/sync-web-icons.mjs`). Never edit one by hand.

When such a test fails, the web side changed. Update the port; don't loosen
the test.

## Flow editor

The routine builder (`features/flow-editor`) is the web builder
(`agent-hub/src/components/automation/Builder/`) ported to touch, so it
follows the rule above more than any other feature does. Its folders, bottom
up:

```
shared/expr/vendor/   the expression engine, byte-identical to agent-hub/src/shared/expr
shared/mapping/vendor/ the binding core (path walker, legacy kinds), generated from server/shared/mapping
model/                the graph, pure: normalize, edges, flowOrder, nodeDefs, palette,
                      route model, issues, summaries, layout, history, flowlets;
                      model/outline/: insert, remove, duplicate, move, pin, disable,
                      step addresses and findNode
bindings/             values and references: valueParts, refTokens, upstream/*, autoMap
formState/            per step type: step → draft (extract) and draft → patch (buildPatch)
schemaForm/           an app action's inputs from its catalog inputSchema (ToolInputForm)
api/ · hooks/         definition, catalog, versions, runs, templates, links, folders,
                      lookups (knowledge bases, approvers, credentials, documents), the AI builder stream
state/                one zustand draft store per open routine: undo, dirty, autosave;
                      a flowlet edits a scoped view of it (scopedStore)
components/           outline · canvas · picker · issues · nodeEditor · fields ·
                      variables · editors/<type> · run · versions · settings · ai
screens/              Build (Steps | Canvas), Flowlet, NodeEditor, Versions, FlowSettings
```

Routes: `app/automations/new`, `[id]/build`, `[id]/flowlets/[layerKey]`,
`[id]/steps/[stepId]`, `[id]/versions`, `[id]/settings`. Forms (`features/forms`) are routines with
a form trigger: the Form page edits that trigger through the same draft store,
and `app/forms/fill/[token]` fills a form in natively.

- **Porting.** Every pure web module the builder uses is ported, not
  rewritten, and pinned: differential where the web file's imports are pure
  (Jest runs it beside the port through the `../agent-hub` transform in
  `jest.config.js`), textual where it is not (the rule's own line is looked
  up in the web source). Fixtures come from `server/automation/templates.js`
  and the web's own tests. A behaviour the web keeps inline in JSX is lifted
  into a pure `*Model.ts` beside its editor and pinned the same way.
- **Step editors.** `components/editors/registry.ts` picks one per type: a
  bespoke editor in `editors/<type>/`, else a declarative spec
  (`editors/declarative/specs/`), else the JSON view — which only `parallel`
  (no editor on the web either) and the retired `parse_json` still reach. A
  bespoke editor may render its spec's plain bands with `SpecSections`.
- **Words.** An editor borrows a web key present in both dictionaries, or says
  `t('mobile.flow.<area>.<key>', 'English')` in the web editor's own words:
  `editorWords.lockstep.test.ts` (bespoke editors) and
  `specs.lockstep.test.ts` (specs) check each sentence against the web file
  it ports, and list the few the phone words itself with the reason.
- **Adding a step editor:** add the folder, register it in `EDITORS` (and
  `FORMS` if formState does not carry its draft keys), map the folder to its
  web files in `editorWords.lockstep.test.ts`, and pin its model.

## Tests

Tests sit next to the code (`x.ts` ↔ `x.test.ts`), under `src/` only.

- Pure logic gets unit tests.
- Shared patterns and primitives get React Native Testing Library tests.
- Stateful hooks get hook tests.
- `serverContract.test.ts` pins request and response shapes against the
  server source.
