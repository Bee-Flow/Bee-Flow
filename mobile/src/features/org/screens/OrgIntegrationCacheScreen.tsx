/**
 * Answer reuse (web: org/OrgIntegrationCacheEditor.jsx): may a routine keep
 * what an app or a web service answered, so a LATER run can use it? Off by
 * default — it means storing a third party's reply — with two separate
 * scopes and a lifetime. Switching it off forgets what is stored; the purge
 * row forgets it now, after a confirm.
 *
 * The web's minute slider is a Stepper in 60 s steps over the server's range.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { Banner, SaveBar, useToast } from '@/shared/ui';

import { ChoiceGroup, type Choice } from '../components/ChoiceGroup';
import { IntegrationCacheScopes } from '../components/IntegrationCacheScopes';
import { OrgSettingsFrame } from '../components/OrgSettingsFrame';
import { StoredAnswersGroup } from '../components/StoredAnswersGroup';
import { usePurgeOrgIntegrationCache, useSaveOrgIntegrationCache } from '../hooks/sectionMutations';
import { useOrgIntegrationCache } from '../hooks/sectionQueries';
import { useDraft } from '../hooks/useDraft';
import { useOrgContext } from '../hooks/useOrgSections';
import { fill } from '../model/format';
import type { IntegrationCacheBody } from '../model/sectionTypes';

type Mode = 'off' | 'on';

function modeChoices(t: TranslateFn): Choice<Mode>[] {
    return [
        {
            value: 'off',
            label: t('admin.integration_cache.off', 'Ask every run (recommended)'),
            description: t(
                'admin.integration_cache.off_desc',
                'Nothing an app answers is stored. A routine can still avoid asking the same thing twice inside one run — that reuse never leaves the run.',
            ),
        },
        {
            value: 'on',
            label: t('admin.integration_cache.on', 'Keep answers for a short while'),
            description: t(
                'admin.integration_cache.on_desc',
                'Answers to look-ups are stored, encrypted, so a later run can use them instead of asking again. Only look-ups, never anything that changes something, and only for steps whose author asked for it. Faster and cheaper — but a run can then work from data that is a few minutes old.',
            ),
        },
    ];
}

export function OrgIntegrationCacheScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const { orgId, isOrgAdmin } = useOrgContext();
    const allowed = isOrgAdmin && Boolean(orgId);
    const query = useOrgIntegrationCache(allowed ? orgId : null);
    const save = useSaveOrgIntegrationCache(orgId);
    const purge = usePurgeOrgIntegrationCache(orgId);
    const server = query.data;
    const form = useDraft<IntegrationCacheBody>(
        server ? { enabled: server.enabled, ttlSeconds: server.ttlSeconds, scopes: server.scopes } : null,
    );

    const onSave = async () => {
        if (!form.draft) return;
        try {
            const saved = await save.mutateAsync(form.draft);
            form.reset();
            toast(
                saved?.purged
                    ? t('admin.integration_cache.saved_purged', 'Saved. Stored answers were deleted.')
                    : t('admin.integration_cache.saved', 'Saved'),
                'success',
            );
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    const onPurge = async (stored: number) => {
        const label = fill(t('admin.integration_cache.clear', 'Delete the {{n}} stored answer(s) now'), { n: stored });
        const ok = await confirm({
            title: label,
            message: t(
                'mobile.org.cache_purge_message',
                'Every answer this organisation has stored is deleted. The next run asks the app again.',
            ),
            confirmLabel: t('common.delete', 'Delete'),
            tone: 'destructive',
        });
        if (!ok) return;
        try {
            await purge.mutateAsync();
            toast(t('admin.integration_cache.cleared', 'Stored answers deleted'), 'success');
        } catch (err) {
            toast(describeError(err).message || t('admin.integration_cache.clear_failed', 'Could not clear the stored answers'), 'error');
        }
    };

    return (
        <OrgSettingsFrame
            title={t('settings.integration_cache', 'Answer Reuse')}
            subtitle={t('admin.integration_cache.title', 'Reusing answers between runs')}
            allowed={allowed}
            query={query}
            dirty={form.dirty}
            footer={<SaveBar dirty={form.dirty} saving={save.isPending} onSave={() => void onSave()} onDiscard={form.reset} />}
        >
            {(data) => {
                const draft = form.draft ?? data;
                return (
                    <>
                        {data.killSwitch ? (
                            <Banner tone="warning">
                                {t(
                                    'admin.integration_cache.kill_switch',
                                    'This is switched off for the whole server by its operator, so nothing is stored whatever you choose here.',
                                )}
                            </Banner>
                        ) : null}
                        <ChoiceGroup
                            title={t('admin.integration_cache.choose', 'Reusing answers between runs')}
                            footer={t(
                                'admin.integration_cache.intro',
                                'Routines often ask an app the same question over and over. This decides whether the answer may be stored so a later run can use it — which means storing what the app sent back.',
                            )}
                            choices={modeChoices(t)}
                            value={draft.enabled ? 'on' : 'off'}
                            onChange={(mode) => form.set('enabled', mode === 'on')}
                            disabled={save.isPending}
                        />
                        {draft.enabled ? (
                            <IntegrationCacheScopes
                                draft={draft}
                                range={data.ttlRange}
                                disabled={save.isPending}
                                onScopes={(scopes) => form.set('scopes', scopes)}
                                onTtl={(ttl) => form.set('ttlSeconds', ttl)}
                            />
                        ) : null}
                        <StoredAnswersGroup
                            cache={data}
                            purging={purge.isPending}
                            onPurge={(stored) => void onPurge(stored)}
                        />
                    </>
                );
            }}
        </OrgSettingsFrame>
    );
}
