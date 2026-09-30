/**
 * Studio → Playbooks: the list (the web's PlaybooksStudio). A playbook is a
 * phased AI build the person watches and consents to phase by phase; opening
 * one goes to its run screen. `startNew` opens the New sheet at once — the
 * route passes it for /playbooks?new=1, which is where the web's
 * /app/studio/playbooks/new and the Studio New menu land.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { Button, Screen, ScreenHeader, Text } from '@/shared/ui';

import { NewPlaybookSheet } from '../components/NewPlaybookSheet';
import { PlaybookRow } from '../components/PlaybookRow';
import { usePlaybooks } from '../hooks/queries';

export function PlaybooksScreen({ startNew = false }: { startNew?: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const query = usePlaybooks();
    const canManage = useHasPermission('manage_apps');
    const [creating, setCreating] = useState(startNew);
    const open = (id: string) => router.push(`/playbooks/${encodeURIComponent(id)}`);
    const newButton = canManage ? (
        <Button size="sm" iconName="Plus" label={t('playbooks.new', 'New playbook')} onPress={() => setCreating(true)} testID="playbook-new" />
    ) : null;

    return (
        <Screen edges={['bottom']}>
            <ScreenHeader title={t('playbooks.title', 'Playbooks')} actions={newButton} />
            <View style={styles.intro}>
                <Text variant="caption" tone="secondary">
                    {t('playbooks.intro', 'Watch the AI build a working set — a table, an automation that fills it, an app on top — and say yes after every phase.')}
                </Text>
            </View>
            <QueryList
                query={query}
                keyExtractor={(pb) => pb.id}
                renderItem={({ item }) => <PlaybookRow playbook={item} onOpen={open} />}
                empty={{
                    icon: 'Clapperboard',
                    title: t('playbooks.empty_title', 'No playbooks yet'),
                    message: canManage
                        ? t('playbooks.empty_body', 'Start one and watch: the table appears, the automation takes shape, the rows arrive, the app builds itself — you say "go on" between the phases.')
                        : t('playbooks.empty_cannot_create', 'Playbooks are started by whoever may build apps and automations here. Ask an administrator.'),
                    actionLabel: canManage ? t('playbooks.new', 'New playbook') : undefined,
                    onAction: canManage ? () => setCreating(true) : undefined,
                    actionIcon: 'Plus',
                }}
            />
            {canManage ? (
                <NewPlaybookSheet
                    visible={creating}
                    onClose={() => setCreating(false)}
                    onCreated={(pb) => {
                        setCreating(false);
                        open(pb.id);
                    }}
                />
            ) : null}
        </Screen>
    );
}

const makeStyles = (theme: Theme) => ({
    intro: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[3] },
});
