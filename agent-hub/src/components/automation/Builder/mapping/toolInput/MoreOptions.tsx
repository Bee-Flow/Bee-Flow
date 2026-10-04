import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { foldedNames } from './toolInputHelpers';

/**
 * "More options · version · text encoding · max size   all default"
 * (round 4, artboard 4a/4c): the optional settings nobody has touched, folded
 * behind one line that names them, so what is in the fold is readable
 * before it is opened. partitionInputs only folds settings that hold
 * nothing, so "all default" is the truth whenever it is shown; an auto-mapped
 * one is counted instead.
 */
export default function MoreOptions({ labels, open, onToggle, autoCount = 0, children }: {
    labels: string[];
    open: boolean;
    onToggle: (open: boolean) => void;
    autoCount?: number;
    children: ReactNode;
}) {
    const { t } = useTranslation();
    return (
        <div className="rounded-lg border border-[var(--border-default)]" data-testid="param-more-options">
            <button
                type="button"
                onClick={() => onToggle(!open)}
                aria-expanded={open}
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left hover:bg-[var(--bg-secondary)] rounded-lg"
            >
                {open ? <ChevronDown size={13} className="shrink-0 text-[var(--text-tertiary)]" /> : <ChevronRight size={13} className="shrink-0 text-[var(--text-tertiary)]" />}
                <span className="font-semibold text-[var(--text-primary)] shrink-0">{t('automations.ndv.more_options', 'More options')}</span>
                <span className="min-w-0 truncate text-[var(--text-tertiary)]">{foldedNames(labels)}</span>
                <span className="ml-auto shrink-0 text-[11px] text-[var(--text-tertiary)]">
                    {autoCount > 0
                        ? t('automations.ndv.n_auto_filled', '{n} filled in for you', { n: autoCount })
                        : t('automations.ndv.all_default', 'all default')}
                </span>
            </button>
            {open && <div className="px-3 pb-3 pt-1 space-y-3">{children}</div>}
        </div>
    );
}
