/**
 * What the server does once the HTTP listener is up, in two halves that index.js
 * calls in order from its listen callback:
 *
 *   runStartupChecks()  — the store schemas (boot/storeSchemas.js), then the
 *                         refuse-to-boot / NODE_ENV posture checks, the INIT_*
 *                         first-boot wizard and the durable HMAC secrets.
 *   runStartupTasks()   — the background work: sanity probes, warmups, one-shot
 *                         backfills and migrations, schedulers, runners and jobs.
 *
 * The webpage full-tier proxy mount sits BETWEEN the two and stays in index.js:
 * it needs the http.Server and the terminal error handler, both of which live
 * there.
 */

const { isModuleAvailable } = require('../modules/catalog');
const fs = require('fs');
const log = require('../telemetry/log');

function runStartupChecks() {
    // First, because everything below this line reads or writes a store, and a
    // fresh install should have its tables before the first request rather
    // than during it. Not awaited and not a precondition — see
    // boot/storeSchemas.js: a store nobody started here creates its schema on
    // its first query.
    require('./storeSchemas').startStoreSchemas();

    if (process.env.INSECURE_CONNECTOR_TRUST === '1') {
        log.error('[SECURITY] INSECURE_CONNECTOR_TRUST=1 was set in the environment but the insecure connector bypass has been retired (Phase 2). Remove the variable. Refusing to boot.');
        process.exit(1);
    }

    // NODE_ENV sanity. Every branch in this file that keys off 'production'
    // silently takes its permissive path otherwise: session cookies are issued
    // without the Secure attribute, the built SPA and its cache headers are
    // never served, and dependencies switch to their debug behaviour — which is
    // exactly how a Node stack trace reached an anonymous caller before the
    // terminal handler above existed.
    //
    // Two different situations, deliberately not treated the same. In-cluster,
    // the ConfigMap pins NODE_ENV=production, so ANY other value is a real
    // misconfiguration of a real deployment. Outside a cluster only an EMPTY
    // value is suspicious: docker-compose.hub.local.yml sets `development` on
    // purpose (the module hub speaks plain http) and a developer running
    // `node index.js` is legitimate. Warned, never fatal — refusing to boot over
    // an env var would be the bigger outage.
    const nodeEnv = process.env.NODE_ENV || '';
    if (nodeEnv !== 'production') {
        const inCluster = !!process.env.KUBERNETES_SERVICE_HOST;
        const consequences = 'session cookies lose the Secure flag, the built frontend is not served, and dependencies take their debug paths';
        if (inCluster) {
            log.error(`[SECURITY] NODE_ENV="${nodeEnv}" in a Kubernetes deployment, expected "production": ${consequences}. Fix NODE_ENV in the beeflow-config ConfigMap.`);
        } else if (!nodeEnv) {
            const line = `NODE_ENV is not set, so this process is NOT in production mode: ${consequences}. Set NODE_ENV=production for any deployment.`;
            if (fs.existsSync('/.dockerenv')) log.error(`[SECURITY] ${line}`);
            else log.warn(`[Server] ${line}`);
        }
    }

    // Run first-boot setup from INIT_* env vars (set by install wizard)
    const { runBootInit } = require('../boot-init');
    runBootInit().catch(err => log.error('[boot-init] Fatal:', err));

    // Learning-certificate HMAC secret: bootstrap a configStore-persisted secret
    // for installs that never set LEARNING_CERT_SECRET, so certificate serials
    // and public verify links survive restarts instead of silently breaking.
    const { ensureDurableSecret } = require('../auth/certificateToken');
    ensureDurableSecret().catch(err => log.error('[CertificateToken] bootstrap failed:', err.message));

    // Webpage preview-token HMAC secret: same pattern — without this, each
    // replica of a multi-pod deploy would mint preview tokens with its own
    // random secret, so a token issued by one pod gets 401'd by another.
    const { ensureDurableSecret: ensureWebpagePreviewSecret } = require('../auth/webpagePreviewToken');
    ensureWebpagePreviewSecret().catch(err => log.error('[WebpagePreviewToken] bootstrap failed:', err.message));

    // Public-share HMAC secret: the same pattern once more, and the one with the
    // widest blast radius — it signs magic links, unlock cookies, view/bridge
    // tokens, the CSRF on public forms and the anonymous Studio-app visitor
    // identity. Without it a form page rendered by one replica answered "This
    // form expired" when the submit round-robined to another (BFSF-420).
    const { ensureDurableSecret: ensurePublicShareSecret } = require('../auth/publicShareToken');
    ensurePublicShareSecret().catch(err => log.error('[PublicShareToken] bootstrap failed:', err.message));
}

function runStartupTasks() {
    // Connector bootstrap sanity probe — verifies the tables the
    // /auth/connector/bootstrap endpoint relies on actually exist after the
    // store modules' implicit migrations. Runs after a short delay so the
    // store init has time to finish CREATE TABLE statements. If a critical
    // table is missing we log fatal and exit non-zero so Kubernetes treats
    // the rollout as failed and we see it in `kubectl rollout status`
    // instead of catching cryptic 500s at the first customer install.
    setTimeout(() => {
        const userStore = require('../stores/userStore');
        userStore.getOrganizationByNcInstanceId('__sanity_probe__')
            .then(() => log.info('[Server] Connector bootstrap tables: OK'))
            .catch(err => {
                log.error(`[Server] FATAL: Connector bootstrap sanity probe failed: ${err.message}`);
                log.error('[Server] The /auth/connector/bootstrap endpoint will return 500s. Exiting so Kubernetes restarts.');
                process.exit(1);
            });
    }, 8000).unref();

    // CPU cross-encoder + CPU embedder — pre-load the Transformers.js
    // pipelines so the first user KB search / web rerank doesn't pay the
    // ~280 MB cold-start cost. Both warmup()s are non-blocking and
    // fail-open; if the model load fails the pipelines stay disabled and
    // search falls back to RRF / cosine.
    try {
        const { warmup: warmRerank } = require('../core/rerank/cpuCrossEncoder');
        const { warmup: warmEmbed } = require('../core/embed/cpuEmbed');
        setImmediate(() => { warmRerank().catch(() => {}); });
        setImmediate(() => { warmEmbed().catch(() => {}); });
    } catch (e) {
        log.warn('[CpuPipelines] Warmup could not start:', e.message);
    }

    // PII Guard model migration hint — non-blocking. If the configStore still
    // records the older `urchade/gliner_multi_pii-v1` model, nudge the admin
    // to reinstall the guard via the dashboard to pick up the newer Dutch +
    // healthcare/finance fine-tune (E3-JSI/gliner-multi-pii-domains-v1).
    setImmediate(async () => {
        try {
            const configStore = require('../stores/configStore');
            const installedModel = await configStore.getConfig('pii_guard_model');
            if (installedModel === 'urchade/gliner_multi_pii-v1') {
                log.warn('[PiiGuard] Old model in config (urchade/gliner_multi_pii-v1). Reinstall the guard service from Admin → Guardrails for improved Dutch + medical recall (E3-JSI/gliner-multi-pii-domains-v1).');
            }
        } catch (_) { /* fail-quiet */ }
    });

    // PII Guard reachability — one loud line at boot, non-blocking.
    //
    // Detection has two failure paths and only one of them is noisy. A guard
    // that is CONFIGURED but unreachable degrades and then applies the org's
    // piiFailureMode (fail_closed by default), so somebody notices within a
    // request. A guard that was never CONFIGURED returns null from detectPii()
    // and every caller falls open — the privacy feature is simply absent, and
    // the only trace is a per-call log line in a stream nobody reads at 3am.
    // A silent privacy measure is worse than a broken one, so say it once,
    // clearly, at the moment an operator is actually looking at the console.
    setImmediate(async () => {
        try {
            const { getGuardEndpoint } = require('../core/privacy/piiDetection/guardEndpoint');
            const { url } = await getGuardEndpoint();
            if (url) return;
            log.warn(
                '[PiiGuard] NOT CONFIGURED — PII detection is OFF and every caller falls open. '
                + 'Nothing is scanned, redacted or blocked. Set PII_SERVICE_URL (compose: bring up '
                + '--profile guard, which selfhost.sh wires for you) or install the guard from '
                + 'Admin → Guardrails.',
            );
        } catch (e) {
            // Resolution itself failed — that is not "off", it is unknown, and
            // unknown must not read as fine.
            log.warn('[PiiGuard] Could not determine whether PII detection is configured:', e.message);
        }
    });

    // License refresh scheduler — periodic ping to license.beeflow.nl for
    // monthly licenses. Yearly/lifetime licenses are validated by JWT exp
    // and skip this loop. Disable with LICENSE_REFRESH_DISABLED=true.
    try { require('../license/refresh').start(); } catch (e) {
        log.warn('[License Refresh] Failed to start scheduler:', e.message);
    }

    // Downloadable modules — re-verify + re-activate every installed package
    // from disk (a tampered staging dir can never come back up), then start the
    // Hub entitlement-refresh scheduler so lapsed subscriptions deactivate, and
    // the runtime reconciler (60s) converging the process onto the ledger
    // (activate-missing, self-heal, retention GC).
    try {
        require('../modules/packageLoader').loadInstalledAtBoot()
            .catch(err => log.error('[Modules] boot activation error:', err.message));
        require('../modules/entitlementRefresh').start();
        require('../modules/packageLoader').startReconciler();
    } catch (e) {
        log.warn('[Modules] Failed to start module runtime:', e.message);
    }

    // Stripe configuration sanity check. If Stripe is enabled but the webhook
    // signing secret is missing, every incoming webhook will be rejected with
    // 400 — that's silent in production unless the admin actively watches
    // webhook delivery logs. Surface it loudly at boot.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        (async () => {
            try {
                const stripeService = require('../services/stripeService');
                const configStore = require('../stores/configStore');
                if (await stripeService.isEnabled()) {
                    const secret = await configStore.getSecret('stripe_webhook_secret');
                    if (!secret) {
                        log.error('[Stripe] WARNING: Stripe is enabled but stripe_webhook_secret is not configured — all incoming webhooks will be rejected with 400. Configure the signing secret in the Stripe admin UI.');
                    }
                }
            } catch (e) {
                log.warn('[Stripe] Startup config check failed:', e.message);
            }
        })();
    }

    // Trial-history backfill — idempotent one-shot that copies existing
    // organizations.trial_used_at / users.trial_used_at into the durable
    // trial_history table. After this runs once, the unique index makes
    // subsequent boots a no-op. Non-blocking so a slow query never holds
    // up boot.
    setImmediate(() => {
        require('../stores/userStore').backfillTrialHistory().catch(e =>
            log.warn('[Server] trial_history backfill error:', e.message));
    });

    // Subscription-plan tier audit. A paid plan whose `tier` column is unset or
    // unrecognised issues NO licence to the customers who buy it — they pay and
    // silently stay on Community. Cheap read, logged loudly, never fatal: a
    // billing-catalogue typo must not stop the server from booting.
    setImmediate(async () => {
        try {
            const plans = await require('../stores/userStore').getAllPlans();
            require('../license/tierResolution').reportPlanTierProblems(plans);
        } catch (e) {
            log.warn('[Server] plan tier audit skipped:', e.message);
        }
    });

    // NC org-name backfill — idempotent one-shot that renames connector-
    // provisioned orgs still on the generic "Nextcloud" default to
    // "Nextcloud (<host>)" so they're distinguishable in the admin list.
    // After a row is renamed it no longer matches, so re-runs are no-ops.
    setImmediate(() => {
        require('../stores/userStore').backfillAutoProvisionedNcOrgNames().catch(e =>
            log.warn('[Server] nc org-name backfill error:', e.message));
    });

    // Losse datamigraties — de lijst en de uitleg per entry staan in
    // bootMigrations.js, dat ook door `npm run db:migrate` wordt gedraaid
    // (daar met exit 1 bij falen; hier warn-en-doorgaan, boot is heilig).
    setImmediate(() => {
        require('./bootMigrations').runLooseMigrations().catch(e =>
            log.warn('[Server] losse-migratieladder faalde:', e.message));
    });


    // Warm the module-capability filter before the first entitlement resolve —
    // after a restart a still-valid session snapshot skips buildCeiling, so a
    // sync listCapabilities() reader would otherwise see the unfiltered
    // registry until some resolve warms the filter.
    setImmediate(() => {
        require('../modules').refreshModuleActivations().catch(e =>
            log.warn('[Server] module activation warm-up error:', e.message));
    });

    // ── Nederlandse vertaalcatalogi — lijst én volgorde-rationale staan in
    // bootMigrations.js (sequentieel: read-modify-write van dezelfde rij;
    // parallel wist de tweede schrijver de sleutels van de eerste).
    setImmediate(() => {
        require('./bootMigrations').runNlTranslations().catch(e =>
            log.warn('[Server] NL-catalogusladder faalde:', e.message));
    });


















    // Dunning + trial-expiry schedulers. The dunning tick scans for orgs
    // that have been past_due longer than STRIPE_DUNNING_GRACE_DAYS and
    // flips them to suspended. The trial tick suspends trials whose
    // trial_end_date is in the past and that don't have payment_status='paid'.
    // Both are idempotent and re-run safely.
    try {
        const userStore = require('../stores/userStore');
        const DUNNING_INTERVAL_MS = parseInt(process.env.STRIPE_DUNNING_TICK_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
        const DUNNING_GRACE_DAYS = parseInt(process.env.STRIPE_DUNNING_GRACE_DAYS || '7', 10);
        const TRIAL_TICK_INTERVAL_MS = parseInt(process.env.TRIAL_EXPIRY_TICK_INTERVAL_MS || String(30 * 60 * 1000), 10);
        const runDunningTick = async () => {
            try {
                const r = await userStore.suspendPastDueSubscriptions(DUNNING_GRACE_DAYS);
                if (r.orgs || r.consumers) {
                    log.info(`[Dunning] suspended orgs=${r.orgs} consumers=${r.consumers} grace_days=${DUNNING_GRACE_DAYS}`);
                }
            } catch (e) { log.error('[Dunning] tick error:', e.message); }
        };
        const runTrialExpiryTick = async () => {
            try {
                const r = await userStore.expireOverdueTrials();
                if (r.orgs || r.consumers) {
                    log.info(`[TrialExpiry] suspended orgs=${r.orgs} consumers=${r.consumers}`);
                }
                // Also sweep `incomplete` subscriptions older than 14 days so
                // a missed Stripe `incomplete_expired` webhook doesn't leave
                // them stuck. Stripe's own grace window is 14 days.
                const stale = await userStore.cancelStaleIncompleteSubscriptions(14);
                if (stale.orgs || stale.consumers) {
                    log.info(`[IncompleteCleanup] cancelled orgs=${stale.orgs} consumers=${stale.consumers}`);
                }
            } catch (e) { log.error('[TrialExpiry] tick error:', e.message); }
        };
        setTimeout(runDunningTick, 60_000).unref();
        setInterval(runDunningTick, DUNNING_INTERVAL_MS).unref();
        setTimeout(runTrialExpiryTick, 45_000).unref();
        setInterval(runTrialExpiryTick, TRIAL_TICK_INTERVAL_MS).unref();
        log.info(`[Server] Dunning+TrialExpiry schedulers started (dunning=${DUNNING_INTERVAL_MS}ms grace=${DUNNING_GRACE_DAYS}d, trial=${TRIAL_TICK_INTERVAL_MS}ms)`);
    } catch (e) {
        log.warn('[Server] Failed to start dunning/trial schedulers:', e.message);
    }

    // Plan-cap drift audit. When a plan's `allowed_*` is narrowed *after*
    // orgs have opted in, the runtime keeps serving the feature because
    // `applyCap` only runs at toggle time. This daily sweep emits an
    // audit row for every drifting (org, feature) pair so compliance has
    // a record. Read-only by default; flip PLAN_CAP_AUTO_TRIM=true to
    // also re-intersect and persist the trimmed list.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const PLAN_CAP_DRIFT_INTERVAL_MS = parseInt(process.env.PLAN_CAP_DRIFT_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
            const PLAN_CAP_AUTO_TRIM = process.env.PLAN_CAP_AUTO_TRIM === 'true';
            const runPlanCapDrift = async ({ isBoot = false } = {}) => {
                try {
                    const r = await require('../services/planEntitlements').auditPlanCapDrift({ trim: PLAN_CAP_AUTO_TRIM });
                    if (r.drifted > 0) {
                        log.info(`[PlanCapDrift] scanned=${r.scanned} drifted=${r.drifted} trimmed=${r.trimmed} auto_trim=${PLAN_CAP_AUTO_TRIM}${isBoot ? ' boot=1' : ''}`);
                        if (isBoot) {
                            // Surface a single audit marker so post-deploy drift
                            // is visible in compliance reports without grepping
                            // logs.
                            try {
                                const userStore = require('../stores/userStore');
                                await userStore.logAccessAudit(
                                    'plan_cap_drift_detected_at_boot',
                                    'system',
                                    'plan_cap_drift',
                                    'system',
                                    null,
                                    { scanned: r.scanned, drifted: r.drifted, trimmed: r.trimmed },
                                    null,
                                );
                            } catch (_) { /* audit best-effort */ }
                        }
                    }
                } catch (e) { log.error('[PlanCapDrift] tick error:', e.message); }
            };
            // Run once synchronously at boot so a deploy with a freshly
            // narrowed plan surfaces drift immediately rather than waiting
            // for the first scheduled tick. Awaited inside an IIFE so we
            // don't block module init.
            (async () => { try { await runPlanCapDrift({ isBoot: true }); } catch (_) {} })();
            setInterval(() => runPlanCapDrift({ isBoot: false }), PLAN_CAP_DRIFT_INTERVAL_MS).unref();
            log.info(`[Server] Plan-cap drift audit scheduled (interval=${PLAN_CAP_DRIFT_INTERVAL_MS}ms auto_trim=${PLAN_CAP_AUTO_TRIM})`);
        } catch (e) {
            log.warn('[Server] Failed to start plan-cap drift audit:', e.message);
        }
    }

    // Stripe per-seat quantity drift sync. The customer.subscription.updated
    // webhook normally echoes seat counts, but if an org adds/removes users
    // without a Stripe event firing (NC group sync, admin DELETE),
    // stripe_seat_quantity can drift below the local active-user count and
    // the next invoice underbills. The sweep walks every per-seat org and
    // pushes the current count to Stripe; idempotent (no-op when Stripe
    // already matches local).
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const SEAT_SYNC_INTERVAL_MS = parseInt(process.env.STRIPE_SEAT_SYNC_INTERVAL_MS || String(15 * 60 * 1000), 10);
            const runSeatSync = async () => {
                try {
                    const us = require('../stores/userStore');
                    const { syncSeatQuantityForOrg } = require('../services/stripeService');
                    const subs = await us.getAllOrgSubscriptions();
                    let synced = 0;
                    for (const sub of (subs || [])) {
                        if (!sub.organization_id || sub.status !== 'active') continue;
                        if (!sub.stripe_subscription_id) continue;
                        try {
                            await syncSeatQuantityForOrg(sub.organization_id);
                            synced++;
                        } catch (e) {
                            log.warn(`[SeatSync] org=${sub.organization_id} failed: ${e.message}`);
                        }
                    }
                    if (synced > 0) log.info(`[SeatSync] checked ${synced} active per-seat orgs`);
                } catch (e) { log.error('[SeatSync] tick error:', e.message); }
            };
            setTimeout(runSeatSync, 90_000).unref();
            setInterval(runSeatSync, SEAT_SYNC_INTERVAL_MS).unref();
            log.info(`[Server] Stripe seat-sync scheduler started (interval=${SEAT_SYNC_INTERVAL_MS}ms)`);
        } catch (e) {
            log.warn('[Server] Failed to start seat-sync scheduler:', e.message);
        }
    }

    // PAYG meter event drain — durable Stripe meter event delivery. The
    // hot path (usageStore.logUsage) enqueues into payg_meter_outbox; this
    // tick drains pending rows with backoff. Self-hosted installs have no
    // PAYG plan so the drain is a cheap empty scan there.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const PAYG_DRAIN_INTERVAL_MS = parseInt(process.env.PAYG_DRAIN_TICK_INTERVAL_MS || '30000', 10);
            const runPaygDrain = async () => {
                const t0 = Date.now();
                let ok = true;
                try {
                    const r = await require('../workers/paygDrain').drainOnce();
                    if (r.delivered || r.failed || r.hardFailed) {
                        log.info(`[PaygDrain] delivered=${r.delivered} failed=${r.failed} hard_failed=${r.hardFailed}`);
                    }
                } catch (e) { ok = false; log.error('[PaygDrain] tick error:', e.message); }
                finally { try { require('../telemetry/metrics').recordJobRun({ job: 'payg_drain', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 }); } catch (_) { /* best-effort */ } }
            };
            setTimeout(runPaygDrain, 30_000).unref();
            setInterval(runPaygDrain, PAYG_DRAIN_INTERVAL_MS).unref();
            log.info(`[Server] PAYG meter drain scheduler started (interval=${PAYG_DRAIN_INTERVAL_MS}ms)`);
        } catch (e) {
            log.warn('[Server] Failed to start PAYG drain scheduler:', e.message);
        }
    }

    // Optionally pre-warm the shared browser singleton so the first PDF export /
    // thumbnail / SPA ingest doesn't pay the container cold-start. Off by default
    // (idle deployments shouldn't hold a browser container open).
    if (process.env.BROWSER_WARMUP === 'true') {
        try {
            require('../services/pwtRunner')
                .ensureBrowserSingleton({ onLine: (l) => log.info(`[browser] ${l}`) })
                .then(
                    () => log.info('[Server] Shared browser singleton warmed'),
                    (e) => log.warn('[Server] Browser warmup failed:', e.message),
                );
        } catch (e) {
            log.warn('[Server] Browser warmup error:', e.message);
        }
    }

    // Security-scan drain moved out of core: Security Scan is now a downloadable
    // .bfmod (Hub marketplace). The module ships its own outbox drain + reaper,
    // scheduled by the module runtime at install time — not here.

    // Non-invasive self-check of every org Privacy Shield blob. Logs warnings
    // for legacy shapes, orphaned regex collections, and invalid custom terms
    // so operators can spot guardrail drift in the startup log.
    const { selfCheckOrgShields } = require('../core/privacy/orgShield');
    selfCheckOrgShields().catch(err => log.warn('[OrgShieldSelfCheck] Error:', err.message));

    // The previous in-process PII pre-warm has been removed — PII detection
    // now runs only through the optional PII Guard service container, which
    // owns its own model loading lifecycle.

    // Pre-warm the in-process Whisper-base CPU transcription model. Same
    // fail-open semantics; first upload doesn't pay the download tax.
    if (process.env.LOCAL_WHISPER_PREWARM !== 'false' && isModuleAvailable('meetingNotes')) {
        const { warmLocalWhisper } = require('../core/voice/localWhisper');
        warmLocalWhisper();
    }

    // Register and schedule AI Act + GDPR compliance checks (6-hour interval,
    // multi-tenant). Also start the Art-5(1)(e) memory retention enforcer and
    // the daily statutory-deadline notifier (72h incidents / 30d DSRs / DPIA
    // expiries).
    require('../jobs/memoryRetentionEnforcer').start();
    // Monitoring-ledger retention and the PII scan-ledger prune. NOT gated on
    // a module: chat and DLP fill those tables on every install, including
    // one without Automations, whose runner these passes used to ride.
    try {
        require('../jobs/platformRetention').start();
    } catch (err) {
        log.warn('[Server] Platform retention job load failed:', err.message);
    }
    // Co-editing upkeep: materialise co-edited notebooks and pages into their
    // own columns, write one version per editing session and compact the
    // update log. Not gated on a module: a log that is never compacted only
    // grows, and a document edited before the module was removed must still
    // reach its notebook. Advisory-locked, one pod per pass.
    try {
        require('../jobs/collabDocCompaction').start();
    } catch (err) {
        log.warn('[Server] Co-editing upkeep job load failed:', err.message);
    }
    // Project live-feed retention: project_events rows older than a week only
    // served a reconnect that now refetches instead. Not gated on a module:
    // every workspace writes events. Advisory-locked, one pod per pass.
    try {
        require('../jobs/projectEventsPrune').start();
    } catch (err) {
        log.warn('[Server] Project event prune job load failed:', err.message);
    }
    // Document version retention: thin out long version histories (hourly,
    // daily, weekly with age), never a named, restore or pinned revision.
    // Daily, advisory-locked, not gated on a module.
    try {
        require('../jobs/documentVersionRetention').start();
    } catch (err) {
        log.warn('[Server] Document version retention job load failed:', err.message);
    }
    if (isModuleAvailable('compliance')) {
        require('../compliance/checks');
        require('../compliance/scheduler').start();
        // Art. 50(2): hand the document runner its marking resolver. core/
        // owns the port, compliance owns the policy — without this line a
        // generated document simply renders unmarked.
        require('../core/automationRunner/documentMarking')
            .setMarkingResolver((orgId, info) => require('../compliance/marking').resolveMarking(orgId, info));
        require('../jobs/complianceDeadlineNotifier').start();
        // ISO evidence connectors — periodic external-system sweeps (advisory-locked).
        require('../jobs/isoEvidenceCollector').start();
    }

    // Azure AD group sync: periodic syncs per org (explicit lifecycle call; it
    // used to be a require() side effect of integrations/azureGroupSync.js).
    try {
        require('../integrations/azureGroupSync').start();
    } catch (err) {
        log.warn('[Server] Azure group sync start failed:', err.message);
    }

    // Seed system agents into the database (explicit lifecycle call, not a require() side-effect)
    const { seedSystemAgents, SYSTEM_AGENT_IDS } = require('../stores/agent/systemAgents');
    seedSystemAgents()
        .then(async () => {
            log.info('[Server] System agents seeded');
            // Point the support AI responder at the seeded Bee Flow Support
            // singleton — keeps the existing `configStore.support_ai_agent_id`
            // contract working without admins having to paste a UUID.
            try {
                const configStore = require('../stores/configStore');
                const current = await configStore.getConfig('support_ai_agent_id');
                if (current !== SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT) {
                    await configStore.setConfig('support_ai_agent_id', SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT);
                    log.info('[Server] support_ai_agent_id pointed at Bee Flow Support singleton');
                }
            } catch (e) {
                log.warn('[Server] Could not sync support_ai_agent_id:', e.message);
            }
            // Sanity check — if the seed failed silently or someone DELETE'd
            // the row, every support thread will escalate. Surface this as a
            // warning so operators see it without having to inspect the DB.
            try {
                const agentStore = require('../stores/agentStore');
                const configStore = require('../stores/configStore');
                const { pool } = require('../db');
                const agent = await agentStore.getAgent(SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT);
                if (!agent) {
                    log.warn('[Support] WARN: Bee Flow Support agent missing after seed; AI auto-responder will escalate every thread until reseeded.');
                } else if (agent.model && agent.model.startsWith('tier:')) {
                    // Self-healing: if the configured tier has no modelId in this
                    // environment, every support thread would escalate with an
                    // unhelpful "model not found" error. Auto-fallback to a tier
                    // that IS configured. Picks the first tier with a non-empty
                    // modelId in the order: fast → standard → thinking → writer → pro.
                    const tierName = agent.model.slice(5);
                    const tiers = (await configStore.getConfig('chat_model_tiers')) || {};
                    const configured = (t) => tiers[t]?.modelId && String(tiers[t].modelId).trim().length > 0;
                    if (tierName !== 'auto' && !configured(tierName)) {
                        const fallback = ['fast', 'standard', 'thinking', 'writer', 'pro'].find(configured);
                        if (fallback) {
                            await pool.query(
                                `UPDATE agents SET model = $1, updated_at = now() WHERE id = $2`,
                                [`tier:${fallback}`, SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT]
                            );
                            log.warn(`[Support] Re-pointed Bee Flow Support from tier:${tierName} (no modelId configured) to tier:${fallback}.`);
                        } else {
                            log.warn(`[Support] WARN: tier:${tierName} has no modelId AND no other tier is configured. Configure at least one tier in Admin → AI Config → Model tiers, then update the support agent.`);
                        }
                    }
                }
            } catch (e) {
                log.warn('[Support] WARN: Bee Flow Support agent check failed:', e.message);
            }
        })
        .catch(err => log.error('[Server] System agents seed failed:', err.message));
    // Initialize MCP server connections (non-blocking)
    try {
        const mcpManager = require('../core/mcpManager');
        mcpManager.initialize().catch(err =>
            log.warn('[Server] MCP manager init error:', err.message)
        );
    } catch (err) {
        log.warn('[Server] MCP manager load failed:', err.message);
    }
    // Initialize AI Task background runner (non-blocking)
    try {
        require('../core/aiTaskRunner');
    } catch (err) {
        log.warn('[Server] AI Task runner load failed:', err.message);
    }
    // Cowork runner — own tick, shares aiTaskRunner's execution engine
    try {
        require('../core/cowork/coworkRunner');
    } catch (err) {
        log.warn('[Server] Cowork runner load failed:', err.message);
    }
    // Initialize Automation Runner — gated per-org by the 'automations' beta feature
    if (isModuleAvailable('automation')) try {
        const automationRunner = require('../core/automationRunner');
        automationRunner.start().catch(err =>
            log.warn('[Server] Automation runner start error:', err.message)
        );
    } catch (err) {
        log.warn('[Server] Automation runner load failed:', err.message);
    }
    // Datatables that mirror a Nextcloud table: the scheduled refresh. The
    // other triggers (push events, opening the rows, "Refresh now") run the
    // same engine on demand; this is the safety net under them. Advisory-
    // locked; each mirror is additionally claimed per row.
    if (isModuleAvailable('automation')) try {
        require('../jobs/datatableNcSync').start();
    } catch (err) {
        log.warn('[Server] Nextcloud mirror sync load failed:', err.message);
    }
    // Automation runs → project feed. runEventBus is in-process only; re-emitting
    // through the project feed is what gives a run cross-replica delivery and
    // reconnect-by-cursor, which projectEventBus already solved. No-ops for every
    // automation that is not in a project, which is most of them.
    if (isModuleAvailable('projects')) try {
        require('../core/projectFeed.runs').start();
    } catch (err) {
        log.warn('[Server] Project run feed bridge load failed:', err.message);
    }
    // The AI that joins team chats and comment threads by itself: every 5 s
    // it claims the debounced watches that came due (FOR UPDATE SKIP LOCKED,
    // so replicas share the work without an advisory lock), asks the fast
    // relevance gate and answers or stays silent. A few at a time per replica,
    // paused by its own circuit breaker when the gate keeps failing.
    if (isModuleAvailable('projects')) try {
        require('../jobs/aiParticipation').start();
    } catch (err) {
        log.warn('[Server] AI participation job load failed:', err.message);
    }
    // OpenObserve usage-push job — periodically pushes per-org/per-user token +
    // cost rollups to OpenObserve. Self-gated (no-op unless USAGE_PUSH_ENABLED),
    // advisory-locked so only one pod pushes.
    try {
        require('../jobs/usageOpenObservePush').start();
    } catch (err) {
        log.warn('[Server] Usage push job load failed:', err.message);
    }
    // OpenObserve ops-metrics push job — periodically snapshots operational /
    // product / security / billing gauges to OpenObserve. Self-gated (no-op
    // unless OPS_PUSH_ENABLED), advisory-locked so only one pod pushes.
    try {
        require('../jobs/opsMetricsPush').start();
    } catch (err) {
        log.warn('[Server] Ops metrics push job load failed:', err.message);
    }
    // Support Studio inbox sync — polls connected tenant mailboxes and turns
    // inbound email into support tickets. Set SUPPORT_INBOX_SYNC_IN_API=false
    // when a dedicated worker owns it. Support-owned, so it follows the module
    // switch like the SLA enforcer below; the tick itself also re-checks the
    // runtime module row.
    if (isModuleAvailable('support')) try {
        if (process.env.SUPPORT_INBOX_SYNC_IN_API !== 'false') {
            require('../services/supportInboxSyncEngine').startSupportInboxSync();
        }
    } catch (err) {
        log.warn('[Server] Support inbox sync engine load failed:', err.message);
    }
    // Support Studio historical-scan drain — runs on-demand "how fast did we
    // answer in the past?" scans queued from the Insights view. Aggregate-only,
    // off the sync tick. Set SUPPORT_SCAN_IN_API=false when a worker owns it.
    if (isModuleAvailable('support')) try {
        if (process.env.SUPPORT_SCAN_IN_API !== 'false') {
            require('../services/supportInboxScanEngine').startSupportInboxScan();
        }
    } catch (err) {
        log.warn('[Server] Support inbox scan engine load failed:', err.message);
    }
    // Customer Support SLA enforcer — policy-driven first-response/resolution
    // breach detection on a 60s tick (replaces the old 15-min at-risk warner).
    if (isModuleAvailable('support')) try {
        require('../services/supportSlaEnforcer').start();
        require('../services/supportIssueSync').start();
    } catch (err) {
        log.warn('[Server] Support SLA enforcer load failed:', err.message);
    }
    // NC user/group sync backstop — covers gaps when real-time webhooks miss
    try {
        require('../jobs/ncSyncBackstop').start();
    } catch (err) {
        log.warn('[Server] NC sync backstop load failed:', err.message);
    }
    // NC onboarding-incomplete reminder — daily nudge to org admins of orgs
    // provisioned >3d ago that never finished the wizard (1 reminder/org/7d,
    // deduped via configStore marker).
    try {
        require('../jobs/ncOnboardingReminder').start();
    } catch (err) {
        log.warn('[Server] NC onboarding reminder load failed:', err.message);
    }
    // Learning Center review nudge — daily tick that reminds lapsed learners
    // (started, unfinished, quiet 7-60d) to do a short review. Max one nudge
    // per user per 14d via configStore marker; advisory-locked across pods.
    // Learning-owned, so it follows the module switch like its siblings.
    if (isModuleAvailable('learning')) try {
        require('../jobs/learningNudge').start();
    } catch (err) {
        log.warn('[Server] Learning nudge load failed:', err.message);
    }
    // Safety net for meeting audio: give any recording still on this pod's disk
    // a durable object-storage copy. The request paths repair opportunistically;
    // this catches notes nobody happens to open.
    if (isModuleAvailable('meetingNotes')) try {
        require('../jobs/savedAudioBackfill').start();
    } catch (err) {
        log.warn('[Server] Saved-audio backfill load failed:', err.message);
    }
    // App Studio connector → table sync. Refreshes the tables that studio apps
    // fill from an external app on the owner's schedule, so viewers read local
    // rows instead of hitting the upstream API on every screen paint.
    // Advisory-locked; each sync is additionally claimed per (app, connector).
    if (isModuleAvailable('apps')) try {
        require('../jobs/studioAppConnectorSync').start();
        require('../jobs/datasetIngest').start();
    } catch (err) {
        log.warn('[Server] Studio app connector sync load failed:', err.message);
    }
    // Knowledge-base source refresh. Keeps a KB's sources up to date on their
    // own schedule, so what an agent quotes is what the source says today
    // rather than what it said the day someone added it. Advisory-locked
    // (0xBEEF10F) AND claimed per source, so two replicas cannot refresh the
    // same one twice; the tick also reaps claims a dead worker left behind,
    // without which one crash takes a source offline permanently.
    //
    // NOT gated on a module: a knowledge base is core, and a source that
    // silently stops refreshing is indistinguishable from one nobody edited.
    try {
        require('../jobs/kbSourceRefresh').start();
    } catch (err) {
        log.warn('[Server] KB source refresh load failed:', err.message);
    }

    // Org-health retention — daily prune of timeline events (90d), resolved
    // problems (30d) and unattributable domain/unknown buckets (30d).
    // Idempotent DELETEs — safe on multi-replica double runs.
    try {
        const orgHealthStore = require('../stores/orgHealthStore');
        const runOrgHealthPrune = async () => {
            try {
                const r = await orgHealthStore.pruneOld({
                    eventRetentionDays: parseInt(process.env.ORG_HEALTH_EVENT_RETENTION_DAYS, 10) || 90,
                    resolvedProblemRetentionDays: parseInt(process.env.ORG_HEALTH_RESOLVED_RETENTION_DAYS, 10) || 30,
                });
                if (r && (r.events || r.resolvedProblems || r.unattributed)) {
                    log.info(`[OrgHealth] pruned events=${r.events} resolvedProblems=${r.resolvedProblems} unattributed=${r.unattributed}`);
                }
            } catch (e) { log.error('[OrgHealth] prune error:', e.message); }
        };
        setTimeout(runOrgHealthPrune, 90_000).unref();
        setInterval(runOrgHealthPrune, 24 * 60 * 60 * 1000).unref();
    } catch (err) {
        log.warn('[Server] Org-health prune scheduler load failed:', err.message);
    }
    // Integration response cache — hourly sweep of expired rows.
    //
    // Hourly rather than daily because the entries hold third-party response
    // payloads and their TTL is capped at an hour: a daily prune would leave a
    // whole day of expired-but-still-stored answers sitting in the table, which
    // is a retention claim the product would not be keeping. The expiry is
    // enforced on READ regardless (the WHERE clause), so this is about not
    // storing what nothing may read, not about correctness.
    try {
        const integrationCacheStore = require('../stores/integrationCacheStore');
        const runIntegrationCachePrune = async () => {
            try {
                const n = await integrationCacheStore.pruneExpired();
                if (n) log.info(`[IntegrationCache] pruned ${n} expired entr${n === 1 ? 'y' : 'ies'}`);
            } catch (e) { log.error('[IntegrationCache] prune error:', e.message); }
        };
        setTimeout(runIntegrationCachePrune, 120_000).unref();
        setInterval(runIntegrationCachePrune, 60 * 60 * 1000).unref();
    } catch (err) {
        log.warn('[Server] Integration cache prune scheduler load failed:', err.message);
    }
    // Purge orphaned KB chunks (non-blocking, delayed to let DB pool warm up)
    setTimeout(() => {
        try {
            const { purgeOrphanedChunks } = require('../core/kb/localKBIngest');
            purgeOrphanedChunks()
                .then(n => { if (n > 0) log.info(`[Server] Startup: purged ${n} orphaned KB chunks`); })
                .catch(err => log.warn('[Server] Orphan purge error:', err.message));
        } catch (_) { /* localKBIngest not available — skip */ }
    }, 5000);
}

module.exports = { runStartupChecks, runStartupTasks };
