/**
 * Install a Blueprint as a new Solution — from the catalogue, or from a file
 * someone handed over. The web's install wizard, for a phone: name it,
 * install it, then read what was and was not installed before opening it.
 *
 * The wizard's "Connect it up" and "Who can reach it" steps are not here:
 * nothing is connected on install (everything arrives as a draft), and the
 * wizard itself says anything left unanswered can be set in the Solution
 * afterwards — which on the phone is the Members tab and each item's screen.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Sheet, Text, TextField } from '@/shared/ui';

import { InstallReportView } from './InstallReportView';
import type { InstallSource } from '../api/packageEndpoints';
import { useInstallBlueprint } from '../hooks/packageMutations';
import type { InstallReport } from '../model/package';

export interface InstallChoice {
    source: InstallSource;
    /** What the person is installing, in words: the Blueprint's name, or the file's. */
    title: string;
    version: number | null;
}

export function InstallSheet({
    choice,
    onClose,
    onOpen,
}: {
    choice: InstallChoice | null;
    onClose: () => void;
    onOpen: (projectId: string) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [name, setName] = useState(choice?.title ?? '');
    const [report, setReport] = useState<InstallReport | null>(null);
    const install = useInstallBlueprint(setReport);

    const footer = report ? (
        <Button label={t('solutions.install_open', 'Open it')} onPress={() => onOpen(report.projectId)} fullWidth size="lg" />
    ) : (
        <Button
            label={t('solutions.install_confirm', 'Install')}
            onPress={() => choice && install.mutate({ source: choice.source, name })}
            loading={install.isPending}
            disabled={!choice}
            fullWidth
            size="lg"
            testID="install-confirm"
        />
    );

    return (
        <Sheet visible={choice !== null} onClose={onClose} title={t('solutions.install_title', 'Install a Blueprint')} footer={footer}>
            {report ? (
                <InstallReportView report={report} />
            ) : (
                <View style={styles.stack}>
                    <Text variant="body" weight="semibold">
                        {choice?.version
                            ? `${choice.title} · ${t('solutions.blueprint_version', 'Blueprint v{version}', { version: choice.version })}`
                            : (choice?.title ?? '')}
                    </Text>
                    {install.error ? <Banner tone="error">{describeError(install.error).message}</Banner> : null}
                    <TextField label={t('solutions.install_name', 'Name for this Solution')} value={name} onChangeText={setName} />
                    <Text variant="caption" tone="tertiary">
                        {t('solutions.catalogue_intro', 'Installing one of these creates a new Solution. Everything arrives as a draft.')}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.projects.install_connect_later', 'Tables, connections and approvers it needs are set in the Solution afterwards.')}
                    </Text>
                </View>
            )}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    stack: { gap: theme.spacing.md } satisfies ViewStyle,
});
