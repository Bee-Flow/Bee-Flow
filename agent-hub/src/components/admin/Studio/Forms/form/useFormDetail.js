import { useCallback, useEffect, useRef, useState } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';

/**
 * One form, loaded from GET /api/automation/forms/:automationId, with a
 * DRAFT of its trigger form the Questions tab edits and saves back through
 * the ordinary PUT /api/automation/:id (the whole definition — one
 * validation pipeline, one version history, and the answers table follows on
 * that same save).
 *
 * `definition` is present only for the owner; `dirty` compares the draft
 * with the saved trigger form by value.
 */
export default function useFormDetail(automationId) {
    const api = useAutomationApi();
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
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
            if (alive.current) setSaveError(e);
            throw e;
        } finally {
            if (alive.current) setSaving(false);
        }
    }, [api, detail, draft, savedForm, reload]);

    const discard = useCallback(() => {
        setDraft(savedForm ? JSON.parse(JSON.stringify(savedForm)) : null);
    }, [savedForm]);

    return { detail, loading, error, reload, draft, setDraft, dirty, save, discard, saving, saveError };
}
