import { useId } from 'react';
import type { ModelTierMap } from '@/api/queries/modelTiers';
import { tierLabel, tierI18nKey, TIER_META } from '../licensing/tierMeta';
import type { TranslateFn } from '@/hooks/useTranslation';

interface Props {
    tiers: ModelTierMap;
    value: string;
    onChange: (tier: string) => void;
    t: TranslateFn;
}

export default function CoworkModelPicker({ tiers, value, onChange, t }: Props) {
    const id = useId();
    const options = Object.entries(tiers).filter(([key]) => key !== 'standard' && key !== 'swarm');
    if (!options.length) return null;
    const name = (key: string) => {
        if (key === 'auto') return t('cowork_task.uses.auto_model', 'Automatic');
        if (TIER_META[key]) return t(tierI18nKey(key), tierLabel(key));
        return tierLabel(key, tiers);
    };
    return (
        <div className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
            <label htmlFor={id} className="text-[13px] font-medium text-[var(--text-secondary)]">
                {t('cowork_task.uses.model', 'AI model')}
            </label>
            <select id={id} value={value} onChange={event => onChange(event.target.value)}
                className="min-w-0 max-w-full min-h-9 cursor-pointer rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 text-[13px] font-medium text-[var(--text-primary)]">
                {!options.some(([key]) => key === value) && <option value={value} disabled>{name(value)}</option>}
                {options.map(([key, config]) => <option key={key} value={key}>
                    {name(key)}{config.modelId ? ` · ${config.modelId}` : ''}
                </option>)}
            </select>
        </div>
    );
}
