import { BookOpen, Lightbulb, Table } from 'lucide-react';
import React, { useState } from 'react';
import CanUseCard, { CanUseRow, CardMenu, EmptyRow, LinkButton, UnreadableNotice } from './CanUseCard';
import { READ } from './canUseFacts';
import { CHOOSER_SECTION, chooserRequest } from './toolChooser';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import Toggle from '../../../shared/Toggle';

/**
 * De Kennis-kaart van de tab "Kan gebruiken" — waarin de agent zoekt vóór hij
 * antwoordt (Agents-artboard 1a, A2 stap 2).
 *
 * Drie soorten rijen, want de agent leest op drie manieren:
 *   KENNISBANK   een geïndexeerde verzameling documenten. De ondertitel is
 *                "kennisbank · 42 documenten · bijgewerkt gisteren";
 *   TABEL        een `datatable_query`-grant. Die leest LIVE — er is geen
 *                index en dus geen "bijgewerkt", en de rij zegt in plaats
 *                daarvan wat de grant écht toestaat: wiens rijen, en dat er
 *                niet geschreven wordt;
 *   TIP          meeting notes met een tag lopen vanzelf een kennisbank in.
 *                Geen rij die iets aan heeft staan, maar een wegwijzer — de
 *                tag zelf staat op de kennisbank, niet op de agent.
 *
 * ── DE UPLOADMODAL ZIT HIER NIET IN ─────────────────────────────────
 * "+ Koppelen" opent de TOOL-KIEZER op "Uit Studio › Kennisbanken"
 * (`toolChooser.js`), niet `FilesUploadModal`. Bestanden uploaden is werk aan
 * een KENNISBANK, niet aan een agent: die modal maakte stilzwijgend een
 * kennisbank per agent aan en verstopte er twee agentinstellingen in.
 * `strictKnowledge` staat sindsdien op Rol ("Als het niet weet") en
 * `includeSourceReferences` in het ⋯-menu hiernaast — waar ze over de
 * ANTWOORDEN gaan die je hier configureert.
 *
 * ── EEN LEZING DIE MISLUKTE IS GEEN LEGE KAART ──────────────────────
 * De koppelingen staan in de config van de agent en die hebben we altijd; de
 * NAMEN komen van routes die kunnen ontbreken (`/api/datatables` hangt achter
 * de automations-module, `/api/kb?context=agent` kan 500'en). Zo'n rij blijft
 * dus staan zonder naam, met een waarschuwing erboven — nooit weggefilterd,
 * want dan zou de kaart beweren dat de agent die kennis niet heeft.
 */

/** Waarschuwingstekst onder een rij — één regel, altijd in de waarschuwkleur. */
function RowWarning({ children }) {
    return <div className="text-[12px]" style={{ color: 'var(--warning)' }}>{children}</div>;
}

/**
 * Eén kennisbank: "kennisbank · 42 documenten · bijgewerkt gisteren".
 *
 * Een deel dat niemand gemeten heeft valt weg — geen "0 documenten" voor een
 * kennisbank waarvan de teller ontbrak, en geen "bijgewerkt" zonder datum.
 */
function KbRow({ t, rel, row, pending = false }) {
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
 * Eén tabel-grant: "live · alleen eigen rijen van de vrager · leest, schrijft
 * niet".
 *
 * Geen "bijgewerkt": een tabel wordt niet geïndexeerd maar op het moment van
 * de vraag gelezen. Wat er in plaats daarvan staat is wat de grant tóestaat —
 * en dat is precies wat `datatable_query` afdwingt, aan beide kanten
 * (server/core/tools/datatableTools.js).
 */
function TableRow({ t, row, pending = false }) {
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
 * De tip over meeting notes. Geen schakelaar: de tag hoort bij de KENNISBANK
 * (een `meeting_tag`-bron, K7), niet bij de agent, dus het enige eerlijke wat
 * deze kaart kan doen is de weg wijzen. Zonder `onNavigate` staat er geen knop
 * — een knop die niets doet is erger dan geen knop.
 */
function MeetingTip({ t, onNavigate, tipKbId }) {
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

/** Het ⋯-menu: één schakelaar, over de ANTWOORDEN die deze kennis oplevert. */
function KnowledgeMenu({ t, ro, includeSourceReferences, onIncludeSourceReferencesChange }) {
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

export default function KnowledgeCard({
    t, ro = false, rel = () => '',
    kbRows = [], kbState = READ.OK, onRetryKbs,
    tableRows = [], tableState = READ.OK, tableTruncated = 0, onRetryTables,
    includeSourceReferences = false, onIncludeSourceReferencesChange,
    onOpenChooser,
    onNavigate = null, tipKbId = null,
}) {
    /**
     * "Niets gekoppeld" is een CONFIG-vraag, geen lezing.
     *
     * Elke rij hier komt uit `config.knowledge_base_ids` en
     * `config.tools.datatables` — die hebben we altijd, ook als de namen
     * ontbreken. Nul rijen betekent dus écht nul koppelingen, en dat mag
     * gezegd worden zonder op een fetch te wachten. Andersom: de
     * waarschuwing hoort alleen te staan als er iets IS dat we niet konden
     * benoemen. Een organisatie zonder tabellen-module kreeg anders een
     * eeuwige waarschuwing over tabellen die deze agent niet heeft, en een
     * waarschuwing die altijd staat leert mensen om ze weg te kijken.
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
