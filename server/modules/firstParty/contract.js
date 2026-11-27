// @typecheck strict
/**
 * The contract between the core and a first-party module's COMPOSITION: the rows of every
 * hand-written list of server composition (route mounts, registrations, startup jobs,
 * shutdown, store schemas, migrations) that belong to that module, as data.
 *
 * A composition is the file at tree path firstParty/<id>.js, owned by module <id>
 * (scripts/module-map.json), with its parts beside it: firstParty/<id>.mounts.js,
 * <id>.register.js, <id>.jobs.js and <id>.stores.js (modules/firstParty/parts.js merges
 * them). The loader (modules/firstParty/loader.js) discovers the compositions, decides each
 * module's state and hands the rows to the core, sorted by the core's order index
 * (modules/firstParty/order.json).
 *
 * Types only: nothing here runs.
 */

'use strict';

/** @typedef {import('express').RequestHandler} RequestHandler */
/** @typedef {import('express').ErrorRequestHandler} ErrorRequestHandler */
/** @typedef {import('./moduleState').Provides} Provides */

/**
 * Where in the main app a mount row goes; the core calls loader.mount(app, gates, slot) at
 * the place that matches today's line of index.js:
 *   static    beside boot/staticAssets.js mountStaticAssets, ahead of every router
 *   early     ahead of the /auth and /ai mounts (well-known documents, health-like paths)
 *   main      the body of the route table
 *   fallback  after every router, ahead of the unmatched-API 404, the marketing renderer and
 *             the SPA fallback
 * @typedef {'static' | 'early' | 'main' | 'fallback'} MountSlot
 */

/**
 * The logger a row gets (telemetry/log.js has this shape).
 * @typedef {{ info: (...args: unknown[]) => void, warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void, debug?: (...args: unknown[]) => void }} Log
 */

/**
 * A gate factory or a ready gate. The members are the ones index.js builds today; a factory
 * takes its arguments (a module id, a capability, a licence feature, ...) and returns the
 * middleware.
 * @typedef {(...args: any[]) => RequestHandler} GateFactory
 */

/**
 * The gates index.js builds once and passes to every mount row. Known members first; the
 * index signature leaves room for more (a later worker adds e.g. a session hydration gate
 * here instead of each module requiring its own copy).
 * @typedef {{
 *   requireModule: GateFactory,
 *   requireCapability: GateFactory,
 *   requireLicenseFeature: GateFactory,
 *   requireTraining: GateFactory,
 *   requireAuthedUser: RequestHandler,
 *   requireAnyPermission: GateFactory,
 *   featureGate: GateFactory,
 *   [name: string]: GateFactory | RequestHandler | undefined,
 * }} Gates
 */

/**
 * One `app.use(...)` line (or `router.use(...)` of routes/ai.js for an aiMounts row).
 *   key       unique over every module: '<id>:<path or purpose>'; the order index names it
 *   slot      mounts only; aiMounts rows have none
 *   path      the mount path, or null for `app.use(...handlers)` without a path
 *   when      optional: mount only when this answers true (an env-gated mount such as /mcp/studio)
 *   handlers  the gate chain followed by the router: exactly what app.use(path, ...) receives
 *             today. Called once, at mount time; requires the router inside, so requiring the
 *             composition loads no router.
 *   onMount   optional: called after the mount, e.g. for the log line an env-gated mount prints
 * @typedef {{
 *   key: string,
 *   slot?: MountSlot,
 *   path: string | null,
 *   when?: () => boolean,
 *   handlers: (gates: Gates) => Array<RequestHandler | ErrorRequestHandler>,
 *   onMount?: (log: Log) => void,
 * }} MountRow
 */

/**
 * The names of the phases of boot/startupTasks.js STARTUP_PHASES, in the order they run
 * (modules/firstParty/loaderRules.js holds them as a list, a test holds that list equal).
 * @typedef {'startConfigInvalidationListener' | 'startBootProbes' | 'startLicenseAndModuleRuntime'
 *   | 'runOneShotTasks' | 'startDunningAndTrialSchedulers' | 'startPlanCapDriftAudit' | 'startSeatSync'
 *   | 'startPaygDrain' | 'startLateWarmups' | 'startRetentionAndComplianceJobs' | 'seedSystemAgentsAtBoot'
 *   | 'startModuleSchedulers' | 'startRunnersAndFeeds' | 'startSupportAndSyncJobs' | 'startPruneSchedulers'} StartupPhase
 */

/**
 * One background start of boot/startup*.js. The loader wraps start() in its own try/catch and
 * logs a throw as boot/startupJobs.js does: log.warn('[Server] <label> <failText>:', err.message).
 * A start() that returns a promise gets the rejection logged as '[Server] <label> start error:'.
 *   key       unique over every module: '<id>:<job>'; the order index names it
 *   phase     the startup phase it belongs to
 *   label     the name in the log line; default the key
 *   failText  default 'load failed' (today's lines also say 'start failed' or 'not enabled')
 * @typedef {{
 *   key: string,
 *   phase: StartupPhase,
 *   start: (ctx: unknown) => unknown,
 *   label?: string,
 *   failText?: string,
 * }} JobRow
 */

/**
 * A store that owns schema: the same shape as an entry of storeModules.js STORE_MODULES
 * (`file` is relative to the tree root, './stores/x').
 * @typedef {{ name: string, file: string }} StoreRow
 */

/**
 * What a composition exports (firstParty/<id>.js, merged with its parts).
 *   id              the module id; equals the file name
 *   requires        hard: loaded first, and this module fails when one is absent or failed
 *   uses            soft: reached only through an optional lookup; informational here
 *   provides        the registry names it registers (moduleState.declareProvides), declared
 *                   before any module code runs, so a failed module never looks absent
 *   mounts          rows for the main app, by slot
 *   aiMounts        rows for the /ai router (routes/ai.js)
 *   register        registrations (boot/featureRegistrations.js, boot/featureModules.js, the
 *                   registries in integrations/); runs once, in requires order
 *   jobs            startup jobs, by phase
 *   afterListen     wiring that needs the listening http.Server (the webpage full-tier proxy);
 *                   ctx carries what that wiring needs from index.js
 *   drain           shutdown, first half: finish or hand back in-flight work within timeoutMs
 *   close           shutdown, second half: stop timers, flush and close handles
 *   stores          store schemas, by name
 *   migrations      loose data migrations, by name (boot/bootMigrations.js LOOSE_MIGRATIONS)
 *   nlTranslations  Dutch seed migrations, by name (boot/bootMigrations.js NL_TRANSLATIONS)
 * @typedef {{
 *   id: string,
 *   requires?: string[],
 *   uses?: string[],
 *   provides?: Provides,
 *   mounts?: MountRow[],
 *   aiMounts?: MountRow[],
 *   register?: () => void,
 *   jobs?: JobRow[],
 *   afterListen?: (app: import('express').Express, server: import('node:http').Server, ctx: AfterListenContext) => void,
 *   drain?: (opts: { timeoutMs: number }) => Promise<void>,
 *   close?: (opts: { timeoutMs: number }) => Promise<void>,
 *   stores?: StoreRow[],
 *   migrations?: string[],
 *   nlTranslations?: string[],
 * }} ModuleComposition
 */

/**
 * What afterListen gets besides the app and the server.
 *   terminalErrorHandler  a mount added after listen sits BEHIND the terminal error handler,
 *                         so it registers the handler again (boot/lifecycle.js does that today)
 * @typedef {{ terminalErrorHandler?: ErrorRequestHandler, log?: Log }} AfterListenContext
 */

/**
 * The part files of a composition and the keys each one may contribute.
 * @typedef {'mounts' | 'register' | 'jobs' | 'stores'} PartName
 */

module.exports = {};
