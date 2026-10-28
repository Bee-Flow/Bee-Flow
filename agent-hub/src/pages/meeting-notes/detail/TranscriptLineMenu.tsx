import React, { useCallback, useMemo } from 'react';
import { BookOpen, Check, Copy, Gavel, ListChecks, Loader2, Table, type LucideIcon } from 'lucide-react';
import AnchoredMenu from '@/components/shared/AnchoredMenu';
import useTranslation from '@/hooks/useTranslation';
import useCopyToClipboard from '@/hooks/useCopyToClipboard';
import { datatablesApi } from '@/components/admin/Studio/Datatables/datatablesApi';
import knowledgeApi from '@/components/admin/Studio/KnowledgeStudio/knowledgeApi';
import { buildRowValues, type DatatableField } from '../lib/actionDestinations';
import {
    anchorOf,
    buildLineActionItem,
    buildLineDecision,
    buildLineKbSource,
    buildLineMarks,
    lineAsActionRecord,
    lineQuote,
} from '../lib/transcriptLines';
import {
    BranchList,
    ColumnMapping,
    MenuRow,
    VIEW,
    fieldLabels,
    useDestinationBranches,
} from './destinationMenu';
import type { PlayerSegment } from './player/player.types';
import type { MeetingActionItem, MeetingNote } from './meetingDetailTypes';

/**
 * WHAT ONE TRANSCRIPT LINE CAN BECOME: the per-line popover (Meeting Notes artboard 1b,
 * plan M4).
 *
 * Five entries, in the order the artboard has them:
 *
 *   Action            an action item on the note, anchored to this line
 *   Decision          a decision on the note, anchored to this line
 *   To a knowledge…   a K1 `text` source carrying which transcript and which line it
 *                     came from
 *   Row in a table    one row in one of the viewer's own tables
 *   Copy quote        the sentence, with who said it and when
 *
 * ── TWO OF THESE WRITE ON THE NOTE, THREE DO NOT ────────────────────
 * "Action" and "Decision" change the meeting note, which only its owner may change. So
 * those two rows exist only when the handler for them does, exactly the way
 * ActionItemsList draws its pencil only for `onEdit`. The other three write into the
 * VIEWER's own workspace (their knowledge base, their table, their clipboard) and are
 * gated by those routes, so a colleague reading a shared note keeps them.
 *
 * ── AND BOTH OF THOSE WRITES MUST SURVIVE "REGENERATE" ──────────────
 * The artifacts built here carry `source: 'user'` (lib/transcriptLines.js). That one
 * field is what keeps them out of the way of the extractor when the summary is
 * regenerated. See server/core/meetingNotes/actionItems.js, whose merge rule for
 * decisions exists because of this menu.
 *
 * ── AND A LINE ONLY BECOMES EACH OF THEM ONCE ───────────────────────
 * The two note rows read `buildLineMarks`, the same index with which the transcript
 * draws its third column, and say "already there" as soon as this line has delivered
 * that kind. Without that, a second visit to the same line made a BYTE-IDENTICAL
 * second item: `buildLineActionItem` is deterministic, `appendArtifact` pastes blindly
 * behind it, and `collect()` (server/core/meetingNotes/actionItems.js) de-duplicates
 * only on id, and every item gets a freshly minted id. The result is not cosmetic.
 * There is no delete button for a single item, and `source:'user'` is precisely what
 * every "Regenerate" leaves in place, so the duplicate is permanent and counts in every
 * open-action tally. The chip that already says so stands 150px further on in the same
 * row. The menu is where the question is asked, so that is where the answer belongs.
 *
 * Only human-made artifacts carry a `segmentIndex` (the extractor does not set it), so
 * this brake never stands in the way of an AI item.
 *
 * ── THE WRITE HAPPENS FIRST, THE MENU CLOSES SECOND ─────────────────
 * Same rule as the destination pill, and the same implementation (./destinationMenu): a
 * failure shows the server's own message inside the menu and leaves the note alone. A
 * menu that closed on a PATCH that returned 500 would look exactly like one that worked.
 */
interface TranscriptLineMenuProps {
    open: boolean;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLElement | null>;
    segment: PlayerSegment;
    segmentIndex: number;
    speakerLabel?: string;
    meeting?: Partial<MeetingNote> | null;
    onAddAction?: ((item: MeetingActionItem | null) => Promise<boolean>) | null;
    onAddDecision?: ((item: MeetingActionItem | null) => Promise<boolean>) | null;
}

/** The table picked in the "Row in a table" branch. */
interface PickedTableRef {
    id: string;
    fields: DatatableField[];
}

export default function TranscriptLineMenu({
    open,
    onClose,
    anchorRef,
    segment,
    segmentIndex,
    speakerLabel = '',
    meeting = null,
    onAddAction = null,
    onAddDecision = null,
}: TranscriptLineMenuProps) {
    const { t } = useTranslation();
    const { copy } = useCopyToClipboard();
    const branches = useDestinationBranches({ t });
    const { view, lists, loading, error, busy, table, mapping, setMapping, reset, back, openBranch, pickTable, runWrite } = branches;

    const close = useCallback(() => { onClose?.(); reset(); }, [onClose, reset]);
    const send = useCallback((write: () => Promise<void>) => runWrite(write, close), [runWrite, close]);

    /**
     * A note write that the note refused is a FAILURE, not a close.
     * `onAddAction`/`onAddDecision` answer whether the PATCH landed; throwing
     * on `false` is what puts the server's refusal in front of the person
     * instead of a menu that quietly went away.
     */
    const saved = async (result: boolean | undefined) => {
        if (result === false) throw new Error(t('meetings.line_not_saved', 'The note could not be updated.'));
    };

    /**
     * Which kinds this line has already delivered.
     *
     * Via `anchorOf`, not via the raw prop. A `segmentIndex` that arrives as a string
     * would miss the Map and offer the row again, which is precisely the fail-open that
     * must be closed here.
     */
    const made = useMemo(() => {
        const index = anchorOf({ segmentIndex });
        if (index === null) return new Set<string>();
        return new Set((buildLineMarks(meeting).get(index) || []).map((m) => m.kind));
    }, [meeting, segmentIndex]);

    const labels: Record<string, string> = {
        ...fieldLabels(t),
        // The same six fields, named for where this row comes from: a
        // transcript line's text is a quote, and its "owner" is whoever said it.
        text: t('meetings.field_quote', 'Quote'),
        assignee: t('meetings.field_speaker', 'Speaker'),
    };

    const writes = {
        onAction: () => send(async () => {
            await saved(await (onAddAction as NonNullable<typeof onAddAction>)(buildLineActionItem(segment, segmentIndex)));
        }),
        onDecision: () => send(async () => {
            await saved(await (onAddDecision as NonNullable<typeof onAddDecision>)(buildLineDecision(segment, segmentIndex)));
        }),
        onKb: (row: { id: string }) => send(async () => {
            const source = buildLineKbSource(segment, segmentIndex, meeting, {
                speakerLabel,
                labels: { speaker: labels.assignee, timestamp: labels.timestamp, meeting_title: labels.meeting_title },
            });
            if (!source) throw new Error(t('meetings.line_no_text', 'This line has no text to file.'));
            await knowledgeApi.createSource(row.id, source);
        }),
        onAddRow: () => send(async () => {
            // Through the SAME payload builder the action card uses: it
            // narrows to writable columns, refuses a field outside the
            // allow-list and leaves empty values out entirely.
            const record = lineAsActionRecord(segment, { speakerLabel });
            await datatablesApi.addRow((table as PickedTableRef).id, buildRowValues(record, meeting, mapping, (table as PickedTableRef).fields));
        }),
        onCopy: () => send(async () => {
            const quote = lineQuote(segment, { speakerLabel });
            if (!quote) throw new Error(t('meetings.line_no_text', 'This line has no text to file.'));
            const done = await copy(quote);
            // A browser that refused the clipboard must say so — "copied"
            // with an empty clipboard is the worst of both.
            if (!done) throw new Error(t('meetings.copy_unavailable', 'Your browser did not allow copying.'));
        }),
    };
    const pick = ({ [VIEW.TABLE]: pickTable, [VIEW.KB]: writes.onKb } as Record<string, (row: { id: string }) => void>)[view];

    return (
        <AnchoredMenu
            open={open}
            onClose={close}
            anchorRef={anchorRef}
            align="right"
            width={260}
            role="menu"
            aria-label={t('meetings.line_menu', 'What is this line?')}
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
                    {onAddAction && (made.has('action')
                        ? <AlreadyRow icon={ListChecks} tone="var(--accent-primary)" kind="action"
                            label={t('meetings.line_already_action', 'Already an action')} />
                        : <MenuRow icon={ListChecks} tone="var(--accent-primary)" onClick={writes.onAction}
                            label={t('meetings.line_action', 'Action')} />
                    )}
                    {onAddDecision && (made.has('decision')
                        ? <AlreadyRow icon={Gavel} tone="var(--success)" kind="decision"
                            label={t('meetings.line_already_decision', 'Already a decision')} />
                        : <MenuRow icon={Gavel} tone="var(--success)" onClick={writes.onDecision}
                            label={t('meetings.line_decision', 'Decision')} />
                    )}
                    <MenuRow icon={BookOpen} kind="kb" chevron onClick={() => openBranch(VIEW.KB)}
                        label={t('meetings.dest_kb', 'To a knowledge base')} />
                    <MenuRow icon={Table} kind="datatable" chevron onClick={() => openBranch(VIEW.TABLE)}
                        label={t('meetings.dest_datatable', 'Row in a table')} />
                    <MenuRow icon={Copy} kind={null} onClick={writes.onCopy}
                        label={t('meetings.line_copy_quote', 'Copy quote')} />
                </>
            )}
            {!busy && view === VIEW.COLUMNS && (
                <ColumnMapping
                    t={t}
                    table={table}
                    mapping={mapping}
                    labels={labels}
                    loading={loading}
                    onMap={(col, field) => setMapping((m) => ({ ...m, [col]: field }))}
                    onBack={back}
                    onAddRow={writes.onAddRow}
                />
            )}
            {!busy && ([VIEW.TABLE, VIEW.KB] as string[]).includes(view) && (
                <BranchList t={t} view={view as 'table' | 'kb'} lists={lists} loading={loading} onBack={back} onPick={pick} />
            )}
        </AnchoredMenu>
    );
}

/**
 * The place of a write row, for a kind that this line already has.
 *
 * A row that is still there but does nothing, rather than a row that disappears. An
 * option that is gone without explanation lets someone search for what broke.
 * No `role="menuitem"` and no button: there is nothing to choose.
 */
interface AlreadyRowProps {
    icon: LucideIcon;
    tone: string;
    kind: string;
    label: string;
}

function AlreadyRow({ icon: Icon, tone, kind, label }: AlreadyRowProps) {
    return (
        <div
            data-testid={`line-already-${kind}`}
            className="w-full px-3 py-1.5 text-sm flex items-center gap-2 text-[var(--text-tertiary)]"
        >
            <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" style={{ color: tone, opacity: 0.5 }} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <Check className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
        </div>
    );
}
