/**
 * The one-and-only showing of a recovery secret.
 *
 * Two things arrive through here and both are shown exactly once, by design of
 * the server rather than of this screen:
 *
 *   - the zero-knowledge recovery key, generated on THIS device
 *     (crypto/keys.ts generateRecoveryKey) or returned by
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

import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import React, { useState } from 'react';
import { Pressable, Share, View } from 'react-native';

import { useTheme } from '../../theme/ThemeProvider';
import { Button } from '../../ui/Button';
import { Banner } from '../../ui/Feedback';
import { Card } from '../../ui/Surface';
import { Text } from '../../ui/Text';
import { useToast } from '../../ui/Toast';

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

export function RecoveryKeyCard({
    secret,
    title = 'Save your recovery key',
    description = 'This is the only way back into your encrypted data if you forget your PIN. Nobody at Bee Flow can recover it for you — not the server, not an administrator.',
    shareTitle = 'Bee Flow recovery key',
    confirmLabel = 'I have saved it — continue',
    onConfirm,
    busy = false,
}: RecoveryKeyCardProps) {
    const theme = useTheme();
    const { toast } = useToast();
    const [taken, setTaken] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);

    const lines = Array.isArray(secret) ? secret : [secret];
    const plain = lines.join('\n');

    const copy = async () => {
        await Clipboard.setStringAsync(plain);
        setTaken(true);
        toast('Copied to your clipboard', 'success');
    };

    const share = async () => {
        // expo-sharing needs a file; Share is the system sheet and takes text
        // directly, which is what a password manager accepts. Falling back to
        // isAvailableAsync keeps the button honest on a device with no share
        // targets at all.
        try {
            const result = await Share.share({ message: plain, title: shareTitle });
            if (result.action !== Share.dismissedAction) setTaken(true);
        } catch {
            if (!(await Sharing.isAvailableAsync())) {
                toast('No app on this device can accept it — copy it instead', 'error');
            }
        }
    };

    return (
        <View style={{ gap: theme.spacing.lg }}>
            <View style={{ gap: theme.spacing.sm }}>
                <Text variant="heading" center accessibilityRole="header">
                    {title}
                </Text>
                <Text variant="body" tone="secondary" center>
                    {description}
                </Text>
            </View>

            <Banner tone="warning" icon="alert-triangle">
                You will not be shown this again. Put it in your password manager
                before you continue.
            </Banner>

            <Card padded>
                <View style={{ gap: theme.spacing.sm }}>
                    {lines.map((line, i) => (
                        <Text
                            key={`${line}-${i}`}
                            variant="code"
                            selectable
                            center
                            // Long-press to select is the gesture people reach
                            // for; the copy button below is the one they find.
                            style={{ letterSpacing: 1 }}
                        >
                            {line}
                        </Text>
                    ))}
                </View>
            </Card>

            <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                <Button
                    label="Copy"
                    onPress={() => void copy()}
                    variant="secondary"
                    icon={<Feather name="copy" size={16} color={theme.colors.textPrimary} />}
                    style={{ flex: 1 }}
                />
                <Button
                    label="Share"
                    onPress={() => void share()}
                    variant="secondary"
                    icon={<Feather name="share-2" size={16} color={theme.colors.textPrimary} />}
                    style={{ flex: 1 }}
                />
            </View>

            <Pressable
                onPress={() => {
                    void Haptics.selectionAsync();
                    setAcknowledged((v) => !v);
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: acknowledged }}
                accessibilityLabel="I have saved this somewhere safe"
                style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    minHeight: theme.minTouch,
                    paddingHorizontal: theme.spacing.md,
                    borderRadius: theme.radii.md,
                    backgroundColor: pressed ? theme.colors.itemHoverBg : 'transparent',
                })}
            >
                <View
                    style={{
                        width: 22,
                        height: 22,
                        borderRadius: theme.radii.sm,
                        borderWidth: 2,
                        borderColor: acknowledged
                            ? theme.colors.accentPrimary
                            : theme.colors.borderDefault,
                        backgroundColor: acknowledged ? theme.colors.accentPrimary : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    {acknowledged ? (
                        <Feather name="check" size={14} color={theme.colors.accentPrimaryFg} />
                    ) : null}
                </View>
                <Text variant="body" style={{ flex: 1 }}>
                    I have saved this somewhere safe
                </Text>
            </Pressable>

            <View style={{ gap: theme.spacing.sm }}>
                <Button
                    label={confirmLabel}
                    onPress={onConfirm}
                    size="lg"
                    fullWidth
                    loading={busy}
                    disabled={!taken || !acknowledged}
                    accessibilityHint={
                        !taken
                            ? 'Copy or share the key first'
                            : !acknowledged
                              ? 'Confirm that you have saved it'
                              : undefined
                    }
                />
                {!taken || !acknowledged ? (
                    <Text variant="caption" tone="tertiary" center accessibilityLiveRegion="polite">
                        {!taken
                            ? 'Copy or share the key, then tick the box.'
                            : 'Tick the box to confirm you have saved it.'}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}
