// @typecheck strict
// English GUI defaults — namespace "studio_apps_w3a": every key whose part before the first "." is "studio_apps_w3a".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_w3a.json. App Studio copies of an app (a template file, an app archive): what the import
// report says about the uploaded files, the triggers and the column rights that came along.
module.exports = {
    'studio_apps_w3a.import.assets_carried': '{count} uploaded files (pictures, logo, fonts) came along.',
    'studio_apps_w3a.import.assets_left': '{count} uploaded files did not come along; upload them again in the app.',
    'studio_apps_w3a.import.triggers_off': '{count} triggers came along switched off: they start when you publish the app.',
    'studio_apps_w3a.import.unknown_roles': 'Some column rights name a role the app does not have; that role sees nothing of those fields.',
    'studio_apps_w3a.import.webhooks_new': 'A webhook trigger gets a new address and secret when you publish; the old ones did not come along.',
};
