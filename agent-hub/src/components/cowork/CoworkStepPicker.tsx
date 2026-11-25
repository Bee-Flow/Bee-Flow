import { useRef } from 'react';
import { useEntitlements } from '../licensing/EntitlementsContext';
import { paletteItemForType } from '../automation/Builder/flow/stepPalette';
import type { TranslateFn } from '@/hooks/useTranslation';

export default function CoworkStepPicker({ types, onPick, t }: { types?: string[]; onPick: (label: string) => void; t: TranslateFn }) {
    const details = useRef<HTMLDetailsElement>(null);
    const access = useEntitlements();
    if (!types?.length || !access.can?.('automations')) return null;
    return (
        <details ref={details} className="px-4 pb-2">
            <summary className="cursor-pointer text-[13px] font-medium">{t('cowork_home.choose_step', 'Choose a step')}</summary>
            <div className="mt-2 flex flex-wrap gap-1">
                {types.filter((type) => type !== 'switch').map((type) => {
                    const item = paletteItemForType(type, t);
                    if (!item?.icon) return null;
                    const Icon = item.icon;
                    const label = item.label;
                    return <button type="button" key={type} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[13px] hover:bg-[var(--item-hover-bg)]" onClick={() => {
                        if (details.current) details.current.open = false;
                        onPick(label);
                    }}><Icon size={15} aria-hidden="true" />{label}</button>;
                })}
            </div>
        </details>
    );
}
