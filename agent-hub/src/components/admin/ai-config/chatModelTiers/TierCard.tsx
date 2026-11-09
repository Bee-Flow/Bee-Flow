// One standard tier as a row of the chat-model-tier list: its name and
// description on the left, the model picker and a settings toggle on the
// right. The per-tier settings open in the inset area under the row
// (TierCardSettings). All bindings are threaded in as props from the panel.
import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { TierDef, TierDefaults } from './constants';
import TierCardSettings from './TierCardSettings';
import { TierGlyph } from './tierIcons';
import type { TierSettings, CatalogModel } from './tierTypes';
import { getModelDisplayName } from '@/api/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import { SettingRow } from '../ui/SettingsList';
import { useTranslation } from '@/hooks/useTranslation';

interface TierCardProps {
    tier: TierDef;
    tierConfig: TierSettings;
    updateFn: (tierKey: string, field: string, value: unknown) => void;
    defaults: TierDefaults | null;
    expandedTier: string | null;
    setExpandedTier: React.Dispatch<React.SetStateAction<string | null>>;
    chatModels: CatalogModel[];
    byProvider: Record<string, CatalogModel[]>;
    hiddenModelIds: string[];
    toggleHiddenModel: (modelId: string) => Promise<void>;
    isLocal: (id: string) => boolean;
    reasoningCapable: (id: string) => boolean;
    applyClaudeRecommendedForTier: (tierKey: string) => void;
}

export default function TierCard(props: TierCardProps) {
    const { t } = useTranslation();
    const { tier, tierConfig, updateFn, defaults, expandedTier, setExpandedTier, chatModels, byProvider, hiddenModelIds, toggleHiddenModel } = props;
    // The Flow tier has a bootstrap model to show even where the tier has no defaults (EU).
    const hasSettings = !!defaults || tier.key === 'standard';
    const isExpanded = hasSettings && expandedTier === tier.key;
    const selectedModel = chatModels.find(m => m.id === tierConfig.modelId);
    const displayName = selectedModel ? getModelDisplayName(selectedModel) : null;
    const selectedLabel = selectedModel
        ? (displayName !== selectedModel.id ? displayName : selectedModel.id)
        : t('admin_ai_config.tier_not_configured', 'Not configured');

    return (
        <SettingRow
            icon={<TierGlyph tier={tier} />}
            label={tier.label}
            hint={tier.desc}
            expanded={isExpanded ? <TierCardSettings {...props} /> : undefined}
        >
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <SearchableModelSelect
                        value={tierConfig.modelId || ''}
                        label={selectedLabel}
                        groups={byProvider}
                        onChange={({ modelId }) => updateFn(tier.key, 'modelId', modelId)}
                        hiddenIds={hiddenModelIds}
                        onToggleHidden={toggleHiddenModel} />
                </div>
                {hasSettings && (
                    <button
                        type="button"
                        onClick={() => setExpandedTier(isExpanded ? null : tier.key)}
                        aria-expanded={isExpanded}
                        aria-label={t('admin_ai_config.tier_settings_toggle', 'Settings for {name}', { name: tier.label })}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                )}
            </div>
        </SettingRow>
    );
}
