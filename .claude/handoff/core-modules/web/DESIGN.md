# The web client: core and modules (design for plan phase 2)

Three designers proposed a design each from a different starting point (ask by name, as the
server does; typed extension points in the shell; let the build do it), and a fourth compared
them against the code. This file is the merged design, with the driver's decisions on top.
Where a decision below contradicts the text further down, the decision wins.

## Decisions (the driver's)

1. **The shell lists stay where they are, byte for byte.** A module's row (label key, icon, path,
   gate, position) stays in the core list file; an owner table beside it says whose row it is,
   and one filter per list reader hides the rows of a module that is not available. Only the
   CODE a row renders leaves the core: an import becomes a lookup by name. This is the same
   idea as on the server (the core asks for a module's file by name; the names are in the
   core), it changes the least, and the inventory goldens prove the GUI identical because the
   lists do not change at all.
2. **A key is `<moduleId>:<Export>`.** The core owns the contract types of what it asks for; a
   module's area file `src/firstParty/<id>.<zone>.tsx` provides them.
3. **Zones.** A part that renders synchronously today must do so afterwards: no new flash, no
   layout shift. So a module's area file loads together with the core lazy boundary that hosts
   its keys (`lazyZone`), not at boot and not on first render.
4. **The project workspace client is NOT re-owned to the core.** The judge grafted that from two
   proposals. On the server the project STORES are core (core tables refer to projects) and the
   project ROUTES are the module `projects`: a core server answers 404 on `/api/projects`. The
   web client follows: `api/queries/projects.ts`, `useProjectStream`, `projectNavigation` and the
   other files the map gives to `projects` stay there, and the core asks for them by name with
   an absent answer (no project context). Only leaf helpers that need no module code, no
   module route and no module i18n namespace are re-owned to the core.
5. **Run-time state.** The server tells the client which first-party modules are loaded. First
   look for an open bootstrap response the client already fetches before login and add a field
   there; only if there is none, a new open route with its reason in `server/auth/openRoutes.js`.
   The answer names module ids and states, nothing else. On an error or a timeout every built
   module counts as loaded (today's behaviour). Rows are also hidden by the capability
   projection (server task `capabilities`): the two must agree, and a test holds that an absent
   module has neither a row nor a capability.
6. **An absent module shows nothing that sells it**: no locked row, no upgrade text. Its address
   still parses and shows "module not installed" inside the shell.
7. **Module files are moved, never edited.** A change to a module-owned screen in this phase is a
   finding, except the area files, which are new.
8. **Proofs, in this order**: the ten inventory goldens byte-identical; the same sha256 per tree
   path for every module-owned file; `web-build-sources --check` showing additions only; the
   core tree (core-owned files alone) building, type-checking and passing its tests; screenshots
   before and after once a stack is available.
9. **This machine cannot run two typechecks of the web client at once** (a memory limit kills
   tsc). Slices that need the full `npm run typecheck` of agent-hub run it one at a time; the
   driver runs it again on every merge.

## What the judge found wrong in the proposals, and what is still unverified

- Wrong: Brief: '172 static edges in 107 files'. web-edges.json has 173 static edges in 108 files, plus 196 lazy (144 i18n, 52 other). All three proposals use 173.
- Wrong: slots: 'the PANELS map (AdminTabContent.tsx:130) ... the data rows import nothing'. AdminTabContent.tsx:38 statically imports ComplianceHub (module), and :151 renders it, so PANELS is a render map over module imports, not import-free data.
- Wrong: slots: the list of row files that import nothing also includes studioSections.ts. Its top-level imports are indeed only lucide and types, but :274 does a lazy import of automation's createDraft (slots does note this elsewhere).
- Wrong: build: lazyWithReload gives 'one reload per visit' on a permanently missing chunk. In fact (lazyWithReload.ts:71-77) the flag is removed when it gives up, so the reload happens on every second failing attempt: a repeating loop, but not on every visit.
- Wrong: by-name and slots both imply that the project-container client is an ownership mistake to fix in the map alone. The plan does keep the container core, but server/routes/projects.js is currently mapped to projects as well, so the server side does not yet reflect that decision either.
- Unverified: The counts per edge kind in the merged table (60/6/16/47/2/7/18/13/4) are a reconciliation of the proposals' classifications, not my own full recount. W3 should produce the exact classification with a script.
- Unverified: The figure of about 68 type-only imports in 48 core files: two proposals report it, and I did not recount it.
- Unverified: The figure of 24 core test files with module edges (build's probe).
- Unverified: Whether typescript-7 honours rootDirs together with paths fallback arrays.
- Unverified: Whether every core consumer of RecorderContext, CaptureContext and ProjectLiveContext has a default.
- Unverified: Whether sourceAst.ts can be extended to resolve lookups without weakening it.
- Unverified: The bundle effect of area chunks per zone compared with today's placement.
- Unverified: The shape and route class of the server's /api/modules/first-party (the server task is in progress).

## The mechanism

A1 TREE PATHS. Module area files live at agent-hub/src/firstParty/<id>.<zone>.tsx and later at modules/<id>/frontend/src/firstParty/<id>.<zone>.tsx, at the same tree path. The zone is one of: boot | public | hub | studio | admin | settings | docs | demo. Each module also gets <id>.i18n.generated.ts. Ownership comes from one glob per module in scripts/module-map.json: "src/firstParty/<id>{,.*}.{ts,tsx}", mirroring server/firstParty/<id>.js plus its parts. W0 adds all 23 globs at once.

A2 CORE HOST. src/moduleHost/ is core and imports only react, utils and the virtual module. Its files:
- contract.ts
- registry.ts, the only importer of virtual:beeflow/*, enforced by eslint
- index.ts
- lazyZone.ts
- loadModuleChunk.ts
- ModuleBoundary.tsx
- ModuleNotInstalled.tsx and ModuleUnavailable.tsx (keys in a new core namespace: en/modules.js plus nl/modules.json)
- ids.generated.ts
- owners/<host>.ts
- exports/<zone>.ts
- testing.ts (withModules, mockModulePart)

```ts
export type FirstPartyId = (typeof FIRST_PARTY_IDS)[number];
export type ModuleState = 'loaded'|'absent'|'failed';
export interface ModuleScreens {} export interface ModuleParts {} export interface ModuleWraps {} export interface ModuleValues {} export interface ModuleLists {} // augmented in exports/<zone>.ts
type Lazy<P> = () => Promise<{ default: ComponentType<P> }>;
type Own<I extends string, M> = { [K in keyof M as K extends `${I}:${string}` ? K : never]?: M[K] };
export interface ModuleArea<I extends FirstPartyId> { id: I; zone: ZoneKey;
  screens?: { [K in keyof Own<I, ModuleScreens>]: ComponentType<ModuleScreens[K]> | Lazy<ModuleScreens[K]> };
  parts?: { [K in keyof Own<I, ModuleParts>]: ComponentType<ModuleParts[K]> | Lazy<ModuleParts[K]> };
  wraps?: { [K in keyof Own<I, ModuleWraps>]: ComponentType<ModuleWraps[K] & { children?: ReactNode }> | Lazy<ModuleWraps[K] & { children?: ReactNode }> };
  values?: Own<I, ModuleValues>; lists?: { [L in keyof ModuleLists]?: ModuleLists[L] }; }
export const defineModuleArea: <I extends FirstPartyId, const A extends ModuleArea<I>>(a: A) => A;
export function moduleScreen<K extends keyof ModuleScreens>(k: K): ComponentType<ModuleScreens[K]>; // absent->ModuleNotInstalled, failed->ModuleUnavailable, in ModuleBoundary
export function modulePart<K extends keyof ModuleParts>(k: K): ComponentType<ModuleParts[K]>;       // absent/failed -> null
export function moduleWrap<K extends keyof ModuleWraps>(k: K): ComponentType<ModuleWraps[K] & { children?: ReactNode }>; // absent -> children
export function moduleValue<K extends keyof ModuleValues>(k: K, absent: ModuleValues[K]): ModuleValues[K]; // late-bound fn or hook
export function moduleImport<K extends keyof ModuleValues>(k: K): Promise<ModuleValues[K] | null>;
export function moduleList<L extends keyof ModuleLists>(l: L): ReadonlyArray<ModuleLists[L]>;
export function moduleState(id: FirstPartyId): ModuleState; export function moduleAvailable(id: FirstPartyId): boolean;
export function visibleByOwner<R>(host: OwnerHost, rows: readonly R[], keyOf: (r: R) => string): R[];
export function lazyZone<T>(zone: ZoneKey, importer: () => Promise<{ default: T }>): ExoticComponent<PropsOf<T>>;
export function bootModules(): Promise<void>;
```

KEY NAMES. A key is '<id>:<Export>', and its prefix is the owner. A test in the style of server/boot/featureModules.test.js checks: every key the core asks for has a contract in exports/; in full mode exactly one area file provides it; that area file is owned by the module in the prefix; and every key is asked for only inside the static closure of its zone's boundary (via importEdges() of module-map-edges.mjs).

A3 DISCOVERY OVER ROOTS.
- Vite and vitest: plugin agent-hub/vite/beeflowModules.mjs, using node:* only, registered next to cmsReactRuntime in vite.config.js.
  - (a) virtual:beeflow/first-party exports AREAS: {id, zone, load}[] over agent-hub/src and modules/*/frontend/src. *.boot.tsx and *.public.tsx are imported statically, so ProductWebsite at AppRoutes.tsx:5 keeps its entry-chunk placement.
  - (b) virtual:beeflow/en-namespaces holds the i18n chunk loaders over every root.
  - (c) BEEFLOW_HIDE_MODULES skips hidden ids, and resolveId rejects any hidden-owned file, using loadModuleMap().ownerOf('agent-hub', tp) with the semantics of server/modules/roots/rootSet.cjs:87-127.
  - (d) A tree-path resolveId over the roots, idle while no frontend root exists.
  - (e) fs.allow, resolve.dedupe react, test.include and optimizeDeps.entries.
- tsc (typescript-7 7.0.2): a generated tsconfig.roots.json with rootDirs, '@/*' paths falling back per root, and include. The virtual modules are declared in src/vite-env.d.ts.
- ESLint: per-root config, and ^virtual: ignored by import/no-unresolved.
- knip: entry src/firstParty/*.{ts,tsx} plus the module roots.
- Tailwind: tailwind-utilities.css gets @source "../../modules/*/frontend/src".
- i18n generator: writes each chunk into the root of its owner, plus coreNamespaces.generated.ts and <id>.i18n.generated.ts.
- Mobile: mobile/jest.resolver.js falls back by tree path. deep-imports.exclude.json and shared-mirror.manifest.json are read as tree paths. A rule bars moduleHost from mobile-executed files.
- modules/<id>/frontend/package.json is {type:'module'}, because modules/package.json is commonjs.

A4 RUN-TIME STATE.
- Server: GET /api/modules/first-party is an OPEN route, with its reason in server/auth/openRoutes.js. It returns {rev, modules: Record<id, state>} from moduleStateOf (moduleState.js:114).
- Client: AppRoutes.tsx:20 lazyWithI18n becomes lazyWithShell = Promise.all([import('./AuthedApp'), ensureI18nDefaults(), bootModules()]). Public module pages await the same promise inside moduleScreen.
- On a 404, an error or a 3 s timeout, every built module counts as loaded (today's behaviour).
- State = built AND server-loaded. A key built while its chunk failed counts as failed.
- The state is frozen per page, so hooks keep their order.
- Module-dependent values are never evaluated at module scope. dispatch.ts:34 SSE_HANDLERS becomes memoised on first dispatch, and the registry throws 'not ready' in dev and test when read before boot.

## How each kind of import from the core into a module is settled

Counts are a reconciliation of three classifications, not an exact count: slice W1 produces the exact one.
The first kind is narrowed by decision 4: the project workspace client is not part of it.

### ownership fix (map only): leaf helpers, project-container client, non-app files (about 60)

- How: Edit only scripts/module-map.json. The leaves (36 edges, 15 files): cmsPublicRouting x6, notebookRef x5, projectRoutes x5, projectErrorText x4, consent x2, citationText x2, CitationChips x2, chatMonitoringLabels x2, coworkSchedule x2, chatMonitoringForm, appLabels, IntegrationLogo, meetingNotesConfig, projectVisuals, projectErrors. Check each one's i18n namespaces first. The project-container client (about 22 edges: api/queries/projects.ts, useSetMemberColor, projectNavigation, workspace/types.ts, useProjectStream, useProjectsAvailable) follows plan line 25 and needs the owner's yes. The non-app files project-preview.tsx and test/refEditor.ts go to their modules.
- Absent answer: none: the file is core
- Example: src/utils/helpers.ts:1 imports utils/cmsPublicRouting.ts, which module-map.json:528 maps to cms. One glob move clears 6 edges.

### seam re-owned, then asked for once (about 6)

- How: Re-own AgentHub/useComposerMode.ts and AgentWizard/triggers/MailTriggerModal.tsx to cowork. Six edges become two lookups.
- Absent answer: useComposerMode gives {coworkMode:'chat', inCoworkMode:false, coworkComposer:null, setters noop}; MailTriggerModal renders null
- Example: AgentHub.tsx:13 `import useComposerMode from './AgentHub/useComposerMode'` becomes moduleValue('cowork:useComposerMode', ABSENT_COMPOSER_MODE). Line 97 is unchanged.

### screen / page / admin panel / settings tab / hub page (about 16)

- How: `const X = moduleScreen('<id>:<Name>')`; the row and the JSX are unchanged. It also settles about 26 lazy edges (studioRegistry.tsx:27-37, hubLazySlots.tsx:15-25, AuthedApp.tsx:56-57, AppRoutes.tsx:24-37, Sidebar.helpers.tsx:16).
- Absent answer: ModuleNotInstalled inside the shell; ModuleUnavailable when failed
- Example: AdminTabContent.tsx:38 `import ComplianceHub from '@/components/admin/compliance'` becomes moduleScreen('compliance:ComplianceHub'). Row :151 is unchanged, owners/admin.ts adds compliance:'compliance', and compliance.admin.tsx provides `() => import('../components/admin/compliance')`.

### component or inline section embedded in a core screen (overlays are its lazy form) (about 47)

- How: `const X = modulePart('<id>:<Name>')`; the JSX position keeps the order. A part that was static is provided statically by its zone's area file, so it stays synchronous.
- Absent answer: null; the error boundary also renders null
- Example: AgentHub/AgentChatView.tsx:9 and DirectChatView.tsx:11 CoworkModeToggle become modulePart('cowork:CoworkModeToggle'); the JSX at :243 and :188 is unchanged. cowork.hub.tsx provides it statically. The zone boundary AuthedApp.tsx:24 `lazy(() => import('./AgentHub'))` becomes lazyZone('hub', ...).

### provider (about 2)

- How: moduleWrap, which also covers the lazy RecorderProvider and CaptureProvider at AuthedApp.tsx:50-53. Check the context defaults first.
- Absent answer: children only
- Example: AuthedApp.tsx:1 ProjectCaptureProvider, used at :548, becomes moduleWrap('projects:ProjectCaptureProvider'). AgentHub.tsx:25 ProjectLiveProvider follows the same pattern, unless the container decision re-owns it.

### hook (about 7)

- How: moduleValue('<id>:useX', fallbackHook), frozen per page.
- Absent answer: useActiveCoworkCount gives 0; useApprovalsNav gives {pendingCount:0,hasApprovals:false}; useTrainingGates gives {lockFor:()=>null}; useComplianceCounts gives zeros
- Example: components/shell/Sidebar.types2.ts:4 useActiveCoworkCount becomes moduleValue('cowork:useActiveCoworkCount', () => 0). Line 41 is unchanged.

### API / query module (about 18)

- How: moduleValue (a query fallback is an AbsentQuery<T> restricted to the fields the core reads). A callback-time import becomes moduleImport.
- Absent answer: Query: {data:undefined,isLoading:false,isError:false}. Function: null or a no-op. No request to an unmounted route.
- Example: AgentHub/useHubStartup.ts:3 loadWorkspaceNotebook becomes moduleValue('notebooks:loadWorkspaceNotebook', async () => null). studioSections.ts:274 `await import('@/api/queries/automation/createDraft')` becomes moduleImport('automation:createAutomationDraft').

### helper or constant (incl. the designer clusters: datatables display in KnowledgeStudio, MermaidBlock, OutputFieldsCard) (about 13)

- How: moduleValue with a fallback; constants become thunks and are never read at module scope. A designer decides whether OutputFieldsCard becomes an automation-owned seam.
- Absent answer: providerName humanises the id; describeMailTrigger returns ''; resolveLessonSteps returns []
- Example: KnowledgeStudio/CloudFolderPicker.tsx:5 providerName becomes moduleValue('datatables:providerName', humanise).

### list a module contributes to (about 4)

- How: moduleList spread into the existing builder, evaluated lazily.
- Absent answer: contributes nothing
- Example: dispatch.ts:3,6,12 and handlers/tools.ts:1 become moduleList('chat.sseHandlers'); SSE_HANDLERS (:34) is memoised on first dispatch.

### type-only import (about 0)

- How: Not in the 173. About 68 type-only statements in 48 core files move to exports/<zone>.ts, or a pure .types.ts is re-owned. They are a separate ratchet metric, enforced by the core-tree tsc.
- Absent answer: compile time only
- Example: AgentChatView.tsx:22 `import type { ProjectContextPillProject }` comes from exports/hub.ts instead.

### i18n (about 0)

- How: 144 lazy edges from enNamespaces.ts:18. It becomes {...CORE_NAMESPACE_LOADERS, ...registry.i18nLoaders()}. en-defaults.js stays whole until step 2.5.
- Absent answer: the namespace is never loaded
- Example: learn.generated.mjs is listed in learning.i18n.generated.ts.

## The shell lists

No row moves: APP_ROUTES and PAGE_ROUTES (executed by mobile), STUDIO_SECTIONS (studioSections.ts:147, imports limited to lucide and types by its IMPORT DISCIPLINE header at :24), ADMIN_TABS, settingsRoutes, orgSections, buildCoreNav and buildSecondaryNav (sidebarNav.tsx:88-108) and DEMO_FEATURES stay byte-identical. Only the code a row renders changes, from an import to a lookup.

OWNER TABLES, one core file per host:
- owners/studio.ts = {aiTasks, approvals, forms, runs: automation; datatables; webpages; apps; playbooks; solutions: projects; meetingNotes}
- owners/sidebar.ts = {cowork, approvals: automation, apps, forms: automation}
- owners/admin.ts = {compliance, support, product-website/website-analytics/release-notes: cms, subscriptions promos and stripe: billing_stripe}
- owners/settings.ts = {learning, help_support: support, org_academy: learning, org_github_sync: int_saas, org_meeting_templates: meetingNotes}
- owners/pages.ts, owners/orgSections.ts, owners/demo.ts
A test holds every table equal to the 'owner' column of its golden. For example, sidebarNav.inventory.golden.json row 'cowork' has owner 'cowork'.

FILTERS: visibleByOwner goes BEFORE the gate and lock logic, at these readers:
- resolveStudioNav (studioGates.ts:192)
- Sidebar.helpers.tsx:137 and :143
- buildAdminRailSections
- settingsNavItems.tsx
- the org-section builder
- the demo registry readers
It is the identity when every module is loaded.

EDITION: moduleAvailable false filters the row out; the address still parses and renders ModuleNotInstalled. A module's rows are never seen by the lock code, so it can show no teaser.

PROOF:
- (1) Every inventory golden (AuthedApp, appRoutes, settingsRoutes, hubLazySlots, studioSections, adminTabs, orgSections, sidebarNav, composerTools, studioRecentSources) stays byte-identical. W0 teaches test/guiInventory/sourceAst.ts to resolve lookups to the same tree path; its negative test checks that a lookup naming a different file changes the golden.
- (2) module-files-untouched: the same sha256 per tree path.
- (3) web-build-sources --check: only additions under firstParty/ and moduleHost/.
- (4) gui-inventory.core.json equals the full golden minus the hidden owners.
- (5) A screenshot walk once per wave.

The W3 owner-column diff is reviewed once.

## Loading and failure

ZONES. About 8 core boundaries change from lazy(() => import(X)) to lazyZone(zone, () => import(X)): AuthedApp.tsx:24 hub, settings, admin, studio, documents, demo and the public routes. lazyZone loads the host through lazyWithReload, and in parallel runs Promise.allSettled over the area chunks of available modules in that zone. Parts that were static before render synchronously inside the zone. Lazy keys stay thunks inside ModuleBoundary, with the LazyFallback from hubLazySlots.tsx:28.

MODULE CHUNKS go through loadModuleChunk: one retry after 250 ms, then the module is 'failed' for this page and the failure is logged. It never calls location.reload or touches RELOAD_FLAG, and a host never fails because of a module area. Absent answers are decided before the zone renders.

FIX: lazyWithReload.ts:71-77 removes RELOAD_FLAG when it gives up, so a permanently missing chunk reloads again on the next attempt. Clear the flag only after the same importer has loaded successfully, and cover it with a test.

WHAT THE USER SEES:
- Absent page: ModuleNotInstalled, with a link to /app and no upgrade text.
- Failed: ModuleUnavailable, with a user-initiated Reload.
- Parts: null. Wraps: children. Values: fallbacks. Rows: filtered.
- Deep links: the URL parses and the panel shows inside the shell.
- A blank screen cannot come from a module, because the shell needs none. The core-tree vitest and an all-'failed' registry test prove it.

## Core mode, the ratchet, CI

1 HIDE MODE (files present). BEEFLOW_HIDE_MODULES=all|ids makes the plugin drop the hidden areas and reject hidden-owned imports (static, import() and glob).
- build:core = vite build --outDir dist-core, then check:core-bundle.
- test:core = vitest over the core-owned test list.
- core-mode-failing-tests.txt may only shrink.

2 MATERIALISED CORE TREE. scripts/web-tree.mjs --mode core copies the core-owned files at their tree paths, the configs and a node_modules link, and regenerates en-defaults.js for the namespaces present. vite build, vitest, tsc --noEmit and knip then run unchanged. This proves absence 4a the way the core image will ship it, and catches type-only, CSS, ?worker and new URL edges.

3 EDITION. setup.ts can boot with BEEFLOW_WEB_STATE=core. Host suites use withModules({x:'absent'|'failed'}) and assert: rows gone, not-installed shown, no lock or teaser keys, no reload. An e2e crawl of the golden addresses runs against a server with BEEFLOW_EDITION=core and the full web build.

RATCHET: scripts/module-boundary.mjs --pkg agent-hub with budget agent-hub/.module-boundary-ratchet.json {static:173, lazy:52, i18n:144, typeOnly:~68}. Every metric goes to 0, --update only lowers it, and check:fast picks it up. Extra rules:
- only moduleHost/registry.ts imports virtual:*;
- an edge from module A into module B needs B in A's requires/uses;
- module-files-untouched;
- the module-mock ratchet flags vi.mock of module paths in core tests.

CI: steps in ci.yml's frontend job:
- full: typecheck, lint, vitest, build, goldens, sources;
- core: build:core, check:core-bundle, test:core;
- web-core: the materialised tree (build, vitest, tsc, knip);
- the edition crawl in the core-start e2e job.
If a new job is split out, update the lint:checks and lint:workflows tables.

## Slices

### W0 Module host and plugin (careful design first)

- Depends on: none
- What: moduleHost/*, beeflowModules.mjs, vite-env, eslint, knip, Tailwind @source, lazyWithShell at AppRoutes.tsx:20, test/setup boot, the lazyWithReload fix, the golden normaliser, the 23 firstParty globs, the 'modules' i18n namespace, and one demonstration key end to end (learning:LessonPlayerHost, AuthedApp.tsx:30).
- Files: about 30
- Gate: Goldens byte-identical. Full vitest, typecheck, lint, knip and build green. Sources: additions only. The accessor matrix test covers each kind × {loaded, absent, not built, failed chunk, failed fetch}. A no-reload test. A hidden import fails with a named message.

### WS Server route

- Depends on: the server edition/capabilities task
- What: The open GET /api/modules/first-party, its openRoutes reason, and regenerated openapi, apiTypes and routes-contract.
- Files: about 6 plus generated files
- Gate: lint:api-reference, lint:routes-contract, lint:api-types, route test

### W1 Ratchet and core tree

- Depends on: none
- What: module-boundary --pkg agent-hub with 4 metrics, the type-only scan, web-tree.mjs, module-files-untouched.mjs and the budget file.
- Files: about 9
- Gate: test:scripts. The ratchet reproduces 173/52/144/68. web-tree full equals in-place. The core-tree error list is recorded.

### W2 Core-mode scripts

- Depends on: W0, W1
- What: build:core, check:core-bundle, test:core and the failing-tests list.
- Files: about 4
- Gate: The failing-edge list equals web-edges minus the settled edges.

### W3 Ownership by map (careful design first)

- Depends on: Owner decisions
- What: The leaf files, the project-container client, the two seams and the two non-app files.
- Files: 1-2
- Gate: module-map --check. Static ratchet goes from 173 to about 111. Only map changes. Golden owner-column diff reviewed.

### W4a Hub and chat

- Depends on: W0, W3
- What: AgentHub.tsx, AgentHub/*, components/chat/*, SSE dispatch, MarkdownRenderer, sessionCaches, oauthPopupLaunchers, hubLazySlots, and lazyZone('hub').
- Files: about 25 core, 9 area, 1 exports
- Gate: Goldens identical, module files untouched, related and chat suites green in full and absent states, ratchet lowered, type-only edges at 0 for these files.

### W4b Studio and agents

- Depends on: W0, W3
- What: studioRegistry, studioSections:274, studioGates:299/302, studioApps, NewMenu, handoff, studioMap, KnowledgeStudio, AgentWizard, appCatalog, useTourRun, the resolveStudioNav filter, and lazyZone('studio').
- Files: about 22 core, 8 area
- Gate: studioSections golden identical. With automation absent there is no locked row and the address shows not-installed.

### W4c Admin and organisation

- Depends on: W0, W3
- What: AdminTabContent:38-46, AdminDashboard, subscriptions, IntegrationsAdminPanel, ServicesSection, OrgInfoPanel, OrgSectionBody, ShieldPane, the SSO files, Microsoft365Panel and the filters.
- Files: about 16 core, 10 area
- Gate: adminTabs and orgSections goldens identical; absent rows gone.

### W4d Settings

- Depends on: W0, W3
- What: renderSettingsContent, PreferencesSection, OrganisationSection, OrgSettings, IntegrationsSection, OrgIntegrationSettings, OAuthIntegrations, SecuritySection, ConsumerLicenseSection, AdvancedSettings, useSettingsAccess and the filter.
- Files: about 14 core, 10 area
- Gate: settingsRoutes golden identical, mobile lockstep green, no empty group header in core mode.

### W4e Shell, sidebar and demo (careful design first)

- Depends on: W0, W3, context-default check
- What: AuthedApp providers, overlays and pages; AppRoutes public pages; the Sidebar files with the filter; useStudioSectionData; the demo registry.
- Files: about 12 core, 10 area
- Gate: AuthedApp, sidebarNav and appRoutes goldens identical; DOM-order overlay snapshot identical; core mode renders.

### W4f Documents

- Depends on: W0, W3
- What: The documents pages, FillFooter, templateFill, MermaidView, versions and suggestions, KnowledgePanel.
- Files: about 12 core, 5 area
- Gate: As W4a, plus the editor/collab tests in core mode.

### W5 i18n per owner (careful design first)

- Depends on: W0
- What: The generator writes per root; enNamespaces reads core plus the registry.
- Files: about 6 plus 24 generated
- Gate: Identical en-defaults.js and chunks, lint:i18n-gen, lazy ratchet -144.

### W6 Core tree green and CI (careful design first)

- Depends on: W4*, W5, WS
- What: Make the core tree pass (about 24 core tests with module edges, leftover type imports, knip findings), add the CI steps and the edition crawl, set budgets to 0.
- Files: about 35
- Gate: web-tree core: build, vitest, tsc and knip all exit 0. lint:checks, lint:workflows.

### W7 Roots and mobile

- Depends on: W6 (the toolchain parts can start in parallel)
- What: Tree-path resolveId, tsconfig.roots, the vitest include, the mobile resolver, the shared-mirror and deep-imports tree paths, frontend package.json. Rehearse by moving learning.
- Files: about 10
- Gate: After the rehearsal: goldens and sha256 identical, mobile jest green, core tree green.

## Risks

- Without the W0 normaliser, the AST-based goldens change on every conversion. The normaliser itself needs a negative test.
- Re-owning by map changes the golden owner column for re-owned files; that diff must be reviewed once and kept alone.
- A key asked for outside its zone suspends (a visible spinner). The zone test only knows the static graph.
- Area chunks per (module, zone) can change Rolldown's grouping; measure after W4a.
- Hooks are frozen per page, so an edition change is seen only on reload.
- Absent wraps need context defaults for their core consumers.
- The contract types can drift from module props; only full-mode tsc catches it.
- The 'last' divider in IntegrationsSection.tsx:569-574 can be wrong in the mixed case of a core web build against a full server.
- The project container is a product decision: the plan keeps it core, while today's map gives the web client and server/routes/projects.js to projects.
- With cms absent, '/' needs a designed answer: RootPathGate falls back to PricingPage, which is cms-owned.
- Unverified toolchain behaviour across roots: typescript-7 rootDirs combined with paths, knip, vitest.
- An unknown number of core tests vi.mock module paths.

## Verify first

- Prototype the normaliser on AuthedApp.tsx:50-51 and studioRegistry.tsx:29, and confirm the goldens stay byte-identical.
- Hide-mode refusal for learning in vite build and vitest (static imports, import() and glob).
- lazyZone on settings: compare chunk sizes and modulepreload, and check that parts render synchronously under RTL.
- web-tree --mode core once, to get the real error list.
- Context defaults of the four wraps, and module constants read at module scope.
- Owner decisions: the project container, the seams, OutputFieldsCard and DsrRequestPage.
- The server route's shape and open class, and lockReason returning null for the capabilities of absent modules.
- typescript-7 rootDirs plus paths on a fixture, and Tailwind @source output identical while nothing has moved.
