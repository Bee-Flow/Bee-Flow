/**
 * Security Scan Routes — scan run lifecycle + SSE + cancel + artifacts, plus
 * the scanner-image provisioning surface (Track C).
 *
 * Ported from server/routes/securityScans.js into `mountSecurityRoutes(router, deps)`
 * where `router` is a bare express.Router() and `deps = { store, scanRunnerSvc,
 * worker, host }`. The module dispatcher mounts this under /api/mod/security_scan
 * and STRIPS that prefix, so every path is RELATIVE (/scans, /toolbox, …).
 *
 * Import swaps vs the built-in:
 *   • checkSubscriptionLimits                        → host.limits.checkSubscription
 *   • workers/scanRunner.isPrivateTarget             → host.net.isPrivateTarget
 *   • require('../stores/storageStore').getPresignedUrl → host.storage.getPresignedUrl
 *   • the POST /scans fast-path drainOne             → the in-module worker.drainOne
 *   • core/securityAggression                        → ./aggression (local copy)
 *   • services/scanRunner                            → scanRunnerSvc (injected)
 *
 * The dispatcher already applies requireCapability('security_scan') in front of
 * this router; the /toolbox/* routes ADD an in-router super-admin check.
 */

const path = require('path');
const aggression = require('./aggression');
const { errMessage } = require('./errors');

// The Kali toolbox Dockerfile ships at <versionDir>/assets/terminal-runner. After
// esbuild bundles this into <versionDir>/server/entry.cjs, __dirname is
// <versionDir>/server, so ../assets/terminal-runner resolves to the packaged asset.
/**
 * @typedef {{ engine: string, intensity?: string }} EngineDescriptor
 * @typedef {import('../../../../types/host').HostSession} HostSession
 *
 * The JSON body of POST /scans: whatever the client sent, every field checked before use.
 * @typedef {object} ScanRequestBody
 * @property {string} [targetUrl]
 * @property {boolean} [authorized]
 * @property {Record<string, unknown> | null} [metadata]
 * @property {unknown} [engines]
 * @property {string} [modelTier]
 * @property {string} [aggression]
 * @property {string} [prewarmId]
 */

/**
 * The user requireAuth let through. Every route below is mounted after it, so a missing user is a
 * wiring mistake, not a request to answer.
 * @param {import('express').Request} req
 * @returns {NonNullable<HostSession['user']>}
 */
function userOf(req) {
    const user = req.session?.user;
    if (!user) throw new Error('security_scan routes: request reached an authenticated route without a user');
    return user;
}

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'terminal-runner');

const VALID_ENGINES = ['zap', 'nuclei', 'testssl'];
const ZAP_INTENSITIES = ['baseline', 'full'];
const MODEL_TIER_RE = /^[a-zA-Z0-9_:-]{1,64}$/;

/**
 * @typedef {ReturnType<typeof import('./store').makeSecurityScanStore>} ScanStore
 * @typedef {typeof import('./scanRunner.service')} ScanRunnerService
 * @typedef {ReturnType<typeof import('./worker').makeWorker>} ScanWorker
 * @typedef {import('../../../../types/host').Host} Host
 *
 * @param {import('express').Router} router
 * @param {{ store?: ScanStore, scanRunnerSvc?: ScanRunnerService, worker?: ScanWorker, host?: Host }} [deps]
 *        store - the security scan store instance; scanRunnerSvc - the scanRunner.service (docker lifecycle + provisioning);
 *        worker - the worker instance (drainOne fast-path); host - the module host API
 */
function mountSecurityRoutes(router, { store, scanRunnerSvc, worker, host } = {}) {
    if (!router || !store || !scanRunnerSvc || !worker || !host) {
        throw new Error('mountSecurityRoutes: router, store, scanRunnerSvc, worker and host are required');
    }
    const securityScanStore = store;
    const express = host.express;

    // Parse JSON bodies. express.json() is a no-op if the body was already parsed
    // upstream (it guards on req._body), so this is safe under the dispatcher.
    router.use(express.json());

    /** @type {import('express').RequestHandler} */
    function requireAuth(req, res, next) {
        if (req.session?.user) return next();
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Super-admin gate for the toolbox provisioning routes. Mirrors the product's
    // auth/adminRoutes check (req.session.isAdmin || user.role === 'admin').
    /** @type {import('express').RequestHandler} */
    function requireSuperAdmin(req, res, next) {
        const isSuper = req.session?.isAdmin || req.session?.user?.role === 'admin';
        if (!isSuper) return res.status(403).json({ error: 'super_admin_required' });
        return next();
    }

    router.use(requireAuth);

    // ── Toolbox image provisioning (Track C) ───────────────────────────
    // GET  /toolbox/status     — what the operator can do with the scanner image
    // POST /toolbox/provision  — SSE-stream a build or pull of the image
    router.get('/toolbox/status', requireSuperAdmin, async (req, res) => {
        try {
            const status = await scanRunnerSvc.toolboxStatus({ assetsDir: ASSETS_DIR });
            res.json(status);
        } catch (err) {
            console.error('[Security] toolbox status failed:', err);
            res.status(500).json({ error: 'toolbox_status_failed', message: errMessage(err) });
        }
    });

    router.post('/toolbox/provision', requireSuperAdmin, async (req, res) => {
        const mode = req.body?.mode === 'pull' ? 'pull' : (req.body?.mode === 'build' ? 'build' : null);
        if (!mode) return res.status(400).json({ error: 'mode must be "build" or "pull"' });

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        /**
         * @param {string} event
         * @param {unknown} data
         */
        const send = (event, data) => {
            try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
        };

        // Keep-alive pings so proxies don't reap a long build.
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
        ping.unref?.();

        try {
            const { imageOk } = await scanRunnerSvc.provisionToolbox({
                mode,
                assetsDir: ASSETS_DIR,
                /** @param {{ stream?: unknown, status?: unknown } | null} evt */
                onEvent: (evt) => {
                    // Build events carry { stream }; pull events carry { status, progress }.
                    const raw = evt && (evt.stream != null ? evt.stream : (evt.status != null ? evt.status : ''));
                    const line = String(raw || '').replace(/\r?\n$/, '');
                    if (line) send('progress', { phase: mode, line, pct: null });
                },
            });
            send('done', { done: true, imageOk });
        } catch (err) {
            console.error('[Security] toolbox provision failed:', err);
            send('error', { error: errMessage(err) || 'provision_failed' });
        } finally {
            clearInterval(ping);
            try { res.end(); } catch (_) {}
        }
    });

    // ── Policy ─────────────────────────────────────────────────────────
    router.get('/scans/policy', (req, res) => {
        res.json({
            aggression: {
                levels: aggression.LEVELS,
                default: aggression.DEFAULT_AGGRESSION,
                ceiling: aggression.ceiling(),
            },
            netRaw: process.env.SECURITY_TOOLBOX_NET_RAW !== 'false',
        });
    });

    // ── Pre-warm ───────────────────────────────────────────────────────
    router.post('/scans/prewarm', async (req, res) => {
        try {
            if (!(await scanRunnerSvc.dockerAvailable())) return res.json({ prewarmId: null });
            const prewarmId = scanRunnerSvc.prewarmToolbox({ userId: userOf(req).id });
            res.json({ prewarmId });
        } catch (err) {
            console.warn('[Security] prewarm failed:', errMessage(err));
            res.json({ prewarmId: null });
        }
    });

    router.post('/scans/prewarm/:id/release', async (req, res) => {
        try { await scanRunnerSvc.releasePrewarm(req.params.id); } catch (_) { /* idempotent */ }
        res.json({ ok: true });
    });

    // ── Scans ──────────────────────────────────────────────────────────

    router.post('/scans', async (req, res) => {
        try {
            /** @type {ScanRequestBody} */
            const body = req.body || {};
            const { targetUrl, authorized = false, metadata = null } = body;
            // Every scan is AI-agent driven — the model drives the full toolbox
            // inside one container.
            const mode = 'agent';
            // Whatever the client sent; each element is checked below before it is used.
            let engines = /** @type {({ engine?: unknown, intensity?: string } | null)[]} */ (body.engines);
            if (!targetUrl || typeof targetUrl !== 'string') {
                return res.status(400).json({ error: 'targetUrl is required' });
            }
            // Default to ZAP so the report header has something concrete.
            if (!Array.isArray(engines) || engines.length === 0) {
                engines = [{ engine: 'zap' }];
            }
            if (host.net.isPrivateTarget(targetUrl)) {
                return res.status(400).json({
                    error: 'unsafe_target',
                    message: 'Target URL points to a private/internal address.',
                });
            }
            // Hard consent gate — we never scan a target the requester didn't
            // explicitly attest they own / are authorized to test.
            if (authorized !== true) {
                return res.status(403).json({
                    error: 'authorization_required',
                    message: 'You must confirm you are authorized to scan this target.',
                });
            }

            // Validate the engine descriptors (report header only).
            /** @type {EngineDescriptor[]} */
            const normalizedEngines = [];
            for (const e of engines) {
                if (!e || typeof e !== 'object' || typeof e.engine !== 'string') {
                    return res.status(400).json({ error: 'each engine must be an object with an engine field' });
                }
                if (!VALID_ENGINES.includes(e.engine)) {
                    return res.status(400).json({ error: `invalid engine: ${e.engine}` });
                }
                /** @type {EngineDescriptor} */
                const descriptor = { engine: e.engine };
                if (e.engine === 'zap' && e.intensity && ZAP_INTENSITIES.includes(e.intensity)) {
                    descriptor.intensity = e.intensity;
                }
                normalizedEngines.push(descriptor);
            }

            // Model tier (which tier drives the agent). Opaque key resolved
            // server-side at run time; validate shape only.
            let modelTier = typeof body.modelTier === 'string' ? body.modelTier.trim() : null;
            if (modelTier && !MODEL_TIER_RE.test(modelTier)) {
                return res.status(400).json({ error: 'invalid_model_tier' });
            }

            // Aggression level — validated and CLAMPED to the server ceiling.
            const chosenAggression = aggression.isValid(body.aggression) ? body.aggression : aggression.DEFAULT_AGGRESSION;
            const effectiveAggression = aggression.clamp(chosenAggression);

            // Pre-warmed toolbox handle (the dialog warmed one on open). Round-
            // tripped via metadata so the worker receives it.
            let prewarmId = typeof body.prewarmId === 'string' ? body.prewarmId.trim() : null;
            if (prewarmId && !/^[a-f0-9]{8,64}$/i.test(prewarmId)) prewarmId = null;
            const mergedMetadata = prewarmId
                ? { ...(metadata && typeof metadata === 'object' ? metadata : {}), prewarmId }
                : metadata;

            // Subscription / plan gate (billed under the 'security' agent type).
            const orgId = userOf(req).organizationId || null;
            const limitError = await host.limits.checkSubscription(orgId, 'security', userOf(req).id);
            if (limitError) {
                return res.status(403).json({ error: 'limit_reached', message: limitError });
            }

            const scanId = await securityScanStore.createScan({
                userId: userOf(req).id,
                organizationId: orgId,
                targetUrl,
                engines: normalizedEngines,
                authorized: true,
                metadata: mergedMetadata,
                mode,
                modelTier,
                aggression: effectiveAggression,
            });

            // Fast-path: kick the worker once for this row so users don't wait
            // for the periodic tick. Errors are absorbed — the tick picks it up.
            if (process.env.SECURITY_DRAIN_IN_API !== 'false') {
                worker.drainOne(scanId).catch(err => console.warn('[Security] drainOne failed:', errMessage(err)));
            }

            // Tell the UI whether this scan will start now or wait for a free slot.
            let queued = false;
            try {
                const caps = {
                    perUser: parseInt(process.env.SECURITY_MAX_CONCURRENT_PER_USER || '1', 10),
                    org: parseInt(process.env.SECURITY_MAX_CONCURRENT_PER_ORG || '2', 10),
                    global: parseInt(process.env.SECURITY_MAX_CONCURRENT_GLOBAL || '3', 10),
                };
                const active = await securityScanStore.countActiveByScope({ userId: userOf(req).id, organizationId: orgId });
                queued = active.user >= caps.perUser || active.org >= caps.org || active.global >= caps.global;
            } catch (_) { /* best-effort hint */ }

            res.json({ scanId, queued });
        } catch (err) {
            console.error('[Security] create scan failed:', err);
            res.status(500).json({ error: 'Failed to start security scan' });
        }
    });

    router.get('/scans/active', async (req, res) => {
        try {
            const scans = await securityScanStore.listActiveScansForUser(userOf(req).id);
            // `scan` (most-recent single) retained for backward compatibility.
            res.json({ scans, scan: scans[0] || null });
        } catch (err) {
            console.error('[Security] get active scans failed:', err);
            res.status(500).json({ error: 'Failed to fetch active scans' });
        }
    });

    router.post('/scans/:id/cancel', async (req, res) => {
        try {
            const result = await securityScanStore.markCancelled(req.params.id, userOf(req).id);
            if (!result.ok) {
                const code = result.error === 'not_found' ? 404
                    : result.error === 'forbidden' ? 403
                    : result.error === 'already_terminal' ? 409 : 500;
                return res.status(code).json(result);
            }
            res.json({ ok: true });
        } catch (err) {
            console.error('[Security] cancel failed:', err);
            res.status(500).json({ error: 'Failed to cancel scan' });
        }
    });

    router.get('/scans/:id', async (req, res) => {
        try {
            const s = await securityScanStore.getScan(req.params.id, userOf(req).id);
            if (!s) return res.status(404).json({ error: 'Scan not found' });
            res.json({ scan: s });
        } catch (err) {
            console.error('[Security] get scan failed:', err);
            res.status(500).json({ error: 'Failed to fetch scan' });
        }
    });

    router.get('/scans/:id/report', async (req, res) => {
        try {
            const s = await securityScanStore.getScan(req.params.id, userOf(req).id);
            if (!s) return res.status(404).json({ error: 'Scan not found' });
            res.json({
                report: s.reportJson || null,
                status: s.status,
                reportWebpageId: s.reportWebpageId || null,
                severitySummary: s.severitySummary || null,
            });
        } catch (err) {
            console.error('[Security] get report failed:', err);
            res.status(500).json({ error: 'Failed to fetch report' });
        }
    });

    router.get('/scans/:id/events', async (req, res) => {
        const scanId = req.params.id;
        const s = await securityScanStore.getScan(scanId, userOf(req).id);
        if (!s) return res.status(404).json({ error: 'Scan not found' });

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        /**
         * @param {string} event
         * @param {unknown} data
         */
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        // Initial snapshot so a late subscriber sees the current state.
        send('snapshot', { status: s.status, stdoutTail: s.stdoutTail, reportJson: s.reportJson });
        if (s.status && ['completed', 'error', 'cancelled'].includes(s.status)) {
            send('done', { status: s.status, reportJson: s.reportJson, error: s.error });
            return res.end();
        }

        const unsubscribe = securityScanStore.subscribe(scanId, ({ type, data }) => {
            try { send(type, data || {}); }
            catch (_) { /* socket gone — cleanup runs on close */ }
            if (type === 'done' || type === 'close') {
                try { res.end(); } catch (_) {}
            }
        });

        // Keep-alive pings so proxies don't reap the connection.
        const ping = setInterval(() => {
            try { res.write(': ping\n\n'); } catch (_) { /* swallow */ }
        }, 25000);
        ping.unref?.();

        req.on('close', () => {
            clearInterval(ping);
            try { unsubscribe(); } catch (_) {}
        });
    });

    router.get('/scans/:id/artifacts', async (req, res) => {
        try {
            const s = await securityScanStore.getScan(req.params.id, userOf(req).id);
            if (!s) return res.status(404).json({ error: 'Scan not found' });
            const artifacts = await securityScanStore.listArtifacts(s.id);
            res.json({ artifacts });
        } catch (err) {
            console.error('[Security] artifacts failed:', err);
            res.status(500).json({ error: 'Failed to list artifacts' });
        }
    });

    router.get('/scans/:id/artifacts/:artifactId', async (req, res) => {
        try {
            const s = await securityScanStore.getScan(req.params.id, userOf(req).id);
            if (!s) return res.status(404).json({ error: 'Scan not found' });
            const artifact = await securityScanStore.getArtifact(s.id, req.params.artifactId);
            if (!artifact || artifact.scanId !== s.id) return res.status(404).json({ error: 'Artifact not found' });
            if (!artifact.storageKey) return res.status(404).json({ error: 'Artifact has no storage key' });
            // The scan owner gets a presigned URL via the host storage seam.
            const url = await host.storage.getPresignedUrl(artifact.storageKey);
            res.json({ url, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes });
        } catch (err) {
            console.error('[Security] artifact url failed:', err);
            res.status(500).json({ error: 'Failed to resolve artifact' });
        }
    });

    return router;
}

module.exports = { mountSecurityRoutes };
