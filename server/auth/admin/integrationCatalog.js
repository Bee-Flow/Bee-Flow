// @typecheck
/**
 * Admin Routes — the built-in integration id catalogue, shared by the
 * default-integrations config routes and the org active-integrations routes.
 * Split out of auth/adminRoutes.js.
 */

// All available integration IDs
const ALL_INTEGRATIONS = [
    { id: 'gmail', label: 'Gmail' },
    { id: 'google-calendar', label: 'Calendar' },
    { id: 'google-drive', label: 'Drive' },
    { id: 'google-docs', label: 'Docs' },
    { id: 'image-gen', label: 'Image Generation' },
    { id: 'fireflies', label: 'Fireflies' },
    { id: 'youtrack', label: 'YouTrack' },
    { id: 'gamma', label: 'Gamma' },
    { id: 'n8n', label: 'n8n' },
];

module.exports = { ALL_INTEGRATIONS };
