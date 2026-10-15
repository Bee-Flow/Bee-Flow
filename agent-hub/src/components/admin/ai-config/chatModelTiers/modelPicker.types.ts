/** The model catalogue and hidden-model bindings every tier / model-setting section threads into its pickers. */
import type { ChatModelCatalog, HiddenModelsState } from './chatModelCatalog';

export interface ModelPickerSource {
    chatModels: ChatModelCatalog['chatModels'];
    byProvider: ChatModelCatalog['byProvider'];
    hiddenModelIds: HiddenModelsState['hiddenModelIds'];
    toggleHiddenModel: HiddenModelsState['toggleHiddenModel'];
}
