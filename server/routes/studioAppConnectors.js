/**
 * App Studio — connectors runtime bridge.
 *
 * Lets viewers of a published studio app LIST and RUN the external connectors
 * its owner wired into the data model (model.connectors[]). Mounted at
 * /api/studio-apps ALONGSIDE the CRUD + action-run routers (Express supports
 * multiple routers per path).
 *
 * Endpoints:
 *   GET  /:id/data/connectors                     — safe projection of the app's
 *                                                   connectors (never fixedArgs /
 *                                                   url / credentials)
 *   POST /:id/data/connectors/:connectorId/run    — run ONE connector and return
 *                                                   { rows, nextPage? }
 *   POST /:id/data/connectors/:connectorId/inspect — OWNER ONLY. Run once and
 *                                                   describe the shape: fields,
 *                                                   identity, incremental tier,
 *                                                   a proposed table.
 *   POST /:id/data/connectors/:connectorId/sync   — OWNER ONLY. Refresh the
 *                                                   connector's table now.
 *   GET  /:id/data/connectors/sync-status         — OWNER ONLY. Last run / next
 *                                                   run / error per connector.
 *   GET  /:id/runtime/connectors/status           — MEMBERS. What the
 *                                                   connector_status component
 *                                                   shows: account, connected,
 *                                                   last/next run.
 *   POST /:id/runtime/connectors/:cid/refresh     — MEMBERS. "Check for new
 *                                                   mail", rate-limited.
 *
 * ── WHY /inspect AND /sync ARE OWNER-ONLY ───────────────────────────
 * The viewer gate (canReadStudioApp) is right for *running* a connector: that is
 * a read the app is published to offer. Inspection and sync are AUTHORING: one
 * describes the owner's upstream data shape (a small leak in itself), the other
 * WRITES rows and spends the owner's API budget. Neither is something a viewer
 * of a published app should be able to trigger, so both check ownership
 * directly rather than reusing the visibility gate.
 *
 * Security model (mirrors routes/studioAppsRun.js):
 *   • Visibility gate is canReadStudioApp — owner always; everyone else needs
 *     is_published + org/group visibility. Failures answer 404 so an app id
 *     never leaks (uniform-404 IDOR defence).
 *   • The connector is resolved from the OWNER's data model by id — the request
 *     can never supply a url/tool/credential, and viewer params are narrowed to
 *     the connector's declared `params` before dispatch. It executes ACTS-AS-OWNER
 *     (connectors.js runConnector): the owner's credentials, quota and pinned
 *     args. The viewer's identity rides along for audit only (_viewerUserId).
 *   • The GET projection is secret-free by construction (connectors.listConnectors);
 *     fixedArgs, url templates and auth are never serialised to a viewer.
 *   • The data model is single-source (the owner's live schema); ?draft=1 is an
 *     owner-only hint — a non-owner only ever reaches a PUBLISHED app's model.
 *
 * ── SSRF re-audit (Wave 6a, signed off) ─────────────────────────────
 * The REST connector fetches only through utils/ssrfGuard.safeFetch, whose
 * Agent revalidates the target on EVERY socket connect (validatingLookup runs
 * resolve-then-connect with no re-resolution window → DNS-rebinding safe) and on
 * every redirect hop (fresh connect → re-screened). Credentials come from the
 * OWNER's credential store (getCredential(app.userId, …)); a viewer can only
 * fill declared {placeholders} with url-encoded primitives, and author fixedArgs
 * always win. This route adds no new fetch path — it delegates entirely to
 * connectors.js.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { z, bodyOf } = require('../core/http/schemaParts');
// A run or inspect takes the connector's parameters and nothing else; the
// connector's own parameter list decides which of them count. A misspelled
// `parms` used to run the connector with none, under a 200.
const ParamsBody = bodyOf({
    params: z.record(z.unknown(), { invalid_type_error: 'params is an object of the connector\'s parameters.' }).nullish(),
}, 'A connector call');

const studioAppStore = require('../stores/studioAppStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const connectors = require('../appStudio/connectors');
const connectorSchema = require('../appStudio/connectorSchema');
const connectorSync = require('../appStudio/connectorSync');
const { resolveAudienceContext } = require('../auth/audience');
const { connectorRunLimiter, connectorSyncLimiter } = require('./studioAppRateLimits');
const { requireAuth } = require('../auth/permissions');

// Form/params ride in the JSON body; 64KB is far above any real connector call
// and far below the app-definition ceiling (same budget as the action bridge).
const MAX_BODY_BYTES = 64 * 1024;
const jsonBody = express.json({ limit: MAX_BODY_BYTES });

function bodySizeGuard(req, res, next) {
    if (req.body && typeof req.body === 'object') {
        let bytes = 0;
        try { bytes = Buffer.byteLength(JSON.stringify(req.body), 'utf8'); } catch { bytes = MAX_BODY_BYTES + 1; }
        if (bytes > MAX_BODY_BYTES) return res.status(413).json({ error: 'Request body too large (max 64KB)' });
    }
    next();
}

// ── App visibility gate (uniform 404) ───────────────────────────────
// Owner always; everyone else needs is_published + an audience that carries
// them: org, shared group, or a Studio Project the app is filed into
// (canReadStudioAppAsync). Responds itself and returns null on failure.
async function loadVisibleApp(req, res) {
    const userId = req.session.user.id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app) { res.status(404).json({ error: 'App not found' }); return null; }
    if (app.userId !== userId) {
        const { orgIds, userGroups } = await resolveAudienceContext(req);
        const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
        if (!await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr)) {
            res.status(404).json({ error: 'App not found' });
            return null;
        }
    }
    return app;
}

// The app's connector-bearing data model is the OWNER's live schema (there is
// no published snapshot of the data model — same as the action bridge, which
// reads getDataModel(app.id, app.userId) unconditionally).
async function loadOwnerModel(app) {
    const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
    return (meta && meta.model) ? meta.model : null;
}

/**
 * OWNER-ONLY gate for the authoring endpoints. Deliberately NOT loadVisibleApp:
 * inspecting a connector describes the owner's upstream data, and syncing spends
 * their API budget and writes rows — neither belongs to a viewer of a published
 * app. Answers the same uniform 404 for an app that isn't theirs, so ownership
 * can't be probed. Responds itself and returns null on failure.
 */
async function loadOwnedApp(req, res) {
    const userId = req.session.user.id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app || app.userId !== userId) { res.status(404).json({ error: 'App not found' }); return null; }
    return app;
}

// Resolve (app, model, connector) for an owner-only endpoint, or answer and
// return null. Shared by /inspect and /sync so their gates can never drift.
async function loadOwnedConnector(req, res) {
    const app = await loadOwnedApp(req, res);
    if (!app) return null;
    const model = await loadOwnerModel(app);
    const connector = connectors.findConnector(model, req.params.connectorId);
    if (!connector) { res.status(404).json({ error: 'Connector not found' }); return null; }
    return { app, model, connector };
}

function appRef(app) {
    return { id: app.id, userId: app.userId, organizationId: app.organizationId || null };
}

// Map a connector/sync failure onto a response. connectors.js and
// connectorSync.js both throw structured errors carrying status/code.
function sendConnectorError(res, err, logLabel) {
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status >= 400 && status < 600 && status !== 500) {
        return res.status(status).json({
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
            ...(typeof err.provider === 'string' && err.provider ? { provider: err.provider } : {}),
        });
    }
    log.error(`[StudioAppConnectors/${logLabel}] ${err.message}`);
    return res.status(500).json({ error: 'Connector failed to run' });
}

// ── GET /:id/data/connectors ────────────────────────────────────────
// Safe projection for any reader — never fixedArgs / url / credentials.
router.get('/:id/data/connectors', requireAuth, async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        const model = await loadOwnerModel(app);
        res.json({ connectors: connectors.listConnectors(model) });
    } catch (err) {
        log.error(`[StudioAppConnectors/list] ${err.message}`);
        res.status(500).json({ error: 'Failed to list connectors' });
    }
});

// ── POST /:id/data/connectors/:connectorId/run ──────────────────────
router.post('/:id/data/connectors/:connectorId/run', requireAuth, connectorRunLimiter, jsonBody, bodySizeGuard, validate({ body: ParamsBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await loadVisibleApp(req, res);
        if (!app) return;

        const model = await loadOwnerModel(app);
        // Resolve the connector FROM THE OWNER's MODEL by id (own-property, no
        // proto walk) — the request never names a url/tool/credential.
        const connector = connectors.findConnector(model, req.params.connectorId);
        if (!connector) return res.status(404).json({ error: 'Connector not found' });

        const rawParams = (req.body && typeof req.body.params === 'object' && !Array.isArray(req.body.params))
            ? req.body.params : {};
        // The connector's declared params are the allow-list: an undeclared key
        // must never reach a tool call made with the OWNER's credentials.
        // connectors.js filters again before dispatch (defence in depth).
        const params = connectors.filterDeclaredParams(connector, rawParams);

        // Runs ACTS-AS-OWNER; viewerId is audit-only (never scopes the call).
        const result = await connectors.runConnector(connector, {
            app: { id: app.id, userId: app.userId, organizationId: app.organizationId || null },
            viewerId: userId,
            params,
        });
        return res.json({ rows: result.rows || [], ...(result.nextPage != null ? { nextPage: result.nextPage } : {}) });
    } catch (err) {
        // connectors.js throws structured connectorError(status, message, code).
        // Surface its status/code for known client/upstream failures; otherwise
        // a generic 500. Never leak internals for unexpected errors. A 409
        // `connection_required` also names the provider so the client can
        // render "connect <app> first" for runAs:'viewer' connectors.
        const status = Number.isInteger(err.status) ? err.status : 500;
        if (status >= 400 && status < 600 && status !== 500) {
            return res.status(status).json({
                error: err.message,
                ...(err.code ? { code: err.code } : {}),
                ...(typeof err.provider === 'string' && err.provider ? { provider: err.provider } : {}),
            });
        }
        log.error(`[StudioAppConnectors/run] ${err.message}`);
        return res.status(500).json({ error: 'Connector failed to run' });
    }
});

// ── Owner-only authoring endpoints ──────────────────────────────────

/**
 * The action descriptor detection needs, resolved server-side from the tool
 * registry rather than the HTTP catalog — /inspect must work even for a tool the
 * catalog would hide, and it saves a round trip.
 *
 * Returns { action, siblings } where `action` carries the inputSchema (what the
 * action REQUIRES) and each sibling carries its declared output sample (what it
 * PRODUCES). Those two halves are what suggestChain matches against each other.
 */
function describeToolFamily(toolName) {
    try {
        const { findOwnerOfTool, loadTools } = require('../automation/toolRegistry');
        const { getOutputSchema } = require('../automation/outputSchemas');
        const { isSideEffect } = require('../automation/sideEffectMap');
        const entry = findOwnerOfTool(toolName);
        if (!entry) return { action: null, siblings: [] };
        const described = loadTools(entry).map((t) => {
            const name = t?.function?.name;
            if (!name) return null;
            const os = getOutputSchema(name);
            return {
                name,
                label: name.replace(/_/g, ' '),
                description: t.function?.description || '',
                inputSchema: t.function?.parameters || null,
                outputSample: os?.sample || null,
                sideEffect: isSideEffect(name),
            };
        }).filter(Boolean);
        return {
            action: described.find((a) => a.name === toolName) || null,
            siblings: described.filter((a) => a.name !== toolName),
        };
    } catch (err) {
        // A registry that can't load must not break inspection — detection still
        // works off the live sample, just without chain suggestions.
        log.warn(`[StudioAppConnectors/inspect] tool family lookup failed: ${err.message}`);
        return { action: null, siblings: [] };
    }
}

// ── POST /:id/data/connectors/:connectorId/inspect ──────────────────
// Run the connector ONCE and describe what came back, so the editor can propose
// a table, a row identity and an incremental strategy the owner just confirms.
// This is the single authority for detection: the picker, the table proposal and
// the sync engine all read this one answer, so they cannot drift.
router.post('/:id/data/connectors/:connectorId/inspect', requireAuth, connectorSyncLimiter, jsonBody, bodySizeGuard, validate({ body: ParamsBody }), async (req, res) => {
    try {
        const loaded = await loadOwnedConnector(req, res);
        if (!loaded) return;
        const { app, model, connector } = loaded;

        const rawParams = (req.body && typeof req.body.params === 'object' && !Array.isArray(req.body.params))
            ? req.body.params : {};
        const params = connectors.filterDeclaredParams(connector, rawParams);

        // `trace` reports the rows at each GRAIN. A chain that expands ends with
        // one row per attachment, so the message-level rows exist only there —
        // and that is exactly what lets us propose related tables instead of one
        // wide table that duplicates every message per attachment.
        const result = await connectors.runConnector(connector, {
            app: appRef(app), viewerId: app.userId, params, trace: true,
        });
        const rows = Array.isArray(result?.rows) ? result.rows : [];

        const { action, siblings } = connector.kind === 'integration_tool' && connector.tool
            ? describeToolFamily(connector.tool)
            : { action: null, siblings: [] };

        const existingKeys = (model?.tables || []).map((t) => t?.key).filter(Boolean);
        const shape = connectorSchema.inspectRows(rows, {
            name: connector.name || 'Connector data',
            inputSchema: action?.inputSchema || null,
            existingKeys,
        });

        // When the chain changed grain, propose one table PER grain, joined by a
        // relation column, rather than one wide table.
        const grains = Array.isArray(result?.grains) ? result.grains : null;
        const tableSet = (grains && grains.length > 1)
            ? connectorSchema.proposeTableSet(grains, {
                name: connector.name || 'Connector data',
                inputSchema: action?.inputSchema || null,
                existingKeys,
            })
            : null;

        // What the action still needs that nothing has supplied, and which
        // sibling action could supply it ("gmail read needs a messageId — gmail
        // search gives one as `id`").
        const chain = action
            ? connectorSchema.suggestChain(action, {
                fields: shape.fields,
                fixedArgs: connector.fixedArgs,
                viewerParams: connector.params,
            }, siblings)
            : { missing: [], suggestions: [] };

        return res.json({
            // A handful of rows is enough to render a preview; the full payload
            // is the owner's upstream data and does not need to be shipped.
            rows: rows.slice(0, 3),
            rowCount: rows.length,
            ...shape,
            // Present only when a chain step expanded — the editor then offers
            // the related set instead of the single suggestedTable above.
            ...(tableSet ? {
                tableSet: {
                    tables: tableSet.tables.map((t) => ({
                        table: t.table,
                        keyField: t.keyField,
                        identity: t.identity,
                        defaultMode: t.defaultMode,
                        level: t.level,
                        parentLevel: t.parentLevel,
                        relationField: t.relationField,
                        expandFrom: t.expandFrom,
                        tool: t.tool,
                        rowCount: t.rowCount,
                    })),
                },
            } : {}),
            missingParams: chain.missing,
            chainSuggestions: chain.suggestions,
            ...(result?.partial ? { partial: true } : {}),
        });
    } catch (err) {
        return sendConnectorError(res, err, 'inspect');
    }
});

// ── POST /:id/data/connectors/:connectorId/sync ─────────────────────
// "Refresh now". The same engine the schedule and the on-view kick use, so what
// the owner sees when they press the button is exactly what happens at 3am.
router.post('/:id/data/connectors/:connectorId/sync', requireAuth, connectorSyncLimiter, jsonBody, bodySizeGuard, async (req, res) => {
    try {
        const loaded = await loadOwnedConnector(req, res);
        if (!loaded) return;
        const { app, model, connector } = loaded;

        const result = await connectorSync.syncConnector(appRef(app), model, connector, { reason: 'manual' });
        if (result.alreadyRunning) {
            return res.status(202).json({ ...result, message: 'A refresh is already running — it will finish shortly.' });
        }
        return res.json(result);
    } catch (err) {
        return sendConnectorError(res, err, 'sync');
    }
});

// ── POST /:id/data/connectors/:connectorId/verify ───────────────────
// Can this connector actually reach the mailbox it names?
//
// A shared mailbox fails in a way nothing else surfaces: Graph answers 403 and
// the sync just writes zero rows, forever, looking healthy. Gmail is worse —
// sending from an unverified alias fails only at send time, long after the
// author thought they were done. So the author gets to ask now.
router.post('/:id/data/connectors/:connectorId/verify', requireAuth, connectorSyncLimiter, jsonBody, bodySizeGuard, async (req, res) => {
    try {
        const loaded = await loadOwnedConnector(req, res);
        if (!loaded) return;
        const { app, connector } = loaded;

        if (connector.kind !== 'mailbox') {
            return res.status(400).json({ error: 'Only a mailbox connector can be verified', code: 'not_verifiable' });
        }

        const { resolveMailboxIdentity } = require('../appStudio/mailboxIdentity');
        const emailFetch = require('../services/email/fetch');

        let identity;
        try {
            // Verification always runs as the OWNER: a runAs:'viewer' mailbox
            // has no viewer at configure time, and the owner is who has to fix
            // a misconfiguration anyway.
            identity = await resolveMailboxIdentity({ ...connector, runAs: 'owner' }, { app: appRef(app) });
        } catch (err) {
            return res.status(err.status || 409).json({
                ok: false,
                code: err.code || 'connection_required',
                provider: err.provider || connector.provider,
                error: err.message,
            });
        }

        if (connector.mode !== 'shared') {
            return res.json({
                ok: true,
                mode: 'personal',
                mailbox: identity.mailbox.address,
                sharedMode: identity.mailbox.sharedMode,
            });
        }

        const probe = await emailFetch.probeSharedAccess({
            provider: connector.provider,
            tokens: identity.tokens,
            onRefresh: identity.onRefresh,
            address: connector.address,
        });

        const HINTS = {
            shared_mailbox_denied: 'Your Microsoft administrator must give you Full Access to this mailbox, and the connection needs the Mail.Read.Shared permission — reconnect Microsoft in Settings → Integrations.',
            mailbox_not_found: 'No mailbox with that address exists in your organisation.',
            alias_not_found: 'This address is not a send-as alias on your Gmail account. Gmail cannot open another mailbox, so the address must be delivered to yours and verified as an alias.',
            alias_not_verified: 'This send-as alias is not verified yet — confirm it in Gmail settings first.',
            alias_unverifiable: 'We could not check the alias automatically; sending will tell you for certain.',
            probe_failed: 'We could not reach that mailbox. Check the address and try again.',
            no_address: 'A shared mailbox needs an address.',
        };

        return res.json({
            ok: probe.ok,
            mode: 'shared',
            mailbox: connector.address,
            sharedMode: identity.mailbox.sharedMode,
            reason: probe.reason || null,
            hint: probe.reason ? (HINTS[probe.reason] || null) : null,
        });
    } catch (err) {
        return sendConnectorError(res, err, 'verify');
    }
});

// ── The runtime pair (MEMBERS, not owners) ──────────────────────────
//
// WHY THESE EXIST NEXT TO THE OWNER-ONLY PAIR ABOVE: the people who USE an app
// are not its owner, and until now they could not see whether the mailbox
// feeding it was even connected. An empty inbox and a broken connection looked
// identical from inside the app, which is the worst kind of silence.
//
// What makes them safe where /sync-status is not:
//   • membership, not visibility — a published app is readable by an audience;
//     these answer only to someone the owner gave a ROLE (or the owner).
//   • a NARROWER projection: no watermark, no row counts, no error text (an
//     upstream error message can carry query fragments and internal hostnames),
//     just "is there a problem". The owner keeps the diagnostic view.
//   • refresh is the same connectorSync the schedule runs, as the same
//     identity (the owner), behind the same limiter, and only for a connector
//     that HAS a sync configured — it can write nothing the clock would not
//     have written by itself, a few minutes later.

async function loadMemberApp(req, res) {
    const app = await loadVisibleApp(req, res);
    if (!app) return null;
    if (app.userId === req.session.user.id) return app;
    const role = await studioAppDataStore.getMemberRole(app.id, req.session.user.id);
    if (!role) { res.status(404).json({ error: 'App not found' }); return null; }
    return app;
}

// A status card can sit on a screen with refreshInterval, so the probe is on
// the critical path of a repeating request. Anything slower than this is not
// worth waiting for: the card renders "unknown" and tries again next tick.
const PROBE_TIMEOUT_MS = 1500;

/**
 * Is the identity this connector runs as actually connected right now?
 *
 * Deliberately cheap: it asks whether the user has the integration available,
 * which is a session/permission question, and never opens the mailbox. Even so
 * it is raced against a timeout — resolving a session touches the database and
 * the integration catalog, and a card that can hang a request is worse than a
 * card that occasionally shrugs.
 */
async function probeConnected(app, connector, viewerId) {
    if (connector.kind !== 'mailbox') return null;
    const { INTEGRATION_BY_MAILBOX_PROVIDER, _viewerHasIntegration } = require('../appStudio/mailboxIdentity');
    const integrationId = INTEGRATION_BY_MAILBOX_PROVIDER[connector.provider];
    if (!integrationId) return null;
    // runAs 'owner' means the app reads as its owner whoever is looking, so the
    // question is about the OWNER's connection, not the viewer's.
    const userId = connector.runAs === 'viewer' ? viewerId : app.userId;

    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
    });
    try {
        const probe = _viewerHasIntegration(integrationId, {
            userId,
            orgId: app.organizationId || null,
            deps: {
                buildUserSession: (...a) => require('../appStudio/connectors')._defaultBuildUserSession(...a),
                getIntegrationTools: (...a) => require('../core/integrations/integrationTools').getIntegrationTools(...a),
                resolveIntegration: (...a) => require('../core/integrations/integrationToolMap').resolveIntegration(...a),
            },
        });
        return await Promise.race([probe, timeout]);
    } catch {
        return null; // unknown beats a confident wrong answer
    } finally {
        if (timer) clearTimeout(timer);
    }
}

router.get('/:id/runtime/connectors/status', requireAuth, async (req, res) => {
    try {
        const app = await loadMemberApp(req, res);
        if (!app) return;
        const model = await loadOwnerModel(app);
        const list = connectors.listConnectors(model) || [];
        const states = await studioAppDataStore.listSyncStates(app.id);
        const byId = new Map(states.map((s) => [s.connectorId, s]));

        const out = [];
        for (const c of list) {
            const full = connectors.findConnector(model, c.id);
            const state = byId.get(c.id) || null;
            out.push({
                id: c.id,
                name: c.name || null,
                kind: c.kind || null,
                provider: full?.provider || null,
                mode: full?.mode || null,
                // A shared mailbox names its address in the model; a personal one
                // is whatever account the token belongs to, which we do not open
                // a connection to discover.
                address: full?.mode === 'shared' ? (full.address || null) : null,
                runAs: full?.runAs || 'owner',
                connected: await probeConnected(app, full || {}, req.session.user.id),
                syncable: !!full?.sync,
                status: state?.status || 'idle',
                lastRunAt: state?.lastRunAt || null,
                nextRunAt: state?.nextRunAt || null,
                // Whether, not what.
                hasError: !!(state?.lastError),
            });
        }
        return res.json({ connectors: out });
    } catch (err) {
        log.error(`[StudioAppConnectors/runtime-status] ${err.message}`);
        return res.status(500).json({ error: 'Failed to read connection status' });
    }
});

router.post('/:id/runtime/connectors/:connectorId/refresh', requireAuth, connectorSyncLimiter, async (req, res) => {
    try {
        const app = await loadMemberApp(req, res);
        if (!app) return;
        const model = await loadOwnerModel(app);
        const connector = connectors.findConnector(model, req.params.connectorId);
        if (!connector) return res.status(404).json({ error: 'Connector not found' });
        if (!connector.sync) {
            return res.status(400).json({ error: 'This connection has no scheduled refresh', code: 'not_syncable' });
        }
        // Runs as the OWNER, exactly like the schedule — connectorSync pins
        // viewerId to app.userId by design. That is the point: a member's
        // "check now" must fetch the same mailbox the clock fetches. Reading it
        // as the CALLER would pour one member's personal mail into the app's
        // shared table, which is a leak wearing a refresh button.
        const result = await connectorSync.syncConnector(appRef(app), model, connector, { reason: 'manual' });
        if (result.alreadyRunning) {
            return res.status(202).json({ ok: true, alreadyRunning: true, message: 'A refresh is already running — it will finish shortly.' });
        }
        return res.json({ ok: !result.error, rowsWritten: result.rowsWritten || 0 });
    } catch (err) {
        return sendConnectorError(res, err, 'runtime-refresh');
    }
});

// ── GET /:id/data/connectors/sync-status ────────────────────────────
// Last run, next run, rows written and the last error per connector — what the
// editor shows next to "Refresh now" so a silently failing sync is visible.
router.get('/:id/data/connectors/sync-status', requireAuth, async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const states = await studioAppDataStore.listSyncStates(app.id);
        return res.json({ syncs: states });
    } catch (err) {
        log.error(`[StudioAppConnectors/sync-status] ${err.message}`);
        return res.status(500).json({ error: 'Failed to read sync status' });
    }
});

// Map body-parser failures to JSON (default handler answers HTML).
router.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
        return res.status(413).json({ error: 'Request body too large (max 64KB)' });
    }
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }
    next(err);
});

module.exports = router;
