// @typecheck
/**
 * GET /agents/tool-catalog — which apps, and which of their actions, an agent
 * may be granted.
 *
 * ── WHY THIS EXISTS NEXT TO /api/automation/catalog ─────────────────
 * The automations builder already has a catalog endpoint, and the agent editor
 * cannot use it: `/api/automation` is mounted behind `requireModule('automation')`
 * + `requireLicenseFeature('automations')` and the router adds
 * `requireBetaFeature('automations')` on top (server/index.js). An organisation
 * that never bought automations gets a 403 there — while agent TOOL GRANTS have
 * nothing to do with automations. Reading the app list through that door would
 * leave the "Can use" tab showing an empty Tools card to exactly the customers
 * whose agents do have tools, which is the worst of the three possible answers:
 * it is not "loading", it is not "could not read", it is a false statement about
 * the agent.
 *
 * So this is a SECOND, UNGATED source for the same facts — not a copy of that
 * endpoint. It answers the four questions the agent tool picker asks and
 * nothing else (no automation steps, no output schemas, no dry-run samples), and
 * it answers them from the same primitives the runtime uses, so the picker and
 * the runtime cannot disagree:
 *
 *   which actions does this app own   automation/toolRegistry.js `ALL_TOOL_APPS`
 *                                     — the same list core/agentRuntime/
 *                                     toolPolicy.js builds its appId↔tool
 *                                     index from;
 *   what does an action DO            automation/sideEffectMap.effectOf →
 *                                     'reads' | 'writes' | 'sends', the field
 *                                     the confirmation rule is decided on;
 *   may THIS user use the app         core/integrations/getIntegrationTools —
 *                                     the authoritative gate (org grant ∩ group
 *                                     grant ∩ personal toggle ∩ credentials);
 *   whose connection does it use      core/integrations/connectionResolution.
 *                                     `null` means the tool draws on no user
 *                                     connection at all (web search, built-ins,
 *                                     platform services) — the editor shows a
 *                                     static "as Bee Flow" there and stores no
 *                                     `actAs`.
 *
 * ── `available` IS STRICT, AND "COULD NOT TELL" IS NOT `false` ──────
 * Availability comes ONLY from `getIntegrationTools`, exactly as
 * routes/automation/catalog.js does, and for the same reason: do NOT reach for
 * `getUserPermittedApps()`, which fails OPEN (no explicit org list lets nearly
 * everything through) and would advertise the whole server catalog.
 *
 * Where this route deliberately differs from that one: when the gate cannot be
 * computed, that endpoint swallows the failure and every app comes back
 * `available: false`. For a PALETTE that is a tolerable lie. For a page that
 * says what an agent may already do it is not — "your agent has no apps" and "I
 * could not check" are different sentences, and only one of them is true. So a
 * failure here sets `degraded: true` and every `available` to `null`, and the
 * card says it could not check instead of claiming an answer.
 *
 * ── AND "NOT AVAILABLE" IS NOT ONE SENTENCE EITHER ──────────────────
 * `ALL_TOOL_APPS` carries the apps whose tools are injected inline — the
 * browser, the notebooks, the regex rules — which no other list this
 * route reads carries. Two extra fields travel with every app because the picker
 * cannot infer either of them:
 *
 *   `requiresGrant`     a curated agent gets nothing from this app unless its
 *                       grants map NAMES it. The picker mirrors that when it
 *                       decides which boxes to open with; without it, the
 *                       overlay ticks every action of an app the runtime is
 *                       serving none of.
 *   `availabilityKinds` ALL the causes why this app may be missing; `availabilityKind` only the one when there is exactly one.
 *                       See the registry heading: `browse_web` sits behind the docker probe AND the org entitlement, so
 *                       "this installation does not have it" was a claim there that the measurement does not yield.
 *   `availabilityKind`  what `available: false` MEANS here. 'installation' —
 *                       this server has no backend for it (browse_web behind
 *                       its docker probe); 'permission' — the caller may not
 *                       use it; 'connection' — the caller has not connected it,
 *                       which is what every ordinary app means. Absent, not
 *                       available on this installation, and not granted are
 *                       three different things, and the picker may only say the
 *                       one that is true.
 *   `grantsVia`         this row supplies the tools of ANOTHER app on the same
 *                       credentials (`outlook-readonly` beside `outlook`). Since A2-4 the
 *                       runtime decides on it: every app that claims a shared
 *                       name must permit it. Without this field the picker could
 *                       show two separate rows for the same tool, and one tick added
 *                       would silently take two away from the row beside it.
 *
 * ── `available` OF TWO ROWS OVER THE SAME MODULE ────────────────────
 * The gate yields one flat list of names, and those two rows share their names. "Does
 * one of my names occur in it" therefore gave the read-only row `true` purely through
 * overlap with the full row, even when the org had enabled precisely that full row.
 * The owner is therefore judged on his EXCLUSIVE names, and a row whose grants run
 * elsewhere falls away as soon as the broader row is available: then it decides
 * nothing any more. See `availabilityFor` in the route.
 *
 * ── IT TAKES NO OPTIONS, AND SAYS SO ────────────────────────────────
 * The answer is per caller and complete: there is no filter by app, by agent
 * or by effect. A query string must not be ignored, or `?app=gmail` would come back
 * with every app under a 200 that read as if it had narrowed. It is refused.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { requireAuth } = require('../../auth');
const { ALL_TOOL_APPS, loadToolsResult } = require('../../automation/toolRegistry');
const { effectOf } = require('../../automation/sideEffectMap');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { fallback } = require('../../utils/bestEffort');
const { sessionUser } = require('../../core/http/sessionUser');

// Bounded like every other user-facing list here: the registry is ours, but a
// response is a response.
const MAX_ACTIONS_PER_APP = 500;

const NoQuery = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());

router.get('/tool-catalog', requireAuth, validate({ query: NoQuery }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const userId = sessionUser(req).id;

    // The strict availability gate. A throw here is "I could not check",
    // which is neither yes nor no — see the header.
    let userToolNames = null;
    try {
        const { getIntegrationTools } = require('../../core/integrations/integrationTools');
        const result = await getIntegrationTools({
            userId, session: req.session, isAdmin: !!req.session?.isAdmin,
        });
        userToolNames = new Set();
        for (const t of result?.tools || []) {
            const name = t?.function?.name;
            if (name) userToolNames.add(name);
        }
    } catch (e) {
        log.warn('[agents/tool-catalog] availability gate unavailable:', /** @type {Error} */ (e).message);
        userToolNames = null;
    }

    /** @type {(toolName: string) => string|null} */
    let providerForTool = () => null;
    let lendingEnabled = false;
    try {
        const cr = require('../../core/integrations/connectionResolution');
        providerForTool = cr.providerForTool;
        lendingEnabled = cr.isLendingEnabled();
    } catch (e) {
        // A tool whose provider we cannot resolve is NOT "no connection
        // needed" — that reading would put a static "as Bee Flow" on an app
        // that borrows credentials. Unknown stays unknown (`provider: null`
        // with `providersKnown: false`), and the editor offers no owner
        // option at all there.
        log.warn('[agents/tool-catalog] connection resolution unavailable:', /** @type {Error} */ (e).message);
        providerForTool = null;
    }
    const providersKnown = typeof providerForTool === 'function';

    // ── ONE READ PER ENTRY, THEN ONLY THE ROWS ────────────────
    // The availability of two entries over the SAME module cannot be read off
    // their own names (see below), so all names are first collected and only
    // then assessed.
    const entries = [];
    const namesOf = new Map();
    for (const entry of ALL_TOOL_APPS || []) {
        if (!entry || !entry.app) continue;
        // NOT `res` — that is the express response of this handler.
        let loaded;
        try { loaded = loadToolsResult(entry); } catch (_) { loaded = null; }
        const tools = loaded && loaded.ok === true && Array.isArray(loaded.tools) ? loaded.tools : null;
        /** @type {string[]} */
        const names = [];
        for (const t of tools || []) {
            const name = t?.function?.name;
            if (typeof name === 'string' && name && names.length < MAX_ACTIONS_PER_APP) names.push(name);
        }
        entries.push({ entry, tools, names });
        namesOf.set(entry.app, tools === null ? null : new Set(names));
    }

    // Welke app leent zijn namen aan wie uit? `grantsVia` in de registry.
    const deferrersOf = new Map();
    for (const { entry } of entries) {
        const via = typeof entry.grantsVia === 'string' && entry.grantsVia ? entry.grantsVia : null;
        if (!via) continue;
        if (!deferrersOf.has(via)) deferrersOf.set(via, []);
        deferrersOf.get(via).push(entry.app);
    }

    /**
     * Is this app available for THIS user?
     *
     * `getIntegrationTools` yields one flat list of names, and two entries
     * over the same module (outlook / outlook-readonly) share those names.
     * "Does the list contain one of my names" therefore gave the read-only row
     * `available: true` purely through overlap with the full row — after which
     * the picker showed TWO rows for the same tool, with all the trouble of an
     * intersection that brings.
     *
     * The distinction that the flat list does carry:
     *   the OWNER is judged on his EXCLUSIVE names (`outlook`
     *   on `outlook_compose`) — those are there only if he is switched on himself;
     *   the LENDER is available as long as his own names are there AND
     *   the owner does not already have it: the broader row then replaces him entirely.
     */
    const availableOf = new Map();
    const overlaps = (/** @type {string[]} */ names) => names.some(n => userToolNames.has(n));
    /**
     * @param {string} app
     * @param {string[]} names
     */
    const availabilityFor = (app, names) => {
        if (userToolNames === null) return null;
        if (availableOf.has(app)) return availableOf.get(app);
        const deferrers = deferrersOf.get(app) || [];
        /** @type {boolean} */
        let value;
        if (deferrers.length) {
            const shared = new Set();
            for (const d of deferrers) for (const n of namesOf.get(d) || []) shared.add(n);
            const exclusive = names.filter(n => !shared.has(n));
            value = exclusive.length ? overlaps(exclusive) : overlaps(names);
        } else {
            value = overlaps(names);
        }
        availableOf.set(app, value);
        return value;
    };

    const apps = [];
    for (const { entry, tools, names } of entries) {
        // Two facts that come off the registry row rather than off a gate,
        // so they survive every degraded answer below.
        //   `requiresGrant`    silence about this app grants NOTHING to a
        //                      curated agent (toolPolicy.isToolAllowed).
        //                      The picker has to know, or it opens the app
        //                      with every tick on while the runtime serves
        //                      none of it.
        //   `availabilityKind` why an app can be missing. "This server has
        //                      no browser" is not "you did not connect it",
        //                      and neither is "you may not use it".
        //   `grantsVia`        this row supplies the tools of ANOTHER app
        //                      on the same credentials. The picker folds the
        //                      two into one grant subject; without this field
        //                      it cannot see that, while the runtime does decide
        //                      on it since A2-4 (`_decidingApps`).
        const requiresGrant = entry.grantsRequireEntry === true;
        // ALL causes, and `availabilityKind` only when there is exactly one.
        // The field describes a STATIC property of the row, while `available: false`
        // per app has several, dynamic causes: `browse_web` sits behind the docker probe
        // AND behind the org entitlement, the notebooks also behind the RBAC permission
        // `use_notebooks`. Passing on a single cause made the card a claim
        // ("this installation does not have it") that does not follow from the
        // measurement; with more than one, the picker names them both.
        const availabilityKinds = (Array.isArray(entry.availability)
            ? entry.availability
            : [entry.availability])
            .filter(k => typeof k === 'string' && k);
        if (!availabilityKinds.length) availabilityKinds.push('connection');
        const availabilityKind = availabilityKinds.length === 1 ? availabilityKinds[0] : null;
        const grantsVia = typeof entry.grantsVia === 'string' && entry.grantsVia ? entry.grantsVia : null;
        if (tools === null) {
            // This app cannot be READ: the module did not load, or its
            // names list is not an array (renamed export). Its actions are
            // therefore unknown — reporting the app with an EMPTY action list
            // would read as "nothing can be granted here", and that is a
            // claim. `loadTools` returned `[]` here without throwing, so this
            // branch was unreachable in production.
            apps.push({
                id: entry.app,
                label: entry.label || entry.app,
                available: null,
                actionsKnown: false,
                provider: null,
                actions: [],
                requiresGrant,
                availabilityKind,
                availabilityKinds,
                grantsVia,
            });
            continue;
        }

        const actions = [];
        /** @type {string | null} */
        let provider = null;
        for (const t of tools) {
            const name = t?.function?.name;
            if (typeof name !== 'string' || !name) continue;
            if (actions.length >= MAX_ACTIONS_PER_APP) break;
            actions.push({
                name,
                // Mechanical, exactly as the automations catalog produces
                // it. `agent-hub/.../flow/appLabels.js` turns these into
                // the verbs the picker shows; doing it here would fork that
                // logic across two clients.
                label: name.replace(/_/g, ' '),
                description: t.function?.description || '',
                effect: effectOf(name),
            });
            // The provider of the FIRST tool that resolves one — the same
            // rule (and the same caveat) as `_providerForApp` in
            // core/agentRuntime/toolPolicy.js: an app that one day draws on
            // two providers would be described by one of them. No registry
            // entry does that today.
            if (provider === null && providersKnown) {
                try { provider = providerForTool(name) || null; } catch (err) { fallback('routes/agents/toolCatalog:anon', err); /* stays null */ }
            }
        }

        let available = availabilityFor(entry.app, names);
        if (available === true && grantsVia) {
            // De bredere rij van dezelfde module vervangt deze volledig.
            const ownerNames = namesOf.get(grantsVia);
            if (ownerNames && availabilityFor(grantsVia, [...ownerNames]) === true) available = false;
        }

        apps.push({
            id: entry.app,
            label: entry.label || entry.app,
            // null = could not check. Never `false` on a failure.
            available,
            actionsKnown: true,
            provider,
            actions,
            requiresGrant,
            availabilityKind,
            availabilityKinds,
            grantsVia,
        });
    }

    res.json({
        apps,
        // Both flags are about THIS answer, not about the caller: the
        // client needs to know which half of the page it may believe.
        degraded: userToolNames === null,
        providersKnown,
        lendingEnabled,
    });
});

module.exports = router;
