/**
 * The two lists of the Access screen, virtualised because the capability
 * registry grows with every MCP server and custom integration:
 *   - GrantsList: every capability of the chosen kinds, with who holds it;
 *     a row opens that capability's screen (access/[id]).
 *   - CeilingList: the web's CeilingReadOnly — what the organisation has
 *     access to, per kind, read-only.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { SectionList, StyleSheet, type SectionListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, InsetDivider, ListRow, Text } from '@/shared/ui';

import type { Capability } from '../model/types';

export interface CapabilityItem {
    cap: Capability;
    summary: string;
    locked: boolean;
}

export interface ListSection<T> {
    title: string;
    data: T[];
    /** Said under the heading when the section is empty. */
    emptyNote?: string;
}

function CapabilityRow({ item }: { item: CapabilityItem }) {
    const router = useRouter();
    const theme = useTheme();
    return (
        <ListRow
            testID={`cap-${item.cap.id}`}
            title={item.cap.name || item.cap.id}
            subtitle={item.summary}
            trailing={item.locked ? <Icon name="Lock" size={16} color={theme.colors.textMuted} /> : undefined}
            chevron={!item.locked}
            onPress={() => router.push(`/org/access/${encodeURIComponent(item.cap.id)}`)}
        />
    );
}

function CeilingRow({ item }: { item: Capability }) {
    return <ListRow title={item.name || item.id} subtitle={item.description || undefined} chevron={false} />;
}

function SectionHeader({ section }: { section: ListSection<unknown> }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <>
            <Text variant="label" tone="tertiary" style={styles.header}>
                {`${section.title.toUpperCase()} · ${section.data.length}`}
            </Text>
            {section.data.length === 0 && section.emptyNote ? (
                <Text variant="caption" tone="tertiary" style={styles.note}>
                    {section.emptyNote}
                </Text>
            ) : null}
        </>
    );
}

const renderCapability: SectionListRenderItem<CapabilityItem, ListSection<CapabilityItem>> = ({ item }) => (
    <CapabilityRow item={item} />
);
const renderCeiling: SectionListRenderItem<Capability, ListSection<Capability>> = ({ item }) => (
    <CeilingRow item={item} />
);
const capabilityKey = (item: CapabilityItem) => item.cap.id;
const ceilingKey = (item: Capability) => item.id;
const renderHeader = ({ section }: { section: ListSection<unknown> }) => <SectionHeader section={section} />;

export function GrantsList({
    sections,
    header,
}: {
    sections: ListSection<CapabilityItem>[];
    header: React.ReactElement;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <SectionList
            sections={sections}
            keyExtractor={capabilityKey}
            renderItem={renderCapability}
            renderSectionHeader={renderHeader}
            ItemSeparatorComponent={InsetDivider}
            ListHeaderComponent={header}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={styles.content}
        />
    );
}

export function CeilingList({
    sections,
    header,
}: {
    sections: ListSection<Capability>[];
    header: React.ReactElement;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const withNotes = sections.map((s) => ({
        ...s,
        emptyNote: t('mobile.orgPeople.ceiling_none', 'Your organisation has no access in this category.'),
    }));
    return (
        <SectionList
            sections={withNotes}
            keyExtractor={ceilingKey}
            renderItem={renderCeiling}
            renderSectionHeader={renderHeader}
            ItemSeparatorComponent={InsetDivider}
            ListHeaderComponent={header}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={styles.content}
        />
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg, paddingBottom: theme.spacing.xs },
        note: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        content: { paddingBottom: theme.spacing.xxl },
    });
