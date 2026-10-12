import { ArrowRight, ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { affectedProjects } from './AffectedProjects';
import {
    isOpen, otherFrameworkRefs, articleForRegulation, resolveRemediation, formatRunAt, rowKeyOf, subjectLabel,
} from './checkSort';
import { FindingStateChip } from './FindingDecision';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TableRow, TableCell } from '../../../../shared/DataTable';
import { TONES, toneOfCheckStatus, glyphOfCheckStatus } from '../../../../shared/statusTone';
import { sectionById } from '../../sections';
import ArticleRef, { formatArticleRef, formatRef } from '../../shared/ArticleRef';
import SeverityTag from '../../shared/SeverityTag';
import VerificationChip from '../../shared/VerificationChip';

/**
 * CheckRow — one check in the framework table (artboard 1b).
 *
 * glyph | title · severity · decision / subject / "also counts for …" / details | article | verification | last run | actions
 *
 * The stripe follows the STATUS (design rule 5): a passing critical check is
 * green. The severity word appears only when the row is open (fail/warn), in
 * neutral text, since the stripe and glyph already carry the colour. Rows that
 * do not apply read in tertiary text: they are on the page so the count adds
 * up, not to be looked at.
 *
 * A per-source check has one row per subject, so the row names its subject
 * (`subjectLabel`) under the title; four "DPIA for high-risk agents" rows
 * must be told apart at a glance.
 *
 * The actions cell holds ONE compact action for an open row: "Fix" (or
 * "Handle" for the request queue) with the full destination as its title and
 * in its accessible name. Auto-fix and Re-run live in the expansion, one
 * click deeper, where Auto-fix asks before it changes anything. Every button
 * stops the click before the row toggles.
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

/**
 * The row's compact action: the short word on the button ("Fix", or
 * "Handle" for the request queue) and where it goes, spelled out for the
 * tooltip and the accessible name ("Go to Processing register (ROPA)"). An
 * admin escape has no section to name, so its destination is "Open fix".
 */
export function compactRemediation(rem, t) {
    if (!rem) return null;
    const full = remediationLabel(rem, t);
    const short = rem.kind === 'section' && rem.sectionId === 'dsr'
        ? t('compliance.tbl_act_handle', 'Handle')
        : t('compliance.tbl_act_fix', 'Fix');
    const named = rem.kind === 'section' || rem.kind === 'settings';
    let destination = full.text;
    if (named) {
        const section = sectionById(rem.sectionId);
        destination = t('compliance.tbl_act_go_to', 'Go to {section}', { section: t(section.labelKey, section.labelFallback) });
    }
    return { short, destination, named, Icon: full.Icon };
}

function stop(fn) {
    return (e) => { e.stopPropagation(); fn?.(e); };
}

function checkTitle(check, t) {
    // A built-in check carries a dictionary key; a CUSTOM framework's check is
    // written by the org itself and carries the literal title instead. Falling
    // back to the id would print `CUSTOM-ACME-3` where a sentence belongs.
    return check.titleKey ? t(check.titleKey, check.check_id) : (check.title || check.check_id);
}

/**
 * CheckCard — the same check as a card (artboard 1h): on a phone, and in any
 * table card narrower than the table's `cardsBelow` (a 1024 window, a table
 * beside an open drawer). The glyph, the whole title (it wraps rather than
 * losing words), the finding on one line, and the columns that survive folded
 * into one 11px meta line led by the subject (subject · article ·
 * verification · last run), with the chevron on the right.
 *
 * It is the whole tappable row, ≥44px, and it opens the SAME `CheckExpansion`
 * the desktop row opens — the fix, Auto-fix and Re-run live there, so the
 * card does not repeat them. No new copy: every string is the desktop row's.
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
    const title = checkTitle(check, t);
    const subject = check.scope_id ? subjectLabel(check) : null;
    const article = articleForRegulation(check, regulation);
    const runAt = formatRunAt(check.run_at ?? check.last_run_at ?? lastRunAt, { now: now ?? Date.now(), locale });
    return (
        <button
            type="button"
            onClick={() => onToggle?.(rowKeyOf(check))}
            aria-expanded={expanded}
            data-testid={testId}
            data-status={status || undefined}
            className={`w-full text-left min-h-[44px] flex items-center gap-2.5 ${na ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}
        >
            <Glyph size={16} aria-hidden="true" style={{ color: TONES[tone].ink, flexShrink: 0 }} data-testid={testId ? `${testId}-glyph` : undefined} />
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                    <span className="text-[12px] font-medium break-words min-w-0" data-testid={testId ? `${testId}-title` : undefined}>{title}</span>
                    {open && <SeverityTag severity={check.severity} tone="neutral" testId={testId ? `${testId}-severity` : undefined} />}
                    {open && <FindingStateChip state={check.finding_state} testId={testId ? `${testId}-state` : undefined} />}
                </span>
                {check.details && (
                    <span className={`block text-[11px] truncate ${na ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`} title={check.details} data-testid={testId ? `${testId}-details` : undefined}>
                        {check.details}
                    </span>
                )}
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 text-[11px] text-[var(--text-tertiary)]">
                    {subject && <span className="min-w-0 max-w-full truncate text-[var(--text-secondary)] font-medium" data-testid={testId ? `${testId}-subject` : undefined}>{subject}</span>}
                    <ArticleRef testId={testId ? `${testId}-article` : undefined}>{article ? formatRef(article) : null}</ArticleRef>
                    <VerificationChip verification={check.verification} compact testId={testId ? `${testId}-verification` : undefined} />
                    {runAt && <span className="tabular-nums whitespace-nowrap" data-testid={testId ? `${testId}-last-run` : undefined}>{runAt}</span>}
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
    onOpenLink,
    canOpenLink = () => true,
    lastRunAt = null,
    now = undefined,
    testId = undefined,
}) {
    const { t, locale } = useTranslation();
    const rootRef = useRef(null);

    const status = check.status;
    const open = isOpen(status);
    const na = status === 'not_applicable';
    const tone = toneOfCheckStatus(status);
    const Glyph = glyphOfCheckStatus(status);
    const title = checkTitle(check, t);
    const others = otherFrameworkRefs(check, regulation);
    const alsoText = others.map(r => formatArticleRef(r?.regulation, r?.ref, t)).filter(Boolean).join(' · ');
    const article = articleForRegulation(check, regulation);
    const rem = open ? resolveRemediation(check.remediationLink) : null;
    const action = rem && canOpenLink(rem) && typeof onOpenLink === 'function' ? compactRemediation(rem, t) : null;
    const runAt = formatRunAt(check.run_at ?? check.last_run_at ?? lastRunAt, { now: now ?? Date.now(), locale });
    const cells = Object.fromEntries((columns || []).map((c) => [c.id, c]));
    // A per-subject row names what it is about: the agent, automation or
    // project (current name, resolved by the server).
    const subject = check.scope_id ? subjectLabel(check) : null;
    // ...and, when it is about ONE project with a path, offers the way into it.
    const projects = check.scope_id ? affectedProjects(check) : [];
    const project = projects.length === 1 ? projects[0] : null;
    const subjectRem = project && project.path ? { kind: 'external', path: project.path } : null;
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
        <TableRow
            accent={tone}
            expanded={expanded}
            onClick={() => onToggle?.(rowKeyOf(check))}
            ariaExpanded={expanded}
            columns={columns}
            testId={testId}
            className={`${na ? 'text-[var(--text-tertiary)]' : ''} ${focus ? 'ring-2 ring-inset ring-[var(--kind-compliance)]' : ''}`}
        >
            <TableCell column={cells.glyph} className="flex items-center">
                {/* The anchor for scrollIntoView sits INSIDE the row: TableRow does not forward a ref. */}
                <span ref={rootRef} className="inline-flex" data-testid={testId ? `${testId}-anchor` : undefined}>
                    <Glyph size={16} aria-hidden="true" style={{ color: TONES[tone].ink, flexShrink: 0 }} data-testid={testId ? `${testId}-glyph` : undefined} />
                </span>
            </TableCell>
            <TableCell column={cells.check} className="flex flex-col gap-0.5">
                {/* Wraps: a long title keeps its line and the severity word drops under it. */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                    <span className={`text-[12px] font-medium truncate min-w-0 ${textTone}`} title={title} data-testid={testId ? `${testId}-title` : undefined}>{title}</span>
                    {open && <SeverityTag severity={check.severity} tone="neutral" testId={testId ? `${testId}-severity` : 'severity-tag'} />}
                    {open && <FindingStateChip state={check.finding_state} testId={testId ? `${testId}-state` : 'check-state'} />}
                </div>
                {subject && (
                    <div className="text-[11px] font-medium text-[var(--text-secondary)] truncate" title={subject} data-testid={testId ? `${testId}-subject` : 'check-subject'}>{subject}</div>
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
                    <div className={`text-[11px] truncate ${na ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`} title={check.details} data-testid={testId ? `${testId}-details` : undefined}>{check.details}</div>
                )}
            </TableCell>
            <TableCell column={cells.article}>
                <ArticleRef testId={testId ? `${testId}-article` : 'article-ref'}>{article ? formatRef(article) : null}</ArticleRef>
            </TableCell>
            <TableCell column={cells.verification} className="flex items-center">
                <VerificationChip verification={check.verification} compact testId={testId ? `${testId}-verification` : 'verification-chip'} />
            </TableCell>
            <TableCell column={cells.last_run} className="text-[11px] text-[var(--text-tertiary)] tabular-nums" testId={testId ? `${testId}-last-run` : undefined}>
                {runAt}
            </TableCell>
            <TableCell column={cells.actions} className="flex items-center justify-end gap-1 min-w-0 overflow-hidden" align="right">
                {canOpenSubject && (
                    <button type="button" className={ICON_BTN} onClick={stop(() => onOpenLink(subjectRem, check))}
                        aria-label={t('compliance.tbl_open_subject', 'Open the affected item')} title={t('compliance.tbl_open_subject', 'Open the affected item')}
                        data-testid={testId ? `${testId}-open-subject` : 'check-open-subject'}>
                        <ArrowUpRight size={13} aria-hidden="true" />
                    </button>
                )}
                {action && (
                    <button type="button" className={SECONDARY_BTN} onClick={stop(() => onOpenLink(rem, check))}
                        title={action.destination} data-testid={testId ? `${testId}-fix` : 'check-fix'}>
                        {action.short}
                        {/* The word on the button is short; the accessible name says where it goes. */}
                        {action.named && <>{' '}<span className="sr-only">{`— ${action.destination}`}</span></>}
                        <action.Icon size={11} aria-hidden="true" />
                    </button>
                )}
                <span className={ICON_BTN} aria-hidden="true"><Chevron size={14} /></span>
            </TableCell>
        </TableRow>
    );
}
