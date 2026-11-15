/**
 * Pair a new Nextcloud (web: integrations/nextcloud/OrgNcPairingPanel.tsx).
 * When this organisation installs Bee Flow on another Nextcloud, a one-shot
 * code entered on that connector's setup page (or given at a first install as
 * BEEFLOW_PAIRING_CODE) binds it to this same organisation instead of creating
 * a second one. The words are the web's own nc_pairing.* keys. Codes live 15
 * minutes and disappear once used. A code is a bearer credential: org admins
 * (of an NC-bound org) and the platform operator only.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame } from '@/features/org';
import { useConfirm } from '@/shared/patterns';
import { Button, Group, NoteRow, Text, useToast } from '@/shared/ui';

import { PairingCodeRow } from '../components/PairingCodeRow';
import { useGeneratePairingCode, useRevokePairingCode } from '../hooks/nextcloudMutations';
import { usePairingCodes } from '../hooks/nextcloudQueries';
import { useIntegrationAccess } from '../hooks/useIntegrationAccess';
import { useNow } from '../hooks/useNow';
import { pairingCommands, SETUP_PAGE_ADDRESSES } from '../model/nextcloud';
import type { PairingCode } from '../model/nextcloudTypes';

export function NcPairingScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const access = useIntegrationAccess();
    const allowed = access.admin && (access.isNcOrg || access.isSuperAdmin);
    const query = usePairingCodes(allowed);
    const generate = useGeneratePairingCode();
    const revoke = useRevokePairingCode();
    const now = useNow((query.data?.length ?? 0) > 0);

    const onGenerate = () => generate.mutate(undefined, { onError: (err) => toast(describeError(err).message, 'error') });
    const onRevoke = async (code: PairingCode) => {
        const ok = await confirm({
            title: t('mobile.orgIntegrations.pair_revoke_title', 'Revoke this pairing code?'),
            message: t('mobile.orgIntegrations.pair_revoke_message', 'Anyone who has it will no longer be able to use it.'),
            confirmLabel: t('mobile.orgIntegrations.pair_revoke', 'Revoke'),
        });
        if (ok) revoke.mutate(code.id, { onError: (err) => toast(describeError(err).message, 'error') });
    };

    return (
        <OrgSettingsFrame
            title={t('mobile.orgIntegrations.pair_title', 'Pair a new Nextcloud')}
            subtitle={t('settings.nextcloud_sync', 'Nextcloud Sync')}
            allowed={allowed}
            query={query}
        >
            {(codes) => (
                <>
                    <NoteRow>
                        {t(
                            'nc_pairing.intro',
                            'Generate a one-shot code, then enter it on the setup page of the Bee Flow connector on the new Nextcloud. The code binds that Nextcloud to this same Bee Flow organisation instead of creating a new one.',
                        )}
                    </NoteRow>
                    <Button
                        testID="pairing-generate"
                        label={t('mobile.orgIntegrations.pair_generate', 'Generate pairing code')}
                        iconName="Plus"
                        loading={generate.isPending}
                        onPress={onGenerate}
                    />
                    <Group title={t('mobile.orgIntegrations.pair_codes', 'Active pairing codes')}>
                        {codes.map((code) => (
                            <PairingCodeRow key={code.id} code={code} now={now} onRevoke={(c) => void onRevoke(c)} />
                        ))}
                        {codes.length === 0 ? (
                            <NoteRow>
                                {t('mobile.orgIntegrations.pair_none', 'No active pairing codes. Generated codes live for 15 minutes and disappear after use.')}
                            </NoteRow>
                        ) : null}
                    </Group>
                    <Group
                        title={t('mobile.orgIntegrations.pair_howto', 'How to use this code on the new Nextcloud')}
                        footer={t(
                            'nc_pairing.howto_result',
                            'The connector redeems the code once and binds this Nextcloud to your existing Bee Flow organisation. A code that has expired or was already used changes nothing: generate a new one.',
                        )}
                    >
                        <NoteRow>
                            {t(
                                'nc_pairing.howto_setup_page',
                                "As a Nextcloud administrator, open Bee Flow from the Nextcloud top bar, or open the connector's setup page:",
                            )}
                        </NoteRow>
                        <NoteRow>
                            <Text variant="code" selectable>
                                {SETUP_PAGE_ADDRESSES}
                            </Text>
                        </NoteRow>
                        <NoteRow>
                            {t(
                                'nc_pairing.howto_enter_code',
                                'Enter the code under Bind to existing organisation and press Apply pairing code. On a self-hosted server you can also enter it in the Pairing code field when you choose the server. Nothing has to be installed again.',
                            )}
                        </NoteRow>
                        <NoteRow>
                            {t(
                                'nc_pairing.howto_at_install',
                                'Installing the connector on that Nextcloud for the first time? You can also give the code at install, in the deploy options or with:',
                            )}
                        </NoteRow>
                        <NoteRow>
                            <Text variant="code" selectable>
                                {pairingCommands(codes[0]?.code ?? '<CODE>')}
                            </Text>
                        </NoteRow>
                    </Group>
                </>
            )}
        </OrgSettingsFrame>
    );
}
