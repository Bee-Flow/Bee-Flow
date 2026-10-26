import { Download, MoreHorizontal } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import useDismiss from './useDismiss';

interface Props {
    /** Download the workflow as the JSON the list row menu also exports. */
    onExportJson?: (() => void) | null;
}

/**
 * Workflow-level actions inside the editor, so a common task such as backing
 * up the workflow as JSON no longer means leaving the editor for the list's
 * row menu (BFSF-405). Renders nothing when there is no action to offer.
 */
export default function WorkflowMenu({ onExportJson }: Props) {
    const { t } = useTranslation();
    const { open, setOpen, ref } = useDismiss();
    if (!onExportJson) return null;
    const label = t('automations.header.workflow_actions', 'Workflow actions');
    return (
        <div ref={ref} className="relative flex-shrink-0">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={label}
                title={label}
                className="w-[30px] h-[30px] rounded-lg grid place-items-center text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition"
            >
                <MoreHorizontal size={16} />
            </button>
            {open && (
                <div role="menu" className="absolute right-0 top-full mt-1 z-40 w-48 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg py-1">
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setOpen(false); onExportJson(); }}
                        className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition"
                    >
                        <Download size={13} aria-hidden="true" />
                        {t('automations.header.export_json', 'Export JSON')}
                    </button>
                </div>
            )}
        </div>
    );
}
