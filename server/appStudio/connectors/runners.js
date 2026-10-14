/**
 * The kind runners behind runConnector (../connectors.js): integration_tool
 * (with its chain), automation, and rest (https-only, allow-listed template,
 * SSRF-screened, size- and time-capped).
 */

'use strict';

const {
    MAX_CONNECTOR_ROWS, REST_TIMEOUT_MS, MAX_REST_BYTES, MAX_CHAIN_STEPS, MAX_CHAIN_CALLS, connectorError, isPlainObject, sanitizeViewerParams, declaredParamKeys, toRows, getByPath, integrationIdsFor,
} = require('./shared');
const { providerFor, resolveViewerExecution, dispatchTool } = require('./dispatch');
const { applyChainStep } = require('./chain');

async function runIntegrationTool(connector, { app, viewerId, params, systemArgs, trace, deps }) {
    const tool = typeof connector.tool === 'string' ? connector.tool : '';
    if (!tool) throw connectorError(400, 'connector has no tool', 'bad_connector');

    const viewerParams = sanitizeViewerParams(params, declaredParamKeys(connector));
    const fixedArgs = isPlainObject(connector.fixedArgs) ? connector.fixedArgs : {};
    // systemArgs are SERVER-ORIGIN arguments (today: the incremental sync's
    // since-param). They are never reachable from an HTTP body — runConnector's
    // only callers that set them are internal — so they sit above viewer input
    // but still BELOW the author's pins, which keep the last word.
    const system = isPlainObject(systemArgs) ? sanitizeViewerParams(systemArgs) : {};
    // Author-pinned fixedArgs ALWAYS win — spread last (same as the webpage
    // integration bridge). The owner keeps control of sensitive fields.
    const mergedArgs = { ...viewerParams, ...system, ...fixedArgs };

    // runAs:'viewer' → the CALLING user's connection (or a lend grant);
    // otherwise the default acts-as-owner path. Resolved ONCE and reused for
    // every chain call: re-negotiating per row would re-check grants hundreds of
    // times and could even change identity mid-run.
    const asViewer = connector.runAs === 'viewer';
    // The integrations this run will actually dispatch — the base tool plus every
    // chain step. Handing these to the session builder is what guarantees their
    // provider tokens get loaded regardless of how the org's integration lists
    // happen to be configured.
    const integrationIds = integrationIdsFor(connector);
    const resolved = asViewer
        ? await resolveViewerExecution(connector, { app, viewerId, deps })
        : {
            userId: app.userId,
            session: await deps.buildOwnerSession(app, {
                include: integrationIds,
                providerHint: providerFor(integrationIds[0], deps),
            }),
        };
    const exec = {
        ...resolved,
        orgId: (asViewer
            ? resolved.session?.user?.organizationId || app.organizationId
            : app.organizationId || resolved.session?.user?.organizationId) || null,
    };

    // Base step — a failure here is the connector failing, so it throws.
    // An explicit rowsPath wins over the envelope heuristic: it is the escape
    // hatch for a payload with more than one candidate list.
    const raw = await dispatchTool(tool, mergedArgs, exec, deps, app, connector);
    let rows = toRows(connector.rowsPath ? getByPath(raw, connector.rowsPath) : raw);

    const chain = Array.isArray(connector.chain) ? connector.chain.slice(0, MAX_CHAIN_STEPS) : [];
    if (!chain.length) return { rows, ...(trace ? { grains: [{ level: 0, tool, rows }] } : {}) };

    // ── GRAINS ──────────────────────────────────────────────────────
    // A step that EXPANDS changes what one row means: after "one row per
    // attachment", the message-level rows no longer exist in the output. A
    // caller that wants to store this as related tables (a messages table and an
    // attachments table joined to it) therefore needs the rows at each grain,
    // not just the final flattened set. A merging step widens the CURRENT grain;
    // an expanding step — or one the author asked to keep in its own table —
    // opens a new one.
    const grains = trace ? [{ level: 0, tool, rows }] : null;
    // rows[i] → its index in grains[last].rows. Null means identity, which is
    // exactly true at grain 0 (they are the same array).
    let rowGrainIndex = null;

    const budget = { remaining: MAX_CHAIN_CALLS };
    for (const step of chain) {
        if (!isPlainObject(step)) continue;
        if (!rows.length) break;
        const stepResult = await applyChainStep(step, rows, budget, exec, deps, app, connector, {
            trace,
            grainRows: grains ? grains[grains.length - 1].rows : null,
            rowGrainIndex,
        });
        rows = trace ? stepResult.rows : stepResult;
        if (!grains) continue;

        // The step's own fields about the SOURCE always widen the current grain
        // (gmail_read's body belongs on the message, not on each attachment) —
        // unless the step keeps its result in a table of its own, in which case
        // parentRows comes back untouched.
        grains[grains.length - 1].rows = stepResult.parentRows || rows;
        rowGrainIndex = stepResult.grainIndexOf || null;
        if ((step.expand || step.ownTable === true) && stepResult.childRows) {
            grains.push({
                level: grains.length,
                tool: step.tool,
                expandFrom: step.expand || null,
                parentLevel: grains.length - 1,
                rows: stepResult.childRows,
            });
        }
    }
    // Say it out loud when the budget cut the enrichment short — a silently
    // half-enriched table is the kind of thing nobody notices until it matters.
    const partial = rows.some((r) => isPlainObject(r) && r._partial);
    return { rows, ...(partial ? { partial: true } : {}), ...(grains ? { grains } : {}) };
}

async function runAutomationConnector(connector, { app, viewerId, params, deps }) {
    const automationId = typeof connector.automationId === 'string' ? connector.automationId : '';
    if (!automationId) throw connectorError(400, 'connector has no automationId', 'bad_connector');

    const automation = await deps.getAutomation(automationId);
    if (!automation) throw connectorError(404, 'Automation not found', 'not_found');
    // Owner-ownership check — an automation transferred away after wiring must not
    // run acts-as-owner as someone else's (mirrors studioAppsRun.js).
    if (automation.userId !== app.userId) {
        throw connectorError(403, 'Automation does not belong to the app owner', 'forbidden');
    }

    const run = await deps.executeAutomation(automation, {
        triggerKind: 'studio_app',
        triggerPayload: {
            params: sanitizeViewerParams(params),
            _viewerUserId: viewerId || null,
            _studioAppId: app.id,
        },
        mode: 'live',
    });
    if (run && run.status && run.status !== 'success') {
        return { rows: [] };
    }
    // The persisted run row carries no `output` column, so read the automation's
    // final value through the SAME derivation the action bridge uses
    // (actionExecutor.deriveFinalOutput → last executed top-level step).
    return { rows: toRows(await deps.deriveFinalOutput(run)) };
}

/**
 * Read an upstream body with MAX_REST_BYTES enforced WHILE streaming: a hostile
 * upstream must never be buffered whole first. Exceeding the cap aborts the
 * in-flight request (`ac`) so the socket is torn down instead of drained.
 * Responses without a web stream (stubs, older shims) fall back to a buffered
 * read that is still byte-capped.
 */
async function readCappedBody(resp, ac) {
    const body = resp.body;
    if (!body || typeof body.getReader !== 'function') {
        const text = await resp.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_REST_BYTES) {
            throw connectorError(502, 'connector response too large', 'connector_failed');
        }
        return text;
    }
    const reader = body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            bytes += chunk.length;
            if (bytes > MAX_REST_BYTES) {
                ac.abort();
                throw connectorError(502, 'connector response too large', 'connector_failed');
            }
            chunks.push(chunk);
        }
    } finally {
        try { await reader.cancel(); } catch { /* already closed/aborted */ }
    }
    return Buffer.concat(chunks).toString('utf8');
}

// Static host of a URL template, with placeholders neutralised so a template
// query param can't be misread as part of the authority.
function templateHost(template) {
    try {
        const probe = String(template).replace(/\{[a-zA-Z0-9_]+\}/g, '0');
        return new URL(probe).host.toLowerCase();
    } catch { return null; }
}

async function runRestConnector(connector, { app, params, deps }) {
    const template = typeof connector.url === 'string' ? connector.url : '';
    if (!template) throw connectorError(400, 'connector has no url template', 'bad_connector');

    // The host must be fixed by the owner — a viewer must never be able to steer
    // it. Reject a template that tries to template its own authority.
    const host = templateHost(template);
    if (!host) throw connectorError(400, 'connector url template is invalid', 'bad_connector');
    const authorityPart = template.split(/[/?#]/).slice(0, 3).join('/'); // scheme://host[:port]
    if (/\{[a-zA-Z0-9_]+\}/.test(authorityPart)) {
        throw connectorError(400, 'connector url may not template the host', 'bad_connector');
    }

    // Fill declared placeholders with URL-encoded viewer params only.
    const placeholders = [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
    const safe = sanitizeViewerParams(params, placeholders);
    const urlStr = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
        const v = safe[key];
        return (v === undefined || v === null) ? '' : encodeURIComponent(String(v));
    });

    let parsed;
    try { parsed = new URL(urlStr); } catch { throw connectorError(400, 'connector produced an invalid URL', 'bad_connector'); }
    if (parsed.protocol !== 'https:') throw connectorError(400, 'connector URL must be https', 'insecure_url');
    // Encoding above prevents authority injection; this equality check is
    // belt-and-braces against it.
    if (parsed.host.toLowerCase() !== host) throw connectorError(403, 'connector URL host is not allow-listed', 'forbidden_host');
    // SSRF: refuse private/internal/metadata targets (sync, DNS-less pre-filter).
    if (deps.isPrivateTarget(parsed.toString())) {
        throw connectorError(403, 'connector target refused (private/internal address)', 'forbidden_host');
    }

    // Owner static headers + owner credential (from the credential store).
    const headers = { Accept: 'application/json' };
    if (isPlainObject(connector.headers)) {
        for (const [k, v] of Object.entries(connector.headers)) {
            if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) headers[k] = String(v);
        }
    }
    if (isPlainObject(connector.auth) && connector.auth.credentialProvider) {
        const cred = await deps.getProviderAuth(app.userId, connector.auth.credentialProvider).catch(() => null);
        const token = cred?.accessToken || null;
        if (token) {
            if (connector.auth.type === 'header' && typeof connector.auth.header === 'string') headers[connector.auth.header] = token;
            else headers.Authorization = `Bearer ${token}`;
        }
    }

    // safeFetch re-screens every socket connect (DNS-rebind + redirect hops).
    // The timer spans the BODY READ too — a slow drip must not outlive the
    // timeout just because the headers arrived in time.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REST_TIMEOUT_MS);
    let text;
    try {
        const resp = await deps.safeFetch(parsed.toString(), { method: 'GET', headers, redirect: 'follow', signal: ac.signal });
        if (!resp || !resp.ok) {
            throw connectorError(502, `connector fetch failed (${resp ? resp.status : 'no response'})`, 'connector_failed');
        }
        text = await readCappedBody(resp, ac);
    } catch (err) {
        if (Number.isInteger(err?.status)) throw err;
        throw connectorError(502, `connector fetch failed (${err?.name === 'AbortError' ? 'timeout' : 'unreachable'})`, 'connector_failed');
    } finally {
        clearTimeout(timer);
    }

    let json;
    try { json = JSON.parse(text); } catch { throw connectorError(502, 'connector response was not JSON', 'connector_failed'); }

    const cap = Math.min(
        Number.isFinite(connector.maxRows) && connector.maxRows > 0 ? connector.maxRows : MAX_CONNECTOR_ROWS,
        MAX_CONNECTOR_ROWS,
    );
    const rows = toRows(getByPath(json, connector.rowsPath), cap);
    const nextPage = connector.nextPagePath ? getByPath(json, connector.nextPagePath) : null;
    return { rows, ...(nextPage != null && nextPage !== '' ? { nextPage } : {}) };
}

module.exports = { runIntegrationTool, runAutomationConnector, runRestConnector };
