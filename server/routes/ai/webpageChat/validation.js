// @typecheck
/**
 * Webpage chat: the post-generation validation of one turn (BFSF-222,
 * routes/ai/webpageChat.js). At most one repair round per turn.
 */

'use strict';

const log = require('../../../telemetry/log');
const configStore = require('../../../stores/configStore');
const webpageStore = require('../../../stores/webpageStore');

/**
 * `turn` is the turn's shared state (./toolLoop.js). Returns
 * `maybeBuildValidationRepair()`: the repair note, or null.
 */
function createValidationRepair({ send, webpageId, userId }, turn) {
    const { liveFiles, dirtySlots, touchedExtraPaths } = turn;

    // ── Post-generation validation (BFSF-222) ─────────────────────────
    // Runs ONCE at end-of-turn (the model returned no tool calls): scans
    // the in-memory html + touched extras for broken anchors and wrong/
    // missing images. When error-severity findings exist it returns a
    // repair note (sent as a user turn) so the model can fix its own
    // output in one extra round. Advisory and fail-open — never blocks
    // persistence.
    async function maybeBuildValidationRepair() {
        if (turn.validationRepairUsed) return null;
        const touchedRelevant = [...touchedExtraPaths].some(p => /\.(html|jsx|js)$/i.test(p));
        if (!dirtySlots.has('html') && !touchedRelevant) return null;
        try {
            // Ops kill-switch — default on, mirrors max_tool_rounds_chat.
            if ((await configStore.getConfig('webpage_validation_enabled')) === 'false') return null;
            const {
                validateWebpageProject,
                buildRepairMessage,
                mergeAllowedImgHosts,
            } = require('../../../services/webpageValidation');
            const allowedHosts = mergeAllowedImgHosts(await configStore.getConfig('webpage_img_host_allowlist'));
            const extras = await webpageStore.listExtraFiles(webpageId);
            // ALL extras (text AND binary) — AI-created SVGs are text
            // extras and must count as existing assets.
            const assetPaths = extras.map(e => e.path);
            let scriptTexts;
            let sourcesMap;
            if (turn.currentFramework === 'react-mui') {
                sourcesMap = {};
                const srcExtras = extras.filter(e => e.isText && /^src\/.*\.(jsx|js)$/i.test(e.path)).slice(0, 10);
                for (const e of srcExtras) {
                    const f = await webpageStore.readExtraFile({ webpageId, userId, path: e.path });
                    if (f?.text) sourcesMap[e.path] = f.text;
                }
            } else {
                scriptTexts = [liveFiles.js];
                const jsExtras = extras.filter(e => e.isText && /\.(js|mjs|cjs)$/i.test(e.path)).slice(0, 10);
                for (const e of jsExtras) {
                    const f = await webpageStore.readExtraFile({ webpageId, userId, path: e.path });
                    if (f?.text) scriptTexts.push(f.text);
                }
            }
            const { violations } = validateWebpageProject({
                framework: turn.currentFramework,
                html: liveFiles.html,
                scriptTexts,
                sources: sourcesMap,
                assetPaths,
                allowedHosts,
            });
            const actionable = violations.filter(v => v.severity !== 'info');
            if (actionable.length === 0) return null;
            // Observability — the frontend SSE switch ignores unknown
            // event names, so old clients are unaffected.
            send('webpage_validation', { violations: actionable });
            log.info(`[WebpageChat] Validation found ${actionable.length} issue(s)`);
            // Warns alone never trigger the extra LLM round — only real
            // errors (broken anchor / missing asset) are worth the cost.
            if (!actionable.some(v => v.severity === 'error')) return null;
            return buildRepairMessage(actionable, { assetPaths });
        } catch (valErr) {
            log.warn('[WebpageChat] Post-generation validation failed (skipping):', valErr.message);
            return null;
        }
    }

    return maybeBuildValidationRepair;
}

module.exports = { createValidationRepair };
