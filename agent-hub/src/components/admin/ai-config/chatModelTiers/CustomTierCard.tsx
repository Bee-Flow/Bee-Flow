// One custom tier as a row of the custom-tier list: an editable name, icon and
// description on the left, the model picker, a settings toggle and delete on
// the right; the per-tier settings open under the row (CustomTierSettings).
// All bindings are threaded in as props from the panel.
import React from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import CustomTierSettings from './CustomTierSettings';
import type { ModelPickerSource } from './modelPicker.types';
import type { CustomTier } from './tierTypes';
import type { CustomTiersState } from './useCustomTiers';
import { getModelDisplayName } from '@/api/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import { FIELD_INPUT, SettingRow } from '../ui/SettingsList';
import { useTranslation } from '@/hooks/useTranslation';

interface CustomTierCardProps extends ModelPickerSource {
    tier: CustomTier;
    expandedCustomId: CustomTiersState['expandedCustomId'];
    setExpandedCustomId: CustomTiersState['setExpandedCustomId'];
    reasoningCapable: (id: string) => boolean;
    updateCustomTier: CustomTiersState['updateCustomTier'];
    renameCustomTier: CustomTiersState['renameCustomTier'];
    removeCustomTier: CustomTiersState['removeCustomTier'];
    toggleCustomTaskType: CustomTiersState['toggleCustomTaskType'];
}

const ICON_BUTTON = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]';

export default function CustomTierCard({
    tier, expandedCustomId, setExpandedCustomId, chatModels, byProvider,
    hiddenModelIds, toggleHiddenModel, reasoningCapable,
    updateCustomTier, renameCustomTier, removeCustomTier, toggleCustomTaskType,
}: CustomTierCardProps) {
    const { t } = useTranslation();
    const isExpanded = expandedCustomId === tier.id;
    const selectedModel = chatModels.find(m => m.id === tier.modelId);
    const displayName = selectedModel ? getModelDisplayName(selectedModel) : null;
    const selectedLabel = selectedModel
        ? (displayName !== selectedModel.id ? displayName : selectedModel.id)
        : t('admin_ai_config.tier_not_configured', 'Not configured');
    // Mistral stamps its own effort vocabulary (none/high) on the model.
    const stampedEfforts = Array.isArray(selectedModel?.efforts) && selectedModel.efforts.length > 0 ? selectedModel.efforts : null;

    const lead = (
        <div className="flex items-start gap-2">
            <input
                type="text"
                value={tier.icon || ''}
                onChange={e => updateCustomTier(tier.id, { icon: e.target.value.slice(0, 4) })}
                maxLength={4}
                className={`${FIELD_INPUT} !w-11 shrink-0 px-1 text-center`}
                title={t('admin_ai_config.custom_icon_title', 'Icon or emoji')}
                aria-label={t('admin_ai_config.custom_icon_title', 'Icon or emoji')} />
            <div className="min-w-0 flex-1 space-y-1.5">
                <input
                    type="text"
                    value={tier.label || ''}
                    onChange={e => renameCustomTier(tier.id, e.target.value)}
                    placeholder={t('admin_ai_config.custom_name_placeholder', 'Tier name')}
                    aria-label={t('admin_ai_config.custom_name_placeholder', 'Tier name')}
                    className={`${FIELD_INPUT} font-medium`} />
                <input
                    type="text"
                    value={tier.description || ''}
                    onChange={e => updateCustomTier(tier.id, { description: e.target.value })}
                    placeholder={t('admin_ai_config.custom_desc_placeholder', 'Short description (shown in tier picker)')}
                    aria-label={t('admin_ai_config.custom_desc_placeholder', 'Short description (shown in tier picker)')}
                    className={`${FIELD_INPUT} text-xs`} />
                <p className="m-0 font-mono text-[10px] text-[var(--text-tertiary)]">{tier.id}</p>
            </div>
        </div>
    );

    return (
        <SettingRow
            lead={lead}
            label={tier.label}
            expanded={isExpanded ? (
                <CustomTierSettings
                    tier={tier}
                    stampedEfforts={stampedEfforts}
                    reasoningCapable={reasoningCapable}
                    updateCustomTier={updateCustomTier}
                    toggleCustomTaskType={toggleCustomTaskType}
                />
            ) : undefined}
        >
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <SearchableModelSelect
                        value={tier.modelId || ''}
                        label={selectedLabel}
                        groups={byProvider}
                        onChange={({ modelId }) => updateCustomTier(tier.id, { modelId })}
                        hiddenIds={hiddenModelIds}
                        onToggleHidden={toggleHiddenModel}
                    />
                </div>
                <button
                    type="button"
                    onClick={() => setExpandedCustomId(isExpanded ? null : tier.id)}
                    aria-expanded={isExpanded}
                    aria-label={t('admin_ai_config.tier_settings_toggle', 'Settings for {name}', { name: tier.label || tier.id })}
                    className={ICON_BUTTON}
                >
                    <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
                <button
                    type="button"
                    onClick={() => removeCustomTier(tier.id)}
                    className={`${ICON_BUTTON} hover:!text-[var(--error)]`}
                    title={t('admin_ai_config.custom_delete_title', 'Delete tier')}
                    aria-label={t('admin_ai_config.custom_delete_title', 'Delete tier')}
                >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>
        </SettingRow>
    );
}
