import { CircleCheck } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { DirtyChip } from '../orgShieldStrip';
import { SHIELD_ROW } from '../shieldLayout';

export interface SaveMessage { type?: string; text: string }

/** Anything that is not a success or a note reads as a failure. */
const MESSAGE_TONE: Record<string, string> = {
    success: 'text-[var(--success-ink)]',
    warning: 'text-[var(--warning-ink)]',
    error: 'text-[var(--error-ink)]',
};

/**
 * The save bar: one Save for the whole document, and an honest account of what
 * is pending.
 *
 * ── Why it names the STAGES with unsaved edits ────────────────────────────
 * One Save writes one document, but the controls behind it are spread over
 * several panes. "Unsaved changes" on its own therefore left an admin who had
 * touched two panes with no way to know that, and — because in-app navigation
 * cannot be intercepted (there is no router hook; `beforeunload` only covers a
 * refresh or a close) — clicking away in the sidebar silently discarded the
 * lot. Naming the stages, as clickable chips, means the pending work is
 * visible from wherever you are and one click away from being reviewed.
 *
 * ── Why Save stays enabled when nothing changed ───────────────────────────
 * It LOOKS idle (grey) when clean, but it is not disabled: a clean re-save is
 * how the server migrates a document's legacy terms.
 */
export function ShieldSaveBar({
    isDirty, dirtyStages = [], message, saving, canSave, onSave, onDiscard, onGoTo, t,
}: {
    isDirty: boolean;
    dirtyStages?: DirtyChip[];
    message?: SaveMessage | null;
    saving: boolean;
    canSave: boolean;
    onSave: () => void;
    onDiscard?: () => void;
    onGoTo?: (id: string) => void;
    t: TranslateFn;
}) {
    return (
        <div className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-card)]">
        <div className={`flex items-center flex-wrap gap-2 px-6 py-3 [@media(max-height:780px)]:py-2 text-xs ${SHIELD_ROW}`}>
            {isDirty ? (
                <DirtySummary stages={dirtyStages} onGoTo={onGoTo} t={t} />
            ) : (
                <>
                    <CircleCheck className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <span className="text-[var(--text-tertiary)]">{t('admin.shield_no_unsaved', 'No unsaved changes')}</span>
                </>
            )}

            {message && (
                // Three tones, because there are three outcomes. "Saved. Note: …"
                // used to render red and read as a failure.
                <span role="status" className={'min-w-0 ' + (MESSAGE_TONE[message.type ?? ''] ?? MESSAGE_TONE.error)}>
                    {message.text}
                </span>
            )}

            <div className="flex-1" />

            {isDirty && onDiscard && (
                <button type="button" onClick={onDiscard} className="hover:underline text-[var(--text-secondary)]">
                    {t('admin.shield_discard', 'Discard')}
                </button>
            )}
            <button
                type="button"
                onClick={onSave}
                disabled={saving || !canSave}
                className={'rounded-[9px] px-3.5 py-[7px] text-xs font-semibold leading-4 whitespace-nowrap transition-opacity disabled:opacity-50 '
                    + (isDirty
                        ? 'bg-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)] enabled:hover:opacity-90'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] enabled:hover:text-[var(--text-secondary)]')}
            >
                {saving ? t('admin.guard_saving', 'Saving...') : t('shield_shell.save_changes', 'Save changes')}
            </button>
        </div>
        </div>
    );
}

function DirtySummary({ stages, onGoTo, t }: { stages: DirtyChip[]; onGoTo?: (id: string) => void; t: TranslateFn }) {
    return (
        <>
            <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0 bg-[var(--warning)]" />
            <span className="font-medium text-[var(--text-primary)]">{t('admin.shield_unsaved', 'Unsaved changes')}</span>
            {stages.length > 0 && (
                <>
                    <span className="text-[var(--text-secondary)]">
                        {stages.length === 1
                            ? t('shield_shell.unsaved_on_one', 'on 1 step:')
                            : t('admin.shield_unsaved_on', 'on {n} steps:', { n: stages.length })}
                    </span>
                    {stages.map(stage => (
                        <button
                            key={stage.id}
                            type="button"
                            onClick={() => onGoTo?.(stage.id)}
                            className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap hover:opacity-80 border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)]"
                        >
                            <stage.Icon className="w-[11px] h-[11px]" aria-hidden="true" />
                            {stage.label}
                            {stage.count > 0 && <span className="text-[var(--text-tertiary)]">· {stage.count}</span>}
                        </button>
                    ))}
                </>
            )}
        </>
    );
}

export default ShieldSaveBar;
