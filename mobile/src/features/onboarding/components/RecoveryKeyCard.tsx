/**
 * The one-and-only showing of a recovery secret.
 *
 * Two things arrive through here and both are shown exactly once, by design of
 * the server rather than of this screen:
 *
 *   - the zero-knowledge recovery key, generated on THIS device
 *     (core/crypto/keys.ts generateRecoveryKey) or returned by
 *     /auth/sso-encryption-setup. It is the only thing that can unwrap the DEK
 *     if the PIN is forgotten. Nobody — not an admin, not the operator of the
 *     server — can reissue it, because nobody else has ever seen it.
 *   - the TOTP recovery codes from POST /auth/mfa/enable, which are the only
 *     way back in if the phone holding the authenticator is lost.
 *
 * So the interaction is built to be un-skippable rather than merely
 * discouraging: Continue stays disabled until the user has both copied or
 * shared the secret AND ticked the acknowledgement. That is two deliberate
 * acts, which is the right amount of friction for a value that cannot be
 * recovered — and it is the difference between "I dismissed a dialog" and "I
 * saved my key".
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Card, CheckRow, Icon, Text } from '@/shared/ui';

import { useTakeSecret } from '../hooks/useTakeSecret';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        card: { gap: theme.spacing.lg },
        stackSm: { gap: theme.spacing.sm },
        buttons: { flexDirection: 'row', gap: theme.spacing.md },
        button: { flex: 1 },
        // Long-press to select is the gesture people reach for; the copy
        // button is the one they find.
        line: { letterSpacing: 1 },
    });

export interface RecoveryKeyCardProps {
    /** One key, or a list of one-time codes. Rendered monospace either way. */
    secret: string | string[];
    /** Overrides the default heading — MFA codes are not "a recovery key". */
    title?: string;
    /** What this secret unlocks, and what is lost without it. */
    description?: string;
    /** Filename used when the user shares the secret out to another app. */
    shareTitle?: string;
    confirmLabel?: string;
    onConfirm: () => void;
    /** Disables Continue while the caller finishes writing something. */
    busy?: boolean;
}

/** What still stands between the user and Continue: the button's hint, and the caption under it. */
function stillNeeded(taken: boolean, acknowledged: boolean, t: TranslateFn): [string | undefined, string | undefined] {
    if (!taken) {
        return [
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English copy, not a secret
            t('mobile.onboarding.secret_take_first', 'Copy or share the key first'),
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English copy, not a secret
            t('mobile.onboarding.secret_take_then_tick', 'Copy or share the key, then tick the box.'),
        ];
    }
    if (!acknowledged) {
        return [
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English copy, not a secret
            t('mobile.onboarding.secret_confirm_saved', 'Confirm that you have saved it'),
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English copy, not a secret
            t('mobile.onboarding.secret_tick', 'Tick the box to confirm you have saved it.'),
        ];
    }
    return [undefined, undefined];
}

export function RecoveryKeyCard({ secret, title, description, shareTitle, confirmLabel, onConfirm, busy = false }: RecoveryKeyCardProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const lines = Array.isArray(secret) ? secret : [secret];
    const { taken, copy, share } = useTakeSecret(
        lines.join('\n'),
        shareTitle ?? t('mobile.onboarding.recovery_key_file', 'Bee Flow recovery key'),
    );
    const [acknowledged, setAcknowledged] = useState(false);
    const [hint, caption] = stillNeeded(taken, acknowledged, t);

    return (
        <View style={styles.card}>
            <View style={styles.stackSm}>
                <Text variant="heading" center accessibilityRole="header">
                    {title ?? t('encryption.save_recovery_title', 'Save your recovery key')}
                </Text>
                <Text variant="body" tone="secondary" center>
                    {description ??
                        t(
                            'mobile.onboarding.recovery_key_intro',
                            'This is the only way back into your encrypted data if you forget your PIN. Nobody at Bee Flow can recover it for you — not the server, not an administrator.',
                        )}
                </Text>
            </View>

            <Banner tone="warning" icon="TriangleAlert">
                {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English copy, not a secret */}
                {t(
                    'mobile.onboarding.secret_once',
                    'You will not be shown this again. Put it in your password manager before you continue.',
                )}
            </Banner>

            <Card padded>
                <View style={styles.stackSm}>
                    {lines.map((line, i) => (
                        <Text key={`${line}-${i}`} variant="code" selectable center style={styles.line}>
                            {line}
                        </Text>
                    ))}
                </View>
            </Card>

            <View style={styles.buttons}>
                <Button
                    label={t('common.copy', 'Copy')}
                    onPress={() => void copy()}
                    variant="secondary"
                    icon={<Icon name="Copy" size={16} color={theme.colors.textPrimary} />}
                    style={styles.button}
                />
                <Button
                    label={t('mobile.onboarding.share', 'Share')}
                    onPress={() => void share()}
                    variant="secondary"
                    icon={<Icon name="Share2" size={16} color={theme.colors.textPrimary} />}
                    style={styles.button}
                />
            </View>

            <CheckRow
                checked={acknowledged}
                onToggle={() => setAcknowledged((v) => !v)}
                // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English copy, not a secret
                label={t('mobile.secret.saved_safe', 'I have saved this somewhere safe')}
            />

            <View style={styles.stackSm}>
                <Button
                    label={confirmLabel ?? t('encryption.saved_continue', 'I have saved it — continue')}
                    onPress={onConfirm}
                    size="lg"
                    fullWidth
                    loading={busy}
                    disabled={!taken || !acknowledged}
                    accessibilityHint={hint}
                />
                {caption ? (
                    <Text variant="caption" tone="tertiary" center accessibilityLiveRegion="polite">
                        {caption}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}
