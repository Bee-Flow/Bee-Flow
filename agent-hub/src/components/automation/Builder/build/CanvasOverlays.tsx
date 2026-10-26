// The small overlays of the build tab's diagram column. Split out of BuildTab
// without a change in behaviour.
import { Sparkles, X } from 'lucide-react';
import type { AddStepPayload } from './addStepModel';
import type { BuilderProposal } from './buildTabTypes';
import { AddStepMenu, DiagramPane } from './jsComponents';
import { useTranslation } from '@/hooks/useTranslation';
import { previewCatalog } from '../chat/pendingTables';
import type { CatalogTable } from '../chat/pendingTables';

/** The proposal drawn over the canvas, read-only and dashed, until reviewed. */
export function ProposalPreviewOverlay({ proposal, catalog, running, onReview, onClose }: {
    proposal: BuilderProposal;
    catalog: { datatables?: CatalogTable[] } | null;
    running?: boolean;
    onReview: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="absolute inset-0 z-20 flex flex-col bg-[var(--bg-primary)]">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-[var(--bg-card)] border-b border-[var(--border-default)] text-xs"><Sparkles size={13} /><span className="flex-1">{t('automations.assistant.proposal', 'Proposal')}</span><button type="button" disabled={running} onClick={onReview} className="rounded-lg px-3 py-1.5 bg-[var(--text-primary)] text-[var(--bg-primary)] disabled:opacity-50">{t('automations.assistant.review_changes', 'Review changes')}</button><button type="button" onClick={onClose} className="p-1.5" aria-label={t('automations.assistant.show_canvas', 'Show canvas')}><X size={14} /></button></div>
            <div className="flex-1 min-h-0 [&_.react-flow__node>div]:!border-dashed [&_.react-flow__node]:opacity-75"><DiagramPane definition={proposal.definition} catalog={previewCatalog(catalog, proposal)} editable={false} /></div>
        </div>
    );
}

/** The chat assistant proposed changes while the user was editing. */
export function ExternalDraftBanner({ onAccept, onDismiss }: {
    onAccept?: (() => void) | null;
    onDismiss?: (() => void) | null;
}) {
    const { t } = useTranslation();
    return (
        <div className="px-4 py-2 border-b border-amber-500/30 bg-amber-500/10 flex items-center justify-between gap-3 flex-shrink-0">
            <div className="text-xs text-amber-700 dark:text-amber-400">
                {t('automations.build_tab.the_chat_assistant_proposed_changes_while', 'The chat assistant proposed changes while you were editing. Accept them, or keep your local edits.')}
            </div>
            <div className="flex items-center gap-1.5">
                <button
                    onClick={onDismiss || undefined}
                    className="px-2 py-1 text-xs rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                >
                    {t('automations.build_tab.keep_mine', 'Keep mine')}
                </button>
                <button
                    onClick={onAccept || undefined}
                    className="px-2 py-1 text-xs rounded bg-[var(--accent)] text-white hover:opacity-90"
                >
                    {t('automations.build_tab.accept_chat_changes', 'Accept chat changes')}
                </button>
            </div>
        </div>
    );
}

/**
 * Summon launcher: when the assistant is closed, a slim rail on the canvas's
 * left edge re-opens it (pulses while building). It lives in the canvas, not
 * the column, so an open step drawer pushes it up with the canvas instead of
 * it landing on the drawer's first column. Vertically centred, but never under
 * the top-left chips (52px) and never on the zoom stack below it (15 + 182 + 8
 * px of it, then the tab's own 40px); on a short canvas the stack lies down as
 * one row and the tab keeps to the top.
 */
export function AssistantLauncher({ running, onOpen }: { running?: boolean; onOpen: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            onClick={onOpen}
            title={t('automations.build_tab.open_the_ai_assistant', 'Open the AI assistant')}
            aria-label={t('automations.build_tab.open_the_ai_assistant', 'Open the AI assistant')}
            className={`absolute left-0 top-[clamp(52px,50%_-_20px,100%_-_245px)] z-20 flex items-center px-1.5 py-3 rounded-r-lg bg-[var(--accent)]/15 text-[var(--accent)] ring-1 ring-[var(--accent)]/40 hover:bg-[var(--accent)]/25 shadow-sm transition ${running ? 'animate-pulse' : ''}`}
        >
            <Sparkles size={16} />
        </button>
    );
}

/**
 * Context-add popover: wiring a step from an edge drop / node "+" / edge "+"
 * must land it at a specific spot. The ribbon handles browse/add-anywhere;
 * this small picker handles the positioned case.
 */
export function ContextAddPopover({ scope, onAdd, onClose }: {
    scope: Record<string, unknown>;
    onAdd: (payload: AddStepPayload | null) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    return (
        <>
            <div className="absolute inset-0 z-30" onMouseDown={onClose} />
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 w-[360px] max-h-[70vh] flex flex-col rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-default)]">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{t('automations.build_tab.add_a_step_here', 'Add a step here')}</span>
                    <button type="button" onClick={onClose} aria-label={t('automations.build_tab.close', 'Close')} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"><X size={14} /></button>
                </div>
                <AddStepMenu
                    scope={scope}
                    showSearch
                    autoFocus
                    onAdd={onAdd}
                    onAfterAdd={onClose}
                />
            </div>
        </>
    );
}
