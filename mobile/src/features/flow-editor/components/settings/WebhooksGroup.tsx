/**
 * Every webhook URL of the routine, whichever trigger it belongs to — the
 * web's full WebhookPanel in the Settings tab (a webhook trigger's own
 * editor shows just its own). Requests must be HMAC-signed; the secret is
 * shown once, right after "New webhook" or Rotate, with "Copy as cURL".
 * A new URL is made for the routine's first webhook trigger: a routine
 * without one has nothing to receive a webhook with, and says so.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowWebhook } from '@/features/flow-editor/api';
import { WebhookRow } from '@/features/flow-editor/components/editors/trigger/WebhookRow';
import { useDraftState, useFlowWebhooks } from '@/features/flow-editor/hooks';
import type { FlowDefinition } from '@/features/flow-editor/model';
import type { DraftStore } from '@/features/flow-editor/state';
import { useConfirm } from '@/shared/patterns';
import { Banner, Button, Group, Spinner, Text, useToast } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.md, padding: theme.spacing.lg } satisfies ViewStyle,
});

/** The trigger a new URL is made for: the primary when it is a webhook, else the first secondary one. */
export function webhookTriggerId(def: FlowDefinition | null): string | null | undefined {
    if (def?.trigger?.kind === 'webhook') return null;
    return (def?.triggers || []).find((t) => t?.kind === 'webhook')?.id;
}

function useWebhookActions(flowKey: string) {
    const t = useTranslation();
    const confirm = useConfirm();
    const hooks = useFlowWebhooks(flowKey);
    const [secrets, setSecrets] = useState<Record<string, string>>({});
    const remember = (wh: FlowWebhook | null | undefined) => {
        if (wh?.secret) setSecrets((prev) => ({ ...prev, [wh.id]: wh.secret as string }));
    };
    const rotate = async (wh: FlowWebhook) => {
        const ok = await confirm({
            title: t('mobile.flow.webhook.rotate_title', 'Rotate the secret?'),
            message: t('mobile.flow.webhook.rotate_message', 'Any caller still using the old secret immediately starts getting 401 errors.'),
            confirmLabel: t('mobile.flow.webhook.rotate_confirm', 'Rotate'),
        });
        if (ok) hooks.rotate.mutate(wh.id, { onSuccess: remember });
    };
    const remove = async (wh: FlowWebhook) => {
        const ok = await confirm({
            title: t('mobile.flow.webhook.delete_title', 'Delete this webhook?'),
            message: t('mobile.flow.webhook.delete_message', 'Any caller using it starts getting 404s immediately.'),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) hooks.remove.mutate(wh.id);
    };
    const create = (triggerStepId: string | null) => hooks.create.mutate(triggerStepId, { onSuccess: remember });
    return { hooks, secrets, rotate, remove, create };
}

export function WebhooksGroup({ flowKey, store }: { flowKey: string; store: DraftStore }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const target = useDraftState(store, (s) => webhookTriggerId(s.definition));
    const locked = useDraftState(store, (s) => s.locked);
    const { hooks, secrets, rotate, remove, create } = useWebhookActions(flowKey);
    const rows = hooks.list.data ?? [];
    const error = hooks.create.error ?? hooks.rotate.error ?? hooks.remove.error ?? hooks.list.error;
    return (
        <Group
            title={t('routine_editor.webhooks', 'Webhooks')}
            footer={t('mobile.flow.settings.webhooks_hint', 'Requests must be HMAC-signed. Use “Copy as cURL” immediately after Create/Rotate to grab a complete signed-request template.')}
        >
            <View style={styles.body}>
                {error ? <Banner tone="error">{describeError(error).message}</Banner> : null}
                {hooks.list.isLoading ? <Spinner /> : null}
                {!hooks.list.isLoading && !rows.length ? (
                    <Text variant="caption" tone="tertiary">{t('routines.settings.webhooks_none', 'No webhooks yet.')}</Text>
                ) : null}
                {rows.map((row) => (
                    <WebhookRow
                        key={row.id}
                        row={row}
                        secret={secrets[row.id] ?? null}
                        onRotate={() => void rotate(row)}
                        onDelete={() => void remove(row)}
                        onCopied={(what) => toast(what, 'success')}
                        disabled={locked}
                    />
                ))}
                {target === undefined ? (
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.flow.settings.no_webhook_trigger', 'Add a webhook trigger to the flow to receive webhooks.')}
                    </Text>
                ) : (
                    <Button
                        size="sm"
                        variant="secondary"
                        iconName="Plus"
                        label={hooks.create.isPending ? t('routines.settings.webhook_creating', 'Creating…') : t('routine_editor.webhook_new', 'New webhook')}
                        onPress={() => create(target)}
                        disabled={hooks.create.isPending || locked}
                        testID="settings-new-webhook"
                    />
                )}
            </View>
        </Group>
    );
}
