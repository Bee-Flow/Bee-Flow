/** The inbox itself: sections by age, a hairline between rows, pull to refresh. */

import React from 'react';
import { RefreshControl, SectionList, StyleSheet } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Divider, Text } from '@/shared/ui';

import { NotificationRow } from './NotificationRow';
import type { NotificationSection } from '../model/sections';
import type { AppNotification } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingBottom: theme.spacing.xxl },
        heading: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg, paddingBottom: theme.spacing.xs },
    });

// Module-level: an inline separator is a new component type on every render.
function Separator() {
    const theme = useTheme();
    return <Divider inset={theme.spacing.lg} />;
}

const keyOf = (item: AppNotification) => item.id;

export interface NotificationListProps {
    sections: NotificationSection[];
    expandedId: string | null;
    refreshing: boolean;
    onRefresh: () => void;
    onOpen: (notification: AppNotification) => void;
    /** An expanded result row's button: go where the notification points. */
    onFollow: (notification: AppNotification) => void;
    onMarkRead: (id: string) => void;
    onDelete: (id: string) => void;
    /** The row whose delete is in flight. */
    deletingId: string | undefined;
}

export function NotificationList(props: NotificationListProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <SectionList<AppNotification, NotificationSection>
            sections={props.sections}
            keyExtractor={keyOf}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={styles.content}
            refreshControl={
                <RefreshControl
                    refreshing={props.refreshing}
                    onRefresh={props.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            renderSectionHeader={({ section }) => (
                <Text variant="label" tone="tertiary" accessibilityRole="header" style={styles.heading}>
                    {section.title.toUpperCase()}
                </Text>
            )}
            ItemSeparatorComponent={Separator}
            renderItem={({ item }) => (
                <NotificationRow
                    notification={item}
                    expanded={props.expandedId === item.id}
                    onPress={() => props.onOpen(item)}
                    onFollow={() => props.onFollow(item)}
                    onToggleRead={() => props.onMarkRead(item.id)}
                    onDelete={() => props.onDelete(item.id)}
                    deleting={props.deletingId === item.id}
                />
            )}
        />
    );
}
