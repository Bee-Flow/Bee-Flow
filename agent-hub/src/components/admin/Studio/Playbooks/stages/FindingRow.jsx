import { AlertTriangle, Check, Database, ExternalLink, Loader2, Sparkles, Workflow, X, LayoutGrid } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { TONES } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { isResolvable, linkFor, severityTone, severityWord, targetWords } from './complianceView';

/**
 * One thing the review wants tidied up.
 *
 * The row is deliberately calm. Only `high` carries a tint; `medium` gets a
 * hairline and `low` nothing at all, and the severity is a WORD — a wall of
 * orange triangles was being read as "the build is broken", which is not what
 * a review of a fresh build means (owner, 2026-09-16).
 *
 * The subject is a chip that LINKS: a finding that cannot take you to the
 * thing it found is a finding nobody acts on.
 *
 * Resolve is propose-then-approve, like the access phase: pressing it asks the
 * server what it would change, the change appears here in words, and only
 * Apply writes anything.
 */
const KIND_ICON = { table: Database, automation: Workflow, app: LayoutGrid };

export default function FindingRow({
    finding, facts, t, presenter = false, onNavigate = null,
    keepChecked = false, onKeepChange = null, showKeep = false,
    onResolve = null, onApply = null, plan = null, planBusy = false, planError = null, applying = false,
}) {
    const tone = severityTone(finding.severity);
    const isHigh = finding.severity === 'high';
    const target = targetWords(finding, t);
    const to = linkFor(finding, facts);
    const TargetIcon = (target && KIND_ICON[target.kind]) || null;
    const canResolve = !!onResolve && isResolvable(finding);
    const [open, setOpen] = useState(false);

    const ask = useCallback(async () => {
        setOpen(true);
        if (onResolve) await onResolve(finding.code);
    }, [onResolve, finding.code]);

    return (
        <li
            className="rounded-xl"
            style={{
                border: `1px solid ${isHigh ? TONES.error.raw : 'var(--border-default)'}`,
                background: isHigh ? 'color-mix(in srgb, var(--error) 5%, var(--bg-card))' : 'var(--bg-card)',
                padding: presenter ? 16 : 12,
            }}
            data-testid="playbook-compliance-finding"
            data-severity={finding.severity}
            data-code={finding.code}
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                    className="text-[10px] font-semibold uppercase tracking-[.04em]"
                    style={{ color: TONES[tone].ink }}
                    data-testid="playbook-compliance-severity"
                >
                    {severityWord(finding.severity, t)}
                </span>
                {/* Where it came from. The rules read a fact; the model read the
                    same facts and noticed something a rule could not. The two
                    must not look alike — a dashed border is the app's own way
                    of saying "this one is a judgement". */}
                <span
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-[1px] rounded-full"
                    style={{
                        border: `1px ${finding.source === 'ai' ? 'dashed' : 'solid'} var(--border-default)`,
                        color: 'var(--text-tertiary)',
                    }}
                    data-testid="playbook-compliance-source"
                    data-source={finding.source || 'rule'}
                >
                    {finding.source === 'ai' && <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />}
                    {finding.source === 'ai' ? t('playbooks.compliance.by_ai', 'noticed by the AI') : t('playbooks.compliance.by_rule', 'from the facts')}
                </span>
            </div>

            <h3 className="mt-1 font-semibold" style={{ fontSize: presenter ? 17 : 14, color: 'var(--text-primary)' }}>{finding.title}</h3>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[11px] whitespace-nowrap" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--text-secondary)' }}>
                    {finding.framework}{finding.article ? ` ${finding.article}` : ''}
                </span>
                {target && (
                    to && onNavigate ? (
                        <button
                            type="button"
                            onClick={() => onNavigate(to)}
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-[2px] rounded-full"
                            style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                            data-testid="playbook-compliance-target"
                            data-kind={target.kind}
                        >
                            {TargetIcon && <TargetIcon className="w-3 h-3 shrink-0" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />}
                            <span className="truncate" style={{ maxWidth: 220 }}>{target.name}</span>
                            <ExternalLink className="w-2.5 h-2.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                        </button>
                    ) : (
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }} data-testid="playbook-compliance-target">{target.name}</span>
                    )
                )}
                {!target && finding.subject && <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{finding.subject}</span>}
            </div>

            <p className="mt-1.5" style={{ fontSize: presenter ? 14 : 12, color: 'var(--text-secondary)' }}>{finding.why}</p>
            <p className="mt-1" style={{ fontSize: presenter ? 14 : 12, color: 'var(--text-primary)' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>{t('playbooks.compliance.fix', 'What to do')}: </span>{finding.fix}
            </p>

            {/* The proposal — in this row, in words, before anything is written. */}
            {open && (
                <div
                    className="mt-2 rounded-lg p-2.5"
                    style={{ border: '1px solid var(--type-ai)', background: 'color-mix(in srgb, var(--type-ai) 5%, transparent)' }}
                    data-testid="playbook-compliance-proposal"
                >
                    {planBusy && (
                        <p className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                            <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                            {t('playbooks.compliance.fix_thinking', 'Working out what to change…')}
                        </p>
                    )}
                    {!planBusy && planError && (
                        <p role="alert" className="text-[11px]" style={{ color: 'var(--error-ink, var(--error))' }}>{planError}</p>
                    )}
                    {!planBusy && plan && (
                        <>
                            <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{plan.title}</p>
                            <ul className="mt-1 space-y-0.5">
                                {(plan.what || []).map((line, i) => (
                                    <li key={i} className="flex items-start gap-1.5" style={{ fontSize: presenter ? 13 : 11, color: 'var(--text-secondary)' }}>
                                        <Check className="w-3 h-3 mt-0.5 shrink-0" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />
                                        {line}
                                    </li>
                                ))}
                            </ul>
                            {plan.note && <p className="mt-1 text-[11px] italic" style={{ color: 'var(--text-tertiary)' }}>{plan.note}</p>}
                            {(plan.unresolved || []).length > 0 && (
                                <ul className="mt-1 space-y-0.5" data-testid="playbook-compliance-unresolved">
                                    {plan.unresolved.map((u, i) => (
                                        <li key={i} className="flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--warning-ink, var(--warning))' }}>
                                            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />{u.what}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {plan.modelFailed && (
                                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('playbooks.compliance.fix_no_model', 'The AI could not be reached, so this is what the rules alone would do.')}
                                </p>
                            )}
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => onApply && onApply(finding.code, plan)}
                                    disabled={applying || plan.empty}
                                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                    style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                                    data-testid="playbook-compliance-apply"
                                >
                                    {applying ? <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check className="w-3 h-3" aria-hidden="true" />}
                                    {t('playbooks.compliance.fix_apply', 'Apply this change')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setOpen(false)}
                                    disabled={applying}
                                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium disabled:opacity-50"
                                    style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
                                    data-testid="playbook-compliance-fix-cancel"
                                >
                                    <X className="w-3 h-3" aria-hidden="true" />{t('playbooks.compliance.fix_cancel', 'Leave it')}
                                </button>
                                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('playbooks.compliance.fix_gate', 'Nothing is written until you press Apply.')}
                                </span>
                            </div>
                        </>
                    )}
                </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-3">
                {canResolve && !open && (
                    <button
                        type="button"
                        onClick={ask}
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ color: 'var(--type-ai)', border: '1px solid var(--type-ai)', background: 'color-mix(in srgb, var(--type-ai) 8%, transparent)', outlineColor: 'var(--type-ai)' }}
                        data-testid="playbook-compliance-resolve"
                    >
                        <Sparkles className="w-3 h-3" aria-hidden="true" />{t('playbooks.compliance.resolve', 'Resolve with AI')}
                    </button>
                )}
                {!canResolve && (
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }} data-testid="playbook-compliance-manual">
                        {t('playbooks.compliance.needs_you', 'This one is a judgement — it needs you.')}
                    </span>
                )}
                {to && onNavigate && (
                    <button type="button" onClick={() => onNavigate(to)} className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--type-ai)' }} data-testid="playbook-compliance-goto">
                        {t('playbooks.compliance.goto', 'Take me there')}<ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </button>
                )}
                {showKeep && (
                    <label className="inline-flex items-center gap-1.5 text-[11px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                        <input
                            type="checkbox"
                            checked={keepChecked}
                            onChange={(e) => onKeepChange && onKeepChange(finding.code, e.target.checked)}
                            className="h-3.5 w-3.5 accent-[var(--kind-playbook)]"
                            data-testid="playbook-compliance-keep"
                            data-code={finding.code}
                        />
                        {t('playbooks.compliance.keep', 'Track this in the risk register')}
                    </label>
                )}
            </div>
        </li>
    );
}
