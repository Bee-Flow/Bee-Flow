/**
 * Encryption: the org admin picks the content-encryption tier
 * (web: security/encryption/OrgEncryptionEditor.jsx).
 *
 * Every tier the server knows is listed; one it will not accept is shown
 * disabled with the server's reason, and an entitlement block carries the
 * web's Enterprise badge line. The per-surface `scope` is left out as on the
 * web: the server accepts it only from a platform administrator. Choosing
 * zero-knowledge signs everyone out, so that save asks first.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { Banner, SaveBar, useToast } from '@/shared/ui';

import { ChoiceGroup, type Choice } from '../components/ChoiceGroup';
import { OrgSettingsFrame } from '../components/OrgSettingsFrame';
import { useSaveOrgEncryption } from '../hooks/sectionMutations';
import { useOrgEncryption } from '../hooks/sectionQueries';
import { useDraft } from '../hooks/useDraft';
import { useOrgContext } from '../hooks/useOrgSections';
import type { EncryptionTierOption, OrgEncryption } from '../model/sectionTypes';

function tierMeta(t: TranslateFn): Record<string, { label: string; description: string }> {
    return {
        none: {
            label: t('admin.encryption.tier_none', 'Off'),
            description: t('admin.encryption.tier_none_desc', 'Messages are stored without content encryption.'),
        },
        managed: {
            label: t('admin.encryption.tier_managed', 'Managed'),
            description: t(
                'admin.encryption.tier_managed_desc',
                'Encrypted at rest. Your administrators can reset a password without the user losing their data.',
            ),
        },
        zk: {
            label: t('admin.encryption.tier_zk', 'Zero-knowledge'),
            description: t(
                'admin.encryption.tier_zk_desc',
                'Encrypted with each user’s own secret. Nobody — not your administrators, not Bee Flow support — can recover a user’s data if they lose their password and recovery key.',
            ),
        },
    };
}

function lockedNote(option: EncryptionTierOption, t: TranslateFn): string | null {
    if (option.selectable) return null;
    if (option.blockedBy !== 'entitlement') return option.reason;
    const plan = `${t('license.enterprise', 'Enterprise')} · ${t('license.upgrade_at_beeflow', 'Upgrade at beeflow.nl')}`;
    return option.reason ? `${option.reason} ${plan}` : plan;
}

function tierChoices(server: OrgEncryption, t: TranslateFn): Choice<string>[] {
    const meta = tierMeta(t);
    return server.tierOptions.map((option) => ({
        value: option.tier,
        label: meta[option.tier]?.label ?? option.tier,
        description: meta[option.tier]?.description,
        disabled: !option.selectable,
        lockedNote: lockedNote(option, t),
    }));
}

export function OrgEncryptionScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const { orgId, isOrgAdmin } = useOrgContext();
    const allowed = isOrgAdmin && Boolean(orgId);
    const query = useOrgEncryption(allowed ? orgId : null);
    const save = useSaveOrgEncryption(orgId);
    const form = useDraft(query.data ? { tier: query.data.tier } : null);
    const tier = form.draft?.tier ?? null;

    const onSave = async () => {
        if (!tier) return;
        if (tier === 'zk') {
            const ok = await confirm({
                title: t('admin.encryption.tier_zk', 'Zero-knowledge'),
                message: t(
                    'admin.encryption.warn_zk_signout',
                    'Saving this will sign out everyone in the organisation, including you. Each person must sign in again so their encryption key can be created. Data can no longer be recovered by an administrator.',
                ),
                confirmLabel: t('common.save', 'Save'),
                tone: 'destructive',
            });
            if (!ok) return;
        }
        try {
            const result = await save.mutateAsync(tier);
            form.reset();
            toast(
                result.sessionsBusted
                    ? t(
                          'admin.encryption.sessions_busted',
                          'Everyone in this organisation has been signed out. Each person must sign in again so their encryption key can be created.',
                      )
                    : t('admin.encryption.saved', 'Encryption settings saved'),
                'success',
            );
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    return (
        <OrgSettingsFrame
            title={t('admin.encryption.title', 'Encryption')}
            allowed={allowed}
            query={query}
            dirty={form.dirty}
            footer={<SaveBar dirty={form.dirty} saving={save.isPending} onSave={() => void onSave()} onDiscard={form.reset} />}
        >
            {(server) => (
                <>
                    <Banner tone="info">
                        {t(
                            'admin.encryption.intro',
                            'Choose how your organisation’s conversation content is stored. This affects new messages; existing messages are left exactly as they are and stay readable either way.',
                        )}
                    </Banner>
                    {!server.entitled ? (
                        <Banner tone="warning">
                            {t(
                                'admin.encryption.not_entitled',
                                'Encryption is not included in your current plan. You can still turn it off, but not on.',
                            )}
                        </Banner>
                    ) : null}
                    <ChoiceGroup
                        title={t('admin.encryption.choose_tier', 'Encryption level')}
                        choices={tierChoices(server, t)}
                        value={tier}
                        onChange={(next) => form.set('tier', next)}
                        disabled={save.isPending}
                    />
                    <TierWarnings server={server} tier={tier} dirty={form.dirty} />
                </>
            )}
        </OrgSettingsFrame>
    );
}

function TierWarnings({ server, tier, dirty }: { server: OrgEncryption; tier: string | null; dirty: boolean }) {
    const t = useTranslation();
    const warning = server.tierOptions.find((o) => o.tier === tier)?.warningReason;
    return (
        <>
            {warning ? <Banner tone="warning">{warning}</Banner> : null}
            {dirty && tier === 'zk' ? (
                <Banner tone="error">
                    {t(
                        'admin.encryption.warn_zk_signout',
                        'Saving this will sign out everyone in the organisation, including you. Each person must sign in again so their encryption key can be created. Data can no longer be recovered by an administrator.',
                    )}
                </Banner>
            ) : null}
        </>
    );
}
