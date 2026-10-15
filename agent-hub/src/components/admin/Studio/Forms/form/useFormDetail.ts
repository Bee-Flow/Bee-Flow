import { useCallback, useEffect, useRef, useState } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { managedOf, managedRefusalOf } from '../../../../shared/managedPart';
import type { ManagedBannerInfo } from '../../../../shared/managedPart';

/** The trigger's form definition the Questions tab edits, as the builder stores it. */
export type FormDraft = Record<string, unknown>;

/** What the answers table of a form reports (`detail.answers`). */
export interface FormAnswers {
    datatableId?: string | null;
    collecting?: boolean;
    grade?: string | null;
    error?: { message?: string } | null;
    lastWriteError?: { message?: string; code?: string } | null;
}

/** One form, as `GET /api/automation/forms/:automationId` returns it. */
export interface FormDetail {
    automationId: string;
    id?: string;
    title?: string;
    isActive?: boolean;
    mine?: boolean;
    audience?: unknown;
    pages?: unknown[];
    answers?: FormAnswers | null;
    questions?: { collect?: boolean } | null;
    /** Present only for someone who may edit the automation (mayEdit). */
    definition?: { trigger?: { form?: FormDraft } & Record<string, unknown> } & Record<string, unknown>;
}

/**
 * One form, loaded from GET /api/automation/forms/:automationId, with a
 * DRAFT of its trigger form the Questions tab edits and saves back through
 * the ordinary PUT /api/automation/:id (the whole definition — one
 * validation pipeline, one version history, and the answers table follows on
 * that same save).
 *
 * `definition` is sent only to anyone who may edit the automation (mayEdit); `dirty` compares the draft
 * with the saved trigger form by value.
 *
 * A form is an automation, so a Solution stage can manage it. `managed` is what the
 * GET said about it (managedPart.managedOf) or, for a tab opened before the
 * stage took the automation over, what the refused save said (409 managed_part,
 * which `save` maps instead of leaving it as a bare failure): the host mounts
 * the ManagedPartBanner from it and stops offering Save. `refusal` is the
 * banner info of that 409 (`reason: 'managed'`).
 */
export default function useFormDetail(automationId: string | null | undefined) {
    const api = useAutomationApi();
    const [detail, setDetail] = useState<FormDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<unknown>(null);
    const [draft, setDraft] = useState<FormDraft | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<unknown>(null);
    const [refusal, setRefusal] = useState<ManagedBannerInfo | null>(null);
    const alive = useRef<boolean>(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const reload = useCallback(async ({ keepDraft = false }: { keepDraft?: boolean } = {}) => {
        if (!automationId) return null;
        setLoading(true);
        setError(null);
        try {
            const body = await api.getForm(automationId) as { form?: FormDetail | null } | null;
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
    const save = useCallback(async (patch: FormDraft | null = null) => {
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
