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
 * nothing else (no routine steps, no output schemas, no dry-run samples), and
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
 * browser, the notebooks, the regex rules — which used to be in NO list this
 * route reads. Two extra fields travel with every app because the picker
 * cannot infer either of them:
 *
 *   `requiresGrant`     a curated agent gets nothing from this app unless its
 *                       grants map NAMES it. The picker mirrors that when it
 *                       decides which boxes to open with; without it, the
 *                       overlay ticks every action of an app the runtime is
 *                       serving none of.
 *   `availabilityKinds` ALLE oorzaken waarom deze app kan ontbreken, en
 *                       `availabilityKind` alleen de ene wanneer er precies één
 *                       is. Zie de registry-kop: `browse_web` zit achter de
 *                       docker-probe én het org-entitlement, dus "deze
 *                       installatie heeft hem niet" was daar een bewering die
 *                       de meting niet oplevert.
 *   `availabilityKind`  what `available: false` MEANS here. 'installation' —
 *                       this server has no backend for it (browse_web behind
 *                       its docker probe); 'permission' — the caller may not
 *                       use it; 'connection' — the caller has not connected it,
 *                       which is what every ordinary app means. Absent, not
 *                       available on this installation, and not granted are
 *                       three different things, and the picker may only say the
 *                       one that is true.
 *   `grantsVia`         deze rij levert de tools van een ANDERE app op dezelfde
 *                       credentials (`outlook-readonly` naast `outlook`). De
 *                       runtime beslist er sinds A2-4 op: elke app die een
 *                       gedeelde naam claimt moet hem toestaan. Zonder dit veld
 *                       kon de kiezer twee losse rijen voor hetzelfde
 *                       gereedschap tonen, en nam één vinkje erbij er stil twee
 *                       af op de rij ernaast.
 *
 * ── `available` VAN TWEE RIJEN OVER DEZELFDE MODULE ─────────────────
 * De gate levert één platte namenlijst, en die twee rijen delen hun namen. "Zit
 * één van mijn namen erin" gaf de read-only rij dus `true` puur door overlap
 * met de volledige rij, óók als de org juist die volledige rij had aangezet.
 * De eigenaar wordt daarom beoordeeld op zijn EXCLUSIEVE namen, en een rij die
 * zijn grants elders laat lopen valt weg zodra de bredere rij beschikbaar is:
 * dan gaat hij nergens meer over. Zie `availabilityFor` in de route.
 *
 * ── IT TAKES NO OPTIONS, AND SAYS SO ────────────────────────────────
 * The answer is per caller and complete: there is no filter by app, by agent
 * or by effect. A query string used to be ignored, so `?app=gmail` came back
 * with every app under a 200 that read as if it had narrowed. It is refused.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { requireAuth } = require('../../auth');
const { ALL_TOOL_APPS, loadToolsResult } = require('../../automation/toolRegistry');
const { effectOf } = require('../../automation/sideEffectMap');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// Bounded like every other user-facing list here: the registry is ours, but a
// response is a response.
const MAX_ACTIONS_PER_APP = 500;

const NoQuery = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());

router.get('/tool-catalog', requireAuth, validate({ query: NoQuery }), async (req, res) => {
    try {
        const userId = req.session.user.id;

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
            log.warn('[agents/tool-catalog] availability gate unavailable:', e.message);
            userToolNames = null;
        }

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
            log.warn('[agents/tool-catalog] connection resolution unavailable:', e.message);
            providerForTool = null;
        }
        const providersKnown = typeof providerForTool === 'function';

        // ── ÉÉN LEZING PER ENTRY, DAARNA PAS DE RIJEN ──────────────
        // De beschikbaarheid van twee entries over DEZELFDE module is niet uit
        // hun eigen namen af te lezen (zie hieronder), dus alle namen worden
        // eerst verzameld en daarna pas beoordeeld.
        const entries = [];
        const namesOf = new Map();
        for (const entry of ALL_TOOL_APPS || []) {
            if (!entry || !entry.app) continue;
            // NIET `res` — dat is de express-response van deze handler.
            let loaded;
            try { loaded = loadToolsResult(entry); } catch (_) { loaded = null; }
            const tools = loaded && loaded.ok === true && Array.isArray(loaded.tools) ? loaded.tools : null;
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
         * Is deze app voor DEZE gebruiker beschikbaar?
         *
         * `getIntegrationTools` levert één platte namenlijst, en twee entries
         * over dezelfde module (outlook / outlook-readonly) delen die namen.
         * "Bevat de lijst één van mijn namen" gaf de read-only rij dus
         * `available: true` puur door overlap met de volledige rij — waarna de
         * kiezer TWEE rijen voor hetzelfde gereedschap toonde, met alle
         * doorsnede-ellende van dien.
         *
         * Het onderscheid dat de platte lijst wél draagt:
         *   de EIGENAAR wordt beoordeeld op zijn EXCLUSIEVE namen (`outlook`
         *   op `outlook_compose`) — die zijn er alleen als hij zelf aanstaat;
         *   de UITLENER is beschikbaar zolang zijn eigen namen er zijn én de
         *   eigenaar het niet al is: de bredere rij vervangt hem dan volledig.
         */
        const availableOf = new Map();
        const overlaps = (names) => names.some(n => userToolNames.has(n));
        const availabilityFor = (app, names) => {
            if (userToolNames === null) return null;
            if (availableOf.has(app)) return availableOf.get(app);
            const deferrers = deferrersOf.get(app) || [];
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
            //   `grantsVia`        deze rij levert de tools van een ANDERE app
            //                      op dezelfde credentials. De kiezer vouwt de
            //                      twee tot één grant-subject; zonder dit veld
            //                      kan hij dat niet zien, terwijl de runtime er
            //                      sinds A2-4 wél op beslist (`_decidingApps`).
            const requiresGrant = entry.grantsRequireEntry === true;
            // ALLE oorzaken, en `availabilityKind` alleen als er precies één is.
            // Het veld beschrijft een STATISCHE eigenschap van de rij, terwijl
            // `available: false` per app meerdere, dynamische oorzaken heeft:
            // `browse_web` zit achter de docker-probe én achter het
            // org-entitlement, de notebooks óók achter de RBAC-permissie
            // `use_notebooks`. Eén oorzaak doorgeven maakte van de kaart een
            // bewering ("deze installatie heeft hem niet") die niet uit de
            // meting volgt; met meer dan één noemt de kiezer ze allebei.
            const availabilityKinds = (Array.isArray(entry.availability)
                ? entry.availability
                : [entry.availability])
                .filter(k => typeof k === 'string' && k);
            if (!availabilityKinds.length) availabilityKinds.push('connection');
            const availabilityKind = availabilityKinds.length === 1 ? availabilityKinds[0] : null;
            const grantsVia = typeof entry.grantsVia === 'string' && entry.grantsVia ? entry.grantsVia : null;
            if (tools === null) {
                // Deze app is niet te LEZEN: de module laadde niet, of zijn
                // namenlijst is geen array (hernoemde export). Zijn acties zijn
                // dus onbekend — de app met een LEGE actielijst melden zou
                // lezen als "hier valt niets te gunnen", en dat is een
                // bewering. `loadTools` gaf hier `[]` terug zonder te gooien,
                // waardoor deze tak in productie onbereikbaar was.
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
                    try { provider = providerForTool(name) || null; } catch (_) { /* stays null */ }
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
    } catch (err) {
        log.error('[agents/tool-catalog] failed:', err.message);
        res.status(500).json({ error: 'Could not load the tool catalog' });
    }
});

module.exports = router;
