// @typecheck strict
// English GUI defaults — namespace "admin_no_org": every key whose part before the first "." is "admin_no_org".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/admin_no_org.json. Admin pages for an account or server without an organisation: the way to create one, and the Compliance Center's state for an account outside any organisation.
module.exports = {
    "admin_no_org.no_orgs_yet": "There is no organisation on this server yet. This page works on one organisation.",
    "admin_no_org.create_org": "Create an organisation",
    "admin_no_org.orgs_empty_title": "No organisations yet",
    "admin_no_org.orgs_empty_desc": "An organisation holds its people, groups, models and settings. Add the first one to get started.",
    "admin_no_org.compliance_title": "No organisation to check",
    "admin_no_org.compliance_desc": "The Compliance Center works on your own organisation, and this account is not in one. Open it with an account of the organisation you want to check.",
};
