/**
 * The saved versions, newest first, grouped by what is live — Not live yet,
 * Live, Earlier (versionText.ts, the web Versions tab's History column).
 * Rows read what they need from a context, so the renderers are declared
 * once and the list can virtualise a long history.
 */

import React, { createContext, useContext } from 'react';
import { SectionList, View, type SectionListData, type SectionListRenderItem, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowVersionSummary } from '@/features/flow-editor/api';
import { Text } from '@/shared/ui';

import { VersionRow } from './VersionRow';
import { groupLabel, groupVersions } from './versionText';

const makeStyles = (theme: Theme) => ({
    section: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md, paddingBottom: theme.spacing.xs } satisfies ViewStyle,
    list: { paddingBottom: theme.spacing[8] } satisfies ViewStyle,
});

interface RowContext {
    current: number | null;
    restoringId: string | null;
    onOpen: (version: FlowVersionSummary) => void;
    onRestore: (version: FlowVersionSummary) => void;
}

const Rows = createContext<RowContext>({ current: null, restoringId: null, onOpen: () => undefined, onRestore: () => undefined });

function Row({ item }: { item: FlowVersionSummary }) {
    const ctx = useContext(Rows);
    return <VersionRow version={item} current={item.version === ctx.current} restoring={ctx.restoringId === item.id} onOpen={ctx.onOpen} onRestore={ctx.onRestore} />;
}

function SectionHeader({ title }: { title: string }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.section}>
            <Text variant="label" tone="tertiary">{title.toUpperCase()}</Text>
        </View>
    );
}

type Section = SectionListData<FlowVersionSummary, { key: string; title: string }>;
const renderItem: SectionListRenderItem<FlowVersionSummary, { key: string; title: string }> = ({ item }) => <Row item={item} />;
const renderSectionHeader = ({ section }: { section: Section }) => <SectionHeader title={section.title} />;
const keyOf = (v: FlowVersionSummary) => v.id;

export interface VersionListProps extends RowContext {
    versions: readonly FlowVersionSummary[];
    refreshing: boolean;
    onRefresh: () => void;
}

export function VersionList({ versions, refreshing, onRefresh, ...ctx }: VersionListProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const sections = groupVersions(versions).map((g) => ({ key: g.key, title: groupLabel(g.key, t), data: g.rows }));
    return (
        <Rows.Provider value={ctx}>
            <SectionList
                sections={sections}
                keyExtractor={keyOf}
                renderItem={renderItem}
                renderSectionHeader={renderSectionHeader}
                stickySectionHeadersEnabled={false}
                refreshing={refreshing}
                onRefresh={onRefresh}
                contentContainerStyle={styles.list}
                testID="versions-list"
            />
        </Rows.Provider>
    );
}
