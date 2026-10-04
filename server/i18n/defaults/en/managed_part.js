// English GUI defaults — namespace "managed_part": every key whose part before the first "." is "managed_part".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // ── A part managed by a Solution stage (builder banners) ────────────
    "managed_part.banner_title": "Managed by {solution}",
    "managed_part.banner_stage": "{stage} · Release {seq}",
    "managed_part.banner_body": "Read-only so it stays exactly what UAT tested. Change it in Dev and deploy.",
    "managed_part.open_in_dev": "Open in Dev",
    "managed_part.stage_settings": "Stage settings",
    "managed_part.stage_uat": "UAT",
    "managed_part.stage_prd": "Production",
    "managed_part.read_only_hint": "Read-only: this part is managed by a Solution stage.",
    "managed_part.save_refused": "This part is managed by a Solution stage. Change it in Dev and deploy.",
    "managed_part.not_deployed": "This part has not been deployed yet.",
};
