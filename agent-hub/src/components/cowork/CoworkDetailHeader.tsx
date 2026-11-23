/**
 * The header of one cowork item (./CoworkDetail.tsx): who this is, what it is doing right now, whether something waits
 * for its owner, and the actions. Run now and Pause/Resume are always in sight; Edit and Delete sit in a small menu,
 * because they are rarer and Delete is the one that cannot be undone.
 */
import { useEffect, useRef } from 'react';
import { MoreHorizontal, Pause, Pencil, Play, Power, Trash2 } from 'lucide-react';
import { isMailTriggerItem } from './mailTrigger';
import { kindIcon, kindTileStyle } from '../shared/kindColors';
import { statusLabel } from '../shared/statusTokens';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { StatusToken } from '../shared/statusTokens/statusTokens.types';

const AgentIcon = kindIcon('agent');

/** "Running since 08:00:04" — the clock the artboard puts in the header. */
function startedAtClock(value: string | null | undefined) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
}

const MENU_ITEM = 'w-full inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-[12.5px] disabled:opacity-50 hover:bg-[var(--bg-secondary)]';

interface ActionsMenuProps {
    t: TranslateFn;
    busy?: boolean;
    onEdit: () => void;
    onDelete: () => void;
}

/**
 * Edit and Delete behind one small button. A native disclosure, so it opens with Enter or Space and the two actions
 * stay in the document; it closes on Escape, on a click outside it, and once an action is chosen.
 */
function ActionsMenu({ t, busy, onEdit, onDelete }: ActionsMenuProps) {
    const ref = useRef<HTMLDetailsElement>(null);
    const close = () => { if (ref.current) ref.current.open = false; };
    useEffect(() => {
        const onPointer = (e: PointerEvent) => {
            const menu = ref.current;
            if (menu?.open && e.target instanceof Node && !menu.contains(e.target)) menu.open = false;
        };
        const onKey = (e: KeyboardEvent) => {
            const menu = ref.current;
            if (e.key !== 'Escape' || !menu?.open) return;
            menu.open = false;
            menu.querySelector('summary')?.focus();
        };
        document.addEventListener('pointerdown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointer);
            document.removeEventListener('keydown', onKey);
        };
    }, []);
    return (
        <details ref={ref} className="relative" data-testid="cowork-menu">
            <summary
                aria-label={t('cowork_detail.menu.label', 'More actions')}
                title={t('cowork_detail.menu.label', 'More actions')}
                className="list-none [&::-webkit-details-marker]:hidden cursor-pointer p-1.5 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)]"
            >
                <MoreHorizontal aria-hidden="true" className="w-3.5 h-3.5" />
            </summary>
            <div className="absolute right-0 top-full mt-1 z-20 min-w-[150px] p-1 flex flex-col rounded-lg border bg-[var(--bg-card)] border-[var(--border-subtle)] [box-shadow:var(--shadow-popover)]">
                <button
                    type="button" disabled={busy} data-testid="cowork-edit"
                    onClick={() => { close(); onEdit(); }}
                    className={`${MENU_ITEM} text-[var(--text-primary)]`}
                >
                    <Pencil aria-hidden="true" className="w-3.5 h-3.5" />{t('cowork.detail.edit', 'Edit')}
                </button>
                <button
                    type="button" disabled={busy} data-testid="cowork-delete"
                    aria-label={t('cowork.detail.delete', 'Delete this cowork')}
                    onClick={() => { close(); onDelete(); }}
                    className={`${MENU_ITEM} text-red-600 dark:text-red-400`}
                >
                    <Trash2 aria-hidden="true" className="w-3.5 h-3.5" />{t('cowork_detail.menu.delete', 'Delete')}
                </button>
            </div>
        </details>
    );
}

export interface DetailHeaderProps {
    item: CoworkItem;
    status: StatusToken;
    t: TranslateFn;
    busy?: boolean;
    /** How many things wait for the owner (the "Needs you" strip below); 0 shows no badge. */
    needsCount?: number;
    onShowNeeds?: () => void;
    onEdit: () => void;
    onToggle: (id: string) => void;
    onDelete: (item: CoworkItem) => void;
    onRunNow: (id: string) => void;
}

/** The badge that says something waits, and takes the reader there. */
function NeedsBadge({ count, t, onClick }: { count: number; t: TranslateFn; onClick?: () => void }) {
    return (
        <button
            type="button"
            data-testid="cowork-needs-badge"
            onClick={onClick}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11.5px] font-medium flex-shrink-0 text-[var(--warning-ink)] [border-color:color-mix(in_srgb,var(--warning)_45%,transparent)] [background:color-mix(in_srgb,var(--warning)_10%,transparent)]"
        >
            {t('cowork_detail.needs.badge', 'Needs you ({count})', { count })}
        </button>
    );
}

export default function DetailHeader({ item, status, t, busy, needsCount = 0, onShowNeeds, onEdit, onToggle, onDelete, onRunNow }: DetailHeaderProps) {
    const tile = kindTileStyle('agent', 26);
    // The status word carries the pill on its own EXCEPT while a run is in
    // flight and the server told us when it started. That is the one moment
    // the word alone is not enough: "Running" says nothing about whether this
    // started four seconds or four hours ago (CW-06). The open run's start
    // time comes from the run row, not from lastStatus — see routes/cowork.js.
    const runningSince = status.labelKey === 'run_status.running'
        ? startedAtClock(item.currentRunStartedAt)
        : '';
    const tone = status.cssVar || 'var(--text-tertiary)';
    const secondary = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50';
    const secondaryStyle = { borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' };

    return (
        <div
            className="flex items-center gap-2.5 px-5 py-2.5 border-b flex-wrap border-[var(--border-subtle)]"
        >
            <div style={tile.tile}><AgentIcon aria-hidden="true" style={tile.glyph} /></div>
            <h2 className="text-[14px] font-semibold truncate min-w-0 text-[var(--text-primary)]">
                {item.title || t('cowork.detail.untitled', 'Untitled cowork')}
            </h2>
            <span
                data-testid="cowork-status"
                data-status-key={status.labelKey}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11.5px] flex-shrink-0 border-[var(--border-subtle)] text-[var(--text-secondary)]"
            >
                <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full" style={{ background: tone }} />
                {runningSince
                    ? t('cowork.detail.running_since', 'Running since {time}', { time: runningSince })
                    : statusLabel(t, status)}
            </span>
            {needsCount > 0 && <NeedsBadge count={needsCount} t={t} onClick={onShowNeeds} />}

            <div className="ml-auto flex items-center gap-1.5">
                {/* The one primary action on the pane. Accent tokens, not the
                    artboard's ink fill: the fill is a hex, and this product
                    follows the admin's accent through eight themes
                    (COMPLETED-STAGES.md:412). */}
                {!isMailTriggerItem(item) && (
                <button
                    type="button"
                    onClick={() => onRunNow(item.id)}
                    disabled={busy || item.lastStatus === 'running'}
                    data-testid="cowork-run-now"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                >
                    <Play className="w-3.5 h-3.5" />{t('cowork.detail.run_now', 'Run now')}
                </button>
                )}
                <button
                    type="button" onClick={() => onToggle(item.id)} disabled={busy}
                    data-testid="cowork-toggle" className={secondary} style={secondaryStyle}
                >
                    {item.isActive ? <Pause className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                    {item.isActive ? t('cowork.detail.pause', 'Pause') : t('cowork.detail.resume', 'Resume')}
                </button>
                <ActionsMenu t={t} busy={busy} onEdit={onEdit} onDelete={() => onDelete(item)} />
            </div>
        </div>
    );
}
