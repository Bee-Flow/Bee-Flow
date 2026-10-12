/**
 * The six sources behind Studio Home's "Needs attention", as a register.
 *
 * ── The shape this file exists to protect ──────────────────────────────────
 *
 * An attention list is a REASSURANCE the moment it is empty: "nothing is wrong
 * here". That sentence may only be said when all six sources actually answered.
 * A source that fell over therefore produces neither rows nor silence — it
 * produces "this one was not checked", and the screen must then refuse to say
 * everything is fine. O2 phase 1 shipped the opposite ("Everything in this
 * project is connected and owned consistently", over a graph half of which had
 * never loaded), and this register is built so that failure cannot recur:
 *
 *   found      → findings, and the source is `checked`
 *   nothing    → no findings, and the source is `checked`   ← the good news
 *   could not look → no findings, and the source is `unavailable`
 *   not yours  → no findings, and the source is `gated`
 *
 * The middle two are the pair everything hangs on, and they are DIFFERENT
 * VALUES here rather than the same empty array. routes/studio/search.js keeps
 * the same distinction with `errors[]`, projects/completeness.js with
 * `unavailable[]` + `complete`; routes/studio/counts.js is the counter-example
 * that drops a failed kind and strips the `partial` flag before answering.
 *
 * ── Structure: agent-hub/src/components/onboarding/actionChecks.js ─────────
 *
 * That register is the model, and it is followed on purpose rather than
 * re-invented: one object per check, `load` (the ONLY thing that touches a
 * store) and `evaluate` (PURE — plain data in, findings out, exported so every
 * rule is testable as an object literal). Three deliberate differences:
 *
 *   1. `evaluate` returns THREE things, not a boolean per criterion:
 *      findings, plus the gaps the source hit. actionChecks flattens every
 *      failure into one `error` string; that is exactly what must not happen
 *      here.
 *   2. A gate that CANNOT ANSWER closes its source and says so. actionChecks'
 *      `applicableCriteria` lets a missing `hasFeature` pass the gate
 *      (fail-open); on this screen unknown NARROWS.
 *   3. Concurrency is `Promise.allSettled` in the runner (attention.js), not
 *      `Promise.all` over a `settle()` helper, so a source that throws in a way
 *      nobody predicted still lands as `unavailable` rather than taking the
 *      response with it.
 *
 * ── Every row comes from the producer that already owns the rule ───────────
 *
 * This is an AGGREGATE, not a second opinion:
 *   apps        → projects/completeness.js buildCompleteness({ apps }) — the
 *                 same canonicalize + validate + Finding conversion a Solution
 *                 runs, called with only the apps half.
 *   empty KBs   → projects/completeness.js emptyKnowledgeBaseFinding, the rule
 *                 itself, exported for this caller.
 *   solutions   → the collectCompleteness verdict, COPIED (`blocked`,
 *                 `complete`), never recomputed.
 *   kb sources  → the `status` column kb_sources already maintains.
 *   runs        → automationStore.getRecentRunStatusesForUser.
 * Only two rules are genuinely new, because nothing anywhere produced them: a
 * published agent with no knowledge base, and an automation's failure streak. Both
 * are written once, here, and go through core/findings/finding.js like the
 * rest.
 */

'use strict';

const { makeFinding } = require('../../core/findings/finding');
const {
    buildCompleteness, emptyKnowledgeBaseFinding,
} = require('../../projects/completeness');
// Het criterium van bron 2, en de ENIGE plek waar het staat. De kaartvoet van
// het agentoverzicht (A5) leest hetzelfde antwoord via het veld `grounding`
// op GET /agents/all; zie de kop van dat bestand voor waarom het geen tweede
// implementatie mag worden.
const { groundedOn, groundingVerdict } = require('../../core/agentRuntime/agentGrounding');
const {
    moduleActive, licenceAllows, capability, permission, userIdOf,
    solutionsGate, visibleKnowledgeBasesFor, visibleSolutionsFor,
} = require('./shared');
const log = require('../../telemetry/log');

// ── Budgets ───────────────────────────────────────────────────────────────
//
// Every one of these is a REPORTED gap when it bites, never a quiet truncation
// of the question: projects/summary.js's completeness budget is the precedent
// ("Not computing it is a REPORTED gap, never a clean bill of health").

/** App definitions read per request. The heaviest of the six by far. */
const MAX_APPS_VALIDATED = 25;
/** Published agents scanned for a missing knowledge base. */
const MAX_AGENTS_SCANNED = 200;
/** Empty knowledge bases whose usage is probed (8 queries each). */
const MAX_KBS_PROBED = 20;
/** Solutions whose completeness is aggregated (a graph build each). */
const MAX_SOLUTIONS_CHECKED = 12;
/** How many of those run at once. */
const SOLUTION_CONCURRENCY = 4;
/** How many app definitions are read at once. */
const APP_READ_CONCURRENCY = 4;
/** Rows one source may contribute before the rest are folded into a count. */
const MAX_ROWS_PER_SOURCE = 20;

/** Runs looked at per automation when counting a failure streak. */
const RUN_WINDOW = 10;
/** Failures in a row before an automation is "failing" rather than "flaky". */
const MIN_FAILURE_STREAK = 3;
/** How far back the streak may reach. An automation nobody has run in a month is
 *  not a thing that needs attention today. */
const RUN_LOOKBACK_MS = 30 * 24 * 3600 * 1000;

/**
 * kbUsage roles that mean something ANSWERS FROM this base.
 *
 * The same cut projects/completeness.js makes with KB_WRITE_EDGES, expressed in
 * core/kb/kbUsage.js's own vocabulary: a base that is only WRITTEN into
 * ('ingest_target' — a support inbox distilling resolved tickets) or merely
 * FILED somewhere ('contains' — a project, a notebook, a template) and holds
 * nothing is a base waiting for its first document, not a broken one. A base
 * something reads is a different story: whatever is grounded on it answers from
 * nothing and says so to nobody.
 */
const KB_READ_ROLES = Object.freeze(['chat', 'ai_step', 'answer_block']);

// ── Pure helpers ──────────────────────────────────────────────────────────

const asArray = (v) => (Array.isArray(v) ? v : []);

/** A gap list that never repeats itself, in the order the gaps were hit. */
function gapCollector() {
    const gaps = [];
    return { gaps, miss: (label) => { if (label && !gaps.includes(label)) gaps.push(label); } };
}

/**
 * The document count of a knowledge base row, or `null` when it is unknown.
 *
 * `null` is NOT 0, and on this screen that is the whole difference between "add
 * a document to this base" and an accusation about a base nobody counted. The
 * same rule projects/completeness.js applies to kbDocumentCounts.
 */
function documentCountOf(kb) {
    if (!kb || typeof kb !== 'object') return null;
    const raw = kb.document_count ?? kb.documentCount;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

/**
 * An agent's config as an object, or `null` when it cannot be read.
 *
 * The column is TEXT (stores/agent/initSchema.js), so a row can hold something
 * that is not JSON. `null` travels as a named gap: an agent whose wiring could
 * not be parsed is not an agent without a knowledge base.
 */
function agentConfigOf(row) {
    const raw = row?.config;
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return raw === null || raw === undefined ? {} : null;
    if (raw.trim() === '') return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * How many of the newest runs failed WITHOUT a success in between.
 *
 * The rows arrive newest-first per automation, so this is a leading count and it
 * stops at the first run that is not an error. A run that is still 'running' or
 * 'queued' stops it too: an unfinished run has not failed, and treating it as a
 * failure would report an automation that is at this moment working.
 */
function leadingErrorStreak(statuses) {
    let n = 0;
    for (const s of asArray(statuses)) {
        if (s !== 'error') break;
        n += 1;
    }
    return n;
}

/** Group `{ automationId, title, status }` rows, preserving arrival order. */
function groupRunsByAutomation(rows) {
    const byId = new Map();
    for (const row of asArray(rows)) {
        const id = row?.automationId ?? row?.automation_id;
        if (!id) continue;
        const held = byId.get(String(id)) || { id: String(id), title: row?.title || null, statuses: [] };
        if (!held.title && row?.title) held.title = row.title;
        held.statuses.push(row?.status ?? null);
        byId.set(String(id), held);
    }
    return [...byId.values()];
}

/**
 * Build one row, or NAME the one that could not be built.
 *
 * `makeFinding` throws on a kind the palette does not know or a message that
 * came out empty, and a rule that let that escape would lose EVERY row of its
 * source over one bad input — a store row with a surprising id type takes the
 * other nineteen findings down with it. projects/completeness.js's `convert`
 * already settled this: the record is counted as a gap, because a problem that
 * never reaches the screen is exactly the silence this list exists to remove.
 */
function pushFinding(out, build, miss, gapLabel) {
    try {
        out.push(typeof build === 'function' ? build() : makeFinding(build));
    } catch (err) {
        miss(gapLabel);
        log.warn('[StudioAttention] could not build a row:', err?.message || err);
    }
}

/**
 * Where a blocked Solution's row goes.
 *
 * projects/completeness.js's DEEP_LINK map deliberately has NO 'solution'
 * entry, and that is right where it lives: `toFindingKind` folds the graph's
 * synthetic nodes — an approval, a notebook — onto the kind 'solution', so a
 * link built from that kind alone would sometimes point at
 * /app/studio/solutions/approval:xyz, which is not a page.
 *
 * This source can link anyway, because its ids do not come from a graph: every
 * one of them is a project id read straight out of listUserProjects, on a
 * project this caller already holds a role on. The guarantee the general map
 * cannot make, this source makes by construction — so the link is built here
 * rather than by widening a map that would then be wrong for four other
 * producers. The segment is studioApps.jsx's own ('solutions'), and the id is
 * encoded for the same reason completeness.js encodes its own.
 */
function solutionDeepLink(finding) {
    const id = finding?.targetRef?.id;
    return id ? `/app/studio/solutions/${encodeURIComponent(String(id))}` : null;
}

/** A quoted display name, or a neutral stand-in — never `"undefined"`. */
function nameOrDefault(name, fallback) {
    const n = typeof name === 'string' ? name.trim() : '';
    return n ? `"${n}"` : fallback;
}

// ── The six rules. Each is PURE and separately exported ────────────────────

/**
 * 1. Apps with validation problems.
 *
 * The rule is not here: `buildCompleteness` runs the App Studio validator over
 * the canonical definition, converts each record through core/findings, and
 * attaches the deep link — the identical path a Solution's "Te controleren"
 * takes. Only the apps half is handed over, so the other three producers idle.
 *
 * `unavailable` comes back from it too, and it is the reason an app that could
 * not be validated is a GAP rather than an app with a clean bill.
 */
function evaluateAppValidation(data = {}) {
    const { gaps, miss } = gapCollector();
    for (const g of asArray(data.gaps)) miss(g);
    let result;
    try {
        result = buildCompleteness({ apps: asArray(data.apps) });
    } catch (err) {
        // buildCompleteness catches per app; this is the "could not even start"
        // case, and it means NOTHING was validated.
        miss('appValidation');
        log.warn('[StudioAttention] app validation failed:', err?.message || err);
        return { findings: [], gaps };
    }
    for (const label of asArray(result.unavailable)) miss(label === 'apps' ? 'apps:validator' : `apps:${label}`);
    return { findings: asArray(result.findings), gaps };
}

/**
 * 2. A published agent that is grounded on nothing.
 *
 * PUBLISHED only, and that narrowing is the rule rather than an optimisation.
 * A draft agent without a knowledge base is an agent being built, which is the
 * normal state of a thing being built; an agent OFFERED TO THE ORGANISATION
 * that can look nothing up answers from the model alone to people who assume it
 * knows their documents. Only the second one is something a person has to look
 * at, and a list that reported the first would be mostly noise — which is how
 * an attention list stops being read.
 *
 * A warning, not an error: plenty of good agents need no knowledge base, so the
 * row says what to do and stays out of the way.
 *
 * ── HET CRITERIUM STAAT NIET HIER ──────────────────────────────────────────
 * `groundedOn` (core/agentRuntime/agentGrounding.js) beantwoordt de vraag, en
 * de kaartvoet van het agentoverzicht (A5) stelt hem aan diezelfde functie.
 * Twee kopieën van deze regel zouden betekenen dat het overzicht iets anders
 * zegt dan dit scherm over dezelfde agent.
 *
 * Sinds die verhuizing telt de regel ook TABELGRANTS mee: een agent met alleen
 * `config.tools.datatables` werd hier gemeld als "antwoordt uit het model
 * alleen", en dat was onwaar — datatableTools.js geeft hem echt iets om in te
 * kijken. Dat is een VERKLEINING van deze lijst, geen verbreding.
 *
 * WEBSEARCH is met opzet GEEN as. `config.enabledIntegrations` wordt door niets
 * in het chatpad gelezen (toolStackAssembly geeft de config door, maar
 * getIntegrationTools kijkt alleen naar `config.tools`; welke apps een agent
 * krijgt hangt aan de GEBRUIKER plus AUTO_ENABLED_APPS plus een geconfigureerde
 * zoekprovider), en de R4-backfill heeft `agent-search` in élke oudere rij
 * gezet. Een as daarop had deze lijst leeggemaakt zonder dat er één agent
 * gegronder was geworden. Zie de kop van agentGrounding.js.
 *
 * En een as die niet te lezen was is een GAT, geen lege bron: `asArray` maakte
 * van een `knowledge_base_ids` die geen lijst is stilletjes `[]` en dus een
 * beschuldiging. `groundedOn` geeft daar `null`, en die belandt hieronder in
 * `agents:config` — dezelfde uitkomst als een config die niet parseerde.
 */
function evaluateAgentNoKb(data = {}) {
    const { gaps, miss } = gapCollector();
    for (const g of asArray(data.gaps)) miss(g);
    const findings = [];
    for (const row of asArray(data.agents)) {
        const config = agentConfigOf(row);
        if (config === null) {
            // Unreadable wiring is not absent wiring.
            miss('agents:config');
            continue;
        }
        const verdict = groundingVerdict(groundedOn(config));
        if (verdict === 'grounded') continue;
        if (verdict === null) {
            // Een as die niet te lezen was — zie de docblock hierboven.
            miss('agents:config');
            continue;
        }
        pushFinding(findings, {
            code: 'agent.no_knowledge_base',
            severity: 'warning',
            kind: 'agent',
            targetRef: { kind: 'agent', id: row?.id ?? null, title: row?.name || null },
            message: `${nameOrDefault(row?.name, 'A published agent')} is published to your organisation but is not grounded on a knowledge base, so it answers from the model alone.`,
            remediation: 'Attach a knowledge base to the agent, or leave it as it is if it is meant to answer without one.',
        }, miss, 'agents:row');
    }
    return { findings, gaps };
}

/**
 * 3. A knowledge base something reads that holds no documents.
 *
 * The finding is projects/completeness.js's own, imported rather than copied.
 * What differs is the "is it read" half: a Solution reads it off a graph edge,
 * an organisation off core/kb/kbUsage.js's scan, and the role filter above is
 * the same cut that module's KB_WRITE_EDGES makes.
 *
 * TWO KINDS OF UNKNOWN, and they are not the same:
 *   - the document count could not be read → gap. Never accuse a base of being
 *     empty because nobody counted it.
 *   - the usage scan was PARTIAL and found no reader → gap. "No table for apps
 *     on this install" is not "no app uses this".
 * A partial scan that DID find a reader needs no gap: the only thing the missing
 * kinds could add is more usage, and more usage does not change the verdict.
 */
function evaluateKbEmptyInUse(data = {}) {
    const { gaps, miss } = gapCollector();
    for (const g of asArray(data.gaps)) miss(g);
    const findings = [];
    for (const entry of asArray(data.candidates)) {
        const kb = entry?.kb || {};
        const count = documentCountOf(kb);
        if (count === null) { miss('knowledge:documentCount'); continue; }
        if (count !== 0) continue;
        const readers = asArray(entry?.usageRows).filter(r => KB_READ_ROLES.includes(r?.role));
        if (readers.length === 0) {
            // Nothing reads it — unless the scan could not answer for every
            // kind, in which case nothing is known and nothing is said.
            if (asArray(entry?.usagePartial).length > 0) miss('knowledge:usage');
            continue;
        }
        pushFinding(findings, () => emptyKnowledgeBaseFinding({ id: kb.id, name: kb.name }), miss, 'knowledge:row');
    }
    return { findings, gaps };
}

/**
 * 4. An automation that failed its last few runs in a row.
 *
 * The streak is counted here rather than in SQL so it is a rule anyone can
 * read and a test can drive with plain objects — see the store function's
 * header for why the query returns a window instead of a verdict.
 *
 * An error, unlike the other five: an automation that has failed three times
 * running is not doing its job, and it will not start again on its own.
 */
function evaluateAutomationFailing(data = {}) {
    const { gaps, miss } = gapCollector();
    for (const g of asArray(data.gaps)) miss(g);
    const findings = [];
    for (const group of groupRunsByAutomation(data.runs)) {
        const streak = leadingErrorStreak(group.statuses);
        if (streak < MIN_FAILURE_STREAK) continue;
        pushFinding(findings, {
            code: 'automation.consecutive_failures',
            severity: 'error',
            kind: 'automation',
            targetRef: { kind: 'automation', id: group.id, title: group.title },
            message: `${nameOrDefault(group.title, 'An automation')} failed its last ${streak} runs in a row.`,
            remediation: 'Open the automation and check the run log for the step that keeps failing.',
        }, miss, 'automations:row');
    }
    return { findings, gaps };
}

/**
 * 5. A Solution that cannot be published.
 *
 * The verdict is COPIED, exactly as projects/summary.js copies it: `blocked` and
 * `complete` are collectCompleteness's own answers and a second opinion here
 * could differ from the one the Solution's own screen shows.
 *
 * ONE row per Solution, not one per finding: the Solution has a screen that
 * lists its findings, and folding a dozen of them onto Studio Home would bury
 * the other five sources.
 *
 * The two verdicts produce DIFFERENT SENTENCES, because `blocked` is true both
 * for a Solution with real problems and for one that could not be fully read
 * (completeness.js: UNKNOWN BLOCKS). Saying "this has blocking findings" about
 * the second would be an accusation nobody checked, so it gets its own code, a
 * warning, and a named gap.
 */
function evaluateSolutionBlocked(data = {}) {
    const { gaps, miss } = gapCollector();
    for (const g of asArray(data.gaps)) miss(g);
    const findings = [];
    for (const entry of asArray(data.checked)) {
        const project = entry?.project || {};
        const result = entry?.result;
        if (!result || typeof result !== 'object') {
            miss(`solutions:${project.id || 'unknown'}`);
            continue;
        }
        const target = { kind: 'solution', id: project.id ?? null, title: project.name || null };
        if (result.complete !== true) {
            miss(`solutions:${project.id || 'unknown'}`);
            pushFinding(findings, {
                code: 'solution.check_incomplete',
                severity: 'warning',
                kind: 'solution',
                targetRef: target,
                message: `${nameOrDefault(project.name, 'A solution')} could not be checked completely, so it counts as blocked until it can be.`,
                remediation: 'Open the solution and reload its checks.',
            }, miss, `solutions:${project.id || 'unknown'}`);
            continue;
        }
        if (result.blocked !== true) continue;
        const n = asArray(result.findings).length;
        pushFinding(findings, {
            code: 'solution.blocked',
            severity: 'error',
            kind: 'solution',
            targetRef: target,
            message: `${nameOrDefault(project.name, 'A solution')} cannot be published yet: ${n === 1 ? '1 finding needs' : `${n} findings need`} a person.`,
            remediation: 'Open the solution and work through its findings.',
        }, miss, `solutions:${project.id || 'unknown'}`);
    }
    return { findings, gaps };
}

/**
 * 6. A knowledge base whose sources stopped refreshing.
 *
 * One row per BASE rather than per source: a source has no screen of its own,
 * so every link would land on the same knowledge base anyway.
 *
 * A warning. The base still answers — with what it had when the refresh last
 * worked — so this is "quietly going stale", not "broken".
 */
function evaluateKbSourceError(data = {}) {
    const { gaps, miss } = gapCollector();
    for (const g of asArray(data.gaps)) miss(g);
    const findings = [];
    // GEEN telling is geen NUL. De store levert bewust alleen de bases MÉT
    // fouten, dus een ontbrekende sleutel in een bestaande Map is een echte
    // nul; een ontbrekende MAP is een antwoord dat er nooit was, en daar een
    // schone verklaring over kennisbronnen op bouwen is precies de fout die
    // deze bestanden moeten uitsluiten. De loader gooit vandaag netjes — deze
    // regel staat er zodat de PURE functie op zichzelf ook klopt.
    const isCountMap = data.errorCounts instanceof Map
        || (data.errorCounts && typeof data.errorCounts === 'object');
    if (!isCountMap) {
        miss('kbSources:counts');
        return { findings, gaps };
    }
    const counts = data.errorCounts instanceof Map
        ? data.errorCounts
        : new Map(Object.entries(data.errorCounts));
    for (const kb of asArray(data.knowledgeBases)) {
        const n = Number(counts.get(String(kb?.id))) || 0;
        if (n <= 0) continue;
        pushFinding(findings, {
            code: 'kb_source.refresh_failed',
            severity: 'warning',
            kind: 'kb',
            targetRef: { kind: 'kb', id: kb?.id ?? null, title: kb?.name || null },
            message: `${nameOrDefault(kb?.name, 'A knowledge base')} has ${n === 1 ? '1 source that could' : `${n} sources that could`} not refresh, so what it answers from may be out of date.`,
            remediation: 'Open the knowledge base and check its sources.',
        }, miss, 'kbSources:row');
    }
    return { findings, gaps };
}

// ── Loaders — the ONLY place a store is touched ────────────────────────────

/**
 * De kennisbanken waar deze beller IETS AAN KAN DOEN, één keer per verzoek.
 *
 * Twee bronnen vragen erom (lege-in-gebruik en mislukte bronnen) en de
 * zichtbaarheidsketen zelf staat in ./shared.js, waar counts.js en search.js
 * hem ook uit lezen — één antwoord op "welke kennisbanken ziet deze persoon",
 * niet drie kopieën die uit elkaar groeien.
 *
 * Daarbovenop staat een tweede zeef, en die is de reden dat deze functie niet
 * gewoon `visibleKnowledgeBasesFor` heet. Beide rijen dragen een opdracht die
 * BEHEERrechten vereist ("Add a document…", "Open the knowledge base and check
 * its sources"): routes/knowledgeBases/detail.js laat GET door op canAccessKB,
 * maar zet PATCH/DELETE en de bronnen achter manage_knowledge + canManageKB.
 * Een gewoon lid met leestoegang tot een gedeelde lege basis kreeg zo een rij
 * met een knop die er voor hem niet is — hij kan hem niet oplossen en de rij
 * blijft staan tot iemand anders het doet. Dat is precies de ruis waar de
 * apps-bron hieronder al tegen zeeft (canWriteStudioApp), met dezelfde reden.
 *
 * Gedeeld via de `once`-memo van het verzoek, en dat koppelt de twee OORDELEN
 * niet: elke bron draait in zijn eigen try/catch, dus een storing hier maakt
 * ze allebei unavailable — wat exact waar is.
 */
function knowledgeBasesToActOn(req, d, ctx) {
    return ctx.once('knowledgeBases', async () => {
        const userId = userIdOf(req);
        const visible = asArray(await visibleKnowledgeBasesFor(req, d));
        // Strikt: een onleesbare org-lezing is geen "lid van niets".
        const orgIds = await d.auth.resolveUserOrgIds(req, { strict: true });
        // `permission` gooit als de rechtenlezing degraded is — dan weten we
        // niet wie dit mag beheren, en dat is een gat, geen lege lijst.
        const hasManage = await permission(d, req, 'manage_knowledge');
        return visible.filter(kb => d.kbStore.canUserManageKB(kb, userId, orgIds, hasManage));
    });
}

const orgIdArray = (orgIds) => (orgIds instanceof Set ? [...orgIds] : asArray(orgIds));

/**
 * The register. `key` is the vocabulary the response and the client share.
 *
 * gate(req, d)        → boolean; false means "not yours", a THROW means "we
 *                       could not tell", and those are different answers.
 * load(req, d, ctx)   → plain data for `evaluate`. The only I/O.
 * evaluate(data)      → { findings, gaps }. Pure.
 */
const SOURCES = [
    {
        key: 'appValidation',
        kind: 'app',
        // routes/studioApps.js's mount gate, as counts.js and search.js read it.
        gate: async (req, d) => (await moduleActive(d, 'apps')) && (await capability(d, req, 'app_studio')),
        load: async (req, d) => {
            const { gaps, miss } = gapCollector();
            const { userId, orgIds, userGroups } = await d.audience.resolveAudienceContext(req);
            const all = await d.studioAppStore.getAccessibleStudioApps(userId, userGroups, orgIdArray(orgIds));
            // ONLY APPS THIS PERSON CAN OPEN IN THE EDITOR. "Show me" goes to
            // /app/studio/apps/:id, and canWriteStudioApp is owner-only — a row
            // about a colleague's published app would hand out a button that
            // 403s, and a deep link that 403s is not a deep link. It is also
            // not something this reader could fix.
            const mine = asArray(all).filter(a => d.studioAppStore.canWriteStudioApp(a, userId));
            const budget = mine.slice(0, MAX_APPS_VALIDATED);
            if (mine.length > budget.length) miss('apps:budget');
            // The definitions are the expensive half (the list carries META
            // only), so they are read a few at a time rather than one after
            // the other — the same bound the Solutions source uses.
            const reads = await d.mapLimited(budget, APP_READ_CONCURRENCY, async (meta) => {
                try {
                    return await d.studioAppStore.getStudioApp(meta.id);
                } catch (err) {
                    log.warn(`[StudioAttention] app ${meta.id} definition failed:`, err?.message || err);
                    return null;
                }
            });
            const apps = [];
            for (const full of reads) {
                // An app whose definition would not load is not an app without
                // problems — the same rule buildGraphForProject applies.
                if (!full) { miss('apps:definition'); continue; }
                apps.push({ id: full.id, name: full.name, definition: full.definition });
            }
            return { apps, gaps };
        },
        evaluate: evaluateAppValidation,
    },
    {
        key: 'agentNoKb',
        kind: 'agent',
        // routes/agents/published.js GET /all — requirePermission('manage_agents').
        gate: (req, d) => permission(d, req, 'manage_agents'),
        load: async (req, d) => {
            const { gaps, miss } = gapCollector();
            // STRIKT. `resolveUserOrgIds` slikt een storing in de userStore en
            // geeft dan een LEGE Set — niet te onderscheiden van "lid van geen
            // enkele organisatie", waar de tak hieronder een hard "gekeken, en
            // er is er geen" van zou maken. permissions.js:832-866 zegt dat in
            // zijn eigen kop: onleesbaar is geen lege lijst, en alleen wie erom
            // vraagt merkt het.
            let orgIds;
            try {
                orgIds = await d.auth.resolveUserOrgIds(req, { strict: true });
            } catch (err) {
                log.warn('[StudioAttention] agent org resolution failed:', err?.message || err);
                miss('agents:orgs');
                return { agents: [], gaps };
            }
            // Three columns, and the org narrowing in the WHERE. getAllAgents()
            // would read every agent row in the database with its tools joined,
            // which counts.js already refuses to do for the same reason.
            const base = `SELECT id, name, config FROM agents
                           WHERE owner_id NOT IN ('system', 'swarm') AND is_published = TRUE`;
            const tail = ' ORDER BY updated_at DESC LIMIT $';
            let rows;
            if (orgIds === null) {
                // Super admin: no narrowing, exactly as the list route has none.
                rows = await d.db.getAll(`${base}${tail}1`, [MAX_AGENTS_SCANNED + 1]);
            } else {
                const ids = [...orgIds].filter(Boolean).map(String);
                // A member of no organisation sees no agent on /all either.
                if (ids.length === 0) return { agents: [], gaps };
                rows = await d.db.getAll(
                    `${base} AND organization_id = ANY($1::text[])${tail}2`,
                    [ids, MAX_AGENTS_SCANNED + 1],
                );
            }
            const agents = asArray(rows);
            if (agents.length > MAX_AGENTS_SCANNED) miss('agents:budget');
            return { agents: agents.slice(0, MAX_AGENTS_SCANNED), gaps };
        },
        evaluate: evaluateAgentNoKb,
    },
    {
        key: 'kbEmptyInUse',
        kind: 'kb',
        // routes/knowledgeBases/list.js is ungated at the mount — Knowledge base
        // is a Community feature, so this source exists for everyone.
        gate: async () => true,
        load: async (req, d, ctx) => {
            const { gaps, miss } = gapCollector();
            const visible = asArray(await knowledgeBasesToActOn(req, d, ctx));
            // EMPTY FIRST, THEN USAGE. Emptiness is already on the row
            // (KB_COUNTS_SELECT); usage is eight queries per base. Asking the
            // cheap question first means the expensive one is only ever asked
            // about the handful of bases that could possibly produce a row.
            const empties = visible.filter(kb => documentCountOf(kb) === 0);
            const unknown = visible.filter(kb => documentCountOf(kb) === null);
            if (unknown.length > 0) miss('knowledge:documentCount');
            const probed = empties.slice(0, MAX_KBS_PROBED);
            if (empties.length > probed.length) miss('knowledge:budget');
            const candidates = [];
            for (const kb of probed) {
                let usage = null;
                try {
                    usage = await d.kbUsage.usageForKb(kb.id);
                } catch (err) {
                    log.warn(`[StudioAttention] kb usage ${kb.id} failed:`, err?.message || err);
                }
                if (!usage) { miss('knowledge:usage'); continue; }
                candidates.push({
                    // The count travels EXPLICITLY. `evaluate` re-derives the
                    // verdict from the candidate alone, so a candidate that
                    // arrived without its count is — correctly — an unknown,
                    // and narrowing the row here without it would report every
                    // base as unchecked.
                    kb: { id: kb.id, name: kb.name, documentCount: documentCountOf(kb) },
                    usageRows: asArray(usage.rows),
                    usagePartial: asArray(usage.partial),
                });
            }
            return { candidates, gaps };
        },
        evaluate: evaluateKbEmptyInUse,
    },
    {
        key: 'automationFailing',
        kind: 'automation',
        // routes/automation/crud.js's mount gate, as counts.js reads it.
        gate: async (req, d) => (await moduleActive(d, 'automation')) && (await licenceAllows(d, req, 'automations')),
        load: async (req, d) => {
            const now = typeof d.now === 'function' ? d.now() : Date.now();
            const sinceTs = new Date(now - RUN_LOOKBACK_MS).toISOString();
            // The caller's OWN automations. `automations` are user-scoped and the
            // organisation-wide run list sits behind manage_automations, so this
            // is both the narrowest correct scope and the only one whose deep
            // link (/app/studio/automations/:id) opens for this reader.
            const runs = await d.automationStore.getRecentRunStatusesForUser(userIdOf(req), {
                perAutomation: RUN_WINDOW,
                sinceTs,
            });
            return { runs: asArray(runs), gaps: [] };
        },
        evaluate: evaluateAutomationFailing,
    },
    {
        key: 'solutionBlocked',
        kind: 'solution',
        linkFor: solutionDeepLink,
        // routes/projects.js's mount gate plus the operator kill switch, as
        // counts.js and search.js read it (./shared.js).
        gate: solutionsGate,
        load: async (req, d) => {
            const { gaps, miss } = gapCollector();
            // listUserProjects (owner + shares) IS the authorisation; nothing
            // below widens it and no id comes out of the request. Solutions
            // (and unclassified legacy projects) only: a collaborative project
            // is never published, so it has no "cannot be published yet" row
            // and must not spend the budget of MAX_SOLUTIONS_CHECKED.
            const projects = asArray(await visibleSolutionsFor(req, d));
            const budget = projects.slice(0, MAX_SOLUTIONS_CHECKED);
            if (projects.length > budget.length) miss('solutions:budget');
            const results = await d.mapLimited(budget, SOLUTION_CONCURRENCY, async (project) => {
                try {
                    return await d.solutionCompleteness(project.id);
                } catch (err) {
                    log.warn(`[StudioAttention] solution ${project.id} check failed:`, err?.message || err);
                    return null;
                }
            });
            return {
                checked: budget.map((project, i) => ({
                    project: { id: project.id, name: project.name },
                    result: results[i] || null,
                })),
                gaps,
            };
        },
        evaluate: evaluateSolutionBlocked,
    },
    {
        key: 'kbSourceError',
        kind: 'kb',
        gate: async () => true,
        load: async (req, d, ctx) => {
            const visible = asArray(await knowledgeBasesToActOn(req, d, ctx));
            const knowledgeBases = visible.map(kb => ({ id: kb.id, name: kb.name }));
            // The ids ARE the authorisation — resolved above, never taken from
            // the request. A rejection here is not an empty map: it makes this
            // source unavailable, one level up.
            const errorCounts = await d.kbSourcesStore.countErrorSourcesByKb(knowledgeBases.map(kb => kb.id));
            return { knowledgeBases, errorCounts, gaps: [] };
        },
        evaluate: evaluateKbSourceError,
    },
];

const SOURCE_KEYS = Object.freeze(SOURCES.map(s => s.key));

module.exports = {
    SOURCES,
    SOURCE_KEYS,
    // The rules, pure and separately testable.
    evaluateAppValidation,
    evaluateAgentNoKb,
    evaluateKbEmptyInUse,
    evaluateAutomationFailing,
    evaluateSolutionBlocked,
    evaluateKbSourceError,
    // The helpers those rules are built from.
    documentCountOf,
    agentConfigOf,
    leadingErrorStreak,
    groupRunsByAutomation,
    KB_READ_ROLES,
    pushFinding,
    solutionDeepLink,
    MIN_FAILURE_STREAK,
    RUN_WINDOW,
    MAX_APPS_VALIDATED,
    MAX_AGENTS_SCANNED,
    MAX_KBS_PROBED,
    MAX_SOLUTIONS_CHECKED,
    MAX_ROWS_PER_SOURCE,
};
