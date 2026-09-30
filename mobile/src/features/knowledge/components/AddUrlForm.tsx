/**
 * The link door of the add sheet: one web address, checked before it is sent.
 * Controlled by AddSourceBody, so what was typed survives a trip to the menu.
 * An address typed without a scheme gets `https://` (model/webAddress), and
 * the hint says so.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, TextField } from '@/shared/ui';

import { isWebAddress, withScheme } from '../model/webAddress';

const makeStyles = (theme: Theme) => StyleSheet.create({ form: { gap: theme.spacing.lg } });

export interface UrlDraft {
    url: string;
    error: string | null;
}

export function AddUrlForm({
    draft,
    onChange,
    busy,
    onUrl,
    onBack,
}: {
    draft: UrlDraft;
    onChange: (next: UrlDraft) => void;
    busy: boolean;
    onUrl: (url: string) => void;
    onBack: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const hint = [
        t('mobile.knowledge.url_scheme_hint', 'You can leave out https:// — it is added for you.'),
        t('mobile.knowledge.link_hint', 'Bee Flow fetches the page on the server and keeps the text, not the page.'),
    ].join(' ');

    return (
        <View style={styles.form}>
            <TextField
                label={t('mobile.knowledge.link_address', 'Web address')}
                value={draft.url}
                onChangeText={(v) => onChange({ url: v, error: null })}
                error={draft.error}
                placeholder={t('mobile.knowledge.link_placeholder', 'https://example.com/report')}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                autoFocus
                hint={hint}
            />
            <Button
                label={t('mobile.knowledge.link_add', 'Add link')}
                fullWidth
                loading={busy}
                onPress={() => {
                    // The server screens for SSRF, but an address that is not
                    // one is worth catching before a round trip.
                    if (!isWebAddress(draft.url)) {
                        onChange({
                            ...draft,
                            error: t('mobile.knowledge.link_invalid', 'Enter a web address, such as example.com/report.'),
                        });
                        return;
                    }
                    onUrl(withScheme(draft.url));
                    onChange({ ...draft, url: '' });
                }}
            />
            <Button label={t('common.back', 'Back')} variant="ghost" onPress={onBack} />
        </View>
    );
}
