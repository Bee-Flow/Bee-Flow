// @typecheck strict
'use strict';
// Delete a dataset nothing uses any more (builderTools/removeDatasetTool.mts).
module.exports = {
    name: 'app_remove_dataset',
    since: 3,
    description: 'Delete one of the app\'s datasets. Refused, with the places listed, while a component or a step still uses it: re-bind or remove those first. The dataset ids come from app_get_data_model.',
    schema: {
        type: 'object',
        properties: { datasetId: { type: 'string', description: 'The id of the dataset to delete.' } },
        required: ['datasetId'],
    },
    apply: (/** @type {Parameters<typeof import('../removeDatasetTool.mts').applyRemoveDataset>[0]} */ draftWrap, /** @type {unknown} */ args) => require('../removeDatasetTool.mts').applyRemoveDataset(draftWrap, args),
    mutating: true,
    dataModel: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_tab.act_remove_dataset', en: 'Removed a dataset' },
};
