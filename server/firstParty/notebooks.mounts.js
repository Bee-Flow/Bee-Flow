// @typecheck strict
'use strict';
/**
 * The mounts of module "notebooks": its rows of the route table of server/index.js and of the
 * /ai router (routes/ai.js), as data (modules/firstParty/contract.js MountRow), with the same
 * gates. Order: the core's (modules/firstParty/order.json "mounts" and "aiMounts"); routers are
 * required at mount time.
 */


/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */
/** @typedef {import('../modules/firstParty/contract').Gates} Gates */
/** @typedef {import('express').RequestHandler} RequestHandler */

/** @type {RequestHandler | null} */
let featureGateInstance = null;

/**
 * The one configStore feature gate both /api/notebooks mounts share (one instance, as before).
 * @param {Gates} g
 * @returns {RequestHandler}
 */
function notebookFeatureGate(g) {
    if (!featureGateInstance) featureGateInstance = g.featureGate('notebooks', 'Notebooks');
    return /** @type {RequestHandler} */ (featureGateInstance);
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {() => void} next
 */
const notebookKillSwitch = async (req, res, next) => {
    try {
        const configStore = require('../stores/configStore');
        const enabled = await configStore.getConfig('feature_notebooks_enabled');
        if (enabled === false) {
            return res.status(403).json({ error: 'Notebooks feature is disabled' });
        }
    } catch (err) { require('../utils/bestEffort').bestEffort('routes/ai:notebookKillSwitch', err); /* fail open on the operator kill-switch only */ }
    next();
};

/**
 * Notebook chat feature gate. Resolves `notebooks` through the ONE entitlements
 * resolver (requireCapability) — identical to the /api/notebooks* mounts — so
 * notebook chat agrees with them on cloud (subscription) and self-hosted
 * (licence). The capability check runs first so the SPA gets the actionable
 * `feature_locked` body; the configStore flag stays a separate operator
 * kill-switch and runs only after the entitlement passes.
 * @param {Gates} g
 */
function notebookChatGateFor(g) {
    const notebookCapGate = g.requireCapability('notebooks');
    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    const notebookChatGate = (req, res, next) => {
        // Lowercased: the router matches paths case-insensitively.
        if (!req.path.toLowerCase().startsWith('/chat/notebook')) return next();
        // requireCapability answers feature_locked/feature_disabled itself, or hands a
        // 503 entitlement_unavailable to next(err). The continuation runs for BOTH, so
        // it must forward an error and only run the operator kill-switch on success.
        return notebookCapGate(req, res, (/** @type {unknown} */ err) => (err ? next(err) : notebookKillSwitch(req, res, next))
        );
    };
    return notebookChatGate;
}

/** @type {MountRow[]} */
const mounts = [
    // Licence gate fires before notebookFeatureGate so the frontend gets the
    // actionable `feature_locked` body it already knows how to render; the
    // configStore.feature_notebooks_enabled flag remains as an operator
    // kill-switch for enterprise installs that want to disable the feature
    // per deployment.
    { key: 'notebooks:/api/notebooks', slot: 'main', path: '/api/notebooks', handlers: (g) => [g.requireModule('notebooks'), g.requireCapability('notebooks'), notebookFeatureGate(g), require('../routes/notebooks')] },
    { key: 'notebooks:/api/notebooks#export', slot: 'main', path: '/api/notebooks', handlers: (g) => [g.requireModule('notebooks'), g.requireCapability('notebooks'), notebookFeatureGate(g), require('../routes/notebookExport')] },
];

/** @type {MountRow[]} */
const aiMounts = [
    { key: 'notebooks:notebookChatGate', path: null, handlers: (g) => [notebookChatGateFor(g)] },
    { key: 'notebooks:notebookChat', path: '/', handlers: () => [require('../routes/ai/notebookChat')] },
];

module.exports = { mounts, aiMounts };
