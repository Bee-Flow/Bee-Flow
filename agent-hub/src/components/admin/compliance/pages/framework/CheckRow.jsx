import { ArrowRight, ArrowUpRight, ChevronDown, ChevronUp, RefreshCw, Wrench } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { affectedProjects } from './AffectedProjects';
import {
    isOpen, otherFrameworkRefs, articleForRegulation, resolveRemediation, autoFixCount, formatRunAt,
} from './checkSort';
import { FindingStateChip } from './FindingDecision';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TableRow, TableCell } from '../../../../shared/DataTable';
import { TONES, toneOfCheckStatus, glyphOfCheckStatus } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { sectionById } from '../../sections';
import ArticleRef, { formatArticleRef, formatRef } from '../../shared/ArticleRef';
import SeverityTag from '../../shared/SeverityTag';
import VerificationChip from '../../shared/VerificationChip';

/**
 * CheckRow — one check in the framework table (artboard 1b).
 *
 * glyph | title · severity (open rows only) · "also counts for …" · details | article | verification | last run | actions
 *
 * The stripe follows the STATUS (design rule 5): a passing critical check is
 * green, and the severity word appears only when the row is open (fail/warn).
 * Rows that do not apply read in tertiary text — they are on the page so the
 * count adds up, not to be looked at.
 *
 * The actions cell offers what the row can DO: for an open row the fix
 * (remediation link → "Open fix ↗" / "Go to <section> →" / "Configure ↗",
 * auto-fix → Wrench "Auto-fix · n" with the legacy confirm step rendered as a
 * full-width strip under the row), for a quiet row the rerun button. Every
 * button stops the click before the row toggles.
 */

export const SECONDARY_BTN = 'inline-flex items-center gap-1 h-7 px-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[11px] font-medium text-[var(--text-primary)] whitespace-nowrap hover:bg-[var(--bg-secondary)] disabled:opacity-60 disabled:cursor-not-allowed';
export const ICON_BTN = 'inline-flex items-center justify-center h-7 w-7 rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-60 disabled:cursor-not-allowed';

/** The label + glyph of the remediation button for a resolved link (null → no button). */
export function remediationLabel(rem, t) {
    if (!rem) return null;
    if (rem.kind === 'settings') return { text: t('compliance.tbl_act_configure', 'Configure'), Icon: ArrowUpRight };
    if (rem.kind === 'section') {
        // The DSR register is a queue: the artboard's verb is "Afhandelen" (Handle), not "Go to".
        if (rem.sectionId === 'dsr') return { text: t('compliance.tbl_act_handle', 'Handle'), Icon: ArrowRight };
        const section = sectionById(rem.sectionId);
        return {
            text: t('compliance.tbl_act_go_to', 'Go to {section}', { section: t(section.labelKey, section.labelFallback) }),
            Icon: ArrowRight,
        };
    }
    return { text: t('compliance.tbl_act_open_fix', 'Open fix'), Icon: ArrowUpRight };
}

function stop(fn) {
    return (e) => { e.stopPropagation(); fn?.(e); };
}

export function AutoFixConfirm({ check, columns, accent, busy, onConfirm, onCancel, testId }) {
    const { t } = useTranslation();
    const affected = Array.isArray(check.evidence?.missing_disclosure) ? check.evidence.missing_disclosure : [];
    return (
        <TableRow accent={accent} expanded columns={[{ id: 'confirm', width: '1fr' }]} testId={testId} className="items-start">
            <div className="pl-7 pr-1 py-1 flex flex-col gap-2" role="group" aria-label={t('compliance.auto_fix_confirm_title', 'Apply the automatic fix?')}>
                <div className="text-[12px] font-semibold text-[var(--text-primary)]">{t('compliance.auto_fix_confirm_title', 'Apply the automatic fix?')}</div>
                <div className="text-[11px] text-[var(--text-secondary)] leading-relaxed">{t('compliance.auto_fix_confirm_desc', 'This applies the automated remediation for this check to every affected item below. The change is recorded in the evidence log and you can adjust the result afterwards.')}</div>
                {affected.length > 0 && (
                    <div>
                        <div className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">{t('compliance.auto_fix_affected', 'Affected agents')}</div>
                        <ul className="m-0 pl-4 text-[11px] text-[var(--text-secondary)] list-disc">
                            {affected.map((a) => <li key={a.id || a.name}>{a.name || a.id}</li>)}
                        </ul>
                    </div>
                )}
                <div className="flex items-center gap-2">
                    <button type="button" onClick={stop(onConfirm)} disabled={busy} data-testid={testId ? `${testId}-apply` : undefined}
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[8px] text-[11px] font-semibold disabled:opacity-60"
                        style={PRIMARY_ACTION_STYLE}>
                        <Wrench size={12} /> {t('compliance.auto_fix_apply', 'Apply fix')}
                    </button>
                    <button type="button" onClick={stop(onCancel)} className={SECONDARY_BTN} data-testid={testId ? `${testId}-cancel` : undefined}>
                        {t('compliance.auto_fix_cancel', 'Cancel')}
                    </button>
                </div>
            </div>
        </TableRow>
    );
}

/**
 * CheckCard — the same check on a phone (artboard 1h): the glyph, the title
 * on one line, and the columns that survive 390px folded into one 11px meta
 * line (article · verification · last run), with the chevron on the right.
 *
 * It is the whole tappable row, ≥44px, and it opens the SAME `CheckExpansion`
 * the desktop row opens (which already folds to one column inside the table's
 * container query) — the fix buttons live there, so the card does not repeat
 * them. No new copy: every string is the desktop row's.
 */
export function CheckCard({
    check,
    regulation,
    expanded = false,
    onToggle,
    lastRunAt = null,
    now = undefined,
    testId = undefined,
}) {
    const { t, locale } = useTranslation();
    const status = check.status;
    const open = isOpen(status);
    const na = status === 'not_applicable';
    const tone = toneOfCheckStatus(status);
    const Glyph = glyphOfCheckStatus(status);
    const Chevron = expanded ? ChevronUp : ChevronDown;
    const title = check.titleKey ? t(check.titleKey, check.check_id) : (check.title || check.check_id);
    const article = articleForRegulation(check, regulation);
    const runAt = formatRunAt(check.run_at ?? check.last_run_at ?? lastRunAt, { now: now ?? Date.now(), locale });
    return (
        <button
            type="button"
            onClick={() => onToggle?.(check.check_id)}
            aria-expanded={expanded}
            data-testid={testId}
            data-status={status || undefined}
            className={`w-full text-left min-h-[44px] flex items-center gap-2.5 ${na ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}
        >
            <Glyph size={16} aria-hidden="true" style={{ color: TONES[tone].ink, flexShrink: 0 }} data-testid={testId ? `${testId}-glyph` : undefined} />
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="flex items-center gap-2 min-w-0">
                    <span className="text-[12px] font-medium truncate">{title}</span>
                    {open && <SeverityTag severity={check.severity} testId={testId ? `${testId}-severity` : undefined} />}
                </span>
                <span className="flex items-center gap-2 min-w-0 text-[11px] text-[var(--text-tertiary)]">
                    <ArticleRef testId={testId ? `${testId}-article` : undefined}>{article ? formatRef(article) : null}</ArticleRef>
                    <VerificationChip verification={check.verification} testId={testId ? `${testId}-verification` : undefined} />
                    {runAt && <span className="tabular-nums truncate" data-testid={testId ? `${testId}-last-run` : undefined}>{runAt}</span>}
                </span>
            </span>
            <Chevron size={16} aria-hidden="true" className="flex-shrink-0 text-[var(--text-tertiary)]" />
        </button>
    );
}

export default function CheckRow({
    check,
    regulation,
    columns,
    expanded = false,
    onToggle,
    focus = false,
    rerunning = false,
    autoFixing = false,
    onRerun,
    onAutoFix,
    onOpenLink,
    canOpenLink = () => true,
    lastRunAt = null,
    now = undefined,
    testId = undefined,
}) {
    const { t, locale } = useTranslation();
    const rootRef = useRef(null);
    const [confirmFix, setConfirmFix] = useState(false);

    const status = check.status;
    const open = isOpen(status);
    const na = status === 'not_applicable';
    const tone = toneOfCheckStatus(status);
    const Glyph = glyphOfCheckStatus(status);
    // A built-in check carries a dictionary key; a CUSTOM framework's check is
    // written by the org itself and carries the literal title instead. Falling
    // back to the id would print `CUSTOM-ACME-3` where a sentence belongs.
    const title = check.titleKey ? t(check.titleKey, check.check_id) : (check.title || check.check_id);
    const others = otherFrameworkRefs(check, regulation);
    const alsoText = others.map(r => formatArticleRef(r?.regulation, r?.ref, t)).filter(Boolean).join(' · ');
    const article = articleForRegulation(check, regulation);
    const rem = open ? resolveRemediation(check.remediationLink) : null;
    const remLabel = rem && canOpenLink(rem) && typeof onOpenLink === 'function' ? remediationLabel(rem, t) : null;
    const canAutoFix = open && !!check.autoFixId && typeof onAutoFix === 'function';
    const fixCount = autoFixCount(check);
    const runAt = formatRunAt(check.run_at ?? check.last_run_at ?? lastRunAt, { now: now ?? Date.now(), locale });
    const cells = Object.fromEntries((columns || []).map((c) => [c.id, c]));
    // A per-subject row about ONE project names it (its current name, resolved
    // by the server) and offers the way into it.
    const projects = check.scope_id ? affectedProjects(check) : [];
    const subject = projects.length === 1 ? projects[0] : null;
    const subjectRem = subject && subject.path ? { kind: 'external', path: subject.path } : null;
    const canOpenSubject = !!subjectRem && typeof onOpenLink === 'function' && canOpenLink(subjectRem);

    // Navigated here from the overview: scroll the row into view once. The
    // host opens it (focusId is the initial expansion) — this only brings it
    // on screen, so a later manual close is not undone by a re-render.
    useEffect(() => {
        if (!focus) return undefined;
        const el = rootRef.current;
        if (!el || typeof el.scrollIntoView !== 'function') return undefined;
        const id = setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
        return () => clearTimeout(id);
    }, [focus]);

    const Chevron = expanded ? ChevronUp : ChevronDown;
    const textTone = na ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]';

    return (
        <>
            <TableRow
                accent={tone}
                expanded={expanded}
                onClick={() => onToggle?.(check.check_id)}
                ariaExpanded={expanded}
                columns={columns}
                testId={testId}
                className={focus ? 'ring-2 ring-inset ring-[var(--kind-compliance)]' : ''}
                style={{ color: na ? 'var(--text-tertiary)' : undefined }}
            >
                <TableCell column={cells.glyph} className="flex items-center">
                    {/* The anchor for scrollIntoView sits INSIDE the row: TableRow does not forward a ref. */}
                    <span ref={rootRef} className="inline-flex" data-testid={testId ? `${testId}-anchor` : undefined}>
                        <Glyph size={16} aria-hidden="true" style={{ color: TONES[tone].ink, flexShrink: 0 }} data-testid={testId ? `${testId}-glyph` : undefined} />
                    </span>
                </TableCell>
                <TableCell column={cells.check} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-[12px] font-medium truncate ${textTone}`}>{title}</span>
                        {open && <SeverityTag severity={check.severity} testId={testId ? `${testId}-severity` : 'severity-tag'} />}
                        {open && <FindingStateChip state={check.finding_state} testId={testId ? `${testId}-state` : 'check-state'} />}
                    </div>
                    {subject && (
                        <div className="text-[11px] text-[var(--text-secondary)] truncate" data-testid={testId ? `${testId}-subject` : 'check-subject'}>{subject.name}</div>
                    )}
                    {others.length > 0 && (
                        <div className="text-[10px] text-[var(--text-tertiary)] flex items-center gap-1 min-w-0" data-testid={testId ? `${testId}-also` : 'check-also-counts'}>
                            {/* One line that ends in an ellipsis: a check that counts for six
                                frameworks used to wrap the label and run the refs over the
                                Article column. The full list is the tooltip. */}
                            <span className="shrink-0 whitespace-nowrap">· {t('compliance.tbl_also_counts', 'also counts for')}</span>
                            <span className="block min-w-0 truncate" title={alsoText}>
                                <ArticleRef refs={others} className="!text-[10px] !text-[var(--text-tertiary)]" testId={testId ? `${testId}-also-ref` : 'check-also-ref'} />
                            </span>
                        </div>
                    )}
                    {check.details && (
                        <div className={`text-[11px] truncate ${na ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`} title={check.details}>{check.details}</div>
                    )}
                </TableCell>
                <TableCell column={cells.article}>
                    <ArticleRef testId={testId ? `${testId}-article` : 'article-ref'}>{article ? formatRef(article) : null}</ArticleRef>
                </TableCell>
                <TableCell column={cells.verification}>
                    <VerificationChip verification={check.verification} testId={testId ? `${testId}-verification` : 'verification-chip'} />
                </TableCell>
                <TableCell column={cells.last_run} className="text-[11px] text-[var(--text-tertiary)] tabular-nums" testId={testId ? `${testId}-last-run` : undefined}>
                    {runAt}
                </TableCell>
                <TableCell column={cells.actions} className="flex items-center justify-end gap-1" align="right">
                    {canOpenSubject && (
                        <button type="button" className={ICON_BTN} onClick={stop(() => onOpenLink(subjectRem, check))}
                            aria-label={t('compliance.tbl_open_subject', 'Open the affected item')} title={t('compliance.tbl_open_subject', 'Open the affected item')}
                            data-testid={testId ? `${testId}-open-subject` : 'check-open-subject'}>
                            <ArrowUpRight size={13} aria-hidden="true" />
                        </button>
                    )}
                    {remLabel && (
                        <button type="button" className={SECONDARY_BTN} onClick={stop(() => onOpenLink(rem, check))} data-testid={testId ? `${testId}-fix` : 'check-fix'}>
                            {remLabel.text} <remLabel.Icon size={11} aria-hidden="true" />
                        </button>
                    )}
                    {canAutoFix && (
                        <button type="button" className={SECONDARY_BTN} disabled={autoFixing || confirmFix}
                            onClick={stop(() => setConfirmFix(true))} data-testid={testId ? `${testId}-autofix` : 'check-autofix'}
                            title={t('compliance.auto_fix', 'Fix automatically')}>
                            <Wrench size={11} aria-hidden="true" className={autoFixing ? 'animate-spin' : ''} />
                            {autoFixing ? t('compliance.auto_fixing', 'Applying fix...') : t('compliance.tbl_act_auto_fix', 'Auto-fix')}
                            {!autoFixing && fixCount != null && <span className="text-[var(--text-tertiary)] tabular-nums">· {fixCount}</span>}
                        </button>
                    )}
                    {!open && typeof onRerun === 'function' && (
                        <button type="button" className={ICON_BTN} disabled={rerunning} onClick={stop(() => onRerun(check.check_id))}
                            aria-label={t('compliance.rerun_check', 'Re-run this check')} title={t('compliance.rerun_check', 'Re-run this check')}
                            data-testid={testId ? `${testId}-rerun` : 'check-rerun'} data-busy={rerunning || undefined}>
                            <RefreshCw size={13} aria-hidden="true" className={rerunning ? 'animate-spin' : ''} />
                        </button>
                    )}
                    <span className={ICON_BTN} aria-hidden="true"><Chevron size={14} /></span>
                </TableCell>
            </TableRow>
            {confirmFix && canAutoFix && (
                <AutoFixConfirm
                    check={check}
                    columns={columns}
                    accent={tone}
                    busy={autoFixing}
                    onConfirm={() => { setConfirmFix(false); onAutoFix(check.check_id); }}
                    onCancel={() => setConfirmFix(false)}
                    testId={testId ? `${testId}-confirm` : 'check-autofix-confirm'}
                />
            )}
        </>
    );
}
