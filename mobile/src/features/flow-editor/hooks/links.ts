/**
 * An automation's webhook URLs and public form links: the list, and the three
 * writes on it. Creating one checks the named trigger against the STORED
 * definition (a trigger dropped a second ago must be saved first), so the
 * draft is flushed before a create. `flowKey` is the automation id, or a new
 * automation's draft key.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useFlowId } from './useFlowId';
import { flowKeys } from '../api/keys';
import {
    createFormLink,
    createWebhook,
    deleteFormLink,
    deleteWebhook,
    listFormLinks,
    listWebhooks,
    rotateFormLink,
    rotateWebhookSecret,
} from '../api/links';
import { ensureDraftSaved } from '../state/ensureSaved';

function useLinkWrites<T>(
    flowKey: string,
    keyOf: (id: string) => readonly unknown[],
    calls: {
        create: (id: string, triggerStepId?: string | null) => Promise<T | null>;
        rotate: (id: string, handle: string) => Promise<T | null>;
        remove: (id: string, handle: string) => Promise<boolean>;
    },
) {
    const queryClient = useQueryClient();
    const settle = (id: string) => void queryClient.invalidateQueries({ queryKey: keyOf(id) });
    const create = useMutation({
        mutationFn: async (triggerStepId?: string | null) => {
            const id = await ensureDraftSaved(flowKey);
            const made = await calls.create(id, triggerStepId);
            settle(id);
            return made;
        },
    });
    const rotate = useMutation({
        mutationFn: async (handle: string) => {
            const id = await ensureDraftSaved(flowKey);
            const rotated = await calls.rotate(id, handle);
            settle(id);
            return rotated;
        },
    });
    const remove = useMutation({
        mutationFn: async (handle: string) => {
            const id = await ensureDraftSaved(flowKey);
            const removed = await calls.remove(id, handle);
            settle(id);
            return removed;
        },
    });
    return { create, rotate, remove };
}

/**
 * Webhook URLs. `create` and `rotate` answer the HMAC secret ONCE — the list
 * never carries it, so the screen has to show it from the mutation's data.
 */
export function useFlowWebhooks(flowKey: string) {
    const id = useFlowId(flowKey);
    const list = useQuery({
        queryKey: flowKeys.webhooks(id ?? ''),
        queryFn: ({ signal }) => listWebhooks(id as string, signal),
        enabled: Boolean(id),
    });
    const writes = useLinkWrites(flowKey, flowKeys.webhooks, {
        create: createWebhook,
        rotate: rotateWebhookSecret,
        remove: deleteWebhook,
    });
    return { list, ...writes };
}

/**
 * Public form links. Rotating replaces the address (the old one stops working
 * at once); asking for a link twice answers the one already handed out.
 */
export function useFormLinks(flowKey: string) {
    const id = useFlowId(flowKey);
    const list = useQuery({
        queryKey: flowKeys.formLinks(id ?? ''),
        queryFn: ({ signal }) => listFormLinks(id as string, signal),
        enabled: Boolean(id),
    });
    const writes = useLinkWrites(flowKey, flowKeys.formLinks, {
        create: createFormLink,
        rotate: rotateFormLink,
        remove: deleteFormLink,
    });
    return { list, ...writes };
}
