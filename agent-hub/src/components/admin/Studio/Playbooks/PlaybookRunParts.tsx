import { AlertTriangle, ArrowLeft, Clapperboard, Loader2, PanelLeftClose, PanelLeftOpen, Presentation, Square, Zap } from 'lucide-react';
import PhaseRail from './PhaseRail';
import type { Phase } from './phaseMachine';
import { kindTileStyle } from '@/components/shared/kindColors';
import type { TranslateFn } from '@/hooks/useTranslation';

// The chrome of PlaybookRun: the bar on top, the phase rail beside the stage, and the autopilot countdown.

interface PlaybookBarProps {
    t: TranslateFn;
    title: string;
    status: string | undefined;
    complete: boolean;
    presenter: boolean;
    onBack: () => void;
    phaseLine: string;
    elapsed: string | null;
    running: boolean;
    autopilot: boolean;
    onToggleAutopilot: () => void;
    busy: boolean;
    onStop: () => void;
}

/** Where the playbook is (phase n of total, how long it has run), Autopilot, and Stop. */
export function PlaybookBar({ t, title, status, complete, presenter, onBack, phaseLine, elapsed, running, autopilot, onToggleAutopilot, busy, onStop }: PlaybookBarProps) {
    const { tile, glyph } = kindTileStyle('playbook', { size: 32, pct: 16 });
    return (
    <header className="flex items-center gap-3 px-4 shrink-0 h-[52px] [border-bottom:1px_solid_var(--border-default)] [background:var(--bg-card)]">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-medium h-8 px-2 rounded-lg text-[var(--text-secondary)]" aria-label={t('playbooks.bar.back', 'Back to playbooks')}>
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        </button>
        <span style={tile}><Clapperboard style={glyph} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
            <div className={`truncate font-semibold [color:var(--text-primary)] ${presenter ? '[font-size:18px]' : '[font-size:14px]'}`}>{title}</div>
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                {complete
                    ? <span>{status === 'stopped' ? t('playbooks.status.stopped', 'Stopped') : t('playbooks.state.done', 'Done')}</span>
                    : (
                        <>
                            <span data-testid="playbook-bar-phase">{phaseLine}</span>
                            {elapsed && (<><span aria-hidden="true">·</span><span className="tabular-nums">{elapsed}</span></>)}
                            {running && !autopilot && (<><span aria-hidden="true">·</span><span>{t('playbooks.bar.pauses', 'Pauses after this phase')}</span></>)}
                        </>
                    )}
            </div>
        </div>
        {presenter && (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full [background:color-mix(in_srgb,var(--type-ai)_12%,transparent)] [color:var(--type-ai)]!">
                <Presentation className="w-3 h-3" aria-hidden="true" />{t('playbooks.bar.presenter', 'Presenter')}
            </span>
        )}
        {!complete && (
            <button
                type="button"
                role="switch"
                aria-checked={autopilot}
                onClick={onToggleAutopilot}
                data-testid="playbook-autopilot"
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] text-xs font-medium"
                style={{ color: autopilot ? 'var(--type-ai)' : 'var(--text-secondary)', border: `1px solid ${autopilot ? 'var(--type-ai)' : 'var(--border-default)'}`, background: autopilot ? 'color-mix(in srgb, var(--type-ai) 10%, transparent)' : 'transparent' }}
            >
                <Zap className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.bar.autopilot', 'Autopilot')}
            </button>
        )}
        {!complete && (
            <button type="button" onClick={onStop} disabled={busy} data-testid="playbook-bar-stop" className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] text-xs font-medium disabled:opacity-50 [color:var(--text-secondary)]! [border:1px_solid_var(--border-default)]">
                <Square className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.bar.stop', 'Stop')}
            </button>
        )}
    </header>
    );
}

interface PhaseRailAsideProps {
    t: TranslateFn;
    phases: Phase[];
    activeKey: string | null;
    presenter: boolean;
    collapsed: boolean;
    onToggle: () => void;
    selectedKey: string | null;
    onSelect: (key: string) => void;
}

/** The phase rail, folded to its circles or open, with its own toggle. */
export function PhaseRailAside({ t, phases, activeKey, presenter, collapsed, onToggle, selectedKey, onSelect }: PhaseRailAsideProps) {
    return (
        <aside className="shrink-0 overflow-y-auto" style={{ width: collapsed ? 56 : (presenter ? 280 : 236), padding: collapsed ? '16px 0' : (presenter ? '24px 20px' : '20px 16px'), borderRight: '1px solid var(--border-default)', background: 'var(--bg-card)' }} data-testid="playbook-rail-aside" data-collapsed={collapsed ? '1' : undefined}>
            <div className={collapsed ? 'flex justify-center mb-3' : 'flex justify-end mb-2'}>
                <button
                    type="button"
                    onClick={onToggle}
                    className="inline-flex items-center justify-center rounded-lg w-[24px] h-[24px] [color:var(--text-tertiary)]"
                    aria-label={collapsed ? t('playbooks.rail.expand', 'Show the phases') : t('playbooks.rail.collapse', 'Hide the phases')}
                    data-testid="playbook-rail-toggle"
                >
                    {collapsed ? <PanelLeftOpen className="w-4 h-4" aria-hidden="true" /> : <PanelLeftClose className="w-4 h-4" aria-hidden="true" />}
                </button>
            </div>
            <PhaseRail
                phases={phases}
                activeKey={activeKey}
                t={t}
                presenter={presenter}
                collapsed={collapsed}
                selectedKey={selectedKey}
                onSelect={onSelect}
            />
        </aside>
    );
}

/** "Autopilot continues in n s" with Continue now. */
export function AutopilotCountdown({ t, seconds, onNow }: { t: TranslateFn; seconds: number; onNow: () => void }) {
    return (
            <div className="absolute right-4 bottom-4 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs [background:var(--bg-card)] [border:1px_solid_var(--type-ai)] [color:var(--text-primary)]! [box-shadow:var(--shadow-md)]" role="status" data-testid="playbook-autopilot-countdown">
                <Zap className="w-3.5 h-3.5 [color:var(--type-ai)]" aria-hidden="true" />
                {t('playbooks.bar.autopilot_in', 'Autopilot continues in {n} s', { n: seconds })}
                <button type="button" onClick={onNow} className="font-semibold text-[var(--type-ai)]" data-testid="playbook-autopilot-now">{t('playbooks.bar.autopilot_now', 'Continue now')}</button>
            </div>
    );
}

/** While the playbook is read for the first time. */
export function PlaybookLoading({ t }: { t: TranslateFn }) {
    return (
        <div className="h-full flex items-center justify-center gap-2 text-sm text-[var(--text-secondary)]">
            <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('playbooks.loading', 'Loading…')}
        </div>
    );
}

/** The playbook could not be read: why, and the way back. */
export function PlaybookLoadFailed({ t, message, onBack }: { t: TranslateFn; message: string | undefined; onBack: () => void }) {
    return (
        <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-2 text-[var(--warning)]"><AlertTriangle className="w-4 h-4" aria-hidden="true" />{message || t('playbooks.err_load', 'Could not load this playbook')}</span>
            <button type="button" onClick={onBack} className="text-xs underline">{t('playbooks.done.back', 'Back to playbooks')}</button>
        </div>
    );
}
