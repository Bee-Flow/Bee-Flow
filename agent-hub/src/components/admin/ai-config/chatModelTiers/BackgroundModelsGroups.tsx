// The background models of the Models page, one row per job: the small models
// that run beside a chat (classifier, titles, memory extraction), then the two
// automation steps. Rows only change the page's draft; the save bar stores them.
import ModelSettingRow from './ModelSettingRow';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useTranslation } from '@/hooks/useTranslation';

type Setting = Pick<ModelSetting, 'model' | 'setModel'>;

interface BackgroundModelsGroupsProps extends ModelPickerSource {
    classifier: Setting;
    title: Setting;
    memory: Setting;
    aiStep: Setting;
    dataExtraction: Setting;
}

export default function BackgroundModelsGroups({ classifier, title, memory, aiStep, dataExtraction, ...picker }: BackgroundModelsGroupsProps) {
    const { t } = useTranslation();
    const useFast = t('admin_ai_config.tier_use_fast', '— Use Fast tier model —');
    return (
        <>
            <SettingsGroup
                title={t('admin_ai_config.bg_models_title', 'Background models')}
                description={t('admin_ai_config.bg_models_hint', 'Small models for the jobs that run beside a chat. Pick the cheapest, fastest one that does the job.')}
            >
                <SettingsList>
                    <ModelSettingRow
                        {...picker}
                        setting={classifier}
                        title={t('admin_ai_config.tier_cls_title', 'Auto-tier Classifier Model')}
                        hint={t('admin_ai_config.tier_cls_hint', 'Picks the model used to classify Auto-tier prompts. Choose the cheapest, fastest model: classification only needs ~8 tokens of output. Defaults to the Fast tier model when unset.')}
                        emptyLabel={useFast}
                    />
                    <ModelSettingRow
                        {...picker}
                        setting={title}
                        title={t('admin_ai_config.tier_title_title', 'Title Generation Model')}
                        hint={t('admin_ai_config.tier_title_hint', 'Model used to name conversations: a tiny, tool-free call made after the second reply. Pick the cheapest, fastest model so a heavy Fast tier doesn\'t make titling expensive. Defaults to the Fast tier model when unset.')}
                        emptyLabel={useFast}
                    />
                    <ModelSettingRow
                        {...picker}
                        setting={memory}
                        title={t('admin_ai_config.tier_mem_title', 'Memory Extraction Model')}
                        hint={t('ai_model_setup.memory_model_hint', 'Reads each finished exchange for facts worth remembering, in organisations that switched Memory on: a small background call after every reply, thinking off. On a self-hosted server with one slot, pick a tiny model so extraction never queues in front of the next turn. Defaults to the Fast tier model when unset.')}
                        emptyLabel={useFast}
                    />
                </SettingsList>
            </SettingsGroup>
            <SettingsGroup
                title={t('ai_model_setup.bg_automation_title', 'Automations')}
                description={t('ai_model_setup.bg_automation_hint', 'The models automation steps run on, whatever tier the automation itself uses.')}
            >
                <SettingsList>
                    <ModelSettingRow
                        {...picker}
                        setting={aiStep}
                        title={t('ai_model_setup.ai_step_title', 'AI step model')}
                        hint={t('ai_model_setup.ai_step_hint', 'Model for automation AI steps that ask for Auto or Fast, the tiers the builder writes by default. Steps that pick Thinking or another tier keep their own model. Leave empty to use the step\'s own tier.')}
                        emptyLabel={t('admin_ai_config.tier_aistep_default', '— Use the step\'s own tier —')}
                    />
                    <ModelSettingRow
                        {...picker}
                        setting={dataExtraction}
                        title={t('admin_ai_config.tier_dx_title', 'Data Extraction Model')}
                        hint={t('admin_ai_config.tier_dx_hint', 'The model every Data extraction step in an automation runs on, whatever tier the automation itself uses: one small call per document, thinking off, temperature zero, answering in a fixed set of fields. Pick a small, fast model here; a large chat model gains nothing on this job and holds the slot. Unset falls back to the Fast tier\'s model.')}
                        emptyLabel={useFast}
                    />
                </SettingsList>
            </SettingsGroup>
        </>
    );
}
