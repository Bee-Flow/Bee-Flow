import { AlertTriangle } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { TABS } from '../orgShieldTabs';
import { SHIELD_ROW } from '../shieldLayout';

/**
 * Amber, above the pane: a save that landed but not exactly as asked.
 * Reported as a plain success, this is how an admin ends up believing a
 * setting took.
 *
 * Naming the clamped setting is half the job; the other half is getting
 * there. Each pane the note concerns gets a jump button, because without it
 * the admin has the sentence and still has to work out which pane owns it.
 */
export function ShieldClampBanner({
    text, tabs = [], onGoTo, t,
}: { text: string; tabs?: string[]; onGoTo: (id: string) => void; t: TranslateFn }) {
    return (
        <div className={`px-6 pt-3 shrink-0 ${SHIELD_ROW}`}>
            <div
                role="status"
                className="rounded-xl px-3.5 py-2.5 flex items-center gap-2.5 flex-wrap border border-[color-mix(in_srgb,var(--warning)_55%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]"
            >
                <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--warning-ink)]" aria-hidden="true" />
                <p className="text-xs leading-relaxed m-0 min-w-0 flex-1 text-[var(--text-primary)]">{text}</p>
                {tabs.map(id => {
                    const stage = TABS.find(x => x.id === id);
                    if (!stage) return null;
                    return (
                        <button
                            key={id}
                            type="button"
                            onClick={() => onGoTo(id)}
                            className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0 hover:opacity-85 border border-[var(--warning-ink)] text-[var(--warning-ink)]"
                        >
                            <stage.Icon className="w-[11px] h-[11px]" aria-hidden="true" />
                            {t(stage.labelKey, stage.fallback)}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export default ShieldClampBanner;
