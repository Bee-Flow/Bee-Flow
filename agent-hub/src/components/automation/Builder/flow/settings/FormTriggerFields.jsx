import React, { useCallback, useMemo, useState } from 'react';
import { Plus, Copy, Check, Link2, RefreshCw, Loader2 } from 'lucide-react';
import { denseInputClass } from './formPrimitives';
import FormBuilderFields, { defaultFormDeclaration } from './FormBuilderFields';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { useBuilderConfirm } from '../../BuilderConfirmContext';
import { useTranslation } from '../../../../../hooks/useTranslation';

/**
 * The authoring surface for a hosted form trigger (`kind: 'form'`) — page one
 * of the automation's public form, plus the URL it lives at.
 *
 * The page editor itself is FormBuilderFields, shared with the `form_page`
 * steps that come after this one: all three declare the same `form` object, so
 * an author who has laid out page one already knows how to lay out page two.
 * What is trigger-only is the public URL below.
 */

// Re-exported so existing importers (DiagramPane, tests) keep one entry point.
export { defaultFormDeclaration, slugifyFieldName, THEME_PRESETS } from './FormBuilderFields';

/** See the note in FormTriggerFields: Forms owns the public link for now. */
export const SHOW_PUBLIC_LINK_IN_BUILDER = false;

export default function FormTriggerFields({ draft, set, automation = null, stepId = null, onTestSubmit = null, onRenameField = null }) {
    const { t } = useTranslation();
    const form = draft.form || null;

    // A trigger that has just been switched to `form` has no declaration yet.
    // Seeding it from a click (rather than an effect) keeps the autosave
    // honest: nothing is written until the author asks for it.
    if (!form) {
        return (
            <div className="space-y-2">
                <p className="text-[11px] text-[var(--text-tertiary)]">
                    {t('automations.form_trigger_fields.a_form_trigger_publishes_a_page', 'A form trigger publishes a page for the colleagues it is shared with — who that is, you set under Studio → Forms → Share. Every submission runs this automation once.')}
                </p>
                <button
                    type="button"
                    onClick={() => set('form', defaultFormDeclaration())}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90"
                >
                    <Plus size={13} /> {t('automations.form_trigger_fields.create_the_form', 'Create the form')}
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {/* The public link used to sit here. It lives in Forms now (the
                sidebar entry and /app/forms), because a published form is the
                organisation's and was only findable by whoever remembered
                which automation it hung off. Turned off rather than deleted:
                FormTriggerUrlPanel is still exported and still works, and this
                flag is the one line to flip when it comes back.

                The link is no longer minted here either — the server does it
                whenever a form trigger is saved (routes/automation/crud.js's
                ensureFormPages), so hiding this panel cannot stop a form from
                being published. */}
            {SHOW_PUBLIC_LINK_IN_BUILDER && <FormTriggerUrlPanel automation={automation} stepId={stepId} />}
            <FormBuilderFields form={form} onChange={(next) => set('form', next)} bindingBase="trigger.output" onTestSubmit={onTestSubmit} onRenameField={onRenameField} />
        </div>
    );
}


/**
 * The public URL, provisioned on first open.
 *
 * Same B11 rule as TriggerWebhookPanel: only provision once the PERSISTED
 * definition carries this node with kind 'form'. The server validates
 * triggerStepId against the SAVED definition, so asking while the node is still
 * inside the autosave debounce deterministically 400s.
 */
export function FormTriggerUrlPanel({ automation, stepId }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const confirmAction = useBuilderConfirm();
    const [page, setPage] = useState(null);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState(null);

    const persistedTrigger = useMemo(() => {
        const def = automation?.definition;
        if (!def || !stepId) return null;
        if (def.trigger?.id === stepId) return def.trigger;
        return (def.triggers || []).find(t => t?.id === stepId) || null;
    }, [automation?.definition, stepId]);
    const provisionable = persistedTrigger?.kind === 'form';

    const load = useCallback(async () => {
        if (!automation?.id || !provisionable) return;
        setBusy(true);
        setError(null);
        try {
            const listed = await api.listFormPages(automation.id);
            const mine = (listed.forms || []).find(f => (f.triggerStepId || null) === (persistedTrigger?.id === automation?.definition?.trigger?.id ? null : stepId))
                || (listed.forms || [])[0];
            if (mine) { setPage(mine); return; }
            const created = await api.createFormPage(automation.id);
            setPage(created.form || null);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }, [api, automation?.id, automation?.definition?.trigger?.id, provisionable, persistedTrigger?.id, stepId]);

    React.useEffect(() => { load(); }, [load]);

    const copy = async () => {
        if (!page?.url) return;
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(page.url);
            else {
                const ta = document.createElement('textarea');
                ta.value = page.url;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                if (!ok) throw new Error('copy failed');
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (e) {
            setError(`Copy failed: ${e.message}. Select the text to copy it manually.`);
        }
    };

    const rotate = async () => {
        if (!page) return;
        // The URL IS the credential, so rotating is not "change the secret" —
        // it is "publish a different address". Say so before doing it.
        const ok = await confirmAction({
            title: 'Create a new link?',
            description: 'The current link stops working immediately — anyone who already has it will see “not available”.',
            confirmLabel: 'Create a new link',
            destructive: true,
        });
        if (!ok) return;
        setBusy(true);
        try {
            const r = await api.rotateFormPage(automation.id, page.id);
            setPage(r.form || null);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    if (!automation?.id || !provisionable) {
        return <div className="text-[11px] text-[var(--text-tertiary)]">{t('automations.form_trigger_fields.waiting_for_the_automation_to_save', 'Waiting for the automation to save…')}</div>;
    }

    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                <Link2 size={13} />
                <span className="text-[12px] font-medium">{t('automations.form_trigger_fields.public_link', 'Public link')}</span>
            </div>
            {error && <div className="text-[11px] text-red-600">{error}</div>}
            {!page ? (
                <div className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-1.5">
                    {busy ? <><Loader2 size={11} className="animate-spin" /> {t('automations.form_trigger_fields.generating_link', 'Generating link…')}</> : (
                        <button onClick={load} className="underline hover:text-[var(--text-primary)]">{t('automations.form_trigger_fields.generate_the_link', 'Generate the link')}</button>
                    )}
                </div>
            ) : (
                <>
                    <div className="flex items-center gap-1">
                        <input readOnly value={page.url || ''} aria-label={t('automations.form_trigger_fields.public_form_url', 'Public form URL')} className={denseInputClass('flex-1 min-w-0 font-mono')} onFocus={(e) => e.target.select()} />
                        <button type="button" onClick={copy} title={t('automations.form_trigger_fields.copy_the_link', 'Copy the link')} aria-label={t('automations.form_trigger_fields.copy_the_link', 'Copy the link')}
                            className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]">
                            {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                        </button>
                        <button type="button" onClick={rotate} disabled={busy} title={t('automations.form_trigger_fields.create_a_new_link_the_current', 'Create a new link (the current one stops working)')} aria-label={t('automations.form_trigger_fields.create_a_new_link', 'Create a new link')}
                            className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40">
                            <RefreshCw size={13} />
                        </button>
                    </div>
                    <p className="text-[11px] text-[var(--text-tertiary)]">
                        {t('automations.form_trigger_fields.anyone_with_this_link_can_submit', 'Anyone with this link can submit the form — it only works while the automation is active.')}
                        {typeof page.submissions === 'number' && page.submissions > 0 ? ` ${page.submissions} submission${page.submissions === 1 ? '' : 's'} so far.` : ''}
                    </p>
                </>
            )}
        </div>
    );
}
