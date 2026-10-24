// @typecheck
/**
 * Package loader: the runtime plumbing an activation wires and unwires.
 *
 * Capability/beta descriptor projection and the registry push, stopping a
 * worker tick, the require.cache purge (so a re-install reloads fresh code)
 * and the bounded drain + dispose of a hot-swapped instance.
 */

'use strict';

const path = require('path');

const { deps, _ticks, _remoteDescriptors, _healthOf, _logSystem } = require('./packageState');
const { moduleRoot } = require('./packageStaging');
const log = require('../telemetry/log');

const { registry, betaFeatures } = deps;

// ── Descriptor projection + registry push ─────────────────────────────────
function _projectDescriptors(moduleId, manifest) {
    const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    const capDescriptors = [];
    const betaDescriptors = [];
    for (const c of caps) {
        if (!c || !c.id) continue;
        // 'core' is host-reserved: mv2 packages are rejected at verify time;
        // mv1 packages are grandfathered by coercing to 'integration'.
        let kind = c.kind || 'integration';
        if (kind === 'core') {
            log.warn(`[Modules] ${moduleId}: capability ${c.id} declared kind 'core' — coerced to 'integration'`);
            kind = 'integration';
        }
        capDescriptors.push({
            id: c.id,
            kind,
            name: c.name || c.id,
            description: c.description || '',
            category: c.category || manifest.name || 'Modules',
            licenseFeature: c.licenseFeature || null,
            lifecycle: c.lifecycle || 'stable',
            defaultState: c.defaultState || (kind === 'integration' ? 'off' : 'on'),
            userFacing: c.userFacing !== false,
            groupTogglable: c.groupTogglable !== false,
            moduleId,
            _remoteModule: true,
        });
        if (kind === 'beta') {
            betaDescriptors.push({
                id: c.id,
                name: c.name || c.id,
                description: c.description || '',
                lifecycle: c.lifecycle || 'beta',
                licenseFeature: c.licenseFeature || null,
            });
        }
    }
    return { capDescriptors, betaDescriptors };
}

function _pushDescriptors() {
    const allCaps = [];
    const allBetas = [];
    for (const d of _remoteDescriptors.values()) {
        allCaps.push(...d.capDescriptors);
        allBetas.push(...d.betaDescriptors);
    }
    try { registry().setRemoteModuleCapabilityDescriptors(allCaps); } catch (err) { log.debug('registry not ready', err); }
    try { betaFeatures().setRemoteBetaFeatures(allBetas); } catch (err) { log.debug('beta not ready', err); }
}

// ── Worker tick (stop; the start lives with activation) ───────────────────
function _stopTick(moduleId) {
    const t = _ticks.get(moduleId);
    if (t) { clearInterval(t); _ticks.delete(moduleId); }
}

// ── require.cache purge (so a re-install reloads fresh code) ───────────────
function _purgeRequireCache(moduleId) {
    const root = moduleRoot(moduleId) + path.sep;
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(root)) delete require.cache[key];
    }
}

// ── Hot-swap drain ─────────────────────────────────────────────────────────
const DRAIN_TIMEOUT_MS = parseInt(process.env.MODULE_DRAIN_TIMEOUT_MS || '10000', 10);
const DISPOSE_TIMEOUT_MS = 10_000;

/** Wait (bounded) for a replaced entry's in-flight requests, then dispose it. */
async function _drainAndDispose(moduleId, oldEntry) {
    oldEntry.draining = true;
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while ((oldEntry.inflight || 0) > 0 && Date.now() < deadline) {
        await new Promise((r) => { const t = setTimeout(r, 200); if (t.unref) t.unref(); });
    }
    if (oldEntry.instance && typeof oldEntry.instance.dispose === 'function') {
        try {
            await Promise.race([
                Promise.resolve(oldEntry.instance.dispose()),
                new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('dispose_timeout')), DISPOSE_TIMEOUT_MS); if (t.unref) t.unref(); }),
            ]);
        } catch (e) {
            if (e && e.message === 'dispose_timeout') _healthOf(moduleId).disposeTimeouts++;
            log.warn(`[Modules] hot-swap dispose failed for ${moduleId}:`, e.message);
        }
    }
    _logSystem(moduleId, `old v${oldEntry.version} drained (${oldEntry.inflight || 0} in-flight at timeout) + disposed`);
}

module.exports = {
    _projectDescriptors,
    _pushDescriptors,
    _stopTick,
    _purgeRequireCache,
    _drainAndDispose,
};
