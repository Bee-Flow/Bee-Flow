import { AlertTriangle, Check, Globe, Loader2, X } from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '@/components/shared/StudioSectionHeader';

interface AccessGateCardProps {
    changes: { kind: string; words: string }[];
    blocked: string | null;
    applying: boolean;
    approve: () => void | Promise<void>;
    discard: () => void;
    planEmpty: boolean | undefined;
    ncResult: object | null;
    ncWords: ReactNode;
    applyError: string | null;
    blockers: string[] | null;
    presenter: boolean;
    t: TranslateFn;
}

export default function AccessGateCard({ changes, blocked, applying, approve, discard, planEmpty, ncResult, ncWords, applyError, blockers, presenter, t }: AccessGateCardProps) {
    // The gate
    return (
        <section
            className={`rounded-2xl [border:1px_solid_var(--kind-playbook)] [background:color-mix(in_srgb,_var(--kind-playbook)_6%,_transparent)] ${presenter ? '[padding:22px]' : '[padding:16px]'}`}
            data-testid="playbook-access-approve-box"
        >
            {/* What Approve will do, one line each. It used to be a
                single run-on sentence under a button that publishes an
                app and hands out access. */}
            <p className={`font-semibold mb-1 [color:var(--text-primary)] ${presenter ? '[font-size:15px]' : '[font-size:13px]'}`}>
                {changes.length
                    ? t('playbooks.access.will_do', 'Approving will:')
                    : t('playbooks.access.will_nothing', 'Nothing chosen yet')}
            </p>
            {changes.length > 0 && (
                <ul className="mb-2 space-y-0.5" data-testid="playbook-access-changes">
                    {changes.map((c, i) => (
                        <li
                            key={i}
                            className={`flex items-start gap-1.5 ${presenter ? '[font-size:13px]' : '[font-size:11px]'} ${c.kind === 'note' ? '[color:var(--text-tertiary)]' : '[color:var(--text-secondary)]'}`}
                            data-kind={c.kind}
                        >
                            {c.kind === 'note'
                                ? <span className="mt-0.5 shrink-0" aria-hidden="true">·</span>
                                : <Check className="w-3 h-3 mt-0.5 shrink-0 [color:var(--kind-playbook)]" aria-hidden="true" />}
                            {c.words}
                        </li>
                    ))}
                </ul>
            )}
            {blocked && (
                <p className={`mb-2 [color:var(--text-secondary)] ${presenter ? '[font-size:13px]' : '[font-size:11px]'}`} data-testid="playbook-access-why-disabled">
                    {blocked}
                </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={approve}
                    disabled={applying || !!blocked}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    data-testid="playbook-access-approve"
                >
                    {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                    {t('playbooks.access.approve', 'Approve and apply')}
                </button>
                <button
                    type="button"
                    onClick={discard}
                    disabled={applying || planEmpty}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-medium disabled:opacity-50 [color:var(--text-secondary)]! [border:1px_solid_var(--border-default)]"
                    data-testid="playbook-access-discard"
                >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.access.discard', 'Discard')}
                </button>
                <span className="text-[11px] text-[var(--text-secondary)]">{t('playbooks.access.gate', 'Nothing is written before you press Approve.')}</span>
            </div>
            {ncResult && !applyError && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]" data-testid="playbook-access-nc-result">
                    <Globe className="w-3 h-3 shrink-0" aria-hidden="true" />{ncWords}
                </p>
            )}
            {applyError && <p role="alert" className="mt-1 text-[11px] [color:var(--error-ink,var(--error))]!">{t('playbooks.access.apply_failed', 'Could not apply: {what}', { what: applyError })}</p>}
            {blockers && blockers.length > 0 && (
                <ul className="mt-1 space-y-0.5" data-testid="playbook-access-blockers">
                    <li className="text-[11px] text-[var(--text-secondary)]">{t('playbooks.access.blockers', 'The app itself is what stops the publish:')}</li>
                    {blockers.map((b, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[11px] text-[var(--warning)]">
                            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />{b}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
