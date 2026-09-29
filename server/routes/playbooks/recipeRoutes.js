/**
 * RECIPES — the catalogue a playbook is started from, and the one call that
 * writes a new recipe DOCUMENT from a sentence. Neither touches a stored
 * playbook: the catalogue is read-only and compose stores nothing, so the
 * dialog can show what it produced and let the person adjust it before
 * POST / creates the playbook from it.
 *
 * Registered FIRST — `/recipes` has to be matched before `/:id`.
 */

'use strict';

const { userIdOf } = require('../studio/shared');
const {
    z, sendErr, localeOfRequest, MAX_DESCRIPTION,
    worded, bodyOf, localeCode, tierName, check,
} = require('./contract');
const log = require('../../telemetry/log');

// The catalogue's language, and the sentence a recipe is written from.
// `tier` was read as `TIERS.has(body.tier) ? body.tier : 'fast'`, so a tier
// one letter off composed on the CHEAPEST model and said nothing -- on the
// one call that writes the whole playbook document.
const RecipesQuery = z.object({ locale: localeCode().optional() }).strict();

const DESCRIPTION_TEXT = 'Describe what the playbook should build.';
const ComposeBody = bodyOf({
    description: worded(DESCRIPTION_TEXT).trim().min(1, DESCRIPTION_TEXT)
        .max(MAX_DESCRIPTION, `Keep the description under ${MAX_DESCRIPTION} characters.`),
    locale: localeCode().nullish(),
    tier: tierName().optional(),
});

// The schema says a `tier` is A tier; it never said it was one THIS person
// may use. Compose did not ask: a request with `tier: 'pro'` from somebody
// whose groups allow only `fast` composed on the pro model. It now asks the
// list every other place a tier is picked asks (phaseFlow.tierFor).
//
// It asks when no tier is sent, too -- which is every request the dialog
// makes. That composed on `fast` without asking, so a group narrowed to
// `thinking` or to an on-prem tier still sent the description to the fast
// model. No tier, and `auto` (which composeRecipe resolved to the FAST model
// whatever the groups allowed), compose on the cheapest tier this person may
// use: fast when it is theirs.

function register(router, ctx) {
    const { d, flow, requireManageApps, runLimiter } = ctx;
    const { approvalsAllowed } = flow;

    // `locale` is the caller's interface language: the recipes come back with
    // their columns, labels and briefs in it, and that is the language the
    // playbook is then built in.
    router.get('/recipes', async (req, res) => {
        const q = check(res, RecipesQuery, req.query, 'bad_options', 'query');
        if (!q.ok) return;
        res.json({ recipes: d.recipes.listRecipes(localeOfRequest(q.value.locale)), approvalsAllowed: await approvalsAllowed(req) });
    });

    // Describe a playbook in words → a recipe DOCUMENT (the tier above, one
    // forced tool call, normalised + validated server-side). Nothing is
    // stored: the dialog shows it, the person adjusts, POST / creates from it.
    router.post('/recipes/compose', requireManageApps, runLimiter, async (req, res) => {
        try {
            const parsed = check(res, ComposeBody, req.body, 'description_required');
            if (!parsed.ok) return;
            const body = parsed.value;
            const tier = await flow.tierFor(req, res, body.tier);
            if (!tier) return;
            const description = body.description;
            const locale = localeOfRequest(body.locale);
            // The language a playbook is written in has been wrong twice, and
            // both times it was invisible from here. Say it once per compose.
            log.info(`[Playbooks] compose locale=${locale} (client sent ${body.locale === undefined ? 'nothing' : JSON.stringify(body.locale)})`);
            // What this workspace can actually do. Without it the composer was
            // free to write an approval phase that arrives `locked` — a dead row
            // in the rail — and paid ~940 characters of prompt for the privilege.
            const out = await d.composeRecipe({
                description,
                locale,
                tier,
                approvalsAllowed: await approvalsAllowed(req),
                userId: userIdOf(req),
                userOrgId: req.session?.user?.organizationId || null,
            });
            if (!out.ok) {
                // An unreachable model carries the id its log line was written
                // under: the one thing that ties this screen to that line.
                return sendErr(res, out.status || 422, out.code, out.error, {
                    errors: out.errors || [], recipe: out.recipe || null,
                    ...(out.correlationId ? { correlationId: out.correlationId } : {}),
                });
            }
            res.json({ recipe: out.recipe, warnings: out.warnings || [] });
        } catch (e) {
            log.error('[Playbooks] compose failed:', e.message);
            sendErr(res, 502, 'compose_failed', 'Could not compose the playbook right now.');
        }
    });
}

module.exports = { register };
