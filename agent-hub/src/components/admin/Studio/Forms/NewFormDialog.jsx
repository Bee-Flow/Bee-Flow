import { ClipboardList, Loader2, Sparkles } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { kindColorVar } from '../../../shared/kindColors';
import Modal from '../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import ChoiceCard from '../Datatables/ChoiceCard';
import { parkSeed } from '../studioAi/handoff';
import { createFormAutomation } from '../studioApps';

/**
 * "New form" — a name and ONE choice: what happens with the answers.
 *
 * The choice is made here, before the routine exists, because it decides
 * where the person lands next. "Collect answers in a table" (the default)
 * creates the routine WITH `trigger.form.collect: true` — the server makes
 * the answers table on that same POST — and opens the Form page, where the
 * questions are edited without ever seeing the routine builder. "Form that
 * starts a routine" is the path that always existed: a form trigger, then
 * the builder.
 *
 * Nothing is posted until "Create form": a person who opens this by accident
 * and closes it leaves no untitled routine behind.
 *
 * The optional BRIEF ("Describe it") is not sent with the create: the form is
 * made first, then the brief is parked under that form's id
 * (handoff.parkSeed `form:<id>`) and the Questions tab it lands on hands it
 * to "Build it with AI" at once. Creating and drafting stay two steps so a
 * slow or failing model never leaves the person without a form — only
 * without drafted questions, with the box still filled to try again.
 */
const BTN = 'px-3 py-2 rounded-[10px] text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
const INPUT = 'w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2';

export default function NewFormDialog({ user = null, onClose, onNavigate }) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [mode, setMode] = useState('collect');
    const [brief, setBrief] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const submit = async (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const title = name.trim() || t('studio.new.untitled_form', 'Untitled form');
            // The creator navigates to the builder by itself; the Form page is
            // where a collecting form lands instead, so navigation is held
            // back and done here.
            const id = await createFormAutomation({ onNavigate: null, t, user }, { title, collect: mode === 'collect' });
            if (!id) throw new Error('no id');
            // The brief only has a reader on the Form page — the routine
            // builder does not draft questions — so it is parked only there.
            if (mode === 'collect' && brief.trim()) parkSeed(`form:${id}`, brief);
            if (onNavigate) onNavigate(mode === 'collect' ? `studio/forms/${id}/questions` : `studio/automations/${id}`);
        } catch (err) {
            setError(t('forms.new.failed', 'Could not create the form.') + (err?.message && err.message !== 'no id' ? ` ${err.message}` : ''));
            setBusy(false);
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            size="md"
            className="sm:max-w-[560px]"
            title={(
                <span className="inline-flex items-center gap-2">
                    <ClipboardList className="w-4 h-4" style={{ color: kindColorVar('form') }} aria-hidden="true" />
                    {t('forms.new.title', 'New form')}
                </span>
            )}
            footer={(
                <>
                    <button type="button" onClick={onClose} className={`${BTN} border`}
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('forms.new.cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={submit}
                        disabled={busy}
                        className={`${BTN} font-medium disabled:opacity-50 inline-flex items-center gap-1.5`}
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                        data-testid="new-form-create"
                    >
                        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                        {t('forms.new.create', 'Create form')}
                    </button>
                </>
            )}
        >
            <form onSubmit={submit} className="space-y-4" data-testid="new-form-dialog">
                <label className="block">
                    <span className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                        {t('forms.new.name_label', 'Name')}
                    </span>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('forms.new.name_placeholder', 'Customer feedback')}
                        className={INPUT}
                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                        autoFocus
                        data-testid="new-form-name"
                    />
                </label>
                <fieldset>
                    <legend className="block text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                        {t('forms.new.mode_legend', 'What happens with the answers?')}
                    </legend>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <ChoiceCard
                            name="new-form-mode"
                            kind="form"
                            checked={mode === 'collect'}
                            onChange={() => setMode('collect')}
                            title={(
                                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                                    <span>{t('forms.new.collect_title', 'Collect answers in a table')}</span>
                                    <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full border" style={{ color: 'var(--success-ink)', borderColor: 'var(--success)' }}>
                                        {t('forms.new.recommended', 'Recommended')}
                                    </span>
                                </span>
                            )}
                            blurb={t('forms.new.collect_blurb', 'A table is created with one column per question and kept in step with the form. Every answer appears there the moment someone submits, and whoever the table is shared with sees them on a dashboard.')}
                        />
                        <ChoiceCard
                            name="new-form-mode"
                            kind="automation"
                            checked={mode === 'routine'}
                            onChange={() => setMode('routine')}
                            title={t('forms.new.routine_title', 'Form that starts a routine')}
                            blurb={t('forms.new.routine_blurb', 'Every submission starts the steps you build in the routine builder — send an e-mail, file a ticket, ask an agent. No table unless you add one.')}
                        />
                    </div>
                </fieldset>
                {mode === 'collect' && (
                    <label className="block">
                        <span className="flex items-center gap-1.5 text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                            <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                            {t('forms.new.brief_label', 'Describe it (optional)')}
                        </span>
                        <textarea
                            value={brief}
                            onChange={(e) => setBrief(e.target.value)}
                            rows={3}
                            maxLength={12000}
                            placeholder={t('forms.new.brief_placeholder', 'What should the form ask? A sentence is enough — or paste the checklist, e-mail or policy it should be based on.')}
                            className={`${INPUT} resize-y`}
                            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                            data-testid="new-form-brief"
                        />
                        <span className="block text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                            {t('forms.new.brief_hint', 'AI drafts the questions from this on the next screen. You review them before anything is saved.')}
                        </span>
                    </label>
                )}
                {error && (
                    <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>
                )}
            </form>
        </Modal>
    );
}
