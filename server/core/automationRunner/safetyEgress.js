const { collectStringLeaves, applyStringLeaves, _vaultOf } = require('./safetyLeaves');
const { _detectPii, _scanText } = require('./safetyScan');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * Replace the personal data in `text` with REVERSIBLE placeholders, minted into
 * the run vault — the same thing chat does before a message reaches a model.
 *
 * The vault is what makes "map it back" automatic, and it is why this cannot
 * just call tokenizeText directly:
 *
 *   • it is run-scoped and shared by reference across branches, iterations and
 *     sub-layers, so one value keeps ONE placeholder everywhere in the run;
 *   • minting is serialised, so two parallel branches can never hand the same
 *     label to two different people;
 *   • it is seeded from what is already in there, so a value tokenized by an
 *     earlier node reuses its existing placeholder rather than gaining a second;
 *   • it is written through to automation_runs.pii_token_map, so an approval
 *     pause or a retry in another process still knows what `[email_1]` meant.
 *
 * Restoration is then free: prepareForEgress and restoreForRunState both read
 * the WHOLE vault, so every point where the runner already puts real values back
 * puts these back too.
 *
 * @returns {{ text, entities, degraded, degradedReason, overflow }}
 */
async function mintTokensFor(text, entities, ctx) {
    const source = String(text ?? '');
    if (!Array.isArray(entities) || !entities.length) return source;
    const { tokenizeText } = require('../privacy/piiDetection');
    // mint() absorbs the `tokenMap` off whatever the callback returns, so the
    // whole tokenizeText result goes back — and the merge happens inside the
    // lock, where it belongs.
    const res = await _vaultOf(ctx).mint((seedMap) => tokenizeText(source, entities, seedMap));
    return res?.tokenizedText ?? source;
}

async function tokenizeIntoVault(text, policy, ctx) {
    const source = String(text ?? '');
    const det = await _scanText(source, policy || {});
    if (!det.entities.length) return { text: source, ...det };
    return { text: await mintTokensFor(source, det.entities, ctx), ...det };
}

/**
 * @returns 'tokens' | 'masked' | 'real'
 */
function egressMode(policy, destination) {
    if (!policy) return 'real';
    // 'external' covers third parties; 'all' additionally covers on-box
    // destinations (Nextcloud on the same host, the local notebook store, …).
    const isExternal = destination !== 'internal';
    const covered = policy.privacyScope === 'all' || isExternal;
    if (!covered) return 'real';
    if (policy.action === 'tokenize') return 'tokens';
    // 'redact' masks for real: tokenizing and then restoring everything would
    // protect nothing at all — it would only leave a guardrail row behind.
    if (policy.action === 'redact') return 'masked';
    return 'real';
}

// Same shape as piiDetection's _TOKEN_NAME_RE: the category key may itself
// contain underscores (`[credit_card_1]`), so the prefix class must include
// them and let backtracking split off the counter.
const _TOKEN_RE = /\[([a-z0-9_]+)_(\d+)\]/g;

/** Replace `[person_1]` with `[person]` — no counter, so occurrences can't be re-linked. */
function maskTokens(value) {
    try {
        const json = JSON.stringify(value);
        if (json === undefined) return value;
        return JSON.parse(json.replace(_TOKEN_RE, (_m, cat) => `[${cat}]`));
    } catch (_) { return value; }
}

/**
 * Put the real values back, walking the value STRUCTURALLY.
 *
 * Serialising the whole value with JSON.stringify, handing the JSON
 * TEXT to restoreTokens and re-parsing would be wrong. restoreTokens is a plain String.replace:
 * it writes the vault's RAW value straight into the JSON text without
 * JSON-escaping it. Any real value containing a `"`, a backslash, a newline, a
 * tab or any other control character therefore produces BROKEN JSON, JSON.parse
 * threw, and the `catch (_) { return value; }` handed back the still-tokenized
 * value — so the customer received a literal `[person_1]` / `[address_1]` (a
 * multi-line address is the common case), and a crafted value could inject
 * extra JSON keys. This is the single restore point for BOTH prepareForEgress
 * and restoreForRunState, so the damage reached every destination.
 *
 * Walking the leaves means a substituted value is never re-parsed as JSON, so
 * quotes/newlines/backslashes are structurally impossible to misinterpret.
 * (Object KEYS are no longer rewritten. Nothing mints a token into a key — the
 * guard only ever transforms string LEAVES — so no token that this vault can
 * resolve can exist in a key.)
 *
 * No try/catch on purpose: "the restore failed" must never masquerade as "the
 * restore succeeded", because the failure mode is shipping placeholders — or
 * unrestored personal data — to a third party. Both callers are inside a step
 * executor, so a throw surfaces as a normal step failure (on_error edge / a
 * failed run), which is exactly the visible outcome we want.
 */
function restoreFromVault(value, vaultMap) {
    if (!vaultMap || !Object.keys(vaultMap).length) return value;
    const { restoreTokens } = require('../privacy/piiDetection');
    const leaves = collectStringLeaves(value);
    if (!leaves.length) return value;
    return applyStringLeaves(value, leaves.map(leaf => restoreTokens(leaf, vaultMap)));
}

/**
 * Decide what a payload looks like when it leaves the platform.
 *
 * Restoration uses the WHOLE run vault, not just the map of the value that was
 * scanned a moment ago: a placeholder minted by an earlier node is not personal
 * data, so the current step's scan never sees it — that is exactly how
 * `[person_1]` would be sent to third parties as literal text.
 *
 * @param {object} opts.destination 'external' (default) | 'internal'
 */
function prepareForEgress(value, policy, ctx, { destination = 'external' } = {}) {
    const mode = egressMode(policy, destination);
    if (mode === 'tokens') return value;                 // already tokenized upstream
    if (mode === 'masked') return maskTokens(value);
    return restoreFromVault(value, _vaultOf(ctx).all());
}

/**
 * Restore a guarded value for use INSIDE the platform (writing into runState).
 * Always the full vault — see prepareForEgress.
 */
function restoreForRunState(value, ctx) {
    return restoreFromVault(value, _vaultOf(ctx).all());
}

// ── egress logging (always the metadata row; scan gated by the org toggle) ──
//
// Non-blocking by design: this must not await the full windowed GLiNER scan
// before returning, and engine.js awaits logEgress — monitoring would sit on the
// critical path of EVERY automation step. The shared logger detaches the
// scan+insert; this function returns in microseconds.
/** @param {import('./safety.types').EgressEntry} entry */
async function logEgress({ toolName, toolArgs, result, error, blocked, probe, policy, auditBase, mode, durationMs, integMeta: metaOverride, servedFromCache = false }) {
    try {
        // `metaOverride` is for outbound paths that are not catalog tools —
        // http_request, the code step's fetch bridge, notification delivery.
        // Without it, resolveIntegration returns null and those calls left the
        // platform with no ledger row at all.
        let integMeta = metaOverride || null;
        if (!integMeta) {
            const { resolveIntegration } = require('../integrations/integrationToolMap');
            integMeta = resolveIntegration(toolName, toolArgs || {}, { nextcloudUrl: auditBase.nextcloudUrl });
        }
        if (!integMeta) return; // internal / non-integration tool — nothing left the platform

        const { logToolEgress } = require('../integrations/integrationLogging');
        logToolEgress({
            toolName,
            toolArgs,
            result,
            error: error || null,
            blocked: !!blocked,
            probe: probe || null,
            source: auditBase.source || 'automation',
            model: auditBase.model || null,
            durationMs,
            preResolvedMeta: integMeta,
            // The policy is already resolved per run — hand it over so the
            // shared logger doesn't re-fetch the shield config per step.
            shield: {
                monitorIntegrations: !!policy.monitorIntegrations,
                piiDetectionConfidenceThreshold: policy.confidence,
            },
            // Windowed GLiNER scan only when the org has PII detection at all;
            // otherwise stay at the 'basic' regex sniff.
            fullScan: policy.piiEnabled
                ? (text) => _detectPii(text, policy)
                : async () => null,
            ids: {
                organization_id: auditBase.organization_id,
                user_id: auditBase.user_id,
                // Automations are NOT agents. The automation id is not
                // stuffed into agent_id here: that would pollute every 'agent'
                // breakdown with automations; automation_id below is the real
                // attribution (automation_id IS NOT NULL classifies the rows).
                agent_id: null,
                agent_name: auditBase.agent_name,
                conversation_id: auditBase.conversation_id,
                automation_id: auditBase.automation_id,
                run_id: auditBase.run_id,
                step_id: auditBase.step_id,
            },
            isDryRun: mode === 'dry_run',
            // A DURABLE cache hit still writes a row — integration_activity_log
            // is the only evidence the org talks to this processor at all, and
            // its RoPA reader takes MAX(timestamp) — but it is flagged, because
            // no bytes crossed the boundary and the Art-44 transfer count must
            // not count it. A RUN-MEMO hit writes nothing: the first call in
            // that run already logged the real transfer.
            servedFromCache: !!servedFromCache,
        });
    } catch (err) { bestEffort('core/automationRunner/safetyEgress:logEgress', err); /* never fail a run on egress logging */ }
}

module.exports = { mintTokensFor, tokenizeIntoVault, egressMode, maskTokens, prepareForEgress, restoreForRunState, logEgress };
