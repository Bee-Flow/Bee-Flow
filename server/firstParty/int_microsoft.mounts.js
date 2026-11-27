// @typecheck strict
'use strict';
/**
 * The mounts of module "int_microsoft" (Microsoft 365): its rows of the route table that
 * the core mounts, as data (modules/firstParty/contract.js MountRow), with the
 * same gates. Order: the core's (modules/firstParty/order.json "mounts"); routers are required
 * at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // The Microsoft counterpart of /api/integrations/google. Without it, Outlook only ever worked for users who
    // logged in via Microsoft SSO, and nobody could grant the shared-mailbox scopes.
    { key: 'int_microsoft:/api/integrations/microsoft', slot: 'main', path: '/api/integrations/microsoft', handlers: () => [require('../routes/integrations/microsoft365')] },
    // These routers read tokens straight off the session, so hydrate it from the vault first — otherwise a
    // connector-acquired Microsoft grant reports "not connected" until the user re-logs in via Microsoft SSO.
    { key: 'int_microsoft:/api/integrations/outlook', slot: 'main', path: '/api/integrations/outlook', handlers: (g) => [g.microsoftSessionHydration, require('../routes/integrations/outlook')] },
    { key: 'int_microsoft:/api/integrations/onedrive', slot: 'main', path: '/api/integrations/onedrive', handlers: (g) => [g.microsoftSessionHydration, require('../routes/integrations/oneDrive')] },
];

module.exports = { mounts };
