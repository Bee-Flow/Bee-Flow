import { ChevronDown, ChevronRight, Package, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import StepRow from './StepRow';
import type { StepRowData } from './StepRow';

const OPEN_KEY = 'routineBlocksOpen';

export interface BuildingBlocksGroupProps {
    /** The building blocks to list, already narrowed by the list's filter box. */
    steps: StepRowData[];
    loading?: boolean;
    /** The filter box has text: an empty group then hides, a matching one opens. */
    filtering?: boolean;
    /** Open regardless of the stored choice (a building block is being edited). */
    forceOpen?: boolean;
    /** Drawn at the top of the list instead of below it: no rule above. */
    leading?: boolean;
    selectedId?: string | null;
    onOpen: (id: string) => void;
    onOpenRuns?: ((id: string) => void) | null;
    onDelete?: ((step: StepRowData) => void) | null;
    /** Offered in the empty group. */
    onCreate?: (() => void) | null;
}

/**
 * "Building blocks · n": the reusable Steps, in the same list as the
 * automations, below them and their folders (owner, 2026-09-28; they used to
 * have a tab of their own). Collapsible like a folder; whether it is open is
 * per user, per browser, and it starts open so nobody has to find it.
 */
export default function BuildingBlocksGroup(props: BuildingBlocksGroupProps) {
    const { steps, filtering, forceOpen, leading } = props;
    const { t } = useTranslation();
    const [stored, setStored] = useState<boolean>(() => scopedStorage.getJSON<boolean>(OPEN_KEY, true) !== false);
    const toggle = () => {
        setStored((prev) => {
            const next = !prev;
            try { scopedStorage.setJSON(OPEN_KEY, next); } catch { /* storage best-effort */ }
            return next;
        });
    };

    // While searching, a group without matches is noise (the folders do the same).
    if (filtering && steps.length === 0) return null;
    const open = stored || !!filtering || !!forceOpen;

    return (
        <div className={leading ? 'mb-1' : 'mt-2 border-t border-[var(--border-default)] pt-1'} data-testid="routine-blocks">
            <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                data-tour="automation-building-blocks"
                className="flex items-center gap-1 w-full text-left px-1.5 py-1 rounded-md text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
            >
                {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                <Package size={11} aria-hidden="true" />
                <span className="flex-1 truncate">{t('routines.library.buildingBlocks', 'Building blocks')}</span>
                <span className="text-[10px] shrink-0">{steps.length}</span>
            </button>
            {open && <GroupBody {...props} />}
        </div>
    );
}

/** The rows, or what to say while there are none. */
function GroupBody({ steps, loading, selectedId, onOpen, onOpenRuns, onDelete, onCreate }: BuildingBlocksGroupProps) {
    const { t } = useTranslation();
    return (
        <div className="ml-3 border-l border-[var(--border-default)] pl-1">
            {loading && steps.length === 0 && (
                <div className="text-[10px] text-[var(--text-tertiary)] px-2 py-1">{t('routines.library.loading', 'Loading…')}</div>
            )}
            {!loading && steps.length === 0 && (
                <div className="px-2 py-1.5">
                    <p className="m-0 text-[10.5px] leading-snug text-[var(--text-tertiary)]">
                        {t('routines.library.blocksEmpty', 'No building blocks yet. A building block is a step you build once and reuse in any automation.')}
                    </p>
                    {onCreate && (
                        <button
                            type="button"
                            onClick={onCreate}
                            className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                        >
                            <Plus size={11} aria-hidden="true" />
                            {t('routines.library.newBlock', 'New building block')}
                        </button>
                    )}
                </div>
            )}
            {steps.map((s) => (
                <StepRow
                    key={s.id}
                    step={s}
                    selected={!!selectedId && selectedId === s.id}
                    onOpen={onOpen}
                    onOpenRuns={onOpenRuns}
                    onDelete={onDelete}
                />
            ))}
        </div>
    );
}
