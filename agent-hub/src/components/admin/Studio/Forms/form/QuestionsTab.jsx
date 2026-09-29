import { Info, Loader2, Workflow } from 'lucide-react';
import React, { Suspense, lazy, useState } from 'react';
import AiDraftPanel from './AiDraftPanel';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DashCard from '../../../../shared/dashboard/DashCard';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { nOf } from '../../KnowledgeStudio/plural';
import { takeSeed } from '../../studioAi/handoff';

// The builder's own form editor — title, intro, questions, button text,
// thank-you message, theme, preview. Lazy: it drags the builder chunk.
const FormBuilderFields = lazy(() => import('../../../../automation/Builder/flow/settings/FormBuilderFields'));

const BTN = 'px-3 py-2 rounded-[10px] text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-50';

/**
 * The Questions tab: the trigger's form, editable without the routine
 * builder. Pages after page one stay in the builder (a note says so); the
 * answers table follows every save (the columns note says that).
 */
export default function QuestionsTab({ detail, draft, setDraft, dirty, save, discard, saving, saveError, onNavigate }) {
    const { t } = useTranslation();
    const pages = Array.isArray(detail?.pages) ? detail.pages : [];
    const collecting = !!detail?.answers?.collecting;
    // A brief parked for THIS form by the "New form" dialog or the Studio AI
    // router — read once, on the first render, and gone from storage either
    // way (handoff.takeSeed): a brief for another form never lands here.
    const [seed] = useState(() => (detail?.automationId ? takeSeed(`form:${detail.automationId}`) : null));
    return (
        <div className="space-y-4" data-testid="form-questions">
            {draft && (
                <AiDraftPanel form={draft} onApply={(next) => setDraft(next)} seed={seed} />
            )}
            {pages.length > 0 && (
                <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }} data-testid="form-pages-note">
                    <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span className="flex-1 min-w-0">
                        {nOf(t, 'forms.page.pages_note', pages.length, '{count} more page — edit it in the routine', '{count} more pages — edit them in the routine')}
                    </span>
                    <button type="button" onClick={() => onNavigate && onNavigate(`studio/automations/${detail.automationId}`)} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                        <Workflow className="w-3 h-3" aria-hidden="true" />{t('forms.studio.open_routine', 'Open the routine')}
                    </button>
                </div>
            )}
            <DashCard testId="form-questions-card">
                {draft ? (
                    <Suspense fallback={<div className="flex items-center gap-2 text-xs py-6" style={{ color: 'var(--text-tertiary)' }}><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('forms.page.loading_editor', 'Loading the editor…')}</div>}>
                        <FormBuilderFields form={draft} onChange={setDraft} bindingBase="trigger.output" />
                    </Suspense>
                ) : (
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('forms.page.readonly_hint', 'Shared with this account through its answers table — the questions and settings belong to the form’s owner.')}</p>
                )}
            </DashCard>
            {collecting && (
                <p className="text-xs flex items-start gap-2" style={{ color: 'var(--text-tertiary)' }} data-testid="form-columns-note">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{t('forms.page.columns_note', 'Every question here is a column in the answers table. Renaming a question renames its column; removing one keeps the column, marked “no longer on the form”.')}</span>
                </p>
            )}
            {draft && (
                <div className="sticky bottom-0 flex items-center justify-end gap-2 py-3 -mx-1 px-1" style={{ background: 'var(--bg-primary)' }} data-testid="form-savebar">
                    {saveError && <span role="alert" className="mr-auto text-xs" style={{ color: 'var(--error)' }}>{saveError.message || t('forms.page.save_failed', 'Could not save the form.')}</span>}
                    <button type="button" onClick={discard} disabled={!dirty || saving} className={BTN} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('forms.page.discard', 'Discard changes')}
                    </button>
                    <button type="button" onClick={() => save()} disabled={!dirty || saving} className={`${BTN} font-medium inline-flex items-center gap-1.5`} style={{ ...PRIMARY_ACTION_STYLE, borderColor: 'transparent', outlineColor: 'var(--accent-primary)' }} data-testid="form-save">
                        {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                        {t('forms.page.save', 'Save')}
                    </button>
                </div>
            )}
        </div>
    );
}
