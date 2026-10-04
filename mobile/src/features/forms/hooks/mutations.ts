/**
 * The writes a form has of its own, and the automation writes the Form page uses
 * — each refreshing the forms list and the open Form page when it lands.
 *
 * A form's link and going live are the automation's own (the flow editor's form
 * links and activation); they are wrapped here only to add that refresh.
 */

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { translate } from '@/core/i18n';
import { automationKeys, createAutomation, type MutationHandlers } from '@/features/automations';
import { newFlowSeed, useActivateFlow, useFormLinks } from '@/features/flow-editor';

import { draftFormWithAi, provisionAnswersTable, setFormAudience } from '../api/endpoints';
import { formKeys } from '../api/keys';
import type { AiFormDraft, FormAudience, FormDetail } from '../model/types';

/** The forms list and every open Form page, refetched. */
export function refreshForms(queryClient: QueryClient): void {
    void queryClient.invalidateQueries({ queryKey: formKeys.all });
}

/** Who may fill the form in. The saved audience lands in the open Form page at once. */
export function useSetFormAudience(automationId: string, handlers: MutationHandlers<FormAudience, FormAudience> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (audience: FormAudience) => setFormAudience(automationId, audience),
        onSuccess: (saved, asked) => {
            queryClient.setQueryData<FormDetail | null>(formKeys.detail(automationId), (prev) => (prev ? { ...prev, audience: saved } : prev));
            refreshForms(queryClient);
            handlers.onSuccess?.(saved, asked);
        },
        onError: handlers.onError,
    });
}

/** "Try again" for a form that collects but has no table yet. */
export function useProvisionAnswersTable(automationId: string, handlers: MutationHandlers<unknown> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => provisionAnswersTable(automationId),
        onSuccess: (result) => {
            refreshForms(queryClient);
            handlers.onSuccess?.(result, undefined);
        },
        onError: handlers.onError,
    });
}

/** A model call that answered with nothing usable reads like the server's own `ai_unusable`. */
function unusable(): Error {
    return Object.assign(new Error('unusable'), { code: 'ai_unusable' });
}

/** "Build it with AI": a draft for the unsaved editor — nothing is stored. */
export function useDraftFormWithAi(handlers: MutationHandlers<AiFormDraft, Record<string, unknown>> = {}) {
    return useMutation({
        mutationFn: async (body: Record<string, unknown>) => {
            const draft = await draftFormWithAi(body);
            if (!draft) throw unusable();
            return draft;
        },
        onSuccess: handlers.onSuccess,
        onError: handlers.onError,
    });
}

/**
 * The form's link: made, replaced (the old address stops working at once —
 * the token IS the credential) or taken down. Through the automation's own link
 * calls, which save any open draft first.
 */
export function useFormLinkActions(automationId: string) {
    const queryClient = useQueryClient();
    const links = useFormLinks(automationId);
    const settle = async <T,>(work: Promise<T>): Promise<T> => {
        try {
            return await work;
        } finally {
            refreshForms(queryClient);
        }
    };
    return {
        busy: links.create.isPending || links.rotate.isPending || links.remove.isPending,
        create: () => settle(links.create.mutateAsync(null)),
        rotate: (token: string) => settle(links.rotate.mutateAsync(token)),
        remove: (token: string) => settle(links.remove.mutateAsync(token)),
    };
}

/**
 * Live or not — which is arming the automation: activation validates the whole
 * flow (a 400 names what stops it) and a form is reachable only while its
 * automation is active and not a draft.
 */
export function useSetFormLive(automationId: string, handlers: MutationHandlers<boolean, boolean> = {}) {
    const queryClient = useQueryClient();
    return useActivateFlow(automationId, {
        onSuccess: (_result, active) => {
            refreshForms(queryClient);
            handlers.onSuccess?.(active, active);
        },
        onError: handlers.onError,
    });
}

/**
 * A new form: an automation whose trigger is a form (the default questions),
 * created as a draft. `collect` makes the answers table on that same create.
 */
export function useCreateForm(handlers: MutationHandlers<string, { title: string; collect: boolean }> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ title, collect }: { title: string; collect: boolean }) => {
            const definition = newFlowSeed('form', { title, collect }) as unknown as Record<string, unknown>;
            const result = await createAutomation({ title, definition });
            const id = result.automation?.id;
            if (!id) throw new Error(translate('forms.new.failed', 'Could not create the form.'));
            return id;
        },
        onSuccess: (id, vars) => {
            refreshForms(queryClient);
            void queryClient.invalidateQueries({ queryKey: automationKeys.automations });
            handlers.onSuccess?.(id, vars);
        },
        onError: handlers.onError,
    });
}
