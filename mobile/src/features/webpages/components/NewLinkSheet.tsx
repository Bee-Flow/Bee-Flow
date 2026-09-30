/**
 * Mint an external link, optionally behind a password. Restricting access to
 * named addresses belongs to the page's public address (PublicSection), where
 * the list is kept with the page rather than with one loose link.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Sheet, Text, TextField, useToast } from '@/shared/ui';

import { useCreateWebpageShare } from '../hooks/mutations';

const makeStyles = (theme: Theme) => StyleSheet.create({ body: { gap: theme.spacing.md } });

export function NewLinkSheet({
    visible,
    pageId,
    pageName,
    onClose,
    onCreated,
}: {
    visible: boolean;
    pageId: string;
    pageName: string | undefined;
    onClose: () => void;
    /** The new address, shown at once: on some servers this is its only sighting. */
    onCreated: (url: string | null) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [password, setPassword] = useState('');
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const createLink = useCreateWebpageShare(pageId, {
        onSuccess: (created) => {
            setPassword('');
            onCreated(created?.url ?? null);
        },
        onError: (err) => toast(describeError(err).message, 'error'),
    });

    const submit = () => {
        const trimmed = password.trim();
        // The store throws below six characters, and a 400 from a create is a
        // worse way to learn that than a line under the field.
        if (trimmed && trimmed.length < 6) {
            setPasswordError(
                t('mobile.webpages.link.password_short', 'Use at least six characters, or leave it empty.'),
            );
            return;
        }
        setPasswordError(null);
        createLink.mutate({ password: trimmed ? trimmed : undefined, title: pageName });
    };

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.webpages.link.new_title', 'New external link')}
            subtitle={t('mobile.webpages.link.new_hint', 'Anyone with the address can open it')}
            footer={
                <Button
                    label={t('mobile.webpages.link.create', 'Create link')}
                    size="lg"
                    fullWidth
                    loading={createLink.isPending}
                    onPress={submit}
                />
            }
        >
            <View style={styles.body}>
                <Text variant="body" tone="secondary">
                    {t(
                        'mobile.webpages.link.new_body',
                        'The link serves a copy of the page as it is right now, with its JavaScript stripped. Refresh it later to publish newer content to the same address.',
                    )}
                </Text>
                <TextField
                    label={t('mobile.webpages.link.password', 'Password (optional)')}
                    hint={t('mobile.webpages.link.password_hint', 'Leave empty for a link that opens straight away.')}
                    value={password}
                    onChangeText={setPassword}
                    error={passwordError}
                    secure
                    autoCapitalize="none"
                />
                <Text variant="caption" tone="tertiary">
                    {t(
                        'mobile.webpages.link.named_hint',
                        'To let only named e-mail addresses in, use the public address on the Share tab.',
                    )}
                </Text>
            </View>
        </Sheet>
    );
}
