// @typecheck strict
// English GUI defaults — namespace "azure_image_deployments": every key whose part before the first "." is "azure_image_deployments".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "azure_image_deployments.title": "Image deployments",
    "azure_image_deployments.deployment": "Deployment name",
    "azure_image_deployments.deployment_placeholder": "e.g. images-prod",
    "azure_image_deployments.model": "Model",
    "azure_image_deployments.model_placeholder": "e.g. gpt-image-1.5",
    "azure_image_deployments.price": "Price per image (€)",
    "azure_image_deployments.price_placeholder": "Not set",
    "azure_image_deployments.remove": "Remove deployment {n}",
    "azure_image_deployments.remove_title": "Remove",
    "azure_image_deployments.add": "Add image deployment",
    "azure_image_deployments.hint": "Uses the endpoint and key above. Supported models: gpt-image and MAI-Image (FLUX is not). The price per image is what Usage shows for each image; leave it empty to record no cost.",
    "azure_image_deployments.price_invalid": "A price per image is a number from 0 to 1000, or empty.",
    "azure_image_deployments.too_many": "At most 20 image deployments.",
};
