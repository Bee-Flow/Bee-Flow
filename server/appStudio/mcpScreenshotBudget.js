// @typecheck strict
/** Rolling per-user screenshot budget of the Studio MCP endpoint (split out of mcpBuilder.js). */

'use strict';

// ── Screenshot budget ───────────────────────────────────────────────────────
//
// app_screenshot's own cap is per-TURN (draftWrap._screenshotsThisTurn), and a
// stateless endpoint that reloads the draft every call would reset it to zero
// every time — turning an 8-per-turn ceiling into no ceiling at all. Each
// render is a headless browser page, so replace it with an equivalent rolling
// per-user budget rather than dropping it.

const SHOT_WINDOW_MS = 10 * 60 * 1000;
const SHOT_MAX_PER_WINDOW = 24;
const _shotBudget = new Map(); // userId → { count, resetAt }

/** @param {string} userId */
function takeScreenshotBudget(userId) {
    const now = Date.now();
    const entry = _shotBudget.get(userId);
    if (!entry || entry.resetAt <= now) {
        _shotBudget.set(userId, { count: 1, resetAt: now + SHOT_WINDOW_MS });
        return true;
    }
    if (entry.count >= SHOT_MAX_PER_WINDOW) return false;
    entry.count += 1;
    return true;
}

module.exports = { SHOT_WINDOW_MS, SHOT_MAX_PER_WINDOW, takeScreenshotBudget, _shotBudget };
