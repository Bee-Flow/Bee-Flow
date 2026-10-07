import React, { useId, useState } from 'react';
import { ArrowUpRight, ChevronDown, CircleAlert, Loader2 } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TONES, toneOfCheckStatus, glyphOfCheckStatus } from '../../../../shared/statusTone';
import StatusPill from '../../shared/StatusPill';
import ArticleRef from '../../shared/ArticleRef';
import SeverityTag from '../../shared/SeverityTag';
import VerificationChip, { VERIFICATION_KINDS } from '../../shared/VerificationChip';
import { complianceActionPath, resolveTarget } from '../../data/actions';

/**
 * AttentionList — the "Needs attention" card on the Overview (artboard 1a,
 * PLAN-FRONTEND C6).
 *
 *   attention   GET /attention body | null  → { items, total, complete }
 *   items       attention.items | null (null = not loaded / failed → one tertiary line, never an empty list)
 *   failed      the read failed (renders the same line)
 *   onAutoFix(checkId)   core.autoFix — called only after the inline confirm step
 *   autoFixingId         core.autoFixingId
 *   navigate(sectionId, subId?, tab?) / onNavigate(path)   hub callbacks; an action path outside the hub goes to onNavigate
 *   limit                rows shown before "Show all {n}" (default 5)
 *
 * The whole to-do list lives here: the first `limit` rows, then ONE toggle
 * that expands the rest inline, each row with its own action. A link that
 * opened the first item's framework used to stand in for "all" and never
 * listed the items of the other frameworks together. Rows the server did not
 * send (`total` beyond `items`, the request is capped at 50) are named in one
 * line at the end, never silently dropped.
 */
export default function AttentionList({
    attention = null, items = null, failed = false, onAutoFix, autoFixingId = null,
    navigate, onNavigate, limit = 5, className = '', testId = 'attention-list',
}) {
    const { t } = useTranslation();
    const [confirmId, setConfirmId] = useState(null);
    const [expanded, setExpanded] = useState(false);
    const listId = useId();

    const all = Array.isArray(items) ? items : null;
    const canExpand = !!all && all.length > limit;
    const list = all ? (expanded || !canExpand ? all : all.slice(0, limit)) : null;
    const total = attention?.total ?? (all ? all.length : null);
    const elsewhere = all && typeof total === 'number' ? Math.max(0, total - all.length) : 0;

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
        const target = resolveTarget(path);
        if (target) navigate?.(target.section, target.id, target.tab);
        else onNavigate?.(path);
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
                <ul id={listId} className="m-0 mt-1 list-none p-0" data-testid={`${testId}-rows`}>
                    {list.map(item => (
                        <AttentionRow
                            key={item.id}
                            item={item}
                            confirming={confirmId === item.id}
                            busy={autoFixingId != null && autoFixingId === (item.code ?? item.check_id)}
                            onAction={() => runAction(item)}
                            onOpenSubject={item.meta?.link && onNavigate
                                ? () => { const p = complianceActionPath({ type: 'navigate', target: item.meta.link }); if (p) onNavigate(p); }
                                : null}
                            onCancel={() => setConfirmId(null)}
                            t={t}
                            testId={`${testId}-row`}
                        />
                    ))}
                </ul>
            )}

            {list && list.length > 0 && (canExpand || elsewhere > 0) ? (
                <footer className="mt-1 flex flex-col items-start gap-1 border-t border-[var(--border-default)] pt-2 text-[11px] text-[var(--text-tertiary)]">
                    {elsewhere > 0 && (expanded || !canExpand) ? (
                        <p className="m-0" data-testid={`${testId}-elsewhere`}>
                            {t('compliance.ovw_more_elsewhere', '{n} more on the framework pages', { n: elsewhere })}
                        </p>
                    ) : null}
                    {canExpand ? (
                        <button
                            type="button"
                            onClick={() => setExpanded(v => !v)}
                            aria-expanded={expanded}
                            aria-controls={listId}
                            className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                            data-testid={`${testId}-toggle`}
                        >
                            {expanded
                                ? t('compliance.ovw_show_fewer', 'Show fewer')
                                : t('compliance.ovw_show_all', 'Show all {n}', { n: all.length })}
                            <ChevronDown size={12} aria-hidden className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                        </button>
                    ) : null}
                </footer>
            ) : null}
        </section>
    );
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

function AttentionRow({ item, confirming, busy, onAction, onOpenSubject, onCancel, t, testId }) {
    const tone = toneOfCheckStatus(item.status);
    const Glyph = glyphOfCheckStatus(item.status);
    const refs = Array.isArray(item.meta?.frameworks) ? item.meta.frameworks : [];
    const severity = item.meta?.severity || item.severity;
    const verification = item.meta?.verification;
    const detail = item.meta?.detail;
    // A per-source check collapses into one item; it says how many subjects.
    const affected = Number(item.meta?.subject_count) > 1 ? Number(item.meta.subject_count) : null;
    const label = actionLabel(item.action, t);
    const showSeverity = (item.status === 'fail' || item.status === 'warn') && !!severity;
    // Separators sit BETWEEN the parts that exist: a register item has no
    // verification kind and an item may have no refs, so a fixed sequence of
    // dots left leading, trailing and double '·' behind.
    const parts = [
        refs.length ? <ArticleRef key="refs" refs={refs} max={2} /> : null,
        showSeverity ? <SeverityTag key="severity" severity={severity} tone="neutral" /> : null,
        VERIFICATION_KINDS.includes(verification) ? <VerificationChip key="verification" verification={verification} minimal /> : null,
        affected ? <span key="affected" data-testid={`${testId}-affected`}>{t('compliance.attention_subjects', '{n} affected', { n: affected })}</span> : null,
    ].filter(Boolean);

    return (
        <li className="grid grid-cols-[18px_1fr_auto] items-start gap-2.5 border-t border-[var(--border-default)] py-2 first:border-t-0" data-testid={testId} data-status={item.status} data-id={item.id}>
            <Glyph size={14} className="mt-0.5" style={{ color: TONES[tone].ink }} aria-hidden />
            <div className="min-w-0">
                <div className="text-xs font-medium text-[var(--text-primary)]">{item.title}</div>
                {parts.length ? (
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-meta`}>
                        {parts.map((part, i) => (
                            <React.Fragment key={part.key}>{i > 0 ? <Dot /> : null}{part}</React.Fragment>
                        ))}
                    </div>
                ) : null}
                {detail || onOpenSubject ? (
                    <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-detail`}>
                        {detail ? <span className="min-w-0">{detail}</span> : null}
                        {onOpenSubject ? (
                            <button type="button" onClick={onOpenSubject} className="inline-flex items-center gap-0.5 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline" data-testid={`${testId}-open-subject`}>
                                {t('compliance.attention_open_subject', 'Open')} <ArrowUpRight size={10} aria-hidden />
                            </button>
                        ) : null}
                    </div>
                ) : null}
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
