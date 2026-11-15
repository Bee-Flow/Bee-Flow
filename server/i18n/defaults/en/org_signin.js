// @typecheck strict
// English GUI defaults — namespace "org_signin": every key whose part before the first "." is "org_signin".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// The organisation's preferred sign-in method (Admin > Organisation): a preference, not a lock.
module.exports = {
    "org_signin.nav": "Preferred sign-in method",
    "org_signin.title": "Preferred sign-in method",
    "org_signin.subtitle": "How you would like members of this organisation to sign in. It is a preference: the other sign-in methods of this server keep working, and you can change it at any time.",
    "org_signin.unavailable_password": "Password sign-in is turned off on this server.",
    "org_signin.unavailable_not_set_up": "Not set up on this server yet. A platform administrator sets it up under Whole server › Identity & access › Sign-in & SSO.",
    "org_signin.unavailable_unlicensed": "Not included in this server's licence.",
    "org_signin.allowed_domains_desc": "E-mail domains that belong to this organisation. Someone who signs in through single sign-on with an address on one of these domains is linked to this organisation, and no new organisation can be created with them.",
    "org_signin.auto_approve": "Let people from your domains in straight away",
    "org_signin.auto_approve_desc": "Someone who signs in through single sign-on with an e-mail address on this organisation's domain joins at once, in the default groups. When this is off, they wait as pending until an administrator lets them in.",
    "org_signin.auto_approve_failed": "The setting could not be saved. Try again.",
    "org_signin.allowed_domains": "Allowed domains",
    "org_signin.allowed_domains_placeholder": "company.com",
    "org_signin.allowed_domains_save_hint": "Add a domain, then save the page with Save changes.",
    "org_signin.method_password": "Username and password",
};
