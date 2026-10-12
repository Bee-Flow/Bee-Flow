/**
 * The webhook trigger's endpoint, inside the trigger's own editor — the web's
 * TriggerWebhookPanel (BFSF-320): a node that exists to receive a POST says
 * where to POST. Scoped to THIS trigger node, so an automation with several
 * webhook triggers shows each its own URL.
 *
 * Once the automation exists, a trigger with no URL gets one on first open,
 * exactly once — there is no reason to make someone press "create" before a
 * webhook trigger has an address. The create saves the draft first
 * (ensureDraftSaved), because the server checks the node against the STORED
 * definition. An automation that does not exist yet is created by the explicit
 * "Generate" instead, never by opening an editor.
 */

import React, { useEffect, useRef, useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import type { FlowWebhook } from '@/features/flow-editor/api';
import { useFlowId, useFlowWebhooks } from '@/features/flow-editor/hooks';
import { useConfirm } from '@/shared/patterns';
import { Banner, Button, Spinner, useToast } from '@/shared/ui';

import { AddButton } from '../shared/AddButton';
import { Note } from '../shared/Note';
import type { StepEditorProps } from '../types';
import { webhooksFor } from './webhook';
import { WebhookRow } from './WebhookRow';

function useSecrets() {
    const [secrets, setSecrets] = useState<Record<string, string>>({});
    const remember = (wh: FlowWebhook | null | undefined) => {
        if (wh?.secret) setSecrets((prev) => ({ ...prev, [wh.id]: wh.secret as string }));
    };
    return { secrets, remember };
}

/** Under the URLs: "Generate" while there is none, "Add a second URL" once there is. */
function Footer({ empty, busy, onMake, disabled }: { empty: boolean; busy: boolean; onMake: () => void; disabled: boolean }) {
    const t = useTranslation();
    if (empty && busy) return <Spinner />;
    if (empty) {
        return (
            <Button
                size="sm"
                variant="secondary"
                iconName="Webhook"
                label={t('automations.trigger_webhook_panel.generate_a_webhook_url', 'Generate a webhook URL')}
                onPress={onMake}
                disabled={disabled}
                testID="webhook-generate"
            />
        );
    }
    return <AddButton label={t('mobile.flow.webhook.add', 'Add a second URL')} onPress={onMake} disabled={disabled || busy} />;
}

export function WebhookPanel({ step, ctx }: StepEditorProps) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const id = useFlowId(ctx.flowKey);
    const { list, create, rotate, remove } = useFlowWebhooks(ctx.flowKey);
    const { secrets, remember } = useSecrets();
    const stepId = String(step.id);
    const rows = webhooksFor(list.data ?? [], stepId, ctx.definition.trigger?.id);
    const error = create.error ?? rotate.error ?? remove.error ?? list.error;

    const make = () => create.mutate(stepId, { onSuccess: remember });
    const provisioned = useRef(false);
    useEffect(() => {
        if (provisioned.current || !id || !list.isSuccess || rows.length || create.isPending || ctx.disabled) return;
        provisioned.current = true;
        make();
    });

    const onRotate = async (wh: FlowWebhook) => {
        const ok = await confirm({
            title: t('mobile.flow.webhook.rotate_title', 'Rotate the secret?'),
            message: t('mobile.flow.webhook.rotate_message', 'Any caller still using the old secret immediately starts getting 401 errors.'),
            confirmLabel: t('mobile.flow.webhook.rotate_confirm', 'Rotate'),
        });
        if (ok) rotate.mutate(wh.id, { onSuccess: remember });
    };
    const onDelete = async (wh: FlowWebhook) => {
        const ok = await confirm({
            title: t('mobile.flow.webhook.delete_title', 'Delete this webhook?'),
            message: t('mobile.flow.webhook.delete_message', 'Any caller using it starts getting 404s immediately.'),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) remove.mutate(wh.id);
    };

    return (
        <>
            <Note>
                {t(
                    'automations.trigger_webhook_panel.post_to_this_url_to_fire',
                    'POST to this URL to fire the automation. Requests must be HMAC-signed — “Copy as cURL” gives you a complete working command, but only while the secret is still on screen (right after Create or Rotate).',
                )}
            </Note>
            {error ? <Banner tone="error">{describeError(error).message}</Banner> : null}
            {rows.map((row) => (
                <WebhookRow
                    key={row.id}
                    row={row}
                    secret={secrets[row.id] ?? null}
                    onRotate={() => void onRotate(row)}
                    onDelete={() => void onDelete(row)}
                    onCopied={(what) => toast(what, 'success')}
                    disabled={ctx.disabled}
                />
            ))}
            <Footer
                empty={!rows.length}
                busy={create.isPending || (!!id && list.isPending)}
                onMake={make}
                disabled={ctx.disabled}
            />
        </>
    );
}
