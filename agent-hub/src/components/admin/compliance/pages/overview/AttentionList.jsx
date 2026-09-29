import React, { useState } from 'react';
import { ArrowUpRight, CircleAlert, Loader2 } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TONES, toneOfCheckStatus, glyphOfCheckStatus } from '../../../../shared/statusTone';
import StatusPill from '../../shared/StatusPill';
import ArticleRef from '../../shared/ArticleRef';
import SeverityTag from '../../shared/SeverityTag';
import VerificationChip from '../../shared/VerificationChip';
import { complianceActionPath, sectionOfPath } from '../../data/actions';
import { sectionForRegulation } from '../../sections';

/**
 * AttentionList — the "Needs attention" card on the Overview (artboard 1a,
 * PLAN-FRONTEND C6).
 *
 *   attention   GET /attention body | null  → { items, total, tail:[{id,title,severity,status}], warn_tail_count, complete }
 *   items       attention.items | null (null = not loaded / failed → one tertiary line, never an empty list)
 *   failed      the read failed (renders the same line)
 *   onAutoFix(checkId)   core.autoFix — called only after the inline confirm step
 *   autoFixingId         core.autoFixingId
 *   navigate(sectionId, subId?) / onNavigate(path)   hub callbacks; an action path outside the hub goes to onNavigate
 *   onViewAll()          footer link (defaults to navigate(section of the first item))
 *   limit                rows shown (default 5)
 */
export default function AttentionList({
    attention = null, items = null, failed = false, onAutoFix, autoFixingId = null,
    navigate, onNavigate, onViewAll, limit = 5, className = '', testId = 'attention-list',
}) {
    const { t } = useTranslation();
    const [confirmId, setConfirmId] = useState(null);

    const list = Array.isArray(items) ? items.slice(0, limit) : null;
    const total = attention?.total ?? (Array.isArray(items) ? items.length : null);
    const tail = Array.isArray(attention?.tail) ? attention.tail : [];
    const warnTail = attention?.warn_tail_count ?? tail.filter(i => i.status === 'warn').length;
    const firstSection = list?.[0] ? sectionOfItem(list[0]) : null;

    const goViewAll = () => {
        if (onViewAll) return onViewAll();
        if (firstSection) navigate?.(firstSection);
    };

    const runAction = (item) => {
        const action = item.action;
        if (!action) return;
        if (action.type === 'auto_fix') {
            if (confirmId !== item.id) { setConfirmId(item.id); return; }
            setConfirmId(null);
            onAutoFix?.(item.code ?? item.check_id);
            return;
        }
        const path = complianceActionPath(action);
        if (!path) return;
        const section = sectionOfPath(path);
        if (section) {
            const sub = /^admin\/compliance\/[^/]+\/(.+)$/.exec(path)?.[1];
            navigate?.(section, sub ? decodeURIComponent(sub) : undefined);
        } else {
            onNavigate?.(path);
        }
    };

    return (
        <section
            className={`flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3.5 ${className}`}
            style={{ boxShadow: 'var(--shadow-sm)' }}
            data-testid={testId}
            aria-label={t('compliance.ovw_attention_title', 'Needs attention')}
        >
            <header className="flex flex-wrap items-center gap-2">
                <CircleAlert size={14} style={{ color: TONES.warning.ink }} aria-hidden />
                <h3 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{t('compliance.ovw_attention_title', 'Needs attention')}</h3>
                {total != null && total > 0 ? <StatusPill tone="warning" testId={`${testId}-count`}>{total}</StatusPill> : null}
                <span className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.ovw_attention_order', 'failing first, then by severity')}</span>
                {list && list.length > 0 ? (
                    <button type="button" onClick={goViewAll} className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]" data-testid={`${testId}-all`}>
                        {t('compliance.ovw_all', 'All')} <ArrowUpRight size={11} aria-hidden />
                    </button>
                ) : null}
            </header>

            {list === null ? (
                // Before the first response the list is null with failed:false —
                // saying "could not read" there tells the DPO the card is broken
                // on every first paint. Its two siblings in this column already
                // split the two states; this one now does too.
                <p className="mt-3 text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-unavailable`}>
                    {failed
                        ? t('compliance.ovw_unavailable', 'Could not read the attention list right now.')
                        : t('compliance.ovw_attention_loading', 'Reading what needs attention…')}
                </p>
            ) : list.length === 0 ? (
                <p className="mt-3 text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-empty`}>
                    {t('compliance.ovw_attention_empty', 'Nothing needs attention — every check passes or is not applicable.')}
                </p>
            ) : (
                <ul className="m-0 mt-1 list-none p-0" data-testid={`${testId}-rows`}>
                    {list.map(item => (
                        <AttentionRow
                            key={item.id}
                            item={item}
                            confirming={confirmId === item.id}
                            busy={autoFixingId != null && autoFixingId === (item.code ?? item.check_id)}
                            onAction={() => runAction(item)}
                            onCancel={() => setConfirmId(null)}
                            t={t}
                            testId={`${testId}-row`}
                        />
                    ))}
                </ul>
            )}

            {list && list.length > 0 && (tail.length > 0 || (total != null && total > list.length)) ? (
                <footer className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border-default)] pt-2 text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-more`}>
                    <span className="min-w-0 flex-1 truncate">
                        {t('compliance.ovw_more_warn', '{n} more with attention: {titles}', {
                            n: tail.length || (total - list.length),
                            titles: tail.map(i => i.title).join(' · '),
                        })}
                        {warnTail > 0 && tail.length === 0 ? ` (${warnTail})` : ''}
                    </span>
                    <button type="button" onClick={goViewAll} className="inline-flex items-center gap-1 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]" data-testid={`${testId}-view-all`}>
                        {t('compliance.ovw_view_all', 'View all →')}
                    </button>
                </footer>
            ) : null}
        </section>
    );
}

function sectionOfItem(item) {
    const reg = item?.meta?.frameworks?.[0]?.regulation || item?.regulation;
    const fromAction = item?.action ? sectionOfPath(complianceActionPath(item.action) || '') : null;
    return fromAction || (reg ? sectionForRegulation(reg) : null);
}

const ACTION_FALLBACK = Object.freeze({
    auto_fix: 'Auto-fix',
    open_fix: 'Open fix',
    navigate: 'Open',
});

export function actionLabel(action, t) {
    if (!action) return null;
    if (action.label) return action.label;
    const fallback = ACTION_FALLBACK[action.type] || ACTION_FALLBACK.navigate;
    const base = action.label_key ? t(action.label_key, fallback) : t(`compliance.ovw_act_${action.type in ACTION_FALLBACK ? action.type : 'navigate'}`, fallback);
    if (action.type === 'auto_fix' && action.count > 0) return t('compliance.ovw_act_auto_fix_n', '{label} · {n}', { label: base, n: action.count });
    return base;
}

function AttentionRow({ item, confirming, busy, onAction, onCancel, t, testId }) {
    const tone = toneOfCheckStatus(item.status);
    const Glyph = glyphOfCheckStatus(item.status);
    const refs = Array.isArray(item.meta?.frameworks) ? item.meta.frameworks : [];
    const severity = item.meta?.severity || item.severity;
    const verification = item.meta?.verification;
    const detail = item.meta?.detail;
    const label = actionLabel(item.action, t);
    const showSeverity = item.status === 'fail' || item.status === 'warn';

    return (
        <li className="grid grid-cols-[18px_1fr_auto] items-start gap-2.5 border-t border-[var(--border-default)] py-2 first:border-t-0" data-testid={testId} data-status={item.status} data-id={item.id}>
            <Glyph size={14} className="mt-0.5" style={{ color: TONES[tone].ink }} aria-hidden />
            <div className="min-w-0">
                <div className="text-xs font-medium text-[var(--text-primary)]">{item.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--text-secondary)]">
                    {refs.length ? <ArticleRef refs={refs} /> : null}
                    {refs.length && showSeverity && severity ? <Dot /> : null}
                    {showSeverity && severity ? <SeverityTag severity={severity} /> : null}
                    {verification ? <><Dot /><VerificationChip verification={verification} minimal /></> : null}
                    {detail ? <><Dot /><span className="truncate">{detail}</span></> : null}
                </div>
            </div>
            {label ? (
                confirming ? (
                    <div className="flex items-center gap-1" data-testid={`${testId}-confirm`}>
                        <span className="text-[11px] text-[var(--text-secondary)]">{t('compliance.ovw_autofix_confirm', 'Apply the fix?')}</span>
                        <button type="button" onClick={onAction} className="rounded-md border px-2 py-1 text-[11px] font-semibold" style={{ borderColor: TONES.success.raw, color: TONES.success.ink }} data-testid={`${testId}-confirm-yes`}>
                            {t('common.confirm', 'Confirm')}
                        </button>
                        <button type="button" onClick={onCancel} className="rounded-md border border-[var(--border-default)] px-2 py-1 text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-confirm-no`}>
                            {t('common.cancel', 'Cancel')}
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={onAction}
                        disabled={busy}
                        className="inline-flex items-center gap-1 self-center whitespace-nowrap rounded-md border border-[var(--border-default)] bg-transparent px-2.5 py-1 text-[11px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-60"
                        data-testid={`${testId}-action`}
                        data-action={item.action?.type}
                    >
                        {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : null}
                        {label}
                    </button>
                )
            ) : <span />}
        </li>
    );
}

function Dot() {
    return <span aria-hidden className="text-[var(--text-tertiary)]">·</span>;
}
