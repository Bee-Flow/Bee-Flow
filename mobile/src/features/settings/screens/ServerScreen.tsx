/**
 * Server — which Bee Flow this install talks to.
 *
 * The web app never needs this screen: it is served BY the server, so its API
 * base is a relative path. An APK has no such anchor — the same binary is used
 * by a SaaS customer on beeflow.nl, by a company on ai.acme.example, and by
 * someone running ./selfhost.sh on a laptop — so the server URL is first-class
 * state (core/api/server.ts).
 */

import React, { useState } from 'react';

import { getServerUrl, isInsecure, isPrivateHost } from '@/core/api/server';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { Banner, GroupedScroll, Screen, ScreenHeader, useToast } from '@/shared/ui';

import { ChangeServerGroup } from '../components/ChangeServerGroup';
import { ForgetServerGroup } from '../components/ForgetServerGroup';
import { ServerStatusGroup } from '../components/ServerStatusGroup';
import { SwitchSheet } from '../components/SwitchSheet';
import { hostOf } from '../model/labels';

export function ServerScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const { chooseServer, forgetServer } = useAuth();
    const current = getServerUrl();
    const [switchSheet, setSwitchSheet] = useState(false);

    const switchTo = async (url: string) => {
        setSwitchSheet(false);
        // forgetServer() first: it wipes the vault and query cache.
        // chooseServer() then points at the new host and re-resolves the auth
        // stage, which lands on that server's sign-in.
        await forgetServer();
        await chooseServer(url);
        toast(t('mobile.settings.switched', 'Now connected to a different server'), 'success');
    };

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title={t('mobile.settings.server', 'Server')}
                subtitle={hostOf(current) ?? t('mobile.settings.not_configured', 'Not configured')}
            />

            <GroupedScroll>
                {current && isInsecure(current) ? (
                    <Banner tone={isPrivateHost(current) ? 'info' : 'warning'}>
                        {isPrivateHost(current)
                            ? t('mobile.settings.http_private', 'This is a plain HTTP address on a private network. That is normal for a self-hosted Bee Flow on your own network.')
                            : t('mobile.settings.http_public', 'This is a plain HTTP address on the public internet, so your sign-in travels unencrypted. Move this server to HTTPS.')}
                    </Banner>
                ) : null}
                <ServerStatusGroup current={current} />
                <ChangeServerGroup onSwitch={() => setSwitchSheet(true)} />
                <ForgetServerGroup />
            </GroupedScroll>

            <SwitchSheet
                visible={switchSheet}
                onClose={() => setSwitchSheet(false)}
                onConfirmed={switchTo}
            />
        </Screen>
    );
}
