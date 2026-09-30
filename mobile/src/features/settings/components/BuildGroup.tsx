/**
 * This build, and the server it talks to — the two halves of a precise bug
 * report, versioned independently and very often the actual mismatch. The
 * values are selectable, and copyable in one tap. The server this APK points
 * at out of the box is here too: none is deliberate for a self-host-first
 * product, which never quietly points a self-hoster at the hosted service.
 */

import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { getServerUrl, MIN_SERVER_BUILD } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Group, Icon, InfoRow, NoteRow, useToast } from '@/shared/ui';

import { useServerHealth, useServerSupport } from '../hooks/queries';
import { supportLabel, versionDetails, type BuildInfo } from '../model/buildInfo';

export function BuildGroup({ info }: { info: BuildInfo }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const { toast } = useToast();
    const server = getServerUrl();
    const health = useServerHealth({ staleTime: 60_000 });
    const support = useServerSupport();
    const compatibility = supportLabel(support.data);
    const notReported = t('mobile.settings.not_reported', 'Not reported');

    const copy = () => {
        void Clipboard.setStringAsync(
            versionDetails(info, server, health.data?.appVersion, compatibility),
        );
        toast(t('mobile.settings.version_copied', 'Version details copied'), 'success');
    };

    return (
        <Group
            title={t('mobile.settings.this_build', 'This build')}
            footer={t('mobile.settings.build_footer', 'Include these details when you report a problem: the app and the server are updated separately, and a mismatch between them is a common cause.')}
        >
            <InfoRow label={t('mobile.settings.app_version', 'App version')} value={`${info.version} (${info.build})`} selectable />
            <InfoRow label={t('mobile.settings.build_profile', 'Build profile')} value={info.profile} />
            <InfoRow label={t('mobile.settings.app_commit', 'App commit')} value={info.sha} selectable />
            <InfoRow label={t('mobile.settings.server_version', 'Server version')} value={health.data?.appVersion || notReported} selectable />
            <InfoRow label={t('mobile.settings.server', 'Server')} value={server ?? t('mobile.settings.not_configured', 'Not configured')} selectable />
            <InfoRow label={t('mobile.settings.server_compatibility', 'Server compatibility')} value={compatibility} />
            <InfoRow
                label={t('mobile.settings.default_server', 'Default server')}
                value={info.defaultServerUrl || t('mobile.settings.no_default_server', 'None, a new install asks')}
                selectable
            />
            {support.data?.level === 'outdated' ? (
                <NoteRow>
                    {t('mobile.settings.server_outdated', 'This server looks older than this app expects (a build from {min} or later). Update the server before reporting a problem in the app.', { min: MIN_SERVER_BUILD })}
                </NoteRow>
            ) : null}
            <View style={styles.action}>
                <Button
                    label={t('mobile.settings.copy_version', 'Copy version details')}
                    variant="secondary"
                    onPress={copy}
                    icon={<Icon name="Copy" size={16} color={theme.colors.textPrimary} />}
                    fullWidth
                />
            </View>
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        action: { padding: theme.spacing.lg },
    });
