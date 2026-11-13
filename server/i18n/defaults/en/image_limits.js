// @typecheck strict
// English GUI defaults — namespace "image_limits": every key whose part before the first "." is "image_limits".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "image_limits.window_hour": "Per hour",
    "image_limits.window_day": "Per 24 hours",
    "image_limits.window_week": "Per 7 days",
    "image_limits.window_month": "Per 30 days",
    "image_limits.not_set": "Not set",
    "image_limits.rules_hint": "Empty: not set. 0: no limit.",
    "image_limits.invalid": "An image limit is a whole number from 0 to 1,000,000, or empty.",
    "image_limits.save": "Save image limits",
    "image_limits.cancel": "Cancel",
    "image_limits.save_failed": "The image limits could not be saved.",
    "image_limits.user_label": "Image limits",
    "image_limits.user_hint": "This person's own limits. An empty window uses their groups (the most generous one), then the organisation's default. 0 lifts the limit for them.",
    "image_limits.group_label": "Image limits per member",
    "image_limits.group_hint": "Each member gets these limits for themselves. A member's own limit comes first; with several groups the most generous one applies. An empty window uses the organisation's default.",
    "image_limits.org_title": "Image limits",
    "image_limits.org_desc": "How many images each user may generate. This is the default for everyone; a group or a user can have their own limits, which come first.",
    "image_limits.org_label": "Images per user",
    "image_limits.quota_hour": "{used} of {limit} images used in the last hour",
    "image_limits.quota_day": "{used} of {limit} images used in the last 24 hours",
    "image_limits.quota_week": "{used} of {limit} images used in the last 7 days",
    "image_limits.quota_month": "{used} of {limit} images used in the last 30 days",
};
