/**
 * The never-hide list — the one control that makes the shield leak by
 * design, so it sits behind a sheet and says exactly what it exempts: an
 * exact match, in every category, permanently.
 *
 * Closing the sheet adds a term that is still typed: the footer's Close is
 * the only way out, and it does not take the focus, so the field would never
 * see its own blur. The list is only a draft until the screen's Save.
 */

import React, { useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Sheet, TagInput, Text, ToggleRow, type TagInputHandle } from '@/shared/ui';

import { allowProblem } from '../model/terms';

export function AllowTermsSheet({
    visible,
    terms,
    publicOrgs,
    onTerms,
    onPublicOrgs,
    onClose,
}: {
    visible: boolean;
    terms: string[];
    publicOrgs: boolean;
    onTerms: (next: string[]) => void;
    onPublicOrgs: (on: boolean) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const input = useRef<TagInputHandle>(null);
    const close = () => {
        input.current?.commit();
        onClose();
    };
    const validate = (value: string): string | null => {
        const problem = allowProblem(terms, value);
        if (problem === 'empty') return t('admin.shield_allow_err_empty', 'Enter a name or word.');
        if (problem === 'too_long') return t('admin.shield_allow_err_long', 'Keep it under 120 characters.');
        if (problem === 'duplicate') {
            return t('admin.shield_allow_err_duplicate', 'That one is already on the list (upper and lower case, spaces and punctuation do not matter).');
        }
        return null;
    };
    return (
        <Sheet
            visible={visible}
            onClose={close}
            title={t('admin.shield_allow_title', 'Never hide these')}
            footer={<Button label={t('common.close', 'Close')} onPress={close} fullWidth />}
        >
            <View style={styles.body}>
                <Text variant="caption" tone="secondary">
                    {t('admin.shield_allow_desc', 'These are always left visible to the AI, in every category. They have to match exactly - allowing "Shell" does not allow "Shell Advies BV". Upper and lower case, spaces and punctuation do not matter.')}
                </Text>
                <ToggleRow
                    label={t('admin.shield_allow_public_title', 'Always allow well-known companies')}
                    description={t('admin.shield_allow_public_desc', 'A built-in list of large companies, household brands and government bodies — Microsoft, PostNL, the Belastingdienst and the like. These are public knowledge rather than personal data, and hiding them takes away context the AI needs.')}
                    value={publicOrgs}
                    onValueChange={onPublicOrgs}
                    gutter={false}
                    testID="allow-public"
                />
                <TagInput
                    ref={input}
                    values={terms}
                    onChange={onTerms}
                    placeholder={t('admin.shield_allow_placeholder', 'Company, product or brand name')}
                    validate={validate}
                    testID="allow-input"
                />
            </View>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
    });
