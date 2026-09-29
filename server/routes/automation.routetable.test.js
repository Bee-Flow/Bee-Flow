/**
 * Route-table equivalence smoke for routes/automation.js (§WS5 #4).
 *
 * routes/automation.js is split into contiguous sub-routers (automation/*.js)
 * mounted in original order. Express is first-match, so the ONE invariant that
 * must hold is: the flattened (method, path) sequence — including where the auth
 * middleware sits — is byte-for-byte identical to the pre-split single router.
 * This test mocks every dependency (no DB/network/timers), loads the router,
 * walks router.stack recursively (into mounted sub-routers), and asserts the
 * ordered table equals the frozen baseline. A reorder, a dropped route, or a
 * sub-router mounted out of order fails here.
 *
 * Run: node --test routes/automation.routetable.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}
const noopMw = () => (req, res, next) => next();

// Mock every module routes/automation.js (and its sub-routers) require, so a
// bare require never hits the DB / network / background timers.
mock(path.join(SERVER, 'stores/automationStore'), {});
mock(path.join(SERVER, 'stores/configStore'), {});
mock(path.join(SERVER, 'automation/cron'), {});
mock(path.join(SERVER, 'automation/validate'), { validateDefinition: () => ({ valid: true }) });
mock(path.join(SERVER, 'automation/summarise'), {});
mock(path.join(SERVER, 'automation/deliverableEvents'), {});
mock(path.join(SERVER, 'automation/toolRegistry'), {});
mock(path.join(SERVER, 'automation/sideEffectMap'), {});
mock(path.join(SERVER, 'automation/outputSchemas'), {});
mock(path.join(SERVER, 'automation/triggerBus'), {});
mock(path.join(SERVER, 'core/integrations/integrationToolMap'), {});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => noopMw() });
mock(path.join(SERVER, 'automation/portability'), {});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), { requireBetaFeature: () => noopMw() });
// approvals.js builds its Enterprise `approvals` gate at module load
// (requireCapability resolves the capability id eagerly, which would build the
// whole capability registry here). Stubbed like requireBetaFeature above — this
// test is about ORDER, and per-route middleware never enters the flattened
// table anyway; whether the gate lets the call through is communityEnforcement's
// and approvals.licenseGate.test.js's job.
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: () => noopMw() });
mock(path.join(SERVER, 'auth'), { requireActiveOrgForMutations: () => noopMw() });

function flatten(stack, out) {
    for (const layer of stack) {
        if (layer.route) {
            const methods = Object.keys(layer.route.methods)
                .filter(m => layer.route.methods[m])
                .map(m => m.toUpperCase())
                .sort()
                .join(',');
            out.push(`${methods} ${layer.route.path}`);
        } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
            flatten(layer.handle.stack, out);
        } else {
            out.push(`USE:${layer.handle && layer.handle.name ? layer.handle.name : 'anonymous'}`);
        }
    }
    return out;
}

// Frozen baseline captured from the pre-split single router. The two `USE:anonymous`
// entries are requireBetaFeature('automations') + requireActiveOrgForMutations().
const EXPECTED = [
    'POST /webhook/:slug',
    'POST /events/gmail',
    'POST /events/nextcloud',
    'POST /events/msgraph',
    'POST /events/github',
    // Forms are signed-in only for now (PUBLIC_FORMS_ENABLED in formPublic.js),
    // so its router carries its own requireAuth. Applied there rather than by
    // moving the mount, which is why everything below keeps its position.
    'USE:requireAuth',
    'GET /form/:token',
    'POST /form/:token/upload',
    // An `app_pick` question's search box. Like /upload it must be matched
    // before the bare POST, and like /upload it is scoped to ONE declared
    // field — the browser names a question, never an app and never a tool.
    'POST /form/:token/pick',
    'POST /form/:token',
    'GET /form/:token/s/:sid',
    // The session-scoped download for a `generate_document` file. Sits under
    // the session so the file is only reachable by the visitor whose journey
    // produced it; every miss is a 404, never a 403.
    'GET /form/:token/s/:sid/file/:fileId',
    // Its twin: the same file, into a new notebook, for the closing page's
    // "Open in Notebooks" button. POST, so it cannot collide with the GET.
    'POST /form/:token/s/:sid/file/:fileId/notebook',
    // BFSF-419 Track 1's generic fallback: the closing page's OWN TEXT (no
    // generate_document step, so no fileId to key off), into a new notebook.
    'POST /form/:token/s/:sid/notebook',
    'POST /form/:token/s/:sid',
    'USE:requireAuth',
    'USE:anonymous',
    'USE:anonymous',
    // The Approvals section's API. Mounted BEFORE crud because crud has
    // GET /:id and Express is first-match — the /approvals literal must win
    // (the same rule that keeps /templates above /:id inside runs.js).
    'GET /approvals',
    'GET /approvals/facets',
    'GET /approvals/directory',
    'GET /approvals/:id',
    'POST /approvals/:id/decide',
    'POST /approvals/:id/withdraw',
    // Handoff 5: the Runs tab's "send reminder".
    'POST /approvals/:id/remind',
    'GET /approvals/:id/files/:fileId',
    'GET /catalog',
    // The `app_pick` source list on its own — the form editor asks for this
    // rather than the whole catalog above. A literal, so it must precede
    // '/catalog/sample/:tool' only in the sense that it cannot collide with it.
    'GET /catalog/form-pick-sources',
    'GET /catalog/sample/:tool',
    // The columns of one Nextcloud table, for the column-aware row editor —
    // design-time picker data like the sample above it; runs through the
    // guarded dispatcher as the signed-in user.
    'GET /catalog/nextcloud-tables/:tableId/columns',
    // R2 — what one agent would bring to an ai_step (which of its tools are
    // held back because they would ask a person first). Under /catalog because
    // it is design-time picker data, like the sample above it.
    'GET /catalog/agent/:agentId',
    'GET /catalog/skill/:skillId',
    // The code editor: analysis and "Try it" for unsaved code (codeTools.js).
    'POST /code/analyze',
    'POST /code/test',
    'GET /',
    'POST /',
    // Folders sit before `/:id` for the same reason templates do: the param
    // route would swallow the literal 'folders'.
    'GET /folders',
    'POST /folders',
    'PUT /folders/:folderId',
    'DELETE /folders/:folderId',
    // Org-wide published forms — likewise before `/:id`, and NOT to be confused
    // with '/:id/forms' further down, which is one routine's own pages.
    'GET /forms',
    // The Form page (Studio → Forms → a form) and its "make the answers
    // table" action — keyed by the routine id, never the page token.
    // Draft or revise a form's questions from a brief; nothing is stored.
    'POST /forms/ai/draft',
    'GET /forms/:automationId',
    // Who may fill the form in: everyone in the organisation, or the people
    // and groups the owner lists. Owner only.
    'PUT /forms/:automationId/audience',
    'POST /forms/:automationId/answers-table',
    'GET /templates',
    'GET /templates/:id',
    'POST /import',
    // Handoff 5: the caller's trash. A literal, so it must precede GET /:id.
    'GET /_trash',
    'GET /:id',
    // Added by the routine-editor work (routes/automation/crud.js): the
    // "used by" capsule. Owner-only — a non-owner gets 403 and an unreadable
    // app yields canOpen:false, so an unknown narrows to no link. Verified
    // before adding it here rather than blessed because the test was red.
    'GET /:id/usage',
    'GET /:id/export',
    'PUT /:id',
    // DELETE is a soft delete since handoff 5; restore takes it out again.
    'DELETE /:id',
    'POST /:id/restore',
    'POST /:id/activate',
    // "Make vN live": the working copy becomes the live version.
    'POST /:id/publish',
    'POST /:id/deactivate',
    'POST /:id/run',
    'POST /:id/diagnose-trigger',
    'POST /:id/dry-run',
    'POST /:id/steps/:stepId/run',
    'GET /_runs/active',
    'POST /_schedule/preview',
    'GET /:id/runs',
    'GET /_runs/recent',
    'GET /_runs/facets',
    // Track H2 — the organisation-wide run log. Deliberately its OWN pair of
    // literals rather than a ?scope=org on the two above: those are
    // user-scoped by contract (runs.js says so, and half a dozen callers rely
    // on it), and a scope parameter would put every one of them one query
    // string away from another person's runs. Both carry an explicit
    // manage_automations check in the handler; position is free either way —
    // '/_runs/org' cannot collide with '/:id/runs' (the second segment is a
    // literal on both sides and they differ).
    'GET /_runs/org',
    'GET /_runs/org/facets',
    'GET /_runs/stream',
    'GET /:id/versions',
    'GET /:id/versions/:versionId/diff/:otherVersionId',
    'GET /:id/versions/:versionId',
    'POST /:id/versions/:versionId/restore',
    // Handoff 5 (artboard 5d): per-field differences and milestone names
    // (routes/automation/versionHistory.js). Five segments: no collisions.
    'GET /:id/versions/:versionId/fielddiff/:other',
    'PUT /:id/versions/:versionId/name',
    'POST /:id/webhook',
    'GET /:id/webhooks',
    'POST /:id/webhook/:slug/rotate',
    'DELETE /:id/webhook/:slug',
    'POST /:id/form',
    'GET /:id/forms',
    'POST /:id/form/:token/rotate',
    'DELETE /:id/form/:token',
    'GET /runs/:id',
    'GET /runs/:id/steps',
    'GET /runs/:id/steps/:stepId/full-output',
    'POST /:id/runs/:runId/retry',
    'POST /runs/:runId/approve-step',
    // Testing a form journey from the builder: which page the run is paused
    // on, and answering it. Owner-only run operations — no token, no session,
    // no anonymous path; formPublic stays the only public form surface.
    'GET /runs/:runId/form',
    'POST /runs/:runId/form',
    // The app picker while the routine is still a draft — the public page's
    // own picker needs a token and 404s a draft, so the builder has its own.
    'POST /:id/form-pick',
    'POST /runs/:runId/cancel',
    'POST /runs/:id/approve',
    'POST /:id/agent-invoke',
    'POST /:id/webhook/:slug/test',
    // Handoff 5, sharing and roles (routes/automation/sharing.js).
    'GET /:id/shares',
    'PUT /:id/shares',
    'POST /:id/transfer-owner',
    'GET /:id/principals',
    // Handoff 5, notification settings read (routes/automation/notifications.js).
    'GET /:id/notifications',
    // Handoff 5, the AI Act check and the readiness checklist
    // (routes/automation/aiAct.js).
    'GET /:id/ai-act',
    'GET /:id/ai-act/check',
    'PUT /:id/ai-act/answers',
    'GET /:id/ai-act/suggestion',
    'PUT /:id/ai-act',
    'GET /:id/readiness',
    // Handoff 5, the builder's "Frequently used" (routes/automation/usage.js).
    'GET /_usage/steps',
    'GET /_usage/values',
    // Handoff 5: duplicate, save as template, the description suggestion and
    // the header's tab counts (routes/automation/actions.js).
    'POST /:id/duplicate',
    'POST /:id/save-as-template',
    'POST /:id/suggest-description',
    'GET /:id/counts',
];

test('automation router loads and exposes the exact baseline route table in order', () => {
    const router = require(path.join(SERVER, 'routes/automation'));
    assert.ok(typeof router === 'function', 'router export should be an express router (function)');
    const table = flatten(router.stack, []);
    assert.deepStrictEqual(table, EXPECTED);
});

test('every relative require() across the facade + sub-routers resolves (catches the one-dir-deeper path break)', () => {
    // node --check / no-undef / the route-table walk all miss a wrong require()
    // PATH inside a handler body (it only throws when the handler runs). The
    // §WS5 #4 split moved files one dir deeper, so inline `require('../x')` had
    // to become `require('../../x')`. Resolve every relative specifier from its
    // file's real directory so a bad path fails here, not in production.
    const fs = require('fs');
    const files = [
        'routes/automation.js',
        'routes/automation/events.js',
        'routes/automation/formPublic.js',
        'routes/automation/catalog.js',
        'routes/automation/crud.js',
        'routes/automation/activate.js',
        'routes/automation/trash.js',
        'routes/automation/runs.js',
        'routes/automation/diagnoseTrigger.js',
        'routes/automation/versions.js',
        'routes/automation/webhooksAndRunOps.js',
        'routes/automation/sharing.js',
        'routes/automation/notifications.js',
        'routes/automation/agentStepRoutes.js',
        'routes/automation/agentStepCatalog.js',
        'routes/automation/aiAct.js',
        'routes/automation/usage.js',
        'routes/automation/versionHistory.js',
        'routes/automation/actions.js',
    ];
    const re = /require\((["'])(\.[^"']+)\1\)/g;
    const unresolved = [];
    for (const rel of files) {
        const abs = path.join(SERVER, rel);
        const dir = path.dirname(abs);
        const src = fs.readFileSync(abs, 'utf8');
        let m;
        while ((m = re.exec(src))) {
            try { require.resolve(path.resolve(dir, m[2])); }
            catch { unresolved.push(`${rel} -> ${m[2]}`); }
        }
    }
    assert.deepStrictEqual(unresolved, [], `unresolved relative requires:\n${unresolved.join('\n')}`);
});

test('public event routes precede the auth middleware (events stay unauthenticated)', () => {
    const router = require(path.join(SERVER, 'routes/automation'));
    const table = flatten(router.stack, []);
    const authIdx = table.indexOf('USE:requireAuth');
    const lastEventIdx = table.lastIndexOf('POST /events/github');
    const firstAuthedIdx = table.indexOf('GET /catalog');
    assert.ok(authIdx > lastEventIdx, 'requireAuth must come after all /events/* routes');
    assert.ok(firstAuthedIdx > authIdx, 'authed routes (/catalog) must come after requireAuth');
    // The hosted form USED to be anonymous. It is signed-in only for now, so
    // its routes sit behind a requireAuth of their own — while the event
    // routes above it stay open, which is the split this test exists to pin.
    assert.ok(table.indexOf('POST /form/:token') > authIdx, 'form routes must be behind requireAuth');
    assert.ok(table.indexOf('POST /events/github') < authIdx, 'event routes must stay public');
    // …and the more specific /upload must be matched before the bare POST,
    // since Express is first-match.
    assert.ok(table.indexOf('POST /form/:token/upload') < table.indexOf('POST /form/:token'));
    assert.ok(table.indexOf('POST /form/:token/pick') < table.indexOf('POST /form/:token'));
    // The multi-page session surface sits behind the same gate: someone
    // part-way through a form is the same person who was allowed to open it.
    assert.ok(table.indexOf('GET /form/:token/s/:sid') > authIdx, 'form session poll is gated too');
    assert.ok(table.indexOf('POST /form/:token/s/:sid') > authIdx, 'form session resume is gated too');
});
