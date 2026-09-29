import { Check, Code2, Link2, Undo2, Wrench } from 'lucide-react';
import React from 'react';
import { linksAddedIn, stepSummary } from './webpageTurnFacts';
import useTranslation from '../../hooks/useTranslation';

/**
 * What sits under one assistant turn in the webpage chat (plan W2):
 *
 *   LINK ADDED       a sub-card, shown only when the turn's tool stream says
 *                    a grant or a table link really completed;
 *   Keep / Undo /    the three next steps for an edit the turn just made;
 *   View in code
 *   How I did this   the step count and, when every step is timed, the total.
 *
 * Nothing here reads the assistant's prose. Everything comes from
 * `webpageTurnFacts`, which reads the tool stream — see that file for why.
 *
 * ── UNDO IS OFFERED ONLY WHEN IT CAN BE HONOURED ─────────────────────────
 * `canUndo` is false when the editor no longer holds the bytes that were on
 * screen before this turn (a reload drops them; they are deliberately not
 * persisted into the chat row). The chip then does not render at all, rather
 * than rendering disabled or — worse — running and restoring something else.
 *
 * Props
 *   msg          the assistant message (toolHistory, webpageEdits)
 *   canUndo      the editor still holds this turn's before-state
 *   undone       this turn has already been undone
 *   kept         the user dismissed the chips with "Keep"
 *   onKeep()     dismiss the chips
 *   onUndo()     restore the before-state
 *   onShowInCode(file)  open that file in the Code section
 */

function LinkAddedCard({ links, t }) {
    return (
        <div
            data-testid="webpage-link-added"
            className="mt-1 ml-1 rounded-md px-2 py-1.5 flex items-start gap-1.5"
            style={{
                background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)',
            }}
        >
            <Link2 size={11} className="mt-0.5 shrink-0" aria-hidden="true" style={{ color: 'var(--accent-primary)' }} />
            <div className="min-w-0">
                <div
                    className="text-[10px] uppercase tracking-wider font-semibold"
                    style={{ color: 'var(--accent-primary)', opacity: 0.9 }}
                >
                    {t('webpages.chat.link_added', 'Link added')}
                </div>
                <div className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                    {links.map(l => l.name).join(', ')}
                </div>
            </div>
        </div>
    );
}

function Chip({ icon, label, onClick, testId }) {
    const Icon = icon;
    return (
        <button
            type="button"
            onClick={onClick}
            data-testid={testId}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] border transition-colors hover:bg-[var(--vsc-hover-bg)]"
            style={{ borderColor: 'var(--vsc-border)', color: 'var(--text-secondary)' }}
        >
            <Icon size={11} aria-hidden="true" />
            {label}
        </button>
    );
}

/** "How I did this · 3 steps · 1.4s" — count always, time only when known. */
function HowIDidThis({ summary, t }) {
    const stepText = summary.steps === 1
        ? t('webpages.chat.steps', '{count} step', { count: summary.steps })
        : t('webpages.chat.steps_plural', '{count} steps', { count: summary.steps });
    return (
        <span
            data-testid="webpage-how-i-did-this"
            className="text-[10px] inline-flex items-center gap-1"
            style={{ color: 'var(--text-tertiary)' }}
        >
            <Wrench size={10} aria-hidden="true" />
            {t('webpages.chat.how_i_did_this', 'How I did this')}
            {` · ${stepText}`}
            {summary.seconds !== null && ` · ${summary.seconds.toFixed(1)}s`}
        </span>
    );
}

/** Keep · Undo · Change in code — the three next steps for a fresh edit. */
function EditChips({ t, canUndo, lastFile, onKeep, onUndo, onShowInCode }) {
    return (
        <>
            <Chip icon={Check} testId="webpage-chip-keep" label={t('webpages.chat.keep', 'Keep')} onClick={onKeep} />
            {/* Absent, not disabled, when the before-state is gone. */}
            {canUndo && (
                <Chip icon={Undo2} testId="webpage-chip-undo" label={t('webpages.chat.undo', 'Undo')} onClick={onUndo} />
            )}
            <Chip
                icon={Code2} testId="webpage-chip-code"
                label={t('webpages.chat.view_in_code', 'Change in code')}
                onClick={() => onShowInCode?.(lastFile)}
            />
        </>
    );
}

export default function WebpageTurnCard({
    msg, canUndo = false, undone = false, kept = false,
    onKeep, onUndo, onShowInCode,
}) {
    const { t } = useTranslation();
    const links = linksAddedIn(msg);
    const summary = stepSummary(msg);
    const edits = Array.isArray(msg?.webpageEdits) ? msg.webpageEdits : [];
    const showChips = edits.length > 0 && !kept && !undone;

    if (links.length === 0 && !summary && !showChips && !undone) return null;

    return (
        <div className="mt-1 ml-1 flex flex-col gap-1">
            {links.length > 0 && <LinkAddedCard links={links} t={t} />}
            {(showChips || summary) && (
                <div className="flex items-center flex-wrap gap-1.5">
                    {showChips && (
                        <EditChips
                            t={t}
                            canUndo={canUndo}
                            lastFile={edits[edits.length - 1]?.file}
                            onKeep={onKeep}
                            onUndo={onUndo}
                            onShowInCode={onShowInCode}
                        />
                    )}
                    {summary && <HowIDidThis summary={summary} t={t} />}
                </div>
            )}
            {undone && (
                <span className="text-[10px]" data-testid="webpage-turn-undone" style={{ color: 'var(--text-tertiary)' }}>
                    {t('webpages.chat.undone', 'Undone — the page is back to how it was before this turn.')}
                </span>
            )}
        </div>
    );
}
