import React, { useMemo, useState } from 'react';
import { ArrowUpRight, CircleCheck, CircleDashed, CircleX, Save, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerSection } from '../../../../shared/SideDrawer';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { TONES, toneOfCheckStatus } from '../../../../shared/statusTone';
import ArticleRef, { formatArticleRef } from '../../shared/ArticleRef';
import UserPicker from '../../shared/UserPicker';
import { sectionForRegulation } from '../../sections';
import RadioCards from './RadioCards';
import { ownerName } from './SoaTable';
import { approvedBlocked, draftOf, justificationMissing, liveCheckOf, patchOf, DECISIONS } from './soaThemes';

/**
 * SoaDrawer — one Annex A row, editable (artboard 1d right pane).
 *
 * Two rules live here and nowhere else in the UI:
 *   1. `approved` is disabled while the linked live check is warn/fail — a
 *      human may not sign off a control the product can see is open.
 *   2. `excluded` needs a written justification before Save enables.
 * Both are pure predicates in soaThemes.js (`approvedBlocked`,
 * `justificationMissing`) so the tests pin them without a DOM.
 *
 * props:
 *   control        the SoA row ({ ref, titleKey, objectiveKey, checks, entry })
 *   checksById     Map from soaThemes.indexChecks(core.checks)
 *   orgUsers       [{ id, displayName, email }] | null — the picker renders nothing without them
 *   busy           true while this ref is being saved
 *   onSave(ref, patch), onClose(), navigate(sectionId, subId?)
 *   mode           SideDrawer mode ('inline' | 'overlay')
 */
export default function SoaDrawer({ control, checksById, orgUsers, busy = false, onSave, onClose, navigate, mode = 'inline', testId = 'soa-drawer' }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(() => draftOf(control));
    // A fresh draft when another control opens or this one changed on the
    // server — during render, so typing is never reset by a parent re-render.
    const controlKey = `${control?.ref}:${control?.entry?.updated_at}`;
    const [seenControl, setSeenControl] = useState(controlKey);
    if (seenControl !== controlKey) {
        setSeenControl(controlKey);
        setDraft(draftOf(control));
    }

    const live = useMemo(() => liveCheckOf(control, checksById), [control, checksById]);
    const blocked = approvedBlocked(live);
    const missingJustification = justificationMissing(draft);
    const saveDisabled = busy || missingJustification;

    if (!control) return null;

    const patch = (p) => setDraft(d => ({ ...d, ...p }));
    const decisionOptions = DECISIONS.map(value => ({
        value,
        label: t(`compliance.soa_decision_${value}`, DECISION_FALLBACK[value]),
        disabled: value === 'approved' && blocked,
        title: value === 'approved' && blocked ? t('compliance.soa_approved_blocked', APPROVED_BLOCKED_EN) : undefined,
    }));

    const owner = ownerName(orgUsers, draft.owner_user_id);
    const entry = control.entry;

    const header = (
        <div className="flex items-center gap-2 min-w-0">
            <ArticleRef>{control.ref}</ArticleRef>
            <div className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]" title={control.titleKey ? t(control.titleKey, control.ref) : control.ref}>
                {control.titleKey ? t(control.titleKey, control.ref) : control.ref}
            </div>
        </div>
    );

    const footer = (
        <div className="flex flex-col gap-2">
            <button
                type="button"
                disabled={saveDisabled}
                onClick={() => onSave?.(control.ref, patchOf(draft))}
                style={PRIMARY_ACTION_STYLE}
                className="h-8 px-3 rounded-[10px] text-[12px] font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid={`${testId}-save`}
            >
                <Save size={13} aria-hidden="true" /> {t('common.save', 'Save')}
            </button>
            <StampNote entry={entry} orgUsers={orgUsers} t={t} testId={`${testId}-stamp`} />
        </div>
    );

    return (
        <SideDrawer open onClose={onClose} header={header} footer={footer} mode={mode} ariaLabel={t('compliance.soa_drawer_aria', 'SoA control')} testId={testId}>
            {control.objectiveKey && (
                <p className="text-[11px] text-[var(--text-secondary)] m-0">{t(control.objectiveKey, '')}</p>
            )}

            <LinkedCheckBox live={live} navigate={navigate} t={t} testId={`${testId}-check`} />

            <DrawerSection label={t('compliance.soa_col_status', 'Decision')}>
                <RadioCards
                    value={draft.status}
                    onChange={(status) => patch({ status })}
                    options={decisionOptions}
                    ariaLabel={t('compliance.soa_col_status', 'Decision')}
                    testId={`${testId}-decision`}
                />
                {blocked && (
                    <p className="m-0 text-[11px]" style={{ color: TONES.warning.ink }} data-testid={`${testId}-approved-hint`}>
                        {t('compliance.soa_approved_blocked', APPROVED_BLOCKED_EN)}
                    </p>
                )}
            </DrawerSection>

            <DrawerSection label={t('compliance.soa_how_met', 'How met')}>
                <textarea
                    value={draft.how_met}
                    rows={3}
                    onChange={e => patch({ how_met: e.target.value })}
                    placeholder={t('compliance.soa_how_met_ph', 'How this control is satisfied — the sentence an auditor reads…')}
                    className={TEXTAREA}
                    data-testid={`${testId}-how-met`}
                />
            </DrawerSection>

            <DrawerSection label={t('compliance.soa_col_owner', 'Owner')}>
                <div className="flex items-center gap-2 text-xs">
                    <span className={owner ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-tertiary)]'} data-testid={`${testId}-owner`}>
                        {owner || t('compliance.soa_owner_none', 'No owner assigned')}
                    </span>
                    {draft.owner_user_id && (
                        <button type="button" onClick={() => patch({ owner_user_id: '' })}
                            className="inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                            aria-label={t('compliance.soa_owner_clear', 'Remove owner')}>
                            <X size={11} aria-hidden="true" />
                        </button>
                    )}
                </div>
                <UserPicker
                    users={orgUsers}
                    mode="single"
                    label=""
                    placeholder={t('compliance.soa_owner_pick', 'Choose an owner…')}
                    onSelect={(u) => patch({ owner_user_id: u.id })}
                    disabled={busy}
                />
            </DrawerSection>

            <DrawerSection
                label={t('compliance.soa_justification', 'Justification')}
                hint={t('compliance.soa_justification_required_excluded', 'required when excluded')}
            >
                <textarea
                    value={draft.justification}
                    rows={3}
                    onChange={e => patch({ justification: e.target.value })}
                    placeholder={t('compliance.soa_justification_ph2', 'Why this control does or does not apply to you…')}
                    className={`${TEXTAREA} border-dashed`}
                    aria-invalid={missingJustification || undefined}
                    data-testid={`${testId}-justification`}
                />
                {missingJustification && (
                    <p className="m-0 text-[11px]" style={{ color: TONES.warning.ink }} data-testid={`${testId}-justification-hint`}>
                        {t('compliance.soa_justification_missing', 'Write down why this control is excluded before saving.')}
                    </p>
                )}
            </DrawerSection>
        </SideDrawer>
    );
}

const DECISION_FALLBACK = Object.freeze({ todo: 'To review', reviewed: 'Reviewed', approved: 'Approved', excluded: 'Excluded' });
const APPROVED_BLOCKED_EN = '"Approved" is not possible while the linked check needs attention — resolve the finding first, or justify why it does not count.';

const TEXTAREA = 'w-full rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] resize-y';

const CHECK_GLYPH = { pass: CircleCheck, warn: TriangleAlert, fail: CircleX };

/** Check status → the platform's existing label key (`not_applicable` is `status_na`, not `status_not_applicable`). */
const CHECK_STATUS_LABEL = Object.freeze({
    pass: ['compliance.status_pass', 'Passing'],
    warn: ['compliance.status_warn', 'Needs attention'],
    fail: ['compliance.status_fail', 'Failing'],
    not_applicable: ['compliance.status_na', 'Not applicable'],
    pending: ['compliance.status_pending', 'Not yet run'],
});

/** The linked-check box under the header: glyph in tone, status word, title · run time · also {other refs}, "Check ↗". */
function LinkedCheckBox({ live, navigate, t, testId }) {
    if (!live || live.kind === 'none') {
        return (
            <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-[11px] text-[var(--text-tertiary)]" data-testid={testId}>
                {t('compliance.soa_no_live_check', 'no live check')}
            </div>
        );
    }
    if (live.kind === 'pending') {
        return (
            <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-[11px] text-[var(--text-tertiary)] inline-flex items-center gap-1.5" data-testid={testId}>
                <CircleDashed size={13} aria-hidden="true" />
                {t('compliance.soa_not_checked', 'not yet checked')}
                <span className="font-mono">· {live.ids.join(', ')}</span>
            </div>
        );
    }
    const { check, status, others } = live;
    const tone = toneOfCheckStatus(status);
    const Glyph = CHECK_GLYPH[status] || CircleDashed;
    const statusWord = t(CHECK_STATUS_LABEL[status]?.[0] || 'compliance.status_pending', CHECK_STATUS_LABEL[status]?.[1] || status);
    const title = check.titleKey ? t(check.titleKey, check.check_id) : (check.title || check.check_id);
    const runAt = check.last_run_at || check.checked_at || null;
    const alsoRefs = (others || []).map(o => formatArticleRef(o.regulation, o.article, t)).filter(Boolean);
    const target = sectionForRegulation(check.regulation);
    return (
        <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 flex items-start gap-2" data-testid={testId} data-status={status}>
            <Glyph size={14} aria-hidden="true" className="shrink-0 mt-0.5" style={{ color: TONES[tone].ink }} />
            <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold" style={{ color: TONES[tone].ink }}>
                    {t('compliance.soa_linked_check', 'Linked live check · {status}', { status: statusWord })}
                </div>
                <div className="text-[11px] text-[var(--text-secondary)] truncate">
                    {title}
                    {runAt && <> · {t('compliance.soa_check_run', 'run {time}', { time: formatTime(runAt) })}</>}
                    {alsoRefs.length > 0 && <> · {t('compliance.soa_check_also', 'also {refs}', { refs: alsoRefs.join(', ') })}</>}
                </div>
            </div>
            <button
                type="button"
                onClick={() => navigate?.(target, check.check_id)}
                className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                data-testid={`${testId}-open`}
            >
                {t('compliance.soa_check_open', 'Check')} <ArrowUpRight size={11} aria-hidden="true" />
            </button>
        </div>
    );
}

/** "Added 10 Jun 2026 (template) · never changed." / "Last changed 3 Sep 2026 by T. Smit" + the stamping sentence. */
function StampNote({ entry, orgUsers, t, testId }) {
    let line;
    if (!entry) {
        line = t('compliance.soa_stamp_none', 'No row yet — saving creates it.');
    } else if (entry.updated_by) {
        line = t('compliance.soa_stamp_changed', 'Last changed {date} by {by}', {
            date: formatDate(entry.updated_at),
            by: ownerName(orgUsers, entry.updated_by) || '—',
        });
    } else {
        line = t('compliance.soa_stamp_template', 'Added {date} (template) · never changed.', { date: formatDate(entry.updated_at) });
    }
    return (
        <p className="m-0 text-[11px] text-[var(--text-tertiary)]" data-testid={testId}>
            {line} {t('compliance.soa_stamp_hint', 'Every change is stamped with who and when and travels into the SoA PDF; "Fill missing rows" never overwrites a decision.')}
        </p>
    );
}

function formatDate(value) {
    const ms = value ? new Date(value).getTime() : NaN;
    if (Number.isNaN(ms)) return '—';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatTime(value) {
    const ms = value ? new Date(value).getTime() : NaN;
    if (Number.isNaN(ms)) return '—';
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
