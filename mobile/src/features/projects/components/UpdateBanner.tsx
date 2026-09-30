/**
 * "There is a newer version" — and the honest silence around it (the web's
 * UpdateBanner). `unknown` shows a line, because without it the ABSENCE of a
 * banner would mean both "up to date" and "we could not check". Only the
 * owner can apply an update (the route's own rule), so only they get the
 * button; the news itself is for everyone.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button } from '@/shared/ui';

import { Strip } from './Strip';
import type { Availability } from '../model/upgrade';

export function UpdateBanner({ availability, onOpen }: { availability: Availability | null; onOpen?: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (availability?.state === 'unknown') {
        return (
            <View style={styles.wrap}>
                <Strip tone="muted" icon="CircleQuestionMark" testID="solution-update-unknown">
                    {t('solutions.update_unknown', 'Whether there is a newer version of this Solution could not be checked, so this is not "up to date".')}
                </Strip>
            </View>
        );
    }
    if (availability?.state !== 'available') return null;
    return (
        <View style={styles.wrap}>
            <Banner
                tone="warning"
                icon="ArrowUp"
                action={onOpen ? <Button label={t('solutions.update_see_plan', 'See what would change')} size="sm" variant="secondary" onPress={onOpen} /> : undefined}
            >
                {t('solutions.update_available', 'Version {version} of the Blueprint this Solution came from is available. You have version {installed}.', {
                    version: availability.latestVersion,
                    installed: availability.installedVersion,
                })}
            </Banner>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ wrap: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md } });
