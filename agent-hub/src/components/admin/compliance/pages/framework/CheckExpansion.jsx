import React, { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, FileJson, Fingerprint, History, Info, Wrench } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TableRow } from '../../../../shared/DataTable';
import { TONES, toneOfCheckStatus } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { API } from '../../data/api';
import { remediationLabel } from './CheckRow';
import { isOpen, resolveRemediation, shortHash, toMs } from './checkSort';

/**
 * CheckExpansion — the open row under a check (artboard 1b): three columns,
 *   Why it matters · How to fix · History & evidence,
 * stacked under 1180px of the table card.
 *
 * The third column is lazy: the audit trail (`GET /checks/:id/history` +
 * `GET /evidence/:id`, through core.loadTrail) is fetched the first time the
 * row opens, and only then. A failed read is its own line — the column never
 * pretends an empty history.
 */

const STATUS_LABEL = Object.freeze({
    pass: ['compliance.status_pass', 'Passing'],
    warn: ['compliance.status_warn', 'Needs attention'],
    fail: ['compliance.status_fail', 'Failing'],
    not_applicable: ['compliance.status_na', 'Not applicable'],
    pending: ['compliance.status_pending', 'Not yet run'],
});

const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };

/** `check.remediation_steps[]` when the registry sends them, else the one translated remediation. */
export function remediationSteps(check, t) {
    if (Array.isArray(check?.remediation_steps) && check.remediation_steps.length > 0) {
        return check.remediation_steps
            .map((s) => (typeof s === 'string' ? s : s && (s.key ? t(s.key, s.text || '') : s.text)))
            .filter(Boolean);
    }
    const one = check?.remediationKey ? t(check.remediationKey, '') : '';
    return one ? [one] : [];
}

function formatWhen(value, locale) {
    const ms = toMs(value);
    if (ms === null) return '—';
    try {
        return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
    } catch {
        return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    }
}

function ColumnHead({ Icon, children }) {
    return (
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">
            <Icon size={12} aria-hidden="true" />
            <span>{children}</span>
        </div>
    );
}

export default function CheckExpansion({
    check,
    regulation,
    exportsEnabled = true,
    dl = (url) => url,
    loadTrail,
    onOpenLink,
    canOpenLink = () => true,
    onAutoFix,
    autoFixing = false,
    testId = 'check-expansion',
}) {
    const { t, locale } = useTranslation();
    const tone = toneOfCheckStatus(check.status);
    const open = isOpen(check.status);
    const [trail, setTrail] = useState(null);       // { history, evidence } once loaded
    const [trailState, setTrailState] = useState(typeof loadTrail === 'function' ? 'loading' : 'idle');

    useEffect(() => {
        if (typeof loadTrail !== 'function') return undefined;
        let alive = true;
        setTrailState('loading');
        let pending;
        try { pending = Promise.resolve(loadTrail(check.check_id)); } catch (e) { pending = Promise.reject(e); }
        pending
            .then((r) => {
                if (!alive) return;
                const history = Array.isArray(r?.history) ? r.history : [];
                const evidence = Array.isArray(r?.evidence) ? r.evidence : [];
                setTrail({ history, evidence, chain: r?.chain ?? null });
                setTrailState('ready');
            })
            .catch(() => { if (alive) setTrailState('failed'); });
        return () => { alive = false; };
    }, [check.check_id, loadTrail]);

    const description = check.descriptionKey ? t(check.descriptionKey, '') : '';
    const steps = remediationSteps(check, t);
    const rem = open ? resolveRemediation(check.remediationLink) : null;
    const remLabel = rem && canOpenLink(rem) && typeof onOpenLink === 'function' ? remediationLabel(rem, t) : null;
    const canAutoFix = open && !!check.autoFixId && typeof onAutoFix === 'function';
    const sevLabel = check.severity ? t(`compliance.sev_${check.severity}`, check.severity) : '';
    const weight = Number.isFinite(Number(check.weight)) && check.weight !== null && check.weight !== undefined ? Number(check.weight) : null;

    const history = (trail?.history || []).slice(0, 15);
    const latest = (trail?.evidence || []).find((e) => e && (e.hash || e.payload_hash));
    const hash = latest ? shortHash(latest.hash || latest.payload_hash) : null;
    const chainIntact = trail?.chain?.intact ?? (latest ? (latest.chain_intact ?? true) : null);
    const evidenceUrl = exportsEnabled ? dl(`${API}/evidence/${encodeURIComponent(check.check_id)}`) : null;

    return (
        <TableRow accent={tone} expanded columns={[{ id: 'expansion', width: '1fr' }]} testId={testId} className="items-start">
            <div className="grid grid-cols-[1fr_1fr_1.1fr] @max-[1180px]/ctable:grid-cols-1 gap-5 pl-7 pr-1 py-1 text-[12px] text-[var(--text-secondary)] leading-relaxed">
                {/* Why it matters */}
                <section className="flex flex-col gap-1.5 min-w-0" data-testid={`${testId}-why`}>
                    <ColumnHead Icon={Info}>{t('compliance.why_matters', 'Why this matters')}</ColumnHead>
                    {description ? <p className="m-0">{description}</p> : <p className="m-0 text-[var(--text-tertiary)]">—</p>}
                    {weight !== null && sevLabel && (
                        <p className="m-0 text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-weight`}>
                            {t('compliance.tbl_weight_line', 'Severity {severity} · weight {weight}', { severity: sevLabel, weight })}
                        </p>
                    )}
                </section>

                {/* How to fix */}
                <section className="flex flex-col gap-1.5 min-w-0" data-testid={`${testId}-fix`}>
                    <ColumnHead Icon={Wrench}>{t('compliance.how_to_fix', 'How to fix')}</ColumnHead>
                    {steps.length > 0 ? (
                        <ol className="m-0 pl-4 flex flex-col gap-1 list-decimal">
                            {steps.map((s, i) => <li key={i}>{s}</li>)}
                        </ol>
                    ) : (
                        <p className="m-0 text-[var(--text-tertiary)]">{open ? t('compliance.tbl_no_steps', 'No remediation steps recorded for this check.') : t('compliance.tbl_nothing_to_fix', 'Nothing to fix — this check passes.')}</p>
                    )}
                    {remLabel || canAutoFix ? (
                        <div className="flex items-center gap-2 pt-1">
                            {remLabel && (
                                <button type="button" onClick={() => onOpenLink(rem, check)} data-testid={`${testId}-primary`}
                                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[8px] text-[11px] font-semibold"
                                    style={PRIMARY_ACTION_STYLE}>
                                    {remLabel.text} {rem.kind === 'section' ? <ArrowRight size={12} aria-hidden="true" /> : <ArrowUpRight size={12} aria-hidden="true" />}
                                </button>
                            )}
                            {canAutoFix && (
                                <button type="button" onClick={() => onAutoFix(check.check_id)} disabled={autoFixing} data-testid={`${testId}-autofix`}
                                    className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[8px] text-[11px] font-semibold disabled:opacity-60 ${remLabel ? 'border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)]' : ''}`}
                                    style={remLabel ? undefined : PRIMARY_ACTION_STYLE}>
                                    <Wrench size={12} aria-hidden="true" className={autoFixing ? 'animate-spin' : ''} />
                                    {autoFixing ? t('compliance.auto_fixing', 'Applying fix...') : t('compliance.tbl_act_auto_fix', 'Auto-fix')}
                                </button>
                            )}
                        </div>
                    ) : null}
                </section>

                {/* History & evidence */}
                <section className="flex flex-col gap-1.5 min-w-0" data-testid={`${testId}-history`} aria-busy={trailState === 'loading' || undefined}>
                    <ColumnHead Icon={History}>{t('compliance.tbl_history_evidence', 'History & evidence')}</ColumnHead>
                    {trailState === 'loading' && <p className="m-0 text-[var(--text-tertiary)]">{t('compliance.trail_loading', 'Loading audit trail...')}</p>}
                    {trailState === 'failed' && <p className="m-0 text-[var(--text-tertiary)]" data-testid={`${testId}-trail-failed`}>{t('compliance.tbl_trail_unavailable', 'The audit trail could not be read.')}</p>}
                    {trailState === 'idle' && <p className="m-0 text-[var(--text-tertiary)]">{t('compliance.trail_empty', 'Nothing recorded yet.')}</p>}
                    {trailState === 'ready' && (
                        <>
                            {history.length === 0 ? (
                                <p className="m-0 text-[var(--text-tertiary)]">{t('compliance.trail_empty', 'Nothing recorded yet.')}</p>
                            ) : (
                                <ol className="m-0 p-0 list-none flex flex-col gap-1" data-testid={`${testId}-timeline`}>
                                    {history.map((h, i) => {
                                        const ht = toneOfCheckStatus(h.status);
                                        const [key, en] = STATUS_LABEL[h.status] || STATUS_LABEL.pending;
                                        return (
                                            <li key={h.id ?? i} className="grid grid-cols-[8px_96px_1fr] items-center gap-2 text-[11px]" data-status={h.status}>
                                                <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full" style={{ background: TONES[ht].raw }} />
                                                <span className="text-[var(--text-tertiary)] tabular-nums whitespace-nowrap">{formatWhen(h.run_at, locale)}</span>
                                                <span className="truncate">
                                                    <span className="font-medium" style={{ color: TONES[ht].ink }}>{t(key, en)}</span>
                                                    {h.run_type && <span className="text-[var(--text-tertiary)]"> · {h.run_type}</span>}
                                                    {h.details && <span className="text-[var(--text-tertiary)]"> · {h.details}</span>}
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ol>
                            )}
                            {hash && (
                                <div className="flex items-center gap-1.5 text-[11px] pt-1" data-testid={`${testId}-hash`}>
                                    <Fingerprint size={12} aria-hidden="true" style={{ color: chainIntact === false ? TONES.error.ink : TONES.success.ink }} />
                                    <span style={MONO} className="text-[var(--text-secondary)]" title={latest?.hash || latest?.payload_hash}>sha256 {hash}</span>
                                    <span className="text-[var(--text-tertiary)]">
                                        · {chainIntact === false ? t('compliance.tbl_chain_broken', 'chain broken') : t('compliance.tbl_chain_intact', 'chain intact')}
                                    </span>
                                </div>
                            )}
                            {evidenceUrl && (
                                <a href={evidenceUrl} target="_blank" rel="noopener noreferrer" data-testid={`${testId}-evidence-link`}
                                    className="inline-flex items-center gap-1.5 self-start text-[11px] font-medium text-[var(--text-primary)] underline-offset-2 hover:underline">
                                    <FileJson size={12} aria-hidden="true" /> {t('compliance.tbl_evidence_json', 'Evidence (JSON)')}
                                </a>
                            )}
                        </>
                    )}
                </section>
            </div>
        </TableRow>
    );
}
