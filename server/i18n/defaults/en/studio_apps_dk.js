// @typecheck strict
// English GUI defaults — namespace "studio_apps_dk": every key whose part before the first "." is "studio_apps_dk".
// Found by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    'studio_apps_dk.heading': 'Who can see and change this field',
    'studio_apps_dk.limit_read': 'Only some roles can see it',
    'studio_apps_dk.limit_write': 'Only some roles can change it',
    'studio_apps_dk.read_hint': 'You always see it. Every other role gets records without this field, and a list, filter, sort or chart that uses it does not load for them.',
    'studio_apps_dk.role_public': 'Visitors of public pages',
    'studio_apps_dk.write_hint': 'You can always change it. Without this list, the roles that can see the field can change it.',
};
