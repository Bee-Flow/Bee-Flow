/**
 * Rate limiters for the App Studio action-run bridge (server/routes/studioAppsRun.js).
 *
 * Split into its own near-dependency-free module (only utils/perUserRateLimit)
 * so it can be unit-tested without pulling in studioAppsRun.js's graph of
 * stores/runner, most of which require live env config (DB) at import time —
 * same split as webpagesPreviewRateLimits.js.
 *
 * The action-run endpoint executes the APP OWNER's routine (acts-as-owner,
 * real side effects) but is callable by any org/group viewer of a published
 * app. Keyed `userId:appId` so one noisy viewer can't drain other viewers'
 * budget for the same app, and a user hammering app A doesn't lock themselves
 * out of app B.
 *
 * Must be mounted AFTER requireAuth — the key generator reads req.session.user.
 */

const { perUserRateLimit } = require('../utils/perUserRateLimit');

// Tightest tier — every hit can trigger a full routine execution (LLM calls,
// integration side effects) under the owner's credentials. Tunable via env;
// read at module load like AUTOMATION_RUN_TRIGGER_RPM in routes/automation/runs.js.
const ACTION_RUN_RPM = parseInt(process.env.STUDIO_APP_ACTION_RUN_RPM, 10) || 10;

// Looser tier for the data-step endpoint. A single v2 sequence dispatches EACH
// server-authoritative data step to POST /:id/actions/:aid/step individually,
// so one multi-step run can spend many /step hits — the tight /run cap (10/min)
// would throttle a normal multi-step run mid-flight. A data step is far cheaper
// than a /run (one record write, no routine graph), so it gets its own higher
// bucket (default 60/min, env STUDIO_APP_STEP_RATE). Same userId:appId keying.
const STEP_RPM = parseInt(process.env.STUDIO_APP_STEP_RATE, 10) || 60;

// Connector-run tier. POST /:id/data/connectors/:connectorId/run dispatches an
// external fetch / tool / routine acts-as-owner — same class of side effect as
// /run, but a connector is typically a read (list rows), so it gets its own
// middle bucket (default 20/min, env STUDIO_APP_CONNECTOR_RATE). Same
// userId:appId keying so one noisy viewer can't drain another's budget.
const CONNECTOR_RUN_RPM = parseInt(process.env.STUDIO_APP_CONNECTOR_RATE, 10) || 20;

// Authoring tier — /inspect and /sync are OWNER-ONLY, so there is no
// cross-viewer fairness problem to solve here; the cap exists because each hit
// runs the connector for real (and /sync also writes rows). Tighter than the
// viewer run tier precisely because a sync is the expensive one: a chained
// connector can spend up to MAX_CHAIN_CALLS upstream calls per hit.
const CONNECTOR_SYNC_RPM = parseInt(process.env.STUDIO_APP_CONNECTOR_SYNC_RATE, 10) || 6;

// Outbound mail. The tightest bucket in the file, and the only one with a daily
// ceiling as well as a per-minute one: every hit puts a real message in a real
// customer's inbox from a real person's mailbox. A support agent answering
// briskly sends a handful a minute; anything beyond that is a mistake or a
// misuse, and neither should be cheap.
//
// These limiters are NAMED, which opts them into the Redis backend (see
// utils/perUserRateLimit): with REDIS_URL configured the counts are shared
// across replicas and the documented number is the real fleet-wide ceiling —
// including the daily e-mail cap, which used to multiply by replica count.
// Without Redis they fall back to the original per-replica in-memory windows.
const SEND_EMAIL_RPM = parseInt(process.env.STUDIO_APP_SEND_EMAIL_RPM, 10) || 5;
const SEND_EMAIL_PER_DAY = parseInt(process.env.STUDIO_APP_SEND_EMAIL_DAILY, 10) || 200;

// Bulk file intake. One hit redeems a whole order's mailed attachments — up to
// 25 provider fetches, each landing bytes in the owner's storage. The generic
// step bucket (60/min) would permit 1500 provider fetches a minute; this one
// exists so it cannot. Named → Redis-backed, fleet-wide when configured.
const FILE_INTAKE_RPM = parseInt(process.env.STUDIO_APP_FILE_INTAKE_RPM, 10) || 6;

// Model calls dispatched as STEPS (ai_extract / ai_generate / kb_query).
//
// These used to be charged to the /run bucket above, which assumes one click =
// one run. A document pipeline breaks that assumption: an action that reads a
// purchase order and then loops one AI call per drawing spends a dozen model
// calls from a SINGLE press, so a nine-drawing order died at "limit is 10 per
// 60s" partway through — after paying for the calls that did land.
//
// The ceiling is still real, but it is a RATE and no longer a whole order:
// file_intake now accepts 500 files (it was 25 when this number was chosen), and
// a 250-part order whose triage asks for every drawing dispatches one model call
// per drawing from a single press. Those calls are serial and a vision extract is
// seconds, not milliseconds, so a real order lands well under 30/min — but the
// headroom is latency, not design. A faster model or a parallel loop would put a
// long order over it, and a 429 here ABORTS the sequence (the runner does not
// retry), so it would stop partway after paying for the calls that did land.
// Raise this together with any change that shortens per-call latency.
const AI_STEP_RPM = parseInt(process.env.STUDIO_APP_AI_STEP_RPM, 10) || 30;

// Large-dataset upload tiers. Init/complete are cheap DB writes but mint real
// multipart uploads in object storage, so they stay tight; the PART tier is the
// throughput knob — 90 × 32 MB parts/min ≈ 48 MB/s per (viewer, app), enough to
// saturate a fast home uplink without letting one viewer monopolise the pod.
// dataset_query is a bounded ranged read + row scan (no model call) — same
// class as a data step, so it gets a step-like budget of its own.
const DATASET_INIT_RPM = parseInt(process.env.STUDIO_APP_DATASET_INIT_RPM, 10) || 5;
const DATASET_PART_RPM = parseInt(process.env.STUDIO_APP_DATASET_PART_RPM, 10) || 90;
const DATASET_COMPLETE_RPM = parseInt(process.env.STUDIO_APP_DATASET_COMPLETE_RPM, 10) || 10;
const DATASET_STATUS_RPM = parseInt(process.env.STUDIO_APP_DATASET_STATUS_RPM, 10) || 120;
const DATASET_QUERY_RPM = parseInt(process.env.STUDIO_APP_DATASET_QUERY_RPM, 10) || 30;

// AI browsing. The tightest AI bucket: one hit runs a headless-browser agent
// loop (up to 90 s) holding one of only FOUR process-wide browser slots, on the
// owner's model spend. 4/min per (viewer, app) keeps a single app's viewers
// from monopolising the shared browser pool the whole chat product also uses.
const BROWSE_RPM = parseInt(process.env.STUDIO_APP_BROWSE_RPM, 10) || 4;

function actionRunKey(req) {
    const userId = req.session?.user?.id || 'anon';
    const appId = req.params?.id || 'unknown';
    return `${userId}:${appId}`;
}

const actionRunLimiter = perUserRateLimit({ windowMs: 60_000, max: ACTION_RUN_RPM, keyFn: actionRunKey, name: 'studio-run' });
const stepLimiter = perUserRateLimit({ windowMs: 60_000, max: STEP_RPM, keyFn: actionRunKey, name: 'studio-step' });
const connectorRunLimiter = perUserRateLimit({ windowMs: 60_000, max: CONNECTOR_RUN_RPM, keyFn: actionRunKey, name: 'studio-connector' });
const connectorSyncLimiter = perUserRateLimit({ windowMs: 60_000, max: CONNECTOR_SYNC_RPM, keyFn: actionRunKey, name: 'studio-sync' });
const sendEmailLimiter = perUserRateLimit({ windowMs: 60_000, max: SEND_EMAIL_RPM, keyFn: actionRunKey, name: 'studio-email' });
const sendEmailDailyLimiter = perUserRateLimit({ windowMs: 86_400_000, max: SEND_EMAIL_PER_DAY, keyFn: actionRunKey, name: 'studio-email-daily' });
const fileIntakeLimiter = perUserRateLimit({ windowMs: 60_000, max: FILE_INTAKE_RPM, keyFn: actionRunKey, name: 'studio-file-intake' });
const aiStepLimiter = perUserRateLimit({ windowMs: 60_000, max: AI_STEP_RPM, keyFn: actionRunKey, name: 'studio-ai-step' });
const datasetInitLimiter = perUserRateLimit({ windowMs: 60_000, max: DATASET_INIT_RPM, keyFn: actionRunKey, name: 'studio-ds-init' });
const datasetPartLimiter = perUserRateLimit({ windowMs: 60_000, max: DATASET_PART_RPM, keyFn: actionRunKey, name: 'studio-ds-part' });
const datasetCompleteLimiter = perUserRateLimit({ windowMs: 60_000, max: DATASET_COMPLETE_RPM, keyFn: actionRunKey, name: 'studio-ds-complete' });
const datasetStatusLimiter = perUserRateLimit({ windowMs: 60_000, max: DATASET_STATUS_RPM, keyFn: actionRunKey, name: 'studio-ds-status' });
const datasetQueryLimiter = perUserRateLimit({ windowMs: 60_000, max: DATASET_QUERY_RPM, keyFn: actionRunKey, name: 'studio-ds-query' });
const browseStepLimiter = perUserRateLimit({ windowMs: 60_000, max: BROWSE_RPM, keyFn: actionRunKey, name: 'studio-browse' });

module.exports = {
    actionRunKey,
    actionRunLimiter, stepLimiter, connectorRunLimiter, connectorSyncLimiter,
    sendEmailLimiter, sendEmailDailyLimiter, fileIntakeLimiter, aiStepLimiter,
    datasetInitLimiter, datasetPartLimiter, datasetCompleteLimiter, datasetStatusLimiter, datasetQueryLimiter,
    browseStepLimiter,
    ACTION_RUN_RPM, STEP_RPM, CONNECTOR_RUN_RPM, CONNECTOR_SYNC_RPM,
    SEND_EMAIL_RPM, SEND_EMAIL_PER_DAY, FILE_INTAKE_RPM, AI_STEP_RPM,
    DATASET_INIT_RPM, DATASET_PART_RPM, DATASET_COMPLETE_RPM, DATASET_STATUS_RPM, DATASET_QUERY_RPM, BROWSE_RPM,
};
