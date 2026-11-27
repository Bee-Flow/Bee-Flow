// @typecheck strict
'use strict';
/**
 * The mounts of module "int_google" (Google Workspace): its rows of the route table that
 * the core mounts, as data (modules/firstParty/contract.js MountRow), with the
 * same gates. Order: the core's (modules/firstParty/order.json "mounts"); routers are required
 * at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    { key: 'int_google:/api/integrations/google', slot: 'main', path: '/api/integrations/google', handlers: () => [require('../routes/integrations/googleWorkspace')] },
    // BFSF-255: hydrate password-account sessions from the encrypted vault so the
    // session-based Google surfaces (pickers, /status) work after connecting via
    // Settings → Connections, not only after Google-SSO login.
    // requireAuthedUser first: the hydration reads the signed-in user's vault.
    { key: 'int_google:/api/integrations/gdrive', slot: 'main', path: '/api/integrations/gdrive', handlers: (g) => [g.requireAuthedUser, g.googleSessionHydration, require('../routes/integrations/googleDrive')] },
    { key: 'int_google:/api/integrations/gmail', slot: 'main', path: '/api/integrations/gmail', handlers: (g) => [g.requireAuthedUser, g.googleSessionHydration, require('../routes/integrations/gmail')] },
    { key: 'int_google:/api/integrations/calendar', slot: 'main', path: '/api/integrations/calendar', handlers: (g) => [g.requireAuthedUser, g.googleSessionHydration, require('../routes/integrations/calendar')] },
    { key: 'int_google:/api/integrations/contacts', slot: 'main', path: '/api/integrations/contacts', handlers: (g) => [g.requireAuthedUser, g.googleSessionHydration, require('../routes/integrations/contacts')] },
    { key: 'int_google:/api/integrations/keep', slot: 'main', path: '/api/integrations/keep', handlers: (g) => [g.requireAuthedUser, g.googleSessionHydration, require('../routes/integrations/keep')] },
];

module.exports = { mounts };
