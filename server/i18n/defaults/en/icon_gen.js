// @typecheck strict
// English GUI defaults — namespace "icon_gen": every key whose part before the first "." is "icon_gen".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// AI icon generation in Appearance > Icons (the pack editor and the icon picker), on the
// image models the server is configured with. Provider-neutral on purpose.
module.exports = {
    "icon_gen.generate_with_ai": "Generate with AI",
    "icon_gen.bulk_title": "Generate all icons with AI",
    "icon_gen.bulk_description": "Generates an icon for every entry in the catalogue with the chosen image model. Your own icons are kept unless you tick overwrite.",
    "icon_gen.image_model": "Image model",
    "icon_gen.generate": "Generate",
    "icon_gen.generating": "Generating…",
    "icon_gen.bulk_failed": "Generating the icons failed.",
    "icon_gen.picker_subtitle_no_ai": "Pick an emoji or upload an image. Default: {default}",
    "icon_gen.picker_hint": "Describe the icon you want. It is made with the image model chosen below.",
    "icon_gen.picker_generate": "Generate icon",
    "icon_gen.failed": "Generating the icon failed.",
    "icon_gen.failed_reason": "Generating the icon failed: {reason}",
    "icon_gen.no_image": "No image came back. Try a different description.",
};
