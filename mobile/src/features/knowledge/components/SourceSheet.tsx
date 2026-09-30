/**
 * One source, opened — what the web's row menu and ScheduleMenu do: see the
 * documents it read (SourceDocumentsSheet), refresh it now, choose how it refreshes (only the modes its kind supports; a
 * schedule is one of the web's three presets, in this device's time zone),
 * rename it, or delete it after saying what leaves with it.
 *
 * "Refresh now" is a request: the server queues it (202) and the list shows
 * it running until the next read says otherwise.
 */

import React, { useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { Button, OptionRow, Sheet, Text, TextField, useToast } from '@/shared/ui';

import { useDeleteKbSource, useRefreshKbSource, useUpdateKbSource } from '../hooks/sources';
import { sourceErrorMessage } from '../model/sourceErrors';
import { CRON_PRESETS, deviceTimeZone, presetFor, refreshModeLabel, ruleFor, sourceSubline } from '../model/sources';
import type { KbSource, RefreshRule } from '../model/types';

function ScheduleOptions({ t, source, disabled, onChoose }: { t: TranslateFn; source: KbSource; disabled: boolean; onChoose: (rule: RefreshRule) => void }) {
    const preset = presetFor(source.refreshCron);
    const scheduled = source.refreshMode === 'schedule';
    return (
        <>
            <Text variant="label" tone="tertiary">
                {t('knowledge.schedule.title', 'Refresh')}
            </Text>
            {source.supportsModes
                .filter((m) => m !== 'schedule')
                .map((mode) => (
                    <OptionRow key={mode} label={refreshModeLabel(t, mode)} selected={source.refreshMode === mode} disabled={disabled} onPress={() => onChoose(ruleFor(mode))} />
                ))}
            {source.supportsModes.includes('schedule')
                ? CRON_PRESETS.map((p) => (
                      <OptionRow key={p.id} label={t(p.key, p.en)} selected={scheduled && preset?.id === p.id} disabled={disabled}
                          onPress={() => onChoose(ruleFor('schedule', p.cron))} />
                  ))
                : null}
            {scheduled && !preset ? (
                <Text variant="caption" tone="tertiary">
                    {t('knowledge.schedule.custom', 'Custom schedule ({cron})', { cron: source.refreshCron ?? '' })}
                </Text>
            ) : null}
            {source.supportsModes.includes('schedule') ? (
                <Text variant="caption" tone="tertiary">
                    {t('knowledge.schedule.tz_note', 'Times are in {tz}.', { tz: source.refreshTz || deviceTimeZone() })}
                </Text>
            ) : null}
        </>
    );
}

export function SourceSheet({ kbId, source, canManage, onClose, onDocuments }: {
    kbId: string; source: KbSource | null; canManage: boolean; onClose: () => void; onDocuments: () => void;
}) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const [name, setName] = useState(source?.name ?? '');
    const fail = (e: Error) => toast(sourceErrorMessage(t, e), 'error');
    const refresh = useRefreshKbSource(kbId, { onSuccess: () => toast(t('mobile.knowledge.refresh_queued', 'Refresh requested'), 'success'), onError: fail });
    const update = useUpdateKbSource(kbId, { onError: fail });
    const remove = useDeleteKbSource(kbId, { onSuccess: onClose, onError: fail });
    if (!source) return <Sheet visible={false} onClose={onClose} title="">{null}</Sheet>;
    const busy = source.status === 'running' || source.status === 'queued' || refresh.isPending;

    const askDelete = async () => {
        const ok = await confirm({
            title: t('knowledge.sources.delete_title', 'Delete “{name}”?', { name: source.name }),
            message: t('knowledge.sources.delete_body', 'Its {count} documents leave this knowledge base. The original files stay where they are.', { count: source.documentCount }),
            confirmLabel: t('knowledge.sources.delete', 'Delete'),
            tone: 'destructive',
        });
        if (ok) remove.mutate(source.id);
    };

    return (
        <Sheet visible onClose={onClose} title={source.name || sourceSubline(t, source)} subtitle={sourceSubline(t, source)}>
            {source.error ? <Text variant="caption" tone="error">{source.error}</Text> : null}
            <Button variant="secondary" iconName="FileText" label={t('mobile.knowledge.source_documents', 'Its documents ({count})', { count: source.documentCount })}
                onPress={onDocuments} testID="source-documents-open" />
            {canManage ? (
                <>
                    <Button iconName="RefreshCw" label={t('knowledge.sources.refresh_now', 'Refresh now')} loading={refresh.isPending} disabled={busy}
                        onPress={() => refresh.mutate(source.id)} testID="source-refresh" />
                    <ScheduleOptions t={t} source={source} disabled={update.isPending}
                        onChoose={(rule) => update.mutate({ sid: source.id, patch: { refresh: rule } })} />
                    <TextField label={t('knowledge.form.name', 'Name')} value={name} onChangeText={setName} />
                    <Button variant="secondary" label={t('knowledge.sources.rename', 'Rename')} disabled={!name.trim() || name.trim() === source.name}
                        loading={update.isPending} onPress={() => update.mutate({ sid: source.id, patch: { name: name.trim() } })} />
                    <Button variant="danger" label={t('knowledge.sources.delete', 'Delete')} loading={remove.isPending} onPress={() => void askDelete()} />
                </>
            ) : (
                <Text variant="caption" tone="tertiary">{refreshModeLabel(t, source.refreshMode)}</Text>
            )}
        </Sheet>
    );
}
