import { AlertTriangle, ArrowRight, CheckCircle2, MessageSquare, Pencil, RotateCcw, Square, SkipForward, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import MarkdownRenderer from '../../../renderers/MarkdownRenderer';
import { CLIENT_RUN, kindOf } from './phaseMachine';
import { errorText } from './playbookView';
import { STAGE_BUTTON, STAGE_BUTTON_GHOST, stageType } from './stages/stageChrome';
import { phaseLabel } from './recipes';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * The pause between phases. Three faces:
 *  - awaiting: "Phase n of N landed" + the summary + the NEXT phase's brief in
 *    an editable textarea + Continue / Skip next / Stop. No next phase left →
 *    Finish.
 *  - failed: the error + Retry / Skip / Stop.
 *  - needs_input (a builder asked a question mid-phase): answer in its chat,
 *    or mark the phase done when the routine already exists.
 * The card floats over the stage's lower third; the stage stays visible.
 * The parent keys it per (phase, next) so the textarea resets with the phase.
 */
/**
 * One line about the phase that comes next when there is no brief to edit.
 *
 * Only design, fill and table had a line, so before the ACCESS and COMPLIANCE
 * phases — neither of which has a brief at all (lifecycle.composeBriefFor
 * returns null for both) and neither of which is a builder — the card said
 * "its brief is composed when you continue", which is simply untrue.
 */
function nextWords(next, t) {
    const name = phaseLabel(next, t);
    switch (kindOf(next)) {
        case 'design': return t('playbooks.handoff.next_design', 'Next: {phase} — the AI first designs the app as a designer, before it builds.', { phase: name });
        case 'fill': return t('playbooks.handoff.next_fill', 'Next: {phase} — the automation runs once so the table has real rows.', { phase: name });
        case 'table': return t('playbooks.handoff.next_table', 'Next: {phase} — the table is created.', { phase: name });
        case 'access': return t('playbooks.handoff.next_access', 'Next: {phase} — you decide who may open the app. Nothing is applied until you approve it.', { phase: name });
        case 'compliance': return t('playbooks.handoff.next_compliance', 'Next: {phase} — what was built is read against the frameworks your organisation has switched on.', { phase: name });
        case 'routine': return t('playbooks.handoff.next_routine', 'Next: {phase} — the automation builder gets a brief and builds it while you watch.', { phase: name });
        case 'app':
        case 'app_turn': return t('playbooks.handoff.next_app', 'Next: {phase} — the app builder gets a brief and builds it while you watch.', { phase: name });
        default: return t('playbooks.handoff.next_plain', 'Next: {phase} — its brief is composed when you continue.', { phase: name });
    }
}

// The brief is written as markdown by the server (a heading, a numbered step
// per line, tool names in backticks). It is READ far more often than it is
// edited — and from the back of a room — so the card shows it rendered and
// keeps the textarea one click away (owner, 2026-09-16).
const BRIEF_MD = 'text-xs leading-relaxed [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:pl-4 [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-[11px] [&_h2]:mt-0 [&_h2]:mb-1 [&_h3]:mb-0.5 [&_h1]:mt-0 [&_pre]:my-1';


export default function HandoffCard({ phase, next, index, total, t, onContinue, onSkipNext, onRetry, onSkip, onStop, onMarkDone, onDismiss = null, canMarkDone = false, busy = false, presenter = false }) {
    // The pause card is what the ROOM reads between phases, and it was the one
    // surface in the film that never grew in presenter mode.
    const type = stageType(presenter);
    const serverBrief = next && typeof next.brief === 'string' ? next.brief : '';
    const [brief, setBrief] = useState(serverBrief);
    // The server RECOMPOSES this brief while the card is on screen — a design
    // redrawn on request is the case that matters: the app's brief carries the
    // design, and the card's copy was taken once, when it first rendered. It
    // then went back on Continue as if the person had typed it, `briefEdited`
    // was set, and the builder was handed the design the person had just
    // replaced (owner, 2026-09-16). A new brief from the server replaces what
    // is in the box; typing in it still wins until the server changes it again.
    const lastServer = useRef(serverBrief);
    const [editing, setEditing] = useState(false);
    useEffect(() => {
        if (lastServer.current === serverBrief) return;
        lastServer.current = serverBrief;
        setBrief(serverBrief);
    }, [serverBrief]);

    const label = (p) => phaseLabel(p, t);
    const btn = STAGE_BUTTON;
    const ghost = STAGE_BUTTON_GHOST;
    const card = { background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 16, boxShadow: 'var(--shadow-lg)', padding: presenter ? '22px 24px' : '16px 18px' };

    if (!phase) return null;

    if (phase.status === 'failed') {
        return (
            <section className="pbk-handoff-enter" style={card} role="dialog" aria-label={t('playbooks.handoff.failed_title', 'Phase {n} did not land', { n: index + 1 })} data-testid="playbook-handoff" data-face="failed">
                <header className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--error-ink, var(--error))' }} aria-hidden="true" />
                    <div className="min-w-0">
                        <h3 className="font-semibold" style={{ fontSize: type.card, color: 'var(--text-primary)' }}>{t('playbooks.handoff.failed_title', 'Phase {n} did not land', { n: index + 1 })} — {label(phase)}</h3>
                        {phase.error && <p className="mt-1 break-words" style={{ fontSize: type.body, color: 'var(--text-secondary)' }}>{errorText(phase.error, t)}</p>}
                    </div>
                </header>
                <div className="flex flex-wrap items-center gap-2 mt-4">
                    <button type="button" className={btn} style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }} onClick={onRetry} disabled={busy} data-testid="playbook-retry"><RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.handoff.retry', 'Retry')}</button>
                    {kindOf(phase) !== 'table' && <button type="button" className={btn} style={ghost} onClick={onSkip} disabled={busy} data-testid="playbook-skip"><SkipForward className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.handoff.skip', 'Skip this phase')}</button>}
                    <button type="button" className={`${btn} ml-auto`} style={ghost} onClick={onStop} disabled={busy} data-testid="playbook-stop"><Square className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.handoff.stop', 'Stop')}</button>
                </div>
            </section>
        );
    }

    if (phase.status === 'running' && phase.needsInput) {
        return (
            <section className="pbk-handoff-enter" style={card} role="dialog" aria-label={t('playbooks.handoff.needs_input_title', 'The builder asked a question')} data-testid="playbook-handoff" data-face="needs_input">
                <header className="flex items-start gap-2">
                    <MessageSquare className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />
                    <div className="min-w-0">
                        <h3 className="font-semibold" style={{ fontSize: type.card, color: 'var(--text-primary)' }}>{t('playbooks.handoff.needs_input_title', 'The builder asked a question')}</h3>
                        <p className="mt-1" style={{ fontSize: type.body, color: 'var(--text-secondary)' }}>{t('playbooks.handoff.needs_input_body', 'Answer in the chat on the left and the phase goes on. Or, when what is there is enough, mark it done.')}</p>
                    </div>
                    {onDismiss && (
                        <button type="button" onClick={onDismiss} className="ml-auto shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg" style={{ color: 'var(--text-secondary)' }} aria-label={t('playbooks.handoff.dismiss', 'Hide')} data-testid="playbook-dismiss">
                            <X className="w-4 h-4" aria-hidden="true" />
                        </button>
                    )}
                </header>
                <div className="flex flex-wrap items-center gap-2 mt-4">
                    {canMarkDone && <button type="button" className={btn} style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }} onClick={onMarkDone} disabled={busy} data-testid="playbook-mark-done"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.handoff.mark_done', 'Mark as done')}</button>}
                    <button type="button" className={`${btn} ml-auto`} style={ghost} onClick={onStop} disabled={busy} data-testid="playbook-stop"><Square className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.handoff.stop', 'Stop')}</button>
                </div>
            </section>
        );
    }

    if (phase.status !== 'awaiting') return null;

    return (
        <section className="pbk-handoff-enter" style={card} role="dialog" aria-label={t('playbooks.handoff.title', 'Phase {n} of {total} landed', { n: index + 1, total })} data-testid="playbook-handoff" data-face="awaiting">
            <header className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />
                <div className="min-w-0">
                    <h3 className="font-semibold" style={{ fontSize: type.card, color: 'var(--text-primary)' }}>{t('playbooks.handoff.title', 'Phase {n} of {total} landed', { n: index + 1, total })} — {label(phase)}</h3>
                    {phase.summary && <p className="mt-1" style={{ fontSize: type.body, color: 'var(--text-secondary)' }}>{phase.summary}</p>}
                </div>
            </header>

            {next && CLIENT_RUN.has(kindOf(next)) && typeof next.brief === 'string' && next.brief ? (
                <div className="mt-3">
                    <div className="flex items-center gap-2 mb-1">
                        <label className="block text-[11px] font-medium" htmlFor="pbk-next-brief" style={{ color: 'var(--text-secondary)' }}>
                            {t('playbooks.handoff.next_brief', 'Next: {phase} — the brief the AI gets (edit if you like)', { phase: label(next) })}
                        </label>
                        {!editing && (
                            <button
                                type="button"
                                onClick={() => setEditing(true)}
                                className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded-lg text-[11px] font-medium"
                                style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
                                data-testid="playbook-brief-edit"
                            >
                                <Pencil className="w-3 h-3" aria-hidden="true" />{t('playbooks.handoff.brief_edit', 'Edit')}
                            </button>
                        )}
                    </div>
                    {editing ? (
                        <>
                            <textarea
                                id="pbk-next-brief"
                                data-testid="playbook-next-brief"
                                className="w-full rounded-lg px-3 py-2 text-xs leading-relaxed resize-y"
                                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', minHeight: 96, maxHeight: 220, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                                value={brief}
                                onChange={(e) => setBrief(e.target.value)}
                                maxLength={3000}
                                spellCheck={false}
                                autoFocus
                            />
                            <div className="text-[11px] tabular-nums text-right" style={{ color: 'var(--text-tertiary)' }}>{brief.length}/3000</div>
                        </>
                    ) : (
                        <div
                            className="w-full rounded-lg px-3 py-2 overflow-y-auto"
                            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', maxHeight: 240 }}
                            data-testid="playbook-brief-preview"
                        >
                            <MarkdownRenderer content={brief} className={BRIEF_MD} />
                        </div>
                    )}
                </div>
            ) : next ? (
                // A phase the server runs (a design, a fill) or one whose brief is
                // composed on Continue: say what comes, no empty box.
                <p className="mt-3" style={{ fontSize: type.body, color: 'var(--text-secondary)' }} data-testid="playbook-next-note">
                    {nextWords(next, t)}
                </p>
            ) : (
                <p className="mt-3" style={{ fontSize: type.body, color: 'var(--text-secondary)' }}>{t('playbooks.handoff.last', 'This was the last phase — finish to see the result.')}</p>
            )}

            <div className="flex flex-wrap items-center gap-2 mt-3">
                <button type="button" className={btn} style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }} onClick={() => onContinue(next && CLIENT_RUN.has(kindOf(next)) && next.brief ? brief : undefined)} disabled={busy} data-testid="playbook-continue">
                    {next ? t('playbooks.handoff.continue', 'Continue') : t('playbooks.handoff.finish', 'Finish')}<ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                {next && kindOf(next) !== 'table' && (
                    <button type="button" className={btn} style={ghost} onClick={onSkipNext} disabled={busy} data-testid="playbook-skip-next"><SkipForward className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.handoff.skip_next', 'Skip {phase}', { phase: label(next) })}</button>
                )}
                <button type="button" className={`${btn} ml-auto`} style={ghost} onClick={onStop} disabled={busy} data-testid="playbook-stop"><Square className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.handoff.stop', 'Stop')}</button>
            </div>
        </section>
    );
}
