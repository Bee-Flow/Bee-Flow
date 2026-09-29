// English GUI defaults — namespace "maintenance": every key whose part before the first "." is "maintenance".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // ── Maintenance / deployment banner (Track U14, 2026-09) ───
    'maintenance.banner.pending_title': 'Update being installed',
    'maintenance.banner.pending_body': 'The connection will drop for a moment — an answer in progress may stop mid-sentence. You can continue in {eta}.',
    'maintenance.banner.overdue_title': 'Update is taking longer than expected',
    'maintenance.banner.overdue_body': 'Still reconnecting. Your work is saved — this page will say so as soon as the update lands.',
    'maintenance.banner.recovered_title': 'Update installed',
    'maintenance.banner.recovered_body': 'This tab is still on the previous version — reload to switch. Until then some things may look stale or misbehave.',
    'maintenance.banner.reload': 'Reload',
    'maintenance.banner.eta_moment': 'any moment now',
    'maintenance.banner.eta_seconds': 'about {seconds} seconds',
    'maintenance.banner.eta_minute': 'about a minute',
    'maintenance.banner.eta_minutes': 'about {minutes} minutes',
};
