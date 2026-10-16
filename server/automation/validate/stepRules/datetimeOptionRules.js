// @typecheck
/**
 * Validation of the optional `timezone` and `epochUnit` fields of a datetime
 * step. Both are optional; absent means UTC and "auto".
 */

const { resolveTimezone, EPOCH_UNITS } = require('../../../core/automationRunner/dateTimeTz');

/**
 * @param {{ pushE: (finding: object) => void }} ctx
 * @param {any} step
 * @param {string} at path of the step in the definition
 */
function checkDatetimeOptions(ctx, step, at) {
    const { pushE } = ctx;
    if (step.timezone != null && step.timezone !== '') {
        let tzOk = typeof step.timezone === 'string';
        if (tzOk) {
            try { resolveTimezone(step.timezone); } catch { tzOk = false; }
        }
        if (!tzOk) {
            pushE({ code: 'datetime.timezone_invalid', severity: 'error', path: `${at}.timezone`, message: `Step ${step.id}: unknown timezone "${String(step.timezone)}".`, hint: 'Use an IANA name such as Europe/Amsterdam, or UTC (the default).' });
        }
    }
    if (step.epochUnit != null && !EPOCH_UNITS.has(step.epochUnit)) {
        pushE({ code: 'datetime.epoch_unit_invalid', severity: 'error', path: `${at}.epochUnit`, message: `Step ${step.id}: epochUnit must be one of ${Array.from(EPOCH_UNITS).join('/')}.`, hint: 'auto (default) reads numbers below 1e11 as seconds, larger ones as milliseconds.' });
    }
}

module.exports = { checkDatetimeOptions };
