/**
 * Everything above the chats in the drawer's one scrolling list: the
 * secondary nav, Projects, My Agents, and the CHATS heading with its count.
 *
 * A component the list is handed by reference (ListHeaderComponent), reading
 * the drawer's state from context: an element built in DrawerBody's render
 * was a new header on every render, which re-rendered the SectionList and,
 * through its fresh renderItem, every chat row it had mounted.
 */

import React from 'react';
import { View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConversations } from '@/features/chat';
import { NavRow, SectionLabel, Text } from '@/shared/ui';

import { MyAgentsSection } from './MyAgentsSection';
import { ProjectsSection } from './ProjectsSection';
import { SecondaryNav } from './SecondaryNav';
import { useDrawerActions } from '../hooks/drawerActions';
import { useDrawerView } from '../hooks/drawerView';
import { offersProjects } from '../model/gates';

export function DrawerListHeader() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const { access } = useDrawerView();
    const count = useConversations().data?.length ?? 0;
    return (
        <>
            <SecondaryNav />
            {offersProjects(access) ? <ProjectsSection /> : null}
            <MyAgentsSection />
            <View style={styles.divider} />
            <View style={styles.chatsHeading}>
                <SectionLabel label={t('sidebar.chats', 'Chats')} style={styles.flex} />
                {count > 0 ? (
                    <Text variant="label" tone="tertiary" style={styles.count}>
                        {count}
                    </Text>
                ) : null}
            </View>
            {count === 0 ? (
                <Text variant="caption" tone="tertiary" style={styles.empty}>
                    {t('sidebar.no_chats_yet', 'No chats yet')}
                </Text>
            ) : null}
        </>
    );
}

/** Below the chats: the whole list, once there is one. */
export function DrawerListFooter() {
    const t = useTranslation();
    const { push } = useDrawerActions();
    const count = useConversations().data?.length ?? 0;
    if (count === 0) return null;
    return <NavRow label={t('mobile.chats.title', 'All conversations')} icon="MessageCircle" onPress={() => push('/chats')} />;
}

const makeStyles = (theme: Theme) => ({
    divider: {
        height: 1,
        backgroundColor: theme.colors.borderSubtle,
        marginHorizontal: theme.spacing[3],
        marginVertical: theme.spacing[1.5],
    } satisfies ViewStyle,
    chatsHeading: { flexDirection: 'row', alignItems: 'center' } satisfies ViewStyle,
    flex: { flex: 1 } satisfies ViewStyle,
    count: { paddingRight: theme.spacing[3], fontVariant: ['tabular-nums'] } satisfies TextStyle,
    empty: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2] } satisfies TextStyle,
});
