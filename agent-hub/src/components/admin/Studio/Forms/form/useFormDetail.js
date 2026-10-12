import { useCallback, useEffect, useRef, useState } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { managedOf, managedRefusalOf } from '../../../../shared/managedPart';

/**
 * One form, loaded from GET /api/automation/forms/:automationId, with a
 * DRAFT of its trigger form the Questions tab edits and saves back through
 * the ordinary PUT /api/automation/:id (the whole definition — one
 * validation pipeline, one version history, and the answers table follows on
 * that same save).
 *
 * `definition` is present only for the owner; `dirty` compares the draft
 * with the saved trigger form by value.
 *
 * A form is an automation, so a Solution stage can manage it. `managed` is what the
 * GET said about it (managedPart.managedOf) or, for a tab opened before the
 * stage took the automation over, what the refused save said (409 managed_part,
 * which `save` maps instead of leaving it as a bare failure): the host mounts
 * the ManagedPartBanner from it and stops offering Save. `refusal` is the
 * banner info of that 409 (`reason: 'managed'`).
 */
export default function useFormDetail(automationId) {
    const api = useAutomationApi();
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [refusal, setRefusal] = useState(null);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const reload = useCallback(async ({ keepDraft = false } = {}) => {
        if (!automationId) return null;
        setLoading(true);
        setError(null);
        try {
            const body = await api.getForm(automationId);
            const form = body?.form || null;
            if (!alive.current) return form;
            setDetail(form);
            if (!keepDraft) setDraft(form?.definition?.trigger?.form ? JSON.parse(JSON.stringify(form.definition.trigger.form)) : null);
            return form;
        } catch (e) {
            if (alive.current) setError(e);
            return null;
        } finally {
            if (alive.current) setLoading(false);
        }
    }, [api, automationId]);

    useEffect(() => { reload(); }, [reload]);

    const savedForm = detail?.definition?.trigger?.form || null;
    const dirty = !!(draft && savedForm && JSON.stringify(draft) !== JSON.stringify(savedForm));

    /**
     * Save the draft (or a patch of it) as the trigger's form. Returns the
     * PUT body (`{ automation, answers?, warnings? }`) or throws.
     */
    const save = useCallback(async (patch = null) => {
        if (!detail?.definition) throw new Error('not the owner');
        const nextForm = { ...(patch ? { ...savedForm, ...patch } : draft) };
        const definition = { ...detail.definition, trigger: { ...detail.definition.trigger, form: nextForm } };
        setSaving(true);
        setSaveError(null);
        try {
            const body = await api.updateAutomation(detail.automationId, { definition });
            await reload();
            return body;
        } catch (e) {
            if (alive.current) {
                // The stage's refusal is not "your draft is bad": keep the
                // draft, say who manages the automation, stop offering Save.
                const info = managedRefusalOf(e);
                if (info) setRefusal(info);
                setSaveError(e);
            }
            throw e;
        } finally {
            if (alive.current) setSaving(false);
        }
    }, [api, detail, draft, savedForm, reload]);

    const discard = useCallback(() => {
        setDraft(savedForm ? JSON.parse(JSON.stringify(savedForm)) : null);
    }, [savedForm]);

    const managed = managedOf(detail) ?? refusal?.managed ?? null;
    const readOnly = !!managed || refusal != null;

    return { detail, loading, error, reload, draft, setDraft, dirty, save, discard, saving, saveError, managed, refusal, readOnly };
}
