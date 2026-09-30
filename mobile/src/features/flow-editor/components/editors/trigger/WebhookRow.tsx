/**
 * One webhook URL of a trigger — the web's WebhookRow (Builder/WebhookPanel):
 * the address with Copy, "Copy as cURL" (a complete signed request, only
 * while the secret is on screen), Renew secret and Revoke, when it was last
 * used; and, right after a create or renew, the secret itself — masked,
 * revealable, copyable, shown this once.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { absoluteTime } from '@/features/automations';
import type { FlowWebhook } from '@/features/flow-editor/api';
import { Icon, IconButton, Text } from '@/shared/ui';

import { buildCurlSnippet, maskSecret } from './webhook';

export interface WebhookRowProps {
    row: FlowWebhook;
    secret: string | null;
    onRotate: () => void;
    onDelete: () => void;
    onCopied: (what: string) => void;
    disabled?: boolean;
}

function SecretLine({ secret, onCopied }: { secret: string; onCopied: (what: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [shown, setShown] = useState(false);
    return (
        <View style={styles.secret}>
            <Text variant="caption" tone="tertiary">
                {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English copy, not a secret */}
                {t('routines.settings.webhook_secret_once', 'You only see the secret now. Requests without a valid signature are refused.')}
            </Text>
            <View style={styles.line}>
                <Text variant="code" style={styles.value} numberOfLines={1} selectable>
                    {shown ? secret : maskSecret(secret)}
                </Text>
                <IconButton
                    icon={<Icon name={shown ? 'EyeOff' : 'Eye'} size={16} color={styles.glyph.color} />}
                    onPress={() => setShown((v) => !v)}
                    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- two i18n keys and their English labels, not a secret
                    accessibilityLabel={shown ? t('routines.settings.webhook_hide_secret', 'Hide secret') : t('routines.settings.webhook_show_secret', 'Show secret')}
                />
                <IconButton
                    icon={<Icon name="Copy" size={16} color={styles.glyph.color} />}
                    onPress={() => {
                        void Clipboard.setStringAsync(secret);
                        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English toast, not a secret; the secret itself is the prop copied on the line above
                        onCopied(t('mobile.flow.webhook.secret_copied', 'Secret copied'));
                    }}
                    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English label, not a secret
                    accessibilityLabel={t('routines.settings.webhook_copy_secret', 'Copy secret')}
                />
            </View>
        </View>
    );
}

export function WebhookRow({ row, secret, onRotate, onDelete, onCopied, disabled = false }: WebhookRowProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const copy = (text: string, what: string) => {
        void Clipboard.setStringAsync(text);
        onCopied(what);
    };
    return (
        <View style={styles.row}>
            <View style={styles.line}>
                <Text variant="code" style={styles.value} numberOfLines={2} selectable>
                    {row.url}
                </Text>
                <IconButton
                    icon={<Icon name="Copy" size={16} color={styles.glyph.color} />}
                    onPress={() => copy(row.url, t('mobile.flow.webhook.url_copied', 'Webhook URL copied'))}
                    accessibilityLabel={t('routines.settings.webhook_copy_url', 'Copy webhook URL')}
                />
                <IconButton
                    icon={<Icon name="Terminal" size={16} color={styles.glyph.color} />}
                    onPress={() => secret && copy(buildCurlSnippet(row.url, secret), t('mobile.flow.webhook.curl_copied', 'cURL command copied'))}
                    disabled={!secret}
                    accessibilityLabel={t('routines.settings.webhook_copy_curl', 'Copy as cURL')}
                    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English hint, not a secret
                    accessibilityHint={secret ? undefined : t('routines.settings.webhook_curl_needs_secret', 'Renew the secret first: it is only shown once')}
                />
                <IconButton
                    icon={<Icon name="RefreshCw" size={16} color={styles.glyph.color} />}
                    onPress={onRotate}
                    disabled={disabled}
                    accessibilityLabel={t('routines.settings.webhook_renew', 'Renew secret')}
                />
                <IconButton
                    tone="danger"
                    icon={<Icon name="Trash2" size={16} color={styles.glyph.color} />}
                    onPress={onDelete}
                    disabled={disabled}
                    accessibilityLabel={t('routines.settings.webhook_revoke', 'Revoke')}
                />
            </View>
            {secret ? <SecretLine secret={secret} onCopied={onCopied} /> : null}
            <Text variant="caption" tone="tertiary">
                {row.lastSeenAt
                    ? t('routines.settings.webhook_last_used', 'last used {when}', { when: absoluteTime(row.lastSeenAt) })
                    : t('routines.settings.webhook_never_used', 'never used')}
            </Text>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    line: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } satisfies ViewStyle,
    value: { flex: 1 },
    secret: { gap: theme.spacing.xs } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
});
