import { AlertTriangle, Loader2 } from 'lucide-react';
import React from 'react';
import { ADDABLE, type KindLoad } from './addPartsSources';
import { kindInkClass } from './kindBar';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * One tile per kind a Solution can hold: its icon, its name and how many of
 * YOUR things of that kind can be added right now. The count is of what is free
 * to add (not what sits in another Solution), and a listing that could not be
 * read shows a warning instead of a number: "0" would say "you have none".
 */

export interface AddKindTilesProps {
    /** Left out on the empty screen, where nothing has been read yet: tiles then show no count. */
    loads?: Record<string, KindLoad>;
    active: string | null;
    onPick: (kind: string) => void;
    bare?: boolean;
}

export function addableCount(load: KindLoad | undefined): number | null {
    return load && load.status === 'ok' ? load.items.filter(i => i.inProjectId === null).length : null;
}

export default function AddKindTiles({ loads = {}, active, onPick, bare = false }: AddKindTilesProps) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="group" aria-label={t('solutions.add_panel_title', 'Add to this Solution')} data-testid="add-kind-tiles">
            {ADDABLE.map(section => {
                const load = loads[section.kind];
                const count = addableCount(load);
                const Icon = section.icon;
                const selected = active === section.kind;
                return (
                    <button
                        key={section.kind}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onPick(section.kind)}
                        data-testid={`add-kind-${section.kind}`}
                        data-state={load?.status ?? 'loading'}
                        className={`flex items-center gap-2 px-3 min-h-[44px] rounded-[var(--radius-md)] border text-left text-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                            selected
                                ? 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)] ring-1 ring-[var(--accent-primary)]'
                                : 'border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] hover:border-[var(--border-default)]'
                        }`}
                    >
                        <Icon className={`w-4 h-4 flex-shrink-0 ${kindInkClass(section.kind)}`} aria-hidden="true" />
                        <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">{t(section.labelKey)}</span>
                        {load?.status === 'ok' && (
                            <span
                                className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                                data-testid={`add-kind-count-${section.kind}`}
                            >
                                {count}
                            </span>
                        )}
                        {load?.status === 'error' && (
                            <AlertTriangle className="w-3.5 h-3.5 text-[var(--warning)]" aria-label={t('solutions.add_list_failed', 'That list could not be loaded. Try again shortly.')} />
                        )}
                        {!bare && (!load || load.status === 'loading') && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none text-[var(--text-tertiary)]" aria-hidden="true" />
                        )}
                    </button>
                );
            })}
        </div>
    );
}
