/**
 * Operator kill-switch for a feature: `feature_<name>_enabled === false` in
 * the config store turns its routes off with a 403. Fails closed: when the
 * flag cannot be read, serving the feature anyway is the one outcome that
 * ignores the operator's instruction.
 */
const log = require('../telemetry/log');
const { HttpError } = require('../shared/httpErrors');
function featureGate(name, label) {
    return async function gate(req, res, next) {
        let enabled;
        try {
            enabled = await require('../stores/configStore').getConfig(`feature_${name}_enabled`);
        } catch (err) {
            log.error(`[${label}] feature gate lookup failed:`, err.message);
            return next(new HttpError(503, 'feature_gate_unavailable', `${label} availability could not be determined`));
        }
        if (enabled === false) return res.status(403).json({ error: `${label} feature is disabled` });
        next();
    };
}

module.exports = { featureGate };
