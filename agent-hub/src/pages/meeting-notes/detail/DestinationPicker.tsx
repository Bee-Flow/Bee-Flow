import React, { useCallback, useRef, useState } from 'react';
import { BookOpen, Loader2, Table, Trash2, Workflow, type LucideIcon } from 'lucide-react';
import AnchoredMenu from '@/components/shared/AnchoredMenu';
import { kindColorVar, kindTint } from '@/components/shared/kindColors';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import { datatablesApi } from '@/components/admin/Studio/Datatables/datatablesApi';
import knowledgeApi from '@/components/admin/Studio/KnowledgeStudio/knowledgeApi';
import {
    buildAutomationPayload,
    buildKbSource,
    buildRowValues,
    destinationRecord,
    type DatatableField,
    type DestinationRecord,
} from '../lib/actionDestinations';
import {
    BranchList,
    ColumnMapping,
    MenuRow,
    VIEW,
    fieldLabels,
    useDestinationBranches,
} from './destinationMenu';
import type { MeetingActionItem, MeetingNote } from './meetingDetailTypes';

/**
 * "Bestemming kiezen ▾" — the destination menu on an action card (Meeting
 * Notes artboard 1a, plan M3).
 *
 * Three destinations, all of them things the person already owns:
 *
 *   Start an automation  an automation whose trigger is `manual` or `agent_call`,
 *                        run with the action as its trigger payload
 *   Row in a table       one row in one of their datatables, columns mapped
 *                        by hand
 *   To a knowledge base  the K1 `text` source
 *
 * "Taak in Cowork" and "Alles naar taken" are on the artboard and are
 * deliberately NOT here: there is no task entity to make one out of, and a
 * menu item that cannot do what it says is worse than a missing one. They come
 * back the day Cowork tasks exist.
 *
 * ── THE WRITE HAPPENS FIRST, THE CHIP SECOND ────────────────────────
 * `onPicked` is called only after the destination's own route answered. A chip
 * recorded ahead of the write would claim a run that never started, a row that
 * was refused for lack of grade, a knowledge source the licence capped — and
 * nothing on the card would ever correct it. A failure therefore shows the
 * server's own message inside the menu and records nothing at all. That
 * ordering, the branch lists and the column mapping all live in
 * ./destinationMenu, shared with the transcript's per-line popover (M4).
 */

/** kindColors' key per destination kind — one legend, never a second palette. */
const COLOR_KIND: Readonly<Record<string, string>> = Object.freeze({ automation: 'automation', datatable_row: 'datatable', kb: 'kb' });
const DEST_ICON: Readonly<Record<string, LucideIcon>> = Object.freeze({ automation: Workflow, datatable_row: Table, kb: BookOpen });

/** What a chip says, per kind. */
function destinationLabel(t: TranslateFn, destination: DestinationRecord) {
    const label = destination?.label || '';
    if (destination?.kind === 'automation') return t('meetings.dest_chip_automation', 'Start: {label}', { label });
    if (destination?.kind === 'datatable_row') return t('meetings.dest_chip_table', 'Row in table {label}', { label });
    if (destination?.kind === 'kb') return t('meetings.dest_chip_kb', 'To {label}', { label });
    return label;
}

/**
 * The pill — a filled, kind-tinted chip once a destination is set, a dashed
 * outline invitation while there is none (artboard 1a). Rendered read-only
 * (no menu) when the viewer may not change it.
 */
interface DestinationChipProps {
    destination: DestinationRecord | null;
    onClick?: (() => void) | null;
    t: TranslateFn;
    disabled?: boolean;
    open?: boolean;
}

const DestinationChip = React.forwardRef<HTMLButtonElement, DestinationChipProps>(function DestinationChip(
    { destination, onClick = null, disabled = false, open = false, t }, ref,
) {
    const set = !!destination;
    const interactive = !!onClick;
    const kind = set ? (COLOR_KIND[destination.kind] || null) : null;
    const Icon = set ? (DEST_ICON[destination.kind] || null) : null;
    const skin = set
        ? { background: kindTint(kind, 14), border: '1px solid transparent', color: kindColorVar(kind) }
        : { background: 'transparent', border: '1px dashed var(--border-default)', color: 'var(--text-tertiary)' };
    return (
        <button
            ref={ref}
            type="button"
            onClick={onClick || undefined}
            disabled={disabled || !interactive}
            aria-haspopup={interactive ? 'menu' : undefined}
            aria-expanded={interactive ? open : undefined}
            data-testid="action-destination-chip"
            className="ml-auto inline-flex items-center gap-1 max-w-[65%] text-[11px] font-semibold disabled:opacity-100"
            style={{ padding: '1px 7px', borderRadius: 999, cursor: interactive ? 'pointer' : 'default', ...skin }}
        >
            {Icon && <Icon className="w-2.5 h-2.5 flex-shrink-0" aria-hidden="true" />}
            <span className="truncate">
                {set ? destinationLabel(t, destination) : t('meetings.pick_destination', 'Pick a destination')}
            </span>
        </button>
    );
});

/** One pickable row of a branch list: an automation (`title`), a table or a knowledge base (`name`). */
interface PickerRow {
    id: string;
    title?: string;
    name?: string;
}

/** The table picked in the "Row in a table" branch. */
interface PickedTableRef {
    id: string;
    name?: string;
    fields: DatatableField[];
}

interface DestinationPickerProps {
    item: MeetingActionItem;
    meeting: MeetingNote | null;
    onPicked: (destination: DestinationRecord | null) => void;
    disabled?: boolean;
}

export default function DestinationPicker({ item, meeting, onPicked, disabled = false }: DestinationPickerProps) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const branches = useDestinationBranches({ t });
    const { view, lists, loading, error, busy, table, mapping, setMapping, reset, back, openBranch, pickTable, runWrite, api } = branches;

    const close = useCallback(() => { setOpen(false); reset(); }, [reset]);
    /** The write first; the chip only if it answered. */
    const send = useCallback((write: () => Promise<void>) => runWrite(write, close), [runWrite, close]);

    const writes = {
        // Forgetting a destination is a change to the NOTE, not an undo of the
        // run, the row or the knowledge source — those happened. The menu says
        // "remove destination" for exactly that reason.
        onClear: () => send(async () => { onPicked?.(null); }),
        onAutomation: (row: PickerRow) => send(async () => {
            const res = await api.run(row.id, { triggerPayload: buildAutomationPayload(item, meeting) }) as { run?: { id?: string } } | null;
            // A run that outlives its 60-second window answers 202 {pending:true}
            // with NO run id. It really did start, so the destination is
            // recorded — without an itemRef, rather than with an invented one.
            onPicked?.(destinationRecord('automation', { ref: row.id, label: row.title, itemRef: res?.run?.id || '' }));
        }),
        onAddRow: () => send(async () => {
            const res = await datatablesApi.addRow((table as PickedTableRef).id, buildRowValues(item, meeting, mapping, (table as PickedTableRef).fields));
            onPicked?.(destinationRecord('datatable_row', { ref: (table as PickedTableRef).id, label: (table as PickedTableRef).name, itemRef: res?.id || '' }));
        }),
        onKb: (row: PickerRow) => send(async () => {
            const source = buildKbSource(item, meeting, { labels: fieldLabels(t) });
            if (!source) throw new Error(t('meetings.dest_no_text', 'This action has no text to file.'));
            const res = await knowledgeApi.createSource(row.id, source);
            onPicked?.(destinationRecord('kb', { ref: row.id, label: row.name, itemRef: res?.source?.id || '' }));
        }),
    };
    const pick = ({ [VIEW.AUTOMATION]: writes.onAutomation, [VIEW.TABLE]: pickTable, [VIEW.KB]: writes.onKb } as Record<string, (row: PickerRow) => void>)[view];

    return (
        <>
            <DestinationChip
                ref={anchorRef}
                destination={item?.destination || null}
                onClick={() => (open ? close() : setOpen(true))}
                disabled={disabled}
                open={open}
                t={t}
            />
            <AnchoredMenu
                open={open}
                onClose={close}
                anchorRef={anchorRef}
                align="right"
                width={300}
                role="menu"
                aria-label={t('meetings.destination_menu', 'Where should this action go?')}
                className="py-1"
            >
                {error && (
                    <div className="px-3 py-2 text-xs text-[var(--error-ink)]" role="alert">{error}</div>
                )}
                {busy && (
                    <div className="px-3 py-2 text-xs flex items-center gap-2 text-[var(--text-tertiary)]">
                        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                        {t('meetings.dest_sending', 'Sending…')}
                    </div>
                )}
                {!busy && view === VIEW.ROOT && (
                    <>
                        <MenuRow icon={Workflow} kind="automation" chevron onClick={() => openBranch(VIEW.AUTOMATION)}
                            label={t('meetings.dest_automation', 'Start an automation')} />
                        <MenuRow icon={Table} kind="datatable" chevron onClick={() => openBranch(VIEW.TABLE)}
                            label={t('meetings.dest_datatable', 'Row in a table')} />
                        <MenuRow icon={BookOpen} kind="kb" chevron onClick={() => openBranch(VIEW.KB)}
                            label={t('meetings.dest_kb', 'To a knowledge base')} />
                        {!!item?.destination && (
                            <MenuRow icon={Trash2} kind={null} onClick={writes.onClear}
                                label={t('meetings.dest_clear', 'Remove destination')} />
                        )}
                    </>
                )}
                {!busy && view === VIEW.COLUMNS && (
                    <ColumnMapping
                        t={t}
                        table={table}
                        mapping={mapping}
                        labels={fieldLabels(t)}
                        loading={loading}
                        onMap={(col, field) => setMapping((m) => ({ ...m, [col]: field }))}
                        onBack={back}
                        onAddRow={writes.onAddRow}
                    />
                )}
                {!busy && ([VIEW.AUTOMATION, VIEW.TABLE, VIEW.KB] as string[]).includes(view) && (
                    <BranchList t={t} view={view as 'automation' | 'table' | 'kb'} lists={lists} loading={loading} onBack={back} onPick={pick} />
                )}
            </AnchoredMenu>
        </>
    );
}
