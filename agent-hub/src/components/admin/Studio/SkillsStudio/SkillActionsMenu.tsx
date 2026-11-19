import { MoreHorizontal, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import AnchoredMenu from '@/components/shared/AnchoredMenu';
import useTranslation from '@/hooks/useTranslation';

/**
 * The ⋯ menu of a skill, in the editor's header and on its row in the list.
 * One action today, Delete…, which opens SkillDeleteDialog (the Used-by list
 * first, the server's 409 `in_use` question before the confirmed request).
 * A menu rather than a bare trash icon: deleting breaks every agent that
 * attaches the skill, and a red icon beside the name is one slip away.
 */
export interface SkillActionsMenuProps {
    name: string;
    onDelete: () => void;
    /** `row`: the small square on a list row; `header`: the 32px button beside "Improve with AI". */
    variant?: 'row' | 'header';
    testid?: string;
}

export default function SkillActionsMenu({ name, onDelete, variant = 'header', testid = 'skill-actions' }: SkillActionsMenuProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);
    const size = variant === 'row' ? 'w-6 h-6 rounded-md' : 'w-8 h-8 rounded-[10px] border border-[var(--border-default)]';
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('skillStore.actions_for', 'Actions for {name}', { name })}
                title={t('skillStore.actions', 'More actions')}
                data-testid={testid}
                className={`${size} grid place-items-center flex-shrink-0 text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition`}
            >
                <MoreHorizontal size={14} aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={200} role="menu" className="p-1">
                <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setOpen(false); onDelete(); }}
                    data-testid={`${testid}-delete`}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left text-[var(--error)] hover:bg-[var(--bg-secondary)]"
                >
                    <Trash2 size={13} aria-hidden="true" />
                    {t('skillStore.delete_action', 'Delete…')}
                </button>
            </AnchoredMenu>
        </>
    );
}
