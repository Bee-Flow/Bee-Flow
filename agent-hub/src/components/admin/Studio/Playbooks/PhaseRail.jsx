import { Check, Lock, Pause, X } from 'lucide-react';
import React from 'react';
import { phaseFact } from './playbookView';
import { phaseLabel } from './recipes';
import { studioLockHint } from '../studioApps';

/**
 * The five phases as a vertical rail: a 28 px circle per phase, 2 px
 * connectors, one 11 px fact line from the artifacts once a phase has landed
 * ("Facturen · 32 rijen", "Routine 'Facturen inlezen'"). The circle is the
 * status — pending hollow, ready hollow blue, running filled blue with the
 * breathing ring, awaiting a pause glyph, done emerald check, failed red X,
 * skipped struck through, locked a lock with the plan hint.
 */
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

function Circle({ status }) {
    const base = { width: 28, height: 28, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxSizing: 'border-box' };
    switch (status) {
        case 'done':
            return <span style={{ ...base, background: 'var(--kind-playbook)', color: 'var(--accent-primary-fg)' }}><Check className="w-4 h-4" strokeWidth={2.5} aria-hidden="true" /></span>;
        case 'running':
            return <span className="pbk-ring" style={{ ...base, background: 'var(--type-ai)', color: 'var(--accent-primary-fg)' }}><span style={{ width: 8, height: 8, borderRadius: 999, background: 'currentColor' }} /></span>;
        case 'awaiting':
            return <span style={{ ...base, border: '2px solid var(--type-ai)', color: 'var(--type-ai)' }}><Pause className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden="true" /></span>;
        case 'failed':
            return <span style={{ ...base, background: 'var(--error)', color: 'var(--accent-primary-fg)' }}><X className="w-4 h-4" strokeWidth={2.5} aria-hidden="true" /></span>;
        case 'locked':
            return <span style={{ ...base, border: '2px solid var(--border-default)', color: 'var(--text-tertiary)' }}><Lock className="w-3.5 h-3.5" aria-hidden="true" /></span>;
        case 'skipped':
            return <span style={{ ...base, border: '2px dashed var(--border-default)', color: 'var(--text-tertiary)' }}><span style={{ width: 10, height: 2, background: 'currentColor' }} /></span>;
        case 'ready':
            return <span style={{ ...base, border: '2px solid var(--type-ai)' }} />;
        default:
            return <span style={{ ...base, border: '2px solid var(--border-default)' }} />;
    }
}

export default function PhaseRail({ phases = [], activeKey = null, t, presenter = false, onSelect = null, selectedKey = null, collapsed = false }) {
    const list = Array.isArray(phases) ? phases : [];
    // Collapsed (a live fill fills the screen): the circles alone, still the
    // way into a phase's details.
    if (collapsed) {
        return (
            <ol className="flex flex-col items-center gap-2" aria-label={t('playbooks.rail.aria', 'Phases')} data-testid="playbook-rail" data-collapsed="1">
                {list.map((p) => (
                    <li key={p.key} data-testid={`playbook-phase-${p.key}`} data-status={p.status} aria-current={p.key === activeKey ? 'step' : undefined}>
                        <button
                            type="button"
                            onClick={onSelect ? () => onSelect(p.key) : undefined}
                            disabled={!onSelect}
                            className="rounded-full block"
                            style={{ outline: p.key === selectedKey ? '2px solid var(--type-ai)' : 'none', outlineOffset: 2, cursor: onSelect ? 'pointer' : 'default' }}
                            title={phaseLabel(p, t)}
                            aria-label={`${phaseLabel(p, t)} — ${t('playbooks.rail.open_phase', 'Show what this phase did')}`}
                            data-testid={`playbook-phase-open-${p.key}`}
                        >
                            <Circle status={p.status} />
                        </button>
                    </li>
                ))}
            </ol>
        );
    }
    return (
        <ol className="flex flex-col" aria-label={t('playbooks.rail.aria', 'Phases')} data-testid="playbook-rail">
            {list.map((p, i) => {
                const fact = phaseFact(p, t);
                const active = p.key === activeKey;
                const selected = p.key === selectedKey;
                const stateText = STATE_TEXT[p.status] ? t(STATE_TEXT[p.status][0], STATE_TEXT[p.status][1]) : p.status;
                const color = p.status === 'pending' ? 'var(--text-tertiary)' : p.status === 'failed' ? 'var(--error-ink, var(--error))' : 'var(--text-primary)';
                return (
                    <li key={p.key} className="flex gap-3" data-testid={`playbook-phase-${p.key}`} data-status={p.status} aria-current={active ? 'step' : undefined}>
                        <div className="flex flex-col items-center" style={{ width: 28 }}>
                            <Circle status={p.status} />
                            {i < list.length - 1 && (
                                <span aria-hidden="true" style={{ width: 2, flex: 1, minHeight: 22, margin: '4px 0', background: p.status === 'done' || p.status === 'skipped' ? 'var(--kind-playbook)' : 'var(--border-default)', opacity: p.status === 'done' ? 1 : 0.7 }} />
                            )}
                        </div>
                        <div className="min-w-0 pb-4 flex-1" style={{ paddingTop: 4 }}>
                            <Body onSelect={onSelect} phaseKey={p.key} selected={selected} label={phaseLabel(p, t)} t={t}>
                            <div className="flex items-baseline gap-2">
                                <span className="font-semibold" style={{ fontSize: presenter ? 15 : 13, color, textDecoration: p.status === 'skipped' ? 'line-through' : 'none' }}>
                                    {phaseLabel(p, t)}
                                </span>
                                <span className="text-[11px]" style={{ color: p.status === 'running' || p.status === 'awaiting' ? 'var(--type-ai)' : 'var(--text-secondary)' }}>{stateText}</span>
                            </div>
                            {fact && <div className="text-[11px] truncate" style={{ color: 'var(--text-secondary)', maxWidth: presenter ? 230 : 190 }}>{fact}</div>}
                            {p.status === 'locked' && (
                                <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{studioLockHint('upgrade', t)}</div>
                            )}
                            {p.status === 'skipped' && p.error === 'no_status_column' && (
                                <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.skip.no_status_column', 'The table has no status column')}</div>
                            )}
                            </Body>
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

/**
 * The text beside a circle is a BUTTON when the page can inspect a phase —
 * the whole block, so a fact line is as clickable as the name.
 */
function Body({ onSelect, phaseKey, selected, label, t, children }) {
    if (!onSelect) return children;
    return (
        <button
            type="button"
            onClick={() => onSelect(phaseKey)}
            className="block w-full text-left rounded-lg -mx-1.5 px-1.5 py-0.5"
            style={{ background: selected ? 'color-mix(in srgb, var(--type-ai) 10%, transparent)' : 'transparent' }}
            aria-pressed={selected}
            aria-label={`${label} — ${t('playbooks.rail.open_phase', 'Show what this phase did')}`}
            data-testid={`playbook-phase-open-${phaseKey}`}
        >
            {children}
        </button>
    );
}
