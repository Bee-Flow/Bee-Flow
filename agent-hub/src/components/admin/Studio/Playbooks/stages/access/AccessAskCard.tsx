import { AlertTriangle, Check, Loader2, Send, Sparkles } from 'lucide-react';
import React from 'react';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { TONES } from '../../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../../shared/StudioSectionHeader';
import { ASK_EXAMPLES } from '../accessView';
import type { ScreenPlan } from './accessScreenTypes';

interface AccessAskCardProps {
    said: string;
    setSaid: (said: string) => void;
    asking: boolean;
    askError: string | null;
    ask: () => void | Promise<void>;
    plan: ScreenPlan;
    presenter: boolean;
    t: TranslateFn;
}

export default function AccessAskCard({ said, setSaid, asking, askError, ask, plan, presenter, t }: AccessAskCardProps) {
    // Say it — the way in, not a note field.
    return (
        <section className="rounded-xl p-3 [border:1px_solid_var(--type-ai)] [background:color-mix(in_srgb,var(--type-ai)_4%,transparent)]">
            <p className="flex items-center gap-1.5 font-semibold mb-1.5" style={{ fontSize: presenter ? 15 : 13, color: 'var(--text-primary)' }}>
                <Sparkles className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />
                {t('playbooks.access.ask_title', 'Say who should use it')}
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
                <textarea
                    value={said}
                    onChange={(e) => setSaid(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(); }}
                    rows={2}
                    maxLength={2000}
                    disabled={asking}
                    className="flex-1 min-w-0 rounded-lg px-2.5 py-2 text-xs resize-y [background:var(--bg-primary)] [border:1px_solid_var(--border-default)] [color:var(--text-primary)]!"
                    placeholder={t('playbooks.access.ask_placeholder', 'e.g. Finance may look at it, Ann approves, nobody else.')}
                    aria-label={t('playbooks.access.ask_label', 'Say who should use this app')}
                    data-testid="playbook-access-ask"
                />
                <button
                    type="button"
                    onClick={ask}
                    disabled={asking || !said.trim()}
                    className="shrink-0 self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50"
                    style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    data-testid="playbook-access-ask-send"
                >
                    {asking ? <><Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('playbooks.access.asking', 'Reading…')}</> : <><Send className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.access.ask_send', 'Propose')}</>}
                </button>
            </div>
            {/* What it can take, so nobody has to guess at a blank box. */}
            {!said && !plan.roles.length && (
                <div className="mt-2 flex flex-wrap gap-1.5" data-testid="playbook-access-examples">
                    {ASK_EXAMPLES.map((eg) => (
                        <button
                            key={eg.key}
                            type="button"
                            onClick={() => setSaid(t(eg.key, eg.en))}
                            className="text-[11px] px-2 py-[3px] rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [border:1px_dashed_var(--border-default)] [color:var(--text-secondary)]! [outline-color:var(--type-ai)]!"
                        >
                            {t(eg.key, eg.en)}
                        </button>
                    ))}
                </div>
            )}
            {plan.note && <p className="mt-2 text-xs text-[var(--text-secondary)]" data-testid="playbook-access-note">{plan.note}</p>}
            {askError && <p role="alert" className="mt-1 text-[11px] [color:var(--error-ink,var(--error))]!">{askError}</p>}
            {plan.roles.length > 0 && (
                <ul className="mt-2 space-y-1" data-testid="playbook-access-roles">
                    {plan.roles.map((r) => (
                        <li key={r.key} className="flex items-start gap-1.5" style={{ fontSize: presenter ? 13 : 11, color: 'var(--text-secondary)' }}>
                            <Check className="w-3 h-3 mt-0.5 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />
                            <span>
                                <span className="font-medium text-[var(--text-primary)]">{r.label}</span>
                                {r.scope
                                    ? ` — ${t('playbooks.access.role_scope', 'sees only rows where {column} is {value}', { column: r.scope.column, value: r.scope.value })}`
                                    : ` — ${t('playbooks.access.role_all', 'sees every row')}`}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {plan.unresolved && plan.unresolved.length > 0 && (
                <ul className="mt-2 space-y-0.5" data-testid="playbook-access-unresolved">
                    {plan.unresolved.map((u, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-[11px]" style={{ color: TONES.warning.ink }}>
                            <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                            {t('playbooks.access.unresolved', 'Could not find {kind} "{name}"', { kind: u.kind, name: u.name })}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
