// @typecheck strict
// English GUI defaults — namespace "automation_image_ai": every key whose part before the first "." is "automation_image_ai".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "automation_image_ai.title": "Images to AI in automations",
    "automation_image_ai.intro": "Whether automations may show pictures to an AI model, or only the text read from them.",
    "automation_image_ai.toggle": "Let automations show images to AI",
    "automation_image_ai.toggle_desc": "An AI step or a data extraction may show a picture (a receipt, a photo of a document) to a model that reads images. When this is off, the step gets the text read from the image instead.",
    "automation_image_ai.rule_shield": "When the Privacy Shield applies to an automation, its images are never sent: the shield cannot check pictures for personal data, so the step uses the text read from them.",
    "automation_image_ai.rule_model": "Only models that read images get them; other models get the text.",
    "automation_image_ai.rule_dry_run": "A test run never sends images.",
    "automation_image_ai.saved": "Saved.",
    "automation_image_ai.save_failed": "Could not save this setting. Try again.",
    "automation_image_ai.forbidden": "Only an admin of this organisation can change this.",
    "automation_image_ai.on_title": "Show images to AI in automations?",
    "automation_image_ai.on_desc": "Pictures that automations read (receipts, photos, scans) are then sent to the AI model provider your organisation uses. They are not stored by Bee Flow, but they cannot be checked for personal data first.",
    "automation_image_ai.on_confirm": "Switch on",
    "automation_image_ai.cancel": "Cancel",
    "automation_image_ai.loading": "Loading…",
    "automation_image_ai.load_failed": "Could not load this setting.",
    "automation_image_ai.retry": "Try again",
    "automation_image_ai.section_title": "Images",
    "automation_image_ai.section_hint": "Pictures to show the AI model: drag in the image handle (sourceHandle) of a \"read file\" step that read an image. It is only sent when your organisation allows images to AI, the Privacy Shield does not apply and the model reads images; otherwise the step uses the text read from the image.",
    "automation_image_ai.row_placeholder": "steps.<read>.output.sourceHandle",
    "automation_image_ai.row_remove": "Remove this image",
    "automation_image_ai.row_add": "Add an image",
};
