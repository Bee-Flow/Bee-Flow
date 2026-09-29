import { Loader2, Sparkles, Undo2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SegmentedControl from '../../../../shared/SegmentedControl';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { nOf } from '../../KnowledgeStudio/plural';

/**
 * "Build it with AI" — the card above the question editor on the Form
 * page's Questions tab.
 *
 * One box, two modes. With a fresh form (no questions, or the product's own
 * placeholder three) the box takes a BRIEF — a sentence, or the material the
 * form should be based on: an intake checklist, an e-mail, a policy — and
 * the whole form is drafted. With questions already there, the box takes a
 * REQUEST ("add a phone number", "make the address optional") and the
 * current questions travel along so a kept question keeps its name; "Start
 * over" switches back to a brief.
 *
 * The draft lands in the UNSAVED editor below — nothing is stored until the
 * person saves. That is the whole safety story on a form that already
 * collects answers: a misread brief is one "Undo" (or "Discard changes"),
 * never a retired column. `Undo` restores exactly what the editor held
 * before the last draft was applied.
 *
 * `seed` is a brief parked by the "New form" dialog or the Studio AI
 * router for THIS form (handoff.takeSeed under `form:<id>`): it is put in
 * the box and run once, so "describe it → create" lands on a drafted form
 * without a second click.
 */
const BTN = 'px-3 py-2 rounded-[10px] text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-50';
const DEFAULT_NAMES = ['name', 'email', 'message'];

/** The product's own placeholder form, or no questions at all: a brief, not a request. */
export function isBlankForm(form) {
    const fields = Array.isArray(form?.fields) ? form.fields : [];
    if (!fields.length) return true;
    return fields.length === DEFAULT_NAMES.length
        && fields.every((f, i) => f?.name === DEFAULT_NAMES[i])
        && (!form?.title || form.title === 'Get in touch');
}

function errorText(t, err) {
    const code = err?.code;
    if (code === 'no_model') return t('forms.ai.err_no_model', 'No AI model is set up for this workspace yet.');
    if (code === 'ai_unusable') return t('forms.ai.err_unusable', 'The AI did not return a usable form. Try again, or describe it more concretely.');
    if (code === 'no_brief' || code === 'no_note') return t('forms.ai.err_no_text', 'Type or paste something first.');
    if (err?.status === 429) return t('forms.ai.err_rate', 'Too many drafts in a minute — wait a moment and try again.');
    return err?.message || t('forms.ai.err_failed', 'Could not draft the questions.');
}

export default function AiDraftPanel({ form, onApply, seed = null }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const blank = isBlankForm(form);
    const [text, setText] = useState(seed || '');
    // 'create' replaces the questions from a brief; 'revise' changes the
    // current ones from a request. A blank form has nothing to revise.
    const [mode, setMode] = useState(blank ? 'create' : 'revise');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null); // { count, notes, before }
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const effectiveMode = blank ? 'create' : mode;

    const run = useCallback(async (input) => {
        const value = String(input ?? text).trim();
        if (!value || busy) return;
        setBusy(true);
        setError(null);
        try {
            const body = effectiveMode === 'revise'
                ? { mode: 'revise', note: value, current: form }
                : { mode: 'create', brief: value, current: form };
            const res = await api.draftForm(body);
            if (!alive.current) return;
            const next = res?.draft?.form;
            if (!next || !Array.isArray(next.fields)) throw Object.assign(new Error('unusable'), { code: 'ai_unusable' });
            const before = form ? JSON.parse(JSON.stringify(form)) : null;
            onApply(next);
            setResult({ count: next.fields.length, notes: res.draft.notes || null, before });
            // After a draft the form is no longer blank: the next ask is a change.
            setMode('revise');
            setText('');
        } catch (err) {
            if (alive.current) setError(errorText(t, err));
        } finally {
            if (alive.current) setBusy(false);
        }
    }, [api, busy, effectiveMode, form, onApply, t, text]);

    // A parked brief runs once, on arrival.
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || !seed || !form) return;
        seeded.current = true;
        run(seed);
    }, [seed, form, run]);

    const undo = () => {
        if (!result?.before) return;
        onApply(result.before);
        setResult(null);
        setMode(isBlankForm(result.before) ? 'create' : 'revise');
    };

    const isRevise = effectiveMode === 'revise';
    return (
        <section className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-card)' }} aria-labelledby="form-ai-title" data-testid="form-ai">
            <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <h3 id="form-ai-title" className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('forms.ai.title', 'Build it with AI')}</h3>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                        {isRevise
                            ? t('forms.ai.intro_revise', 'Say what should change. The questions you keep stay as they are — and so do their answers.')
                            : t('forms.ai.intro', 'Describe the form, or paste what it should be based on — an intake checklist, an e-mail, a policy. The questions are drafted below for you to review; nothing is saved until you save.')}
                    </p>
                </div>
            </div>
            {!blank && (
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('forms.ai.mode_label', 'What the AI does')}
                    value={mode}
                    onChange={(v) => { setMode(v); setError(null); }}
                    options={[
                        { value: 'revise', label: t('forms.ai.mode_revise', 'Change the current questions') },
                        { value: 'create', label: t('forms.ai.mode_create', 'Start over from a description') },
                    ]}
                />
            )}
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } }}
                rows={isRevise ? 2 : 5}
                maxLength={12000}
                placeholder={isRevise
                    ? t('forms.ai.placeholder_revise', 'e.g. add a phone number, make the address optional, shorter labels')
                    : t('forms.ai.placeholder', 'e.g. A vacation request: name, department, first and last day, a reason, and whether a colleague covers. Or paste the checklist the form should follow.')}
                disabled={busy}
                className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 disabled:opacity-60"
                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                aria-label={t('forms.ai.title', 'Build it with AI')}
                data-testid="form-ai-text"
            />
            <div className="flex flex-wrap items-center gap-2">
                {error && <span role="alert" className="text-xs mr-auto" style={{ color: 'var(--error)' }}>{error}</span>}
                {!error && result && (
                    <span className="text-xs mr-auto" style={{ color: 'var(--success-ink)' }} role="status" data-testid="form-ai-done">
                        {nOf(t, 'forms.ai.done', result.count, '{count} question drafted — review it below, then Save.', '{count} questions drafted — review them below, then Save.')}
                        {result.notes ? ` ${result.notes}` : ''}
                    </span>
                )}
                {result?.before && (
                    <button type="button" onClick={undo} disabled={busy} className={`${BTN} inline-flex items-center gap-1.5`} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }} data-testid="form-ai-undo">
                        <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />{t('forms.ai.undo', 'Undo')}
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => run()}
                    disabled={busy || !text.trim()}
                    className={`${BTN} font-medium inline-flex items-center gap-1.5 ml-auto`}
                    style={{ ...PRIMARY_ACTION_STYLE, borderColor: 'transparent', outlineColor: 'var(--accent-primary)' }}
                    data-testid="form-ai-run"
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />}
                    {busy
                        ? t('forms.ai.running', 'Drafting…')
                        : (isRevise ? t('forms.ai.run_revise', 'Change the questions') : t('forms.ai.run', 'Draft the questions'))}
                </button>
            </div>
        </section>
    );
}
