/**
 * Connect to a different server. Never remember an address that has not
 * answered — a typo saved is a first-run screen the user cannot get out of
 * without reinstalling — so the address is probed, then confirmed.
 */

import React, { useState } from 'react';

import { checkHealth, isInsecure, isPrivateHost, normaliseServerUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { FormSheet, useConfirm } from '@/shared/patterns';
import { Banner, TextField } from '@/shared/ui';

import { hostOf } from '../model/labels';

export function SwitchSheet({
    visible,
    onClose,
    onConfirmed,
}: {
    visible: boolean;
    onClose: () => void;
    onConfirmed: (url: string) => Promise<void>;
}) {
    const t = useTranslation();
    const confirm = useConfirm();
    const [input, setInput] = useState('');
    const [probing, setProbing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const normalised = normaliseServerUrl(input);

    const verifyAndSwitch = async () => {
        if (!normalised) {
            setError('That does not look like a web address.');
            return;
        }
        setError(null);
        setProbing(true);
        const result = await checkHealth(normalised);
        setProbing(false);
        if (!result.ok) {
            setError(result.error ?? 'That address did not answer.');
            return;
        }
        const ok = await confirm({
            title: 'Switch server?',
            message: `You will be signed out and this phone’s cached data and encryption key will be removed before connecting to ${hostOf(normalised)}.`,
            confirmLabel: t('mobile.settings.switch_server', 'Switch'),
        });
        if (ok) void onConfirmed(normalised);
    };

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title="Connect to a different server"
            subtitle="Bee Flow checks the address before it remembers it"
            submitLabel="Check and switch"
            onSubmit={() => void verifyAndSwitch()}
            canSubmit={input.trim().length > 0}
            submitting={probing}
        >
            <TextField
                label="Server address"
                value={input}
                onChangeText={setInput}
                placeholder="beeflow.nl"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                hint={
                    normalised
                        ? `Will connect to ${normalised}`
                        : 'Type a host name. https:// is assumed unless you type http:// yourself.'
                }
                error={error}
            />
            {normalised && isInsecure(normalised) && !isPrivateHost(normalised) ? (
                <Banner tone="warning">
                    That is a plain HTTP address on the public internet. Your password and
                    session would travel in the clear.
                </Banner>
            ) : null}
        </FormSheet>
    );
}
