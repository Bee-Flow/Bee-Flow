import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { CHECK_KINDS } from './checkLists';
import type { CheckKind } from './reliabilityModel';

/** The "Add a check" button and the list of kinds it opens. */
export function AddCheckMenu({ titles, available, onAdd }: {
    titles: Record<CheckKind, { title: string }>;
    available: (kind: CheckKind) => boolean;
    onAdd: (kind: CheckKind) => void;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <div className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
            >
                <Plus size={12} /> {t('ai_step_checks.add', 'Add a check')}
            </button>
            {open && (
                <div role="menu" className="mt-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] divide-y divide-[var(--border-subtle)]">
                    {CHECK_KINDS.map(k => (
                        <button
                            key={k} type="button" role="menuitem" disabled={!available(k)}
                            onClick={() => { setOpen(false); onAdd(k); }}
                            className="block w-full text-left px-2 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                        >
                            {titles[k].title}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
