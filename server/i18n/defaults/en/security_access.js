// @typecheck strict
// English GUI defaults — namespace "security_access": every key whose part before the first "." is "security_access".
// The admin dashboard's security and access screens (Privacy Shield preview, MCP client access), admin dashboard round 2026-11.
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `npm run i18n:gen`.
module.exports = {
    "security_access.mcp_cli_hint": "A ready-made command per server for a command-line client. The format is that of Claude Code; another client takes the same address and header.",
    "security_access.shield_review_reveal_body": "“{setting}” is on. That is useful for trust, but it also means shared conversations expose the originals.",
    "security_access.shield_preview_sample": "Send the policy to {email} for {name}, IBAN {iban}.",
};
