// @typecheck
/**
 * The Privacy Shield for a notebook's one-shot AI calls (POST
 * /api/notebooks/:id/generate/:type and /ai-fill), on the path the notebook
 * chat takes (routes/ai/notebookChat.js), so neither call can send what the
 * chat would not:
 *
 *   1. the organisation's resolved shield strips its own-server block list
 *      from the retrieved source text (core/privacy/toolPiiGate);
 *   2. ONE personal-data scan over everything that goes into the prompt,
 *      through the durable scan ledger (core/dlp/composeScan), with the
 *      organisation's stored shield: the values are tokenised into the
 *      notebook's own token map (the chat's, keyed by notebook id), or the
 *      call is refused when the shield blocks;
 *   3. a scan that cannot run refuses the call when the shield fails closed,
 *      and otherwise goes on with the text as it was (the chat's rule);
 *   4. the answer is untokenised on its way back to the person who asked
 *      (core/dlp/untokeniseStream), and the model is told to keep the tokens.
 *
 * The shield off (or no organisation): the texts pass through unchanged.
 * Never logs content; counts only.
 */

'use strict';

/**
 * @typedef {{ ok: false, status: number, code: string, error: string }} ShieldRefusal
 * @typedef {{ ok: true, units: string[], addendum: string, untokenise: { push: (s: string) => string, flush: () => string } }} ShieldPass
 */

/**
 * @param {{ orgId: string|null, userId: string, notebookId: string,
 *   sourceText: string, otherUnits?: string[] }} input
 *   `sourceText` is retrieved material (block lists apply); `otherUnits` is
 *   what the person sent (a template to fill), scanned the same way.
 * @param {object} [deps]  test seams: getConfig, resolveShieldFor, stripInjectedText, composeScan, dlp, log
 * @returns {Promise<ShieldRefusal|ShieldPass>}  the units in order: sourceText first, then otherUnits
 */
async function shieldNotebookPrompt({ orgId, userId, notebookId, sourceText, otherUnits = [] }, deps = {}) {
    const getConfig = deps.getConfig || ((key) => require('../../stores/configStore').getConfig(key));
    const resolveShieldFor = deps.resolveShieldFor || require('../../core/privacy/orgShield').resolveShieldFor;
    const stripInjectedText = deps.stripInjectedText || require('../../core/privacy/toolPiiGate').stripInjectedText;
    const composeScan = deps.composeScan || require('../../core/dlp/composeScan').composeScan;
    const dlp = deps.dlp || require('../../core/dlp/dlpRunner');
    const log = deps.log || require('../../telemetry/log');
    const { createUntokeniser } = require('../../core/dlp/untokeniseStream');
    const { buildTokenPreservationAddendum } = require('../../core/dlp/tokenPreservationPrompt');

    // The notebook's token map, so tokens minted in its chat are reused here.
    try { await dlp.getConversationTokenMapAsync(notebookId); } catch (_) { /* best-effort */ }
    const storedShield = orgId ? await getConfig(`org_privacy_shield_${orgId}`) : null;
    const resolved = await resolveShieldFor({ orgId, userId });
    const failClosed = !!storedShield?.enabled && storedShield?.dlpFailureMode === 'fail_closed';

    let units = [
        await stripInjectedText(sourceText || '', { shield: resolved, tag: 'NotebookAi', what: 'notebook sources' }),
        ...otherUnits.map((u) => (typeof u === 'string' ? u : '')),
    ];
    if (storedShield?.enabled) {
        try {
            const r = await composeScan({ units, orgShield: storedShield, conversationId: notebookId, scope: 'g' });
            if (r.blocked) {
                log.warn(`[NotebookAi] Privacy Shield blocked the request (${r.reason || 'pii'}, ${r.mentions} mention(s))`);
                return {
                    ok: false, status: 422, code: 'privacy_shield_blocked',
                    error: 'Privacy Shield blocked this request because the sources contain personal data that may not be sent to the AI model.',
                };
            }
            if (r.tokenMap) {
                log.info(`[NotebookAi] tokenised ${r.count} value(s), ${r.mentions} mention(s)`);
                units = r.units;
            }
        } catch (err) {
            log.warn('[NotebookAi] Privacy Shield scan failed:', /** @type {Error} */ (err).message);
            if (failClosed) {
                return {
                    ok: false, status: 503, code: 'privacy_shield_unavailable',
                    error: 'Privacy Shield could not check this content for personal data, so the request was blocked. Please try again shortly.',
                };
            }
        }
    }
    const map = () => dlp.getConversationTokenMap(notebookId);
    return {
        ok: true,
        units,
        addendum: buildTokenPreservationAddendum(map()) || '',
        untokenise: createUntokeniser(map),
    };
}

module.exports = { shieldNotebookPrompt };
