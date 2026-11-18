// @typecheck strict
// English GUI defaults — namespace "sanctions": every key whose part before the first "." is "sanctions".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/sanctions.json. Platform services > Sanctions lists: the status of the imported official
// sanctions lists (EU, UN, Dutch, OFAC, UK) and "Refresh now".
module.exports = {
    "sanctions.entries": "{count} entries",
    "sanctions.interval": "Refreshed every {hours} hours while an organisation uses the lists.",
    "sanctions.interval_off": "Automatic refresh is off on this server (SANCTIONS_REFRESH_INTERVAL_HOURS=0).",
    "sanctions.intro": "This server keeps its own copy of the official sanctions lists. Screening runs here against that copy: names never leave the server. Organisations switch the Sanctions lists integration on themselves.",
    "sanctions.last_error": "Last error: {error}",
    "sanctions.last_success": "Last checked {when}",
    "sanctions.load_failed": "The status of the sanctions lists could not be loaded.",
    "sanctions.loading": "Loading the sanctions lists...",
    "sanctions.no_success": "Never refreshed successfully",
    "sanctions.pep_version": "PEP function lists (Dutch and EU) bundled with this version: {version}.",
    "sanctions.rail_desc": "The official sanctions lists this server imports, and their last refresh.",
    "sanctions.refresh_failed": "The refresh could not be started.",
    "sanctions.refresh_now": "Refresh now",
    "sanctions.refreshing": "Refreshing...",
    "sanctions.status_error": "Last refresh failed",
    "sanctions.status_never": "Not imported yet",
    "sanctions.status_ok": "Up to date",
    "sanctions.title": "Sanctions lists",
};
