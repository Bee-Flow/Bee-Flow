import { BarChart3, ClipboardList, ExternalLink, Link2, ListChecks, Loader2, Settings2, Share2, Workflow } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnswersDashboard from './answers/AnswersDashboard';
import QuestionsTab from './form/QuestionsTab';
import SettingsTab from './form/SettingsTab';
import ShareTab from './form/ShareTab';
import useFormDetail from './form/useFormDetail';
import { formLiveness, publicFormPath } from './FormsStudio';
import { useTranslation } from '../../../../hooks/useTranslation';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import Tabs from '../../../shared/Tabs';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';

/**
 * Studio → Forms → one form. Tabs: Questions · Share · Answers · Settings for
 * the owner; Answers only for a colleague the answers TABLE is shared with.
 * The routine builder stays one click away ("Open the routine") for the
 * work this page does not do — pages after page one, the steps.
 *
 * Addressed by the ROUTINE id (`form.automationId`) — the page token is a
 * credential and never travels in a URL. `tab` is the path's sub segment
 * (`/app/studio/forms/<id>/<tab>`), adopted the way KnowledgeStudio adopts
 * its tab.
 */
const TABS_OWNER = ['questions', 'share', 'answers', 'settings'];
const TABS_VIEWER = ['answers'];

export default function FormPage({ form, tab = null, onTab, onBack, onNavigate, user = null, onChanged = null }) {
    const { t } = useTranslation();
    const mine = form?.mine === true;
    const grade = form?.answers?.grade || null;
    const allowed = mine ? TABS_OWNER : TABS_VIEWER;
    const fallback = mine ? 'questions' : 'answers';
    const [active, setActive] = useState(allowed.includes(tab) ? tab : fallback);
    const lastTab = useRef(tab);
    useEffect(() => {
        if (tab !== lastTab.current) {
            lastTab.current = tab;
            setActive(allowed.includes(tab) ? tab : fallback);
        }
    }, [tab, allowed, fallback]);

    const detailState = useFormDetail(form?.automationId);
    const { detail, loading, error, reload, dirty } = detailState;
    const { confirm, confirmDialog } = useConfirm();

    // Leaving with unsaved questions asks first — on a tab switch here, and
    // on the browser's own leave.
    useEffect(() => {
        if (!dirty) return undefined;
        const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [dirty]);

    const switchTab = useCallback(async (next) => {
        if (next === active) return;
        if (dirty) {
            const ok = await confirm({
                title: t('forms.page.unsaved_title', 'Unsaved changes'),
                description: t('forms.page.unsaved_body', 'The questions were changed and not saved. Leave and lose them?'),
                confirmLabel: t('forms.page.unsaved_leave', 'Leave'),
                cancelLabel: t('forms.page.unsaved_stay', 'Keep editing'),
                destructive: true,
            });
            if (!ok) return;
            detailState.discard();
        }
        setActive(next);
        if (onTab) onTab(next);
    }, [active, dirty, confirm, t, onTab, detailState]);

    const merged = detail || form;
    const title = merged?.title || t('forms.studio.untitled', 'Untitled form');
    const liveness = formLiveness(merged);
    const chipLabel = { live: t('forms.status.live', 'Live'), off: t('forms.status.off', 'Not live'), unknown: t('forms.status.unknown', 'Status unknown') }[liveness];
    const answersCount = merged?.answers?.rowCount;

    const tabs = useMemo(() => {
        const all = {
            questions: { id: 'questions', label: t('forms.page.tab_questions', 'Questions'), icon: <ListChecks className="w-3.5 h-3.5" /> },
            share: { id: 'share', label: t('forms.page.tab_share', 'Share'), icon: <Share2 className="w-3.5 h-3.5" /> },
            answers: { id: 'answers', label: t('forms.page.tab_answers', 'Answers'), icon: <BarChart3 className="w-3.5 h-3.5" />, badge: typeof answersCount === 'number' ? answersCount : undefined },
            settings: { id: 'settings', label: t('forms.page.tab_settings', 'Settings'), icon: <Settings2 className="w-3.5 h-3.5" /> },
        };
        return allowed.map(id => all[id]);
    }, [allowed, answersCount, t]);

    const path = publicFormPath(merged);
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const copyLink = useCallback(async () => {
        if (!path) return;
        try {
            await navigator.clipboard.writeText(`${origin}${path}`);
            toast.success(t('forms.studio.copied', 'Link copied'));
        } catch {
            toast.error(t('forms.studio.copy_failed', 'Could not copy the link — your browser refused clipboard access.'));
        }
    }, [origin, path, t]);

    const rename = mine && detail?.definition ? async (next) => {
        const name = String(next || '').trim();
        if (!name) return;
        try {
            await detailState.save({ title: name });
            if (onChanged) onChanged();
        } catch (e) {
            toast.error(e?.message || t('forms.page.save_failed', 'Could not save the form.'));
        }
    } : undefined;

    return (
        <div className="h-full flex flex-col overflow-hidden" data-testid="form-page">
            <StudioSectionHeader
                kind="form"
                icon={ClipboardList}
                title={title}
                onRename={rename}
                onBack={onBack}
                backLabel={t('forms.page.back', 'All forms')}
                statusChip={chipLabel}
                primary={path ? (
                    <button type="button" onClick={copyLink} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium" style={PRIMARY_ACTION_STYLE} title={t('forms.studio.copy_link', 'Copy the link')} data-testid="form-page-copy">
                        <Link2 className="w-3.5 h-3.5" aria-hidden="true" />{t('forms.page.open_form', 'Open the form')}
                    </button>
                ) : null}
                extras={(
                    <>
                        {path && (
                            <a href={`${origin}${path}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs border hover:bg-[var(--bg-tertiary)]" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} title={t('forms.page.open_new_tab', 'Open in a new tab')}>
                                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                            </a>
                        )}
                        {mine && (
                            <button type="button" onClick={() => onNavigate && onNavigate(`studio/automations/${form.automationId}`)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border hover:bg-[var(--bg-tertiary)]" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} data-testid="form-page-open-routine">
                                <Workflow className="w-3.5 h-3.5" aria-hidden="true" />{t('forms.studio.open_routine', 'Open the routine')}
                            </button>
                        )}
                        {!mine && (
                            <span className="text-[11px] hidden md:inline" style={{ color: 'var(--text-tertiary)' }} title={t('forms.page.readonly_hint', 'Shared with this account through its answers table — the questions and settings belong to the form’s owner.')}>
                                {t('forms.page.readonly_chip', 'shared with you')}
                            </span>
                        )}
                    </>
                )}
            />
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto px-6 py-6" style={{ maxWidth: 900 }}>
                    <Tabs value={active} onChange={switchTab} items={tabs} size="sm" ariaLabel={t('forms.page.tabs_label', 'This form')} className="mb-5" />
                    {loading && !detail && (
                        <div className="flex items-center gap-2 py-8 text-xs" style={{ color: 'var(--text-tertiary)' }} role="status">
                            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('forms.page.loading', 'Loading the form…')}
                        </div>
                    )}
                    {error && !detail && (
                        <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{t('forms.page.load_failed', 'Could not load the form.')}</p>
                    )}
                    {active === 'questions' && detail && (
                        <QuestionsTab
                            detail={detail}
                            draft={detailState.draft}
                            setDraft={detailState.setDraft}
                            dirty={dirty}
                            save={async () => { await detailState.save(); toast.success(t('forms.page.saved', 'Saved.')); if (onChanged) onChanged(); }}
                            discard={detailState.discard}
                            saving={detailState.saving}
                            saveError={detailState.saveError}
                            onNavigate={onNavigate}
                        />
                    )}
                    {active === 'share' && detail && (
                        <ShareTab detail={detail} canEdit={mine} onNavigate={onNavigate} onChanged={async () => { await reload({ keepDraft: true }); if (onChanged) onChanged(); }} />
                    )}
                    {active === 'answers' && (
                        merged?.answers?.datatableId ? (
                            <AnswersDashboard
                                datatableId={merged.answers.datatableId}
                                grade={grade}
                                mine={mine}
                                automationId={form.automationId}
                                onNavigate={onNavigate}
                                onCopyLink={path ? copyLink : null}
                                testId="form-answers"
                            />
                        ) : (
                            <div className="rounded-xl border p-6 text-center" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-card)' }} data-testid="form-answers-none">
                                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('forms.answers.no_table_title', 'No answers table')}</p>
                                <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{t('forms.answers.no_table_body', 'This form starts a routine and does not collect answers in a table.')}</p>
                            </div>
                        )
                    )}
                    {active === 'settings' && detail && (
                        <SettingsTab detail={detail} save={async (patch) => { await detailState.save(patch); if (onChanged) onChanged(); }} reload={async () => { await reload({ keepDraft: true }); if (onChanged) onChanged(); }} onNavigate={onNavigate} onBack={onBack} user={user} />
                    )}
                </div>
            </div>
            {confirmDialog}
        </div>
    );
}
