'use strict';

/**
 * ISO readiness — the "continuously verified" count behind GET
 * /iso/readiness (routes/compliance/isoSoa.js).
 *
 * A control counts as verified only when it was actually judged and every
 * judged check passed. A not_applicable result is not a judgement: a
 * connector control whose connector is not enabled answers not_applicable,
 * and controls.js says a 'connector' control counts only where a connector is
 * live. Counting not_applicable as a pass put every unconnected connector
 * control into the headline number. A control whose checks are all
 * not_applicable (or have no result) is unchecked; a control with a warn and
 * no fail counts neither verified nor failing (the remainder on the screen).
 */

/**
 * @param {Array<{ref: string}>} verifiable  the auto + connector controls
 * @param {Record<string, string[]>} checksByControl  control ref → check ids
 * @param {Record<string, string>} statusByCheck  check id → latest status
 * @returns {{verified: number, failing: number, unchecked: number}}
 */
function readinessCounts(verifiable, checksByControl, statusByCheck) {
    let verified = 0, failing = 0, unchecked = 0;
    for (const c of verifiable) {
        const judged = (checksByControl[c.ref] || [])
            .map(id => statusByCheck[id])
            .filter(s => s && s !== 'not_applicable');
        if (!judged.length) { unchecked++; continue; }
        if (judged.includes('fail')) failing++;
        else if (judged.every(s => s === 'pass')) verified++;
    }
    return { verified, failing, unchecked };
}

module.exports = { readinessCounts };
