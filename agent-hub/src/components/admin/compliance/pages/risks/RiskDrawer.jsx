import React, { useState } from 'react';
import { CheckCircle2, Plus, ShieldCheck } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerSection, DrawerId, DrawerFooter } from '../../../../shared/SideDrawer';
import { TONES } from '../../../../shared/statusTone';
import { useDateFormat } from '../../shared/formatDates';
import { CATEGORIES, OPTIONS, SCALE, RISK_STATUSES, ScorePill, RiskStatusPill, riskRef, ownerName } from './RisksTable';
import { acceptPatchOf, draftOf, memberOptions, patchOf, treatmentOf } from './riskDraft';

/**
 * RiskDrawer — one register row: the edit form (title, scenario, category,
 * likelihood × impact, owner, next review, status), the acceptance stamp
 * (an explicit, recorded human decision — never automatic) and the
 * treatment plan with the add-treatment row. Same handlers as the legacy
 * page: onUpdate(id, patch), onAddTreatment(riskId, fields).
 *
 * The footer holds the two decisions: "Accept risk" (secondary, left) and
 * "Save changes" (primary, right). Accepting sends the whole draft WITH the
 * new status in one write (riskDraft.acceptPatchOf). The form state and the
 * bodies it sends live in riskDraft.ts.
 */
const EMPTY_TREATMENT = Object.freeze({ option: 'mitigate', description: '', due_at: '' });

export default function RiskDrawer({ risk, treatments = [], orgUsers, busy = false, onUpdate, onAddTreatment, onClose, mode = 'inline', testId = 'risk-drawer' }) {
    const { t } = useTranslation();
    const { formatDay } = useDateFormat();
    const [draft, setDraft] = useState(() => draftOf(risk));
    const [treat, setTreat] = useState(EMPTY_TREATMENT);
    // A fresh draft when another risk opens or this one changed on the
    // server — during render, so typing is never reset by a parent re-render.
    const riskKey = `${risk?.id}:${risk?.updated_at}`;
    const [seenRisk, setSeenRisk] = useState(riskKey);
    if (seenRisk !== riskKey) {
        setSeenRisk(riskKey);
        setDraft(draftOf(risk)); setTreat(EMPTY_TREATMENT);
    }

    if (!risk) return null;
    const patch = (p) => setDraft(d => ({ ...d, ...p }));
    const preview = { ...risk, likelihood: Number(draft.likelihood), impact: Number(draft.impact), score: Number(draft.likelihood) * Number(draft.impact) };

    const header = (
        <div className="flex items-center gap-2 min-w-0">
            <DrawerId>{riskRef(risk)}</DrawerId>
            <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{risk.title}</span>
            <RiskStatusPill status={risk.status} className="flex-shrink-0" />
        </div>
    );

    const canAccept = risk.status !== 'accepted' && risk.status !== 'closed';
    const footer = (
        <DrawerFooter
            onPrimary={() => onUpdate?.(risk.id, patchOf(draft))}
            primaryLabel={t('compliance.risk_save', 'Save changes')}
            primaryDisabled={busy || !draft.title.trim()}
            testId={`${testId}-actions`}
        >
            {canAccept && (
                <button type="button" disabled={busy} onClick={() => onUpdate?.(risk.id, acceptPatchOf(draft))}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] disabled:opacity-50 hover:bg-[var(--item-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    data-testid={`${testId}-accept`}>
                    <CheckCircle2 size={13} aria-hidden="true" /> {t('compliance.risk_accept_button', 'Accept risk')}
                </button>
            )}
        </DrawerFooter>
    );

    return (
        <SideDrawer open onClose={onClose} header={header} footer={footer} mode={mode} ariaLabel={t('compliance.risk_drawer_aria', 'Risk')} testId={testId}>
            <DrawerSection label={t('compliance.risk_f_title', 'Title')}>
                <input value={draft.title} onChange={e => patch({ title: e.target.value })} className={INPUT} data-testid={`${testId}-title`} />
                <textarea rows={3} value={draft.description} onChange={e => patch({ description: e.target.value })} placeholder={t('compliance.risk_f_desc_ph', 'What could go wrong, and what would the consequence be?')} className={`${INPUT} resize-y`} data-testid={`${testId}-description`} />
            </DrawerSection>

            <DrawerSection label={t('compliance.risk_col_score', 'Score')} hint={t('compliance.risk_score_hint', 'likelihood × impact, 1–5 each')}>
                <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        {t('compliance.risk_f_likelihood', 'Likelihood (1–5)')}
                        <select value={draft.likelihood} onChange={e => patch({ likelihood: e.target.value })} className={`${INPUT} w-auto`} data-testid={`${testId}-likelihood`}>
                            {SCALE.map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                    </label>
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        {t('compliance.risk_f_impact', 'Impact (1–5)')}
                        <select value={draft.impact} onChange={e => patch({ impact: e.target.value })} className={`${INPUT} w-auto`} data-testid={`${testId}-impact`}>
                            {SCALE.map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                    </label>
                    <ScorePill risk={preview} testId={`${testId}-score`} />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        {t('compliance.risk_f_category', 'Category')}
                        <select value={draft.category} onChange={e => patch({ category: e.target.value })} className={`${INPUT} w-auto`} data-testid={`${testId}-category`}>
                            {CATEGORIES.map(c => <option key={c} value={c}>{t(`compliance.risk_cat_${c}`, c)}</option>)}
                            {!CATEGORIES.includes(draft.category) && <option value={draft.category}>{draft.category}</option>}
                        </select>
                    </label>
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        {t('compliance.risk_col_status', 'Status')}
                        <select value={draft.status} onChange={e => patch({ status: e.target.value })} className={`${INPUT} w-auto`} data-testid={`${testId}-status`}>
                            {RISK_STATUSES.filter(s => s !== 'accepted' || draft.status === 'accepted').map(s => (
                                <option key={s} value={s}>{t(`compliance.risk_status_${s}`, s)}</option>
                            ))}
                        </select>
                    </label>
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        {t('compliance.risk_f_review_due', 'Next review')}
                        <input type="date" value={draft.review_due_at} onChange={e => patch({ review_due_at: e.target.value })} className={`${INPUT} w-auto`} data-testid={`${testId}-review`} />
                    </label>
                </div>
            </DrawerSection>

            <DrawerSection label={t('compliance.risk_f_owner', 'Owner')}>
                <select value={draft.owner_user_id} onChange={e => patch({ owner_user_id: e.target.value })} disabled={busy}
                    aria-label={t('compliance.risk_f_owner', 'Owner')} className={INPUT} data-testid={`${testId}-owner`}>
                    <option value="">{t('compliance.risk_owner_none', 'No owner')}</option>
                    {memberOptions(orgUsers, draft.owner_user_id).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
            </DrawerSection>

            <DrawerSection label={t('compliance.risk_acceptance', 'Acceptance')}>
                {risk.status === 'accepted' && risk.accepted_at ? (
                    <div className="inline-flex items-center gap-1.5 text-xs text-[var(--success-ink)]" data-testid={`${testId}-accepted`}>
                        <ShieldCheck size={13} aria-hidden="true" />
                        {t('compliance.risk_accepted_stamp', 'Accepted by {name} on {date}', { name: ownerName(orgUsers, risk.accepted_by) || '—', date: formatDay(risk.accepted_at) || '—' })}
                    </div>
                ) : risk.status !== 'closed' ? (
                    <p className="m-0 text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-accept-note`}>{t('compliance.risk_accept_note', 'Accepting is a management decision: it records who accepted this risk and when. Nothing is ever accepted automatically.')}</p>
                ) : (
                    <p className="m-0 text-[11px] text-[var(--text-tertiary)]">{t('compliance.risk_closed_note', 'Closed — no acceptance needed.')}</p>
                )}
            </DrawerSection>

            <DrawerSection label={t('compliance.risk_treatments', 'Treatment plan')} hint={treatments.length ? String(treatments.length) : null}>
                {treatments.length === 0 ? (
                    <p className="m-0 text-[11px] text-[var(--text-tertiary)]">{t('compliance.risk_no_treatments', 'No treatments recorded yet.')}</p>
                ) : (
                    <ul className="m-0 p-0 list-none flex flex-col gap-1" data-testid={`${testId}-treatments`}>
                        {treatments.map(tr => (
                            <li key={tr.id} className="flex items-center gap-2 text-[11px] rounded-lg px-2 py-1.5 bg-[var(--bg-secondary)]" data-done={tr.done_at ? 'true' : 'false'}>
                                <span className="font-semibold uppercase tracking-[.04em] text-[10px]" style={{ color: tr.done_at ? TONES.success.ink : 'var(--text-secondary)' }}>
                                    {t(`compliance.risk_opt_${tr.option}`, tr.option)}
                                </span>
                                <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">{tr.description || '—'}</span>
                                <span className="text-[var(--text-tertiary)] whitespace-nowrap">
                                    {tr.done_at ? t('compliance.risk_t_done', 'Done {date}', { date: formatDay(tr.done_at) || '—' }) : tr.due_at ? `${t('compliance.risk_t_due', 'Due')} ${formatDay(tr.due_at) || '—'}` : '—'}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="flex flex-wrap items-center gap-2">
                    <select value={treat.option} onChange={e => setTreat(s => ({ ...s, option: e.target.value }))} className={`${INPUT} w-auto`} data-testid={`${testId}-t-option`}>
                        {OPTIONS.map(o => <option key={o} value={o}>{t(`compliance.risk_opt_${o}`, o)}</option>)}
                    </select>
                    <input value={treat.description} onChange={e => setTreat(s => ({ ...s, description: e.target.value }))} placeholder={t('compliance.risk_t_desc', 'What will be done')} className={`${INPUT} flex-1 min-w-[140px]`} data-testid={`${testId}-t-desc`} />
                    <input type="date" value={treat.due_at} onChange={e => setTreat(s => ({ ...s, due_at: e.target.value }))} className={`${INPUT} w-auto`} data-testid={`${testId}-t-due`} />
                    <button type="button" disabled={busy}
                        onClick={async () => { await onAddTreatment?.(risk.id, treatmentOf(treat)); setTreat(EMPTY_TREATMENT); }}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] disabled:opacity-50 hover:bg-[var(--item-hover-bg)]"
                        data-testid={`${testId}-t-add`}>
                        <Plus size={13} aria-hidden="true" /> {t('compliance.risk_t_add', 'Add treatment')}
                    </button>
                </div>
            </DrawerSection>
        </SideDrawer>
    );
}

const INPUT = 'w-full rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]';
