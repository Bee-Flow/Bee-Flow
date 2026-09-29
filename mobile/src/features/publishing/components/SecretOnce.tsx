/**
 * A secret shown exactly once, in a sheet you cannot dismiss by accident.
 *
 * The MCP token is `bfmcp.<userId>.<64 hex>` and only its random half is ever
 * stored (routes/mcpServer.js). Nobody — not an admin, not the operator of the
 * server — can show it again, and minting a replacement revokes the one that
 * just scrolled off the screen. So the interaction is built to be
 * un-skippable rather than merely discouraging: Done stays disabled until the
 * user has both copied or shared the token AND ticked the acknowledgement.
 * Two deliberate acts is the right amount of friction for a value that cannot
 * be recovered, and it is the difference between "I dismissed a dialog" and
 * "I saved my token".
 *
 * Same reasoning, and deliberately the same shape, as the recovery-key screen
 * in onboarding. Rebuilt here rather than imported so neither feature owns the
 * other's copy — if the two ever need to agree, they belong in src/ui.
 */

import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Share, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../../../theme/ThemeProvider';
import { Button } from '../../../ui/Button';
import { Banner, describeError } from '../../../ui/Feedback';
import { Card } from '../../../ui/Surface';
import { Text } from '../../../ui/Text';
import { useToast } from '../../../ui/Toast';

export function SecretOnce({
    visible,
    secret,
    title,
    description,
    shareTitle,
    onDone,
}: {
    visible: boolean;
    /** Rendered monospace and selectable. Null while nothing has been minted. */
    secret: string | null;
    title: string;
    description: string;
    shareTitle: string;
    onDone: () => void;
}) {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { toast } = useToast();
    const [taken, setTaken] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);

    // A second minting reopens this sheet with a different value; carrying the
    // last one's ticks over would let the new token be dismissed unread.
    //
    // Adjusted DURING render rather than in an effect. This is React's own
    // recipe for "reset state when a prop changes" — an effect would render
    // once with the new secret and the old acknowledgement still ticked before
    // correcting itself, and that frame is exactly the one where a fast tap
    // dismisses a token nobody has read.
    const [lastSecret, setLastSecret] = useState(secret);
    if (secret !== lastSecret) {
        setLastSecret(secret);
        setTaken(false);
        setAcknowledged(false);
    }

    const copy = async () => {
        if (!secret) return;
        await Clipboard.setStringAsync(secret);
        setTaken(true);
        toast('Copied to your clipboard', 'success');
    };

    const share = async () => {
        if (!secret) return;
        try {
            const result = await Share.share({ message: secret, title: shareTitle });
            if (result.action !== Share.dismissedAction) setTaken(true);
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    return (
        <Modal
            visible={visible && secret !== null}
            transparent
            animationType="slide"
            // Android's back button must NOT close this — the whole point is
            // that leaving without the token cannot happen by reflex. It is
            // wired to nothing, and Done is the only way out.
            onRequestClose={() => undefined}
            statusBarTranslucent
        >
            <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000099' }}>
                <View
                    style={{
                        backgroundColor: theme.colors.bgSecondary,
                        borderTopLeftRadius: theme.radii.xl,
                        borderTopRightRadius: theme.radii.xl,
                        paddingTop: theme.spacing.xl,
                        paddingHorizontal: theme.spacing.lg,
                        paddingBottom: insets.bottom + theme.spacing.lg,
                        maxHeight: '90%',
                        gap: theme.spacing.lg,
                    }}
                >
                    <ScrollView
                        contentContainerStyle={{ gap: theme.spacing.lg }}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={{ gap: theme.spacing.sm }}>
                            <Text variant="heading" center accessibilityRole="header">
                                {title}
                            </Text>
                            <Text variant="body" tone="secondary" center>
                                {description}
                            </Text>
                        </View>

                        <Banner tone="warning" icon="alert-triangle">
                            You will not be shown this again. Put it where the client that needs it
                            can read it before you continue.
                        </Banner>

                        <Card padded>
                            <Text variant="code" selectable style={{ letterSpacing: 0.5 }}>
                                {secret ?? ''}
                            </Text>
                        </Card>

                        <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                            <Button
                                label="Copy"
                                variant="secondary"
                                onPress={() => void copy()}
                                icon={
                                    <Feather name="copy" size={16} color={theme.colors.textPrimary} />
                                }
                                style={{ flex: 1 }}
                            />
                            <Button
                                label="Share"
                                variant="secondary"
                                onPress={() => void share()}
                                icon={
                                    <Feather
                                        name="share-2"
                                        size={16}
                                        color={theme.colors.textPrimary}
                                    />
                                }
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
                                    backgroundColor: acknowledged
                                        ? theme.colors.accentPrimary
                                        : 'transparent',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                {acknowledged ? (
                                    <Feather
                                        name="check"
                                        size={14}
                                        color={theme.colors.accentPrimaryFg}
                                    />
                                ) : null}
                            </View>
                            <Text variant="body" style={{ flex: 1 }}>
                                I have saved this somewhere safe
                            </Text>
                        </Pressable>
                    </ScrollView>

                    <View style={{ gap: theme.spacing.sm }}>
                        <Button
                            label="Done"
                            onPress={onDone}
                            size="lg"
                            fullWidth
                            disabled={!taken || !acknowledged}
                            accessibilityHint={
                                !taken
                                    ? 'Copy or share the token first'
                                    : !acknowledged
                                      ? 'Confirm that you have saved it'
                                      : undefined
                            }
                        />
                        {!taken || !acknowledged ? (
                            <Text
                                variant="caption"
                                tone="tertiary"
                                center
                                accessibilityLiveRegion="polite"
                            >
                                {!taken
                                    ? 'Copy or share the token, then tick the box.'
                                    : 'Tick the box to confirm you have saved it.'}
                            </Text>
                        ) : null}
                    </View>
                </View>
            </View>
        </Modal>
    );
}
