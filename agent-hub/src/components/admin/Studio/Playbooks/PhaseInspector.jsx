import { AlertTriangle, ExternalLink, RotateCcw, SkipForward, X } from 'lucide-react';
import React from 'react';
import { canRetry, canSkip, kindOf } from './phaseMachine';
import { errorText, phaseDuration, phaseFacts, phaseLinks } from './playbookView';
import { phaseLabel } from './recipes';
import { STAGE_BUTTON, STAGE_BUTTON_GHOST } from './stages/stageChrome';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import MarkdownRenderer from '../../../renderers/MarkdownRenderer';

/**
 * Click a phase in the rail and this panel says what that phase did: its
 * state and how long it took, what landed, what it made (the table with its
 * columns, the automation, the design, the app) with a door to each, and the
 * brief the AI works from. It slides over the stage and NEVER unmounts it —
 * the builders of the running phase keep their stream and their canvas.
 */
const LINK_TEXT = {
    datatable: ['playbooks.rows.open', 'Open the table'],
    automation: ['playbooks.inspect.open_automation', 'Open the automation'],
    app: ['playbooks.inspect.open_app', 'Open the app'],
};

const STATE_TEXT = {
    pending: ['playbooks.state.pending', 'Later'],
    ready: ['playbooks.state.ready', 'Ready to start'],
    running: ['playbooks.state.running', 'Building…'],
    awaiting: ['playbooks.state.awaiting', 'Paused for you'],
    done: ['playbooks.state.done', 'Done'],
    failed: ['playbooks.state.failed', 'Failed'],
    skipped: ['playbooks.state.skipped', 'Skipped'],
    locked: ['playbooks.state.locked', 'Locked'],
};

// The brief is markdown (see HandoffCard): small type, tight lists.
const BRIEF_MD = 'text-[11px] leading-relaxed [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:pl-4 [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:text-[11px] [&_h2]:text-[11px] [&_h3]:text-[11px] [&_h2]:mt-0 [&_h2]:mb-1 [&_h3]:mb-0.5 [&_pre]:my-1';

export default function PhaseInspector({ phase, t, onClose, onNavigate = null, presenter = false, onRetry = null, onSkip = null, busy = false }) {
    if (!phase) return null;
    const facts = phaseFacts(phase, t);
    const links = phaseLinks(phase);
    const took = phaseDuration(phase);
    const state = STATE_TEXT[phase.status] ? t(STATE_TEXT[phase.status][0], STATE_TEXT[phase.status][1]) : phase.status;
    const columns = kindOf(phase) === 'table' && Array.isArray(phase.artifacts?.fields) ? phase.artifacts.fields : [];
    const nothing = !facts.length && !phase.summary && !phase.error && !phase.brief;
    const retryable = !!onRetry && canRetry(phase);
    const skippable = !!onSkip && canSkip(phase);

    return (
        <aside
            className="absolute inset-y-0 left-0 z-20 flex flex-col overflow-hidden"
            style={{ width: presenter ? 400 : 340, background: 'var(--bg-card)', borderRight: '1px solid var(--border-default)', boxShadow: 'var(--shadow-lg, var(--shadow-md))' }}
            data-testid="playbook-inspector"
            data-phase={phase.key}
            aria-label={t('playbooks.inspect.title', 'What this phase did')}
        >
            <header className="flex items-center gap-2 px-4 shrink-0" style={{ height: 44, borderBottom: '1px solid var(--border-default)' }}>
                <span className="font-semibold truncate" style={{ fontSize: presenter ? 15 : 13, color: 'var(--text-primary)' }}>{phaseLabel(phase, t)}</span>
                <span className="text-[11px]" style={{ color: phase.status === 'failed' ? 'var(--error-ink, var(--error))' : 'var(--text-secondary)' }}>{state}</span>
                <button type="button" onClick={onClose} className="ml-auto inline-flex items-center justify-center rounded-lg" style={{ width: 28, height: 28, color: 'var(--text-secondary)' }} aria-label={t('playbooks.inspect.close', 'Close')} data-testid="playbook-inspector-close">
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4 text-xs">
                {took && (
                    <div style={{ color: 'var(--text-secondary)' }}>{t('playbooks.inspect.took', 'Took {time}', { time: took })}</div>
                )}

                {phase.summary && (
                    <Block title={t('playbooks.inspect.summary', 'What landed')}>
                        <p style={{ color: 'var(--text-primary)' }}>{phase.summary}</p>
                    </Block>
                )}

                {phase.error && (
                    <Block title={t('playbooks.inspect.error', 'What went wrong')}>
                        <p className="flex items-start gap-1.5" style={{ color: 'var(--error-ink, var(--error))' }}>
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />{errorText(phase.error, t)}
                        </p>
                    </Block>
                )}

                {facts.length > 0 && (
                    <Block title={t('playbooks.inspect.made', 'What it made')}>
                        <dl className="space-y-1">
                            {facts.map((f, i) => (
                                <div key={i} className="flex gap-2">
                                    <dt className="shrink-0" style={{ color: 'var(--text-secondary)', minWidth: 84 }}>{f.label}</dt>
                                    <dd className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }} title={f.value}>{f.value}</dd>
                                </div>
                            ))}
                        </dl>
                    </Block>
                )}

                {columns.length > 0 && (
                    <Block title={t('playbooks.inspect.columns', 'Columns')}>
                        <ul className="flex flex-wrap gap-1.5" data-testid="playbook-inspector-columns">
                            {columns.map((c) => (
                                <li key={c.key} className="inline-flex items-baseline gap-1 px-2 py-0.5 rounded-lg text-[11px]" style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                                    {c.name || c.key}<span style={{ color: 'var(--text-tertiary)' }}>{c.type}</span>
                                </li>
                            ))}
                        </ul>
                    </Block>
                )}

                {links.length > 0 && onNavigate && (
                    <div className="flex flex-wrap gap-2">
                        {links.map((l) => (
                            <button key={l.kind} type="button" onClick={() => onNavigate(l.to)} className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--type-ai)' }} data-testid={`playbook-inspector-open-${l.kind}`}>
                                {t(LINK_TEXT[l.kind][0], LINK_TEXT[l.kind][1])}<ExternalLink className="w-3 h-3" aria-hidden="true" />
                            </button>
                        ))}
                    </div>
                )}

                {phase.brief && (
                    <Block title={t('playbooks.inspect.brief', 'The brief the AI works from')}>
                        <div className="break-words rounded-lg p-2" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', maxHeight: 260, overflowY: 'auto' }} data-testid="playbook-inspector-brief">
                            <MarkdownRenderer content={phase.brief} className={BRIEF_MD} />
                        </div>
                    </Block>
                )}

                {nothing && <p style={{ color: 'var(--text-secondary)' }}>{t('playbooks.inspect.empty', 'This phase has not run yet.')}</p>}
            </div>

            {/* A FOOT, because the handoff card renders nothing for a phase that
                is `running` without a question — which is the state every hang
                lands in. This was the only page in the film where a stuck phase
                had no button at all. */}
            {(retryable || skippable) && (
                <div className="shrink-0 flex flex-wrap items-center gap-2" style={{ padding: '10px 14px', borderTop: '1px solid var(--border-default)', background: 'var(--bg-primary)' }} data-testid="playbook-inspector-actions">
                    {retryable && (
                        <button type="button" className={STAGE_BUTTON} style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }} onClick={onRetry} disabled={busy} data-testid="playbook-inspector-retry">
                            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.handoff.retry', 'Retry')}
                        </button>
                    )}
                    {skippable && (
                        <button type="button" className={STAGE_BUTTON} style={STAGE_BUTTON_GHOST} onClick={onSkip} disabled={busy} data-testid="playbook-inspector-skip">
                            <SkipForward className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.handoff.skip', 'Skip this phase')}
                        </button>
                    )}
                    {phase.status === 'running' && (
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {t('playbooks.inspect.stuck', 'Taking too long? Skip it, or Stop and resume — resuming fails whatever is still running.')}
                        </span>
                    )}
                </div>
            )}
        </aside>
    );
}

function Block({ title, children }) {
    return (
        <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-tertiary)' }}>{title}</h3>
            {children}
        </section>
    );
}
