/**
 * A secret shown exactly once, in a sheet you cannot dismiss by accident.
 *
 * The MCP token is `bfmcp.<userId>.<64 hex>` and only its random half is ever
 * stored (routes/mcpServer.js). Nobody can show it again, and minting a
 * replacement revokes the one that just scrolled off the screen. So Done stays
 * disabled until the person has both copied or shared the token AND ticked
 * the acknowledgement: two deliberate acts is the right amount of friction for
 * a value that cannot be recovered.
 *
 * Same reasoning, and deliberately the same shape, as the recovery-key screen
 * in onboarding. Rebuilt rather than imported so neither feature owns the
 * other's copy.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Modal, ScrollView, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Card, CheckRow, Icon, Text, useToast } from '@/shared/ui';

import { SecretDone } from './SecretDone';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000099' },
        panel: {
            backgroundColor: theme.colors.bgSecondary,
            borderTopLeftRadius: theme.radii.xl,
            borderTopRightRadius: theme.radii.xl,
            paddingTop: theme.spacing.xl,
            paddingHorizontal: theme.spacing.lg,
            maxHeight: '90%',
            gap: theme.spacing.lg,
        },
        scroll: { gap: theme.spacing.lg },
        intro: { gap: theme.spacing.sm },
        code: { letterSpacing: 0.5 },
        actions: { flexDirection: 'row', gap: theme.spacing.md },
        half: { flex: 1 },
    });

/**
 * Whether the secret has been taken away and acknowledged — reset whenever a
 * new secret arrives. Adjusted DURING render, React's own recipe for "reset
 * state when a prop changes": an effect would render one frame with the new
 * secret and the old tick, and that frame is exactly where a fast tap
 * dismisses a token nobody has read.
 */
function useSecretState(secret: string | null, shareTitle: string) {
    const { toast } = useToast();
    const [taken, setTaken] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);
    const [lastSecret, setLastSecret] = useState(secret);
    // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack -- resets local UI state when a new secret prop arrives; both values are already on this device and nothing is authenticated here
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

    return { taken, acknowledged, toggle: () => setAcknowledged((v) => !v), copy, share };
}

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
    const styles = useThemedStyles(makeStyles);
    const insets = useSafeAreaInsets();
    const state = useSecretState(secret, shareTitle);
    const t = useTranslation();

    return (
        // Android's back button must NOT close this: leaving without the token
        // cannot happen by reflex. Done is the only way out.
        <Modal visible={visible && secret !== null} transparent animationType="slide" onRequestClose={() => undefined} statusBarTranslucent>
            <View style={styles.backdrop}>
                <View style={[styles.panel, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
                    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                        <View style={styles.intro}>
                            <Text variant="heading" center accessibilityRole="header">
                                {title}
                            </Text>
                            <Text variant="body" tone="secondary" center>
                                {description}
                            </Text>
                        </View>
                        <Banner tone="warning" icon="TriangleAlert">
                            You will not be shown this again. Put it where the client that needs it
                            can read it before you continue.
                        </Banner>
                        <Card padded>
                            <Text variant="code" selectable style={styles.code}>
                                {secret ?? ''}
                            </Text>
                        </Card>
                        <View style={styles.actions}>
                            <Button
                                label="Copy"
                                variant="secondary"
                                onPress={() => void state.copy()}
                                icon={<Icon name="Copy" size={16} color={theme.colors.textPrimary} />}
                                style={styles.half}
                            />
                            <Button
                                label="Share"
                                variant="secondary"
                                onPress={() => void state.share()}
                                icon={<Icon name="Share2" size={16} color={theme.colors.textPrimary} />}
                                style={styles.half}
                            />
                        </View>
                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English copy, not a secret */}
                        <CheckRow checked={state.acknowledged} onToggle={state.toggle} label={t('mobile.secret.saved_safe', 'I have saved this somewhere safe')} />
                    </ScrollView>
                    <SecretDone taken={state.taken} acknowledged={state.acknowledged} onDone={onDone} />
                </View>
            </View>
        </Modal>
    );
}
