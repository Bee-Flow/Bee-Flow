import React, { useCallback, useMemo } from 'react';
import { BookOpen, Check, Copy, Gavel, ListChecks, Loader2, Table } from 'lucide-react';
import AnchoredMenu from '../../../components/shared/AnchoredMenu';
import useTranslation from '../../../hooks/useTranslation';
import useCopyToClipboard from '../../../hooks/useCopyToClipboard';
import { datatablesApi } from '../../../components/admin/Studio/Datatables/datatablesApi';
import knowledgeApi from '../../../components/admin/Studio/KnowledgeStudio/knowledgeApi';
import { buildRowValues } from '../lib/actionDestinations';
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

/**
 * WHAT ONE TRANSCRIPT LINE CAN BECOME — the per-line popover (Meeting Notes
 * artboard 1b, plan M4).
 *
 * Five entries, in the order the artboard has them:
 *
 *   Action            an action item on the note, anchored to this line
 *   Decision          a decision on the note, anchored to this line
 *   To a knowledge…   a K1 `text` source carrying which transcript and which
 *                     line it came from
 *   Row in a table    one row in one of the viewer's own tables
 *   Copy quote        the sentence, with who said it and when
 *
 * ── TWO OF THESE WRITE ON THE NOTE, THREE DO NOT ────────────────────
 * "Action" and "Decision" change the meeting note, which only its owner may
 * do — so those two rows exist only when the handler for them does, exactly
 * the way ActionItemsList draws its pencil only for `onEdit`. The other three
 * write into the VIEWER's own workspace (their knowledge base, their table,
 * their clipboard) and are gated by those routes, so a colleague reading a
 * shared note keeps them.
 *
 * ── AND BOTH OF THOSE WRITES MUST SURVIVE "OPNIEUW" ─────────────────
 * The artifacts built here carry `source: 'user'` (lib/transcriptLines.js).
 * That one field is what keeps them out of the way of the extractor when the
 * summary is regenerated — see server/core/meetingNotes/actionItems.js, whose
 * merge rule for decisions exists because of this menu.
 *
 * ── AND A LINE ONLY BECOMES EACH OF THEM ONCE ───────────────────────
 * De twee notitie-rijen lezen `buildLineMarks` — dezelfde index waarmee het
 * transcript zijn derde kolom tekent — en zeggen "staat er al" zodra deze
 * regel die soort heeft opgeleverd. Zonder dat maakte een tweede bezoek aan
 * dezelfde regel een BYTE-IDENTIEK tweede item: `buildLineActionItem` is
 * deterministisch, `appendArtifact` plakt er blind achter, en `collect()`
 * (server/core/meetingNotes/actionItems.js) ontdubbelt alleen op id — dat elk
 * item vers gemunt krijgt. Het resultaat is niet cosmetisch: er is geen
 * verwijderknop voor een los item, en `source:'user'` is juist wat elke
 * "Opnieuw" laat staan, dus de dubbel is permanent én telt mee in elke
 * open-actie-telling. De chip die het al zegt staat 150px verderop in dezelfde
 * rij; het menu is waar de vraag gesteld wordt, dus daar hoort het antwoord.
 *
 * Alleen door mensen gemaakte artefacten dragen een `segmentIndex` (de
 * extractor zet hem niet), dus deze rem gaat nooit voor een AI-item staan.
 *
 * ── THE WRITE HAPPENS FIRST, THE MENU CLOSES SECOND ─────────────────
 * Same rule as the destination pill, and the same implementation
 * (./destinationMenu): a failure shows the server's own message inside the
 * menu and leaves the note alone. A menu that closed on a PATCH that 500'd
 * would look exactly like one that worked.
 */
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
}) {
    const { t } = useTranslation();
    const { copy } = useCopyToClipboard();
    const branches = useDestinationBranches({ t });
    const { view, lists, loading, error, busy, table, mapping, setMapping, reset, back, openBranch, pickTable, runWrite } = branches;

    const close = useCallback(() => { onClose?.(); reset(); }, [onClose, reset]);
    const send = useCallback((write) => runWrite(write, close), [runWrite, close]);

    /**
     * A note write that the note refused is a FAILURE, not a close.
     * `onAddAction`/`onAddDecision` answer whether the PATCH landed; throwing
     * on `false` is what puts the server's refusal in front of the person
     * instead of a menu that quietly went away.
     */
    const saved = async (result) => {
        if (result === false) throw new Error(t('meetings.line_not_saved', 'The note could not be updated.'));
    };

    /**
     * Welke soorten deze regel al heeft opgeleverd.
     *
     * Via `anchorOf`, niet via de ruwe prop: een `segmentIndex` die als string
     * binnenkomt zou de Map missen en de rij weer aanbieden — precies het
     * fail-open dat hier dicht moet.
     */
    const made = useMemo(() => {
        const index = anchorOf({ segmentIndex });
        if (index === null) return new Set();
        return new Set((buildLineMarks(meeting).get(index) || []).map((m) => m.kind));
    }, [meeting, segmentIndex]);

    const labels = {
        ...fieldLabels(t),
        // The same six fields, named for where this row comes from: a
        // transcript line's text is a quote, and its "owner" is whoever said it.
        text: t('meetings.field_quote', 'Quote'),
        assignee: t('meetings.field_speaker', 'Speaker'),
    };

    const writes = {
        onAction: () => send(async () => {
            await saved(await onAddAction(buildLineActionItem(segment, segmentIndex)));
        }),
        onDecision: () => send(async () => {
            await saved(await onAddDecision(buildLineDecision(segment, segmentIndex)));
        }),
        onKb: (row) => send(async () => {
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
            await datatablesApi.addRow(table.id, buildRowValues(record, meeting, mapping, table.fields));
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
    const pick = { [VIEW.TABLE]: pickTable, [VIEW.KB]: writes.onKb }[view];

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
                <div className="px-3 py-2 text-xs" style={{ color: 'var(--error-ink)' }} role="alert">{error}</div>
            )}
            {busy && (
                <div className="px-3 py-2 text-xs flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
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
            {!busy && [VIEW.TABLE, VIEW.KB].includes(view) && (
                <BranchList t={t} view={view} lists={lists} loading={loading} onBack={back} onPick={pick} />
            )}
        </AnchoredMenu>
    );
}

/**
 * De plek van een schrijfrij, voor een soort die deze regel al heeft.
 *
 * Een rij die er nog wél staat maar niets doet, in plaats van een rij die
 * verdwijnt: een optie die zonder uitleg weg is laat iemand zoeken naar wat er
 * kapot ging. Geen `role="menuitem"` en geen knop — er valt niets te kiezen.
 */
function AlreadyRow({ icon: Icon, tone, kind, label }) {
    return (
        <div
            data-testid={`line-already-${kind}`}
            className="w-full px-3 py-1.5 text-sm flex items-center gap-2"
            style={{ color: 'var(--text-tertiary)' }}
        >
            <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" style={{ color: tone, opacity: 0.5 }} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <Check className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
        </div>
    );
}
