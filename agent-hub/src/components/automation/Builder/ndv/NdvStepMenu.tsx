import { Copy as CopyIcon, MoreHorizontal, Pin, PinOff, Power, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import AnchoredMenu from '../../../shared/AnchoredMenu';

/**
 * The header's ⋯ menu (round 4): Pin / Duplicate / Disable / Delete. They are
 * step PLUMBING, not configuration, so they left the header row for one
 * menu; the node's hover chrome and right-click menu still offer them too.
 * Every item keeps the long title it had as a header button, so the words a
 * screen reader or a hover gives did not change with the move.
 */
export interface NdvStepMenuProps {
    pinned: boolean;
    canPin: boolean;
    pinTitle: string;
    onTogglePin: (() => void) | null;
    disabled: boolean;
    onToggleDisabled: (() => void) | null;
    onDuplicate: (() => void) | null;
    onDelete: (() => void) | null;
}

const item = 'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed';

export default function NdvStepMenu({
    pinned, canPin, pinTitle, onTogglePin, disabled, onToggleDisabled, onDuplicate, onDelete,
}: NdvStepMenuProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    if (!onTogglePin && !onToggleDisabled && !onDuplicate && !onDelete) return null;
    const run = (fn: (() => void) | null) => () => { setOpen(false); fn?.(); };
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('routines.ndv.more_actions', 'More step actions')}
                title={t('routines.ndv.more_actions', 'More step actions')}
                data-testid="ndv-more-menu"
                className="w-[30px] h-[30px] shrink-0 grid place-items-center rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
            >
                <MoreHorizontal size={15} />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                minWidth={200}
                role="menu"
                className="p-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg"
            >
                {onTogglePin && (
                    <button
                        type="button"
                        role="menuitem"
                        onClick={run(onTogglePin)}
                        disabled={!canPin && !pinned}
                        title={pinTitle}
                        className={`${item} ${pinned ? 'text-[var(--pinned)]' : 'text-[var(--text-primary)]'} hover:bg-[var(--bg-tertiary)]`}
                    >
                        {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                        {pinned ? t('routines.ndv.pinned', 'Pinned') : t('routines.ndv.pin', 'Pin')}
                    </button>
                )}
                {onDuplicate && (
                    <button
                        type="button"
                        role="menuitem"
                        onClick={run(onDuplicate)}
                        title={t('routines.ndv.duplicate_title', 'Duplicate this step and its settings')}
                        className={`${item} text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]`}
                    >
                        <CopyIcon size={13} /> {t('routines.ndv.duplicate', 'Duplicate')}
                    </button>
                )}
                {onToggleDisabled && (
                    <button
                        type="button"
                        role="menuitem"
                        onClick={run(onToggleDisabled)}
                        title={disabled
                            ? t('routines.ndv.reenable_title', 'Re-enable this node')
                            : t('routines.ndv.disable_title', 'Disable this node (skipped during execution)')}
                        className={`${item} ${disabled ? 'text-[var(--warning)]' : 'text-[var(--text-primary)]'} hover:bg-[var(--bg-tertiary)]`}
                    >
                        <Power size={13} />
                        {disabled ? t('routines.ndv.disabled', 'Disabled') : t('routines.ndv.disable', 'Disable')}
                    </button>
                )}
                {onDelete && (
                    <button
                        type="button"
                        role="menuitem"
                        onClick={run(onDelete)}
                        title={t('routines.ndv.delete_title', 'Delete this step (reconnects its neighbours)')}
                        className={`${item} text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]`}
                    >
                        <Trash2 size={13} /> {t('common.delete', 'Delete')}
                    </button>
                )}
            </AnchoredMenu>
        </>
    );
}
