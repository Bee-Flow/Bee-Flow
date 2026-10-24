'use strict';

// Split from license/index so stores/user/users can read the seat cap without
// loading the whole licence module (which reaches back into userStore).
const store = require('./store');

/**
 * Return the seat cap from the active license metadata, or null when no
 * active license is present or the license does not set a cap. Useful for
 * enforcing per-license seat limits on user creation.
 */
async function getMaxSeatsForOrg(organizationId) {
    if (!organizationId) return null;
    const lic = await store.getActiveLicenseForOrg(organizationId);
    if (!lic) return null;
    if (lic.refreshStatus === 'expired' || lic.refreshStatus === 'revoked') return null;
    if (lic.expiresAt && new Date(lic.expiresAt).getTime() <= Date.now()) return null;
    const raw = lic.metadata && lic.metadata.max_seats;
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

module.exports = { getMaxSeatsForOrg };
