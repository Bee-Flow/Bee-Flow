/**
 * A URL, and the three things a phone can honestly do with one.
 *
 * Copy and Share are obvious. "Open" is the interesting one: this app has no
 * WebView and is not getting one, so there is no in-app preview of a published
 * page or a hosted form — the whole point of both is how they look in a real
 * browser, and a native re-render would be a different artefact wearing the
 * page's name. expo-web-browser hands it to Chrome Custom Tabs instead, which
 * is the same browser, with the same cookies, showing the same thing the
 * recipient will see.
 *
 * `createTask: false` keeps the tab attached to this app's task rather than
 * spawning a second entry in the Android recents list, so Back returns here.
 */

import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { Share, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Button } from '../../../ui/Button';
import { describeError } from '../../../ui/Feedback';
import { Text } from '../../../ui/Text';
import { useToast } from '../../../ui/Toast';

export function LinkActions({
    url,
    shareTitle,
    /** Shown above the buttons. Pass false for a row that already shows it. */
    showUrl = true,
    /** Hidden for a link that only resolves inside a browser session. */
    allowOpen = true,
}: {
    url: string;
    shareTitle?: string;
    showUrl?: boolean;
    allowOpen?: boolean;
}) {
    const theme = useTheme();
    const { toast } = useToast();

    const copy = async () => {
        await Clipboard.setStringAsync(url);
        toast('Link copied', 'success');
    };

    const share = async () => {
        try {
            await Share.share({ message: url, title: shareTitle });
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    const open = async () => {
        try {
            await WebBrowser.openBrowserAsync(url, { createTask: false });
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    return (
        <View style={{ gap: theme.spacing.md }}>
            {showUrl ? (
                <Text variant="code" tone="secondary" selectable numberOfLines={2}>
                    {url}
                </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                <Button
                    label="Copy"
                    variant="secondary"
                    onPress={() => void copy()}
                    icon={<Feather name="copy" size={16} color={theme.colors.textPrimary} />}
                    style={{ flex: 1 }}
                    accessibilityHint="Copies the link to the clipboard"
                />
                <Button
                    label="Share"
                    variant="secondary"
                    onPress={() => void share()}
                    icon={<Feather name="share-2" size={16} color={theme.colors.textPrimary} />}
                    style={{ flex: 1 }}
                />
                {allowOpen ? (
                    <Button
                        label="Open"
                        variant="secondary"
                        onPress={() => void open()}
                        icon={
                            <Feather name="external-link" size={16} color={theme.colors.textPrimary} />
                        }
                        style={{ flex: 1 }}
                        accessibilityHint="Opens the link in your browser"
                    />
                ) : null}
            </View>
        </View>
    );
}
