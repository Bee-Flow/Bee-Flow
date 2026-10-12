/**
 * Studio → Runs & log (the web's RunsStudio): every time an automation fired, what
 * started it, what it did and what went wrong. The scope switch sits above a
 * virtualised, paged list whose header carries the "Now running" card and the
 * filters; a row opens the run on the automation's own run screen.
 *
 * It opens on MY RUNS on every visit — a remembered scope is state that
 * outlives a permission. Both scopes are always offered and the server
 * refuses in words: a refused organisation list shows that sentence and a way
 * back, and never quietly becomes "my runs".
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Screen, ScreenHeader, Segmented, Text } from '@/shared/ui';

import { NowRunningStrip } from '../components/NowRunningStrip';
import { RunFilterBar } from '../components/RunFilterBar';
import { RunLogList } from '../components/RunLogList';
import { useNowRunning, useRunFacets, useRunLog, useRunLogLive, useRunAutomations } from '../hooks/queries';
import { DEFAULT_FILTERS, type RunFilters } from '../model/filters';
import type { RunScope } from '../model/types';

/** The switch, the refusal (with the way back) and the org scope's honesty line. */
function ScopeBlock({ scope, onScope, refused }: { scope: RunScope; onScope: (s: RunScope) => void; refused: unknown }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.top}>
            <Text variant="caption" tone="secondary">
                {t('runs.intro', 'Every time an automation fired: what started it, what it did, and what went wrong. Opening a run shows it step by step.')}
            </Text>
            <Segmented
                fullWidth
                value={scope}
                onChange={onScope}
                accessibilityLabel={t('runs.scope_label', 'Whose runs')}
                options={[
                    { value: 'mine', label: t('runs.scope_mine', 'My runs') },
                    { value: 'org', label: t('runs.scope_org', 'Organisation') },
                ]}
            />
            {refused ? (
                <Banner
                    tone="error"
                    action={<Button size="sm" variant="secondary" label={t('runs.scope_back_to_mine', 'Show my runs')} onPress={() => onScope('mine')} />}
                >
                    {describeError(refused).message || t('runs.scope_failed', 'Could not read this scope.')}
                </Banner>
            ) : null}
            {scope === 'org' && !refused ? (
                <Text variant="label" tone="tertiary" testID="runs-org-not-live">
                    {t('runs.org_not_live', "The organisation's runs do not update by themselves — refresh to see new ones. Only the person who started a run can open it.")}
                </Text>
            ) : null}
        </View>
    );
}

export function RunsLogScreen() {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const [scope, setScope] = useState<RunScope>('mine');
    const [filters, setFilters] = useState<RunFilters>(DEFAULT_FILTERS);
    const list = useRunLog(scope, filters);
    const facets = useRunFacets(scope, filters);
    const automations = useRunAutomations(scope, filters);
    const strip = useNowRunning(scope);
    useRunLogLive(scope, filters);
    const refused = scope === 'org' && (list.isError || strip.isError) ? (list.error ?? strip.error) : null;
    const header = (
        <View style={styles.header}>
            <NowRunningStrip
                facets={strip.data}
                loading={strip.isLoading}
                failed={strip.isError}
                onOpen={scope === 'mine' ? (id) => router.push(`/automations/${encodeURIComponent(id)}`) : null}
            />
            <RunFilterBar filters={filters} onChange={setFilters} facets={facets.data} automationFacets={automations.data} />
        </View>
    );
    return (
        <Screen edges={['bottom']}>
            <ScreenHeader title={t('runs.title', 'Runs & log')} />
            <ScopeBlock scope={scope} onScope={setScope} refused={refused} />
            {refused ? null : (
                <RunLogList
                    scope={scope}
                    list={list}
                    header={header}
                    onRefresh={() => Promise.all([list.refetch(), facets.refetch(), automations.refetch(), strip.refetch()])}
                />
            )}
        </Screen>
    );
}

const makeStyles = (theme: Theme) => ({
    top: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[3], gap: theme.spacing[2.5] },
    header: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[3], gap: theme.spacing[3] },
});
