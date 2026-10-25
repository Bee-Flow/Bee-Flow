import { BookOpen, Lightbulb, Table } from 'lucide-react';
import React, { useState } from 'react';
import CanUseCard, { CanUseRow, CardMenu, EmptyRow, LinkButton, UnreadableNotice } from './CanUseCard';
import { READ } from './canUseFacts';
import { CHOOSER_SECTION, chooserRequest } from './toolChooser';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import Toggle from '../../../shared/Toggle';
import type { ReactNode } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { ReadState } from '../agentEditor.types';
import type { datatableRows, knowledgeBaseRows } from './canUseFacts';

/**
 * The Knowledge card of the "Can use" tab, where the agent searches before it answers
 * (Agents artboard 1a, A2 step 2).
 *
 * Three kinds of rows, because the agent reads in three ways:
 *   KNOWLEDGE BASE   an indexed collection of documents. The subtitle is
 *                    "knowledge base · 42 documents · updated yesterday";
 *   TABLE            a `datatable_query` grant. That one reads LIVE. There is no index and
 *                    therefore no "updated", and the row says instead what the grant really
 *                    permits: whose rows, and that nothing is written;
 *   TIP              meeting notes with a tag flow into a knowledge base by themselves. Not a row
 *                    that something is attached to, but a signpost. The tag itself sits on the
 *                    knowledge base, not on the agent.
 *
 * ── THE UPLOAD MODAL IS NOT IN HERE ─────────────────────────────────
 * "+ Link" opens the TOOL PICKER at "From Studio › Knowledge bases" (`toolChooser.js`), not
 * `FilesUploadModal`. Uploading files is work on a KNOWLEDGE BASE, not on an agent: that modal silently
 * created a knowledge base per agent and hid two agent settings in it. `strictKnowledge` has since moved
 * to Role ("If it does not know"), and `includeSourceReferences` to the ⋯ menu next to it, where they
 * concern the ANSWERS you configure here.
 *
 * ── A READ THAT FAILED IS NOT AN EMPTY CARD ─────────────────────────
 * The links are in the agent's config, and we always have those. The NAMES come from routes that may be
 * missing (`/api/datatables` sits behind the automations module, `/api/kb?context=agent` can return a 500).
 * Such a row stays in place without a name, with a warning above it. It is never filtered out, because then
 * the card would claim that the agent does not have that knowledge.
 */

/** One linked knowledge base, as `canUseFacts.knowledgeBaseRows` builds it. */
type KbCardRow = ReturnType<typeof knowledgeBaseRows>[number];
/** One table grant, as `canUseFacts.datatableRows` builds it. */
type TableCardRow = ReturnType<typeof datatableRows>['rows'][number];

/** Waarschuwingstekst onder een rij — één regel, altijd in de waarschuwkleur. */
function RowWarning({ children }: { children?: ReactNode }) {
    return <div className="text-[12px] text-[var(--warning)]">{children}</div>;
}

/**
 * One knowledge base: "knowledge base · 42 documents · updated yesterday".
 *
 * A part that nobody measured drops out: no "0 documents" for a knowledge base whose counter was missing,
 * and no "updated" without a date.
 */
function KbRow({ t, rel, row, pending = false }: { t: TranslateFn; rel: (when: string) => string; row: KbCardRow; pending?: boolean }) {
    return (
        <CanUseRow
            testId="agent-knowledge-kb-row"
            icon={<BookOpen size={14} />}
            muted={!row.readable}
            title={row.name || t('agent_studio.can_use.kb_unnamed', 'Knowledge base')}
            parts={row.readable ? [
                t('agent_studio.can_use.kb_kind', 'knowledge base'),
                row.documentCount === null
                    ? null
                    : nOf(t, 'agent_studio.can_use.n_documents', row.documentCount, '{count} document', '{count} documents'),
                row.lastContentAt
                    ? t('agent_studio.can_use.updated', 'updated {when}', { when: rel(row.lastContentAt) })
                    : null,
            ] : []}
            note={(row.readable || pending) ? null : (
                <RowWarning>
                    {t('agent_studio.can_use.kb_row_unreadable', 'Linked, but this knowledge base could not be read — so what is in it is unknown.')}
                </RowWarning>
            )}
        />
    );
}

/**
 * One table grant: "live · only the asker's own rows · reads, does not write".
 *
 * No "updated": a table is not indexed but read at the moment of the question. What appears instead is what
 * the grant PERMITS, and that is exactly what `datatable_query` enforces, on both sides
 * (server/core/tools/datatableTools.js).
 */
function TableRow({ t, row, pending = false }: { t: TranslateFn; row: TableCardRow; pending?: boolean }) {
    return (
        <CanUseRow
            testId="agent-knowledge-table-row"
            icon={<Table size={14} />}
            muted={!row.readable}
            title={row.name || t('agent_studio.can_use.table_unnamed', 'Table')}
            parts={[
                t('agent_studio.can_use.table_live', 'live'),
                row.scope === 'all'
                    ? t('agent_studio.can_use.table_scope_all', 'all rows')
                    : t('agent_studio.can_use.table_scope_own', "only the asker's own rows"),
                t('agent_studio.can_use.table_reads', 'reads, does not write'),
            ]}
            note={(
                <>
                    {row.grantsNothing && (
                        <RowWarning>
                            {t('agent_studio.can_use.table_no_columns', 'No columns picked, so this table is refused until someone picks them.')}
                        </RowWarning>
                    )}
                    {!row.readable && !pending && (
                        <RowWarning>
                            {t('agent_studio.can_use.table_row_unreadable', 'Granted, but this table could not be read — so its name is unknown.')}
                        </RowWarning>
                    )}
                </>
            )}
        />
    );
}

/**
 * The tip about meeting notes. Not a switch: the tag belongs to the KNOWLEDGE BASE (a `meeting_tag` source,
 * K7), not to the agent, so the only honest thing this card can do is point the way. Without `onNavigate`
 * there is no button: a button that does nothing is worse than no button.
 */
function MeetingTip({ t, onNavigate, tipKbId }: { t: TranslateFn; onNavigate?: ((path: string) => void) | null; tipKbId?: string | null }) {
    return (
        <CanUseRow
            testId="agent-knowledge-tip"
            icon={<Lightbulb size={14} />}
            title={t('agent_studio.can_use.meeting_tip_title', 'Meeting notes can add themselves')}
            note={(
                <div className="text-[12px] text-[var(--text-tertiary)]">
                    {t('agent_studio.can_use.meeting_tip_body', 'Give a knowledge base a meeting tag and every note carrying that tag becomes knowledge on its own — no upload, no copy.')}
                    {onNavigate && (
                        <button
                            type="button"
                            data-testid="agent-knowledge-tip-action"
                            onClick={() => onNavigate(tipKbId ? `studio/knowledge/${tipKbId}/sources` : 'studio/knowledge')}
                            className="ml-1.5 underline text-[var(--accent)] hover:opacity-80"
                        >
                            {t('agent_studio.can_use.meeting_tip_action', 'Set the tag')}
                        </button>
                    )}
                </div>
            )}
        />
    );
}

/** The ⋯ menu: one switch, about the ANSWERS that this knowledge yields. */
function KnowledgeMenu({ t, ro, includeSourceReferences, onIncludeSourceReferencesChange }: { t: TranslateFn; ro?: boolean; includeSourceReferences?: boolean; onIncludeSourceReferencesChange?: (next: boolean) => void }) {
    const [open, setOpen] = useState(false);
    return (
        <CardMenu
            testId="agent-knowledge-menu"
            label={t('agent_studio.can_use.more_options', 'More options')}
            open={open}
            onToggle={() => setOpen(v => !v)}
            onClose={() => setOpen(false)}
        >
            <Toggle
                checked={!!includeSourceReferences}
                disabled={ro}
                onChange={(next) => onIncludeSourceReferencesChange?.(next)}
                label={t('agent_wizard.knowledge.sources_label', 'Include source references')}
                description={t('agent_wizard.knowledge.sources_help', 'Cite source URLs when answering from knowledge.')}
            />
        </CardMenu>
    );
}

export interface KnowledgeCardProps {
    t: TranslateFn;
    ro?: boolean;
    rel?: (when: string) => string;
    kbRows?: KbCardRow[];
    kbState?: ReadState;
    onRetryKbs?: () => void;
    tableRows?: TableCardRow[];
    tableState?: ReadState;
    tableTruncated?: number;
    onRetryTables?: () => void;
    includeSourceReferences?: boolean;
    onIncludeSourceReferencesChange?: (next: boolean) => void;
    onOpenChooser?: (request: ReturnType<typeof chooserRequest>) => void;
    onNavigate?: ((path: string) => void) | null;
    tipKbId?: string | null;
}

export default function KnowledgeCard({
    t, ro = false, rel = () => '',
    kbRows = [], kbState = READ.OK, onRetryKbs,
    tableRows = [], tableState = READ.OK, tableTruncated = 0, onRetryTables,
    includeSourceReferences = false, onIncludeSourceReferencesChange,
    onOpenChooser,
    onNavigate = null, tipKbId = null,
}: KnowledgeCardProps) {
    /**
     * "Nothing linked" is a CONFIG question, not a read.
     *
     * Every row here comes from `config.knowledge_base_ids` and `config.tools.datatables`, which we always
     * have, even if the names are missing. Zero rows therefore really means zero links, and that may be said
     * without waiting for a fetch. The other way round: the warning should only appear if there is something
     * that we could not name. An organisation without a tables module got a permanent warning about tables
     * that this agent does not have, and a warning that always stands teaches people to look away from it.
     */
    const nothingLinked = kbRows.length === 0 && tableRows.length === 0;
    const kbPending = kbState === READ.LOADING;
    const tablesPending = tableState === READ.LOADING;

    return (
        <CanUseCard
            kind="kb"
            testId="agent-knowledge-card"
            title={t('agent_studio.can_use.knowledge_title', 'Knowledge')}
            subtitle={t('agent_studio.can_use.knowledge_sub', 'Where it looks before it answers')}
            action={!ro && (
                <LinkButton
                    testId="agent-knowledge-link"
                    label={t('agent_studio.can_use.link', 'Link')}
                    onClick={() => onOpenChooser?.(chooserRequest(CHOOSER_SECTION.KNOWLEDGE_BASES))}
                />
            )}
            menu={(
                <KnowledgeMenu
                    t={t}
                    ro={ro}
                    includeSourceReferences={includeSourceReferences}
                    onIncludeSourceReferencesChange={onIncludeSourceReferencesChange}
                />
            )}
        >
            {kbState === READ.ERROR && kbRows.length > 0 && (
                <UnreadableNotice
                    testId="agent-knowledge-kbs-unreadable"
                    message={t('agent_studio.can_use.kbs_unreadable', 'Could not load the knowledge bases, so their names and counts are missing here.')}
                    retryLabel={t('agent_studio.retry', 'Retry')}
                    onRetry={onRetryKbs}
                />
            )}
            {tableState === READ.ERROR && tableRows.length > 0 && (
                <UnreadableNotice
                    testId="agent-knowledge-tables-unreadable"
                    message={t('agent_studio.can_use.tables_unreadable', 'Could not load the tables, so their names are missing here.')}
                    retryLabel={t('agent_studio.retry', 'Retry')}
                    onRetry={onRetryTables}
                />
            )}

            {kbRows.map((row) => <KbRow key={`kb-${row.id}`} t={t} rel={rel} row={row} pending={kbPending} />)}
            {tableRows.map((row) => <TableRow key={`tbl-${row.id}`} t={t} row={row} pending={tablesPending} />)}

            {tableTruncated > 0 && (
                <UnreadableNotice
                    testId="agent-knowledge-tables-truncated"
                    message={nOf(
                        t, 'agent_studio.can_use.tables_over_limit', tableTruncated,
                        '{count} more table is stored but the agent never reads it — a run honours the first 25.',
                        '{count} more tables are stored but the agent never reads them — a run honours the first 25.',
                    )}
                />
            )}

            {nothingLinked && (
                <EmptyRow
                    testId="agent-knowledge-empty"
                    message={t('agent_studio.can_use.knowledge_empty', 'Nothing linked yet — this agent answers from its instructions alone.')}
                />
            )}

            <MeetingTip t={t} onNavigate={onNavigate} tipKbId={tipKbId} />
        </CanUseCard>
    );
}
