/**
 * "Needs attention", whole — where the hub card's "Show all" goes. Every
 * finding with the producer's own sentence, its remediation and "Show me",
 * under one heading per group (source and code, model/attentionGroups), with
 * the lines the web draws: whether the list is the whole picture, how many
 * were found but not sent, and that some checks run only for the people who
 * can act on them.
 */

import React from 'react';
import { SectionList, View, type SectionListData, type SectionListRenderItem, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, ErrorState, LoadingState, Screen, ScreenHeader, SectionLabel, Text } from '@/shared/ui';

import { AttentionRowView } from '../components/AttentionRowView';
import { useStudioAttention } from '../hooks/queries';
import { useStudioNav } from '../hooks/useStudioNav';
import type { AttentionRow, StudioAttention } from '../model/api';
import { groupAttention, sourceWords, type AttentionGroup } from '../model/attentionGroups';
import { attentionLineText } from '../model/attentionText';
import { nOf } from '../model/plural';

interface GroupSection {
    key: string;
    group: AttentionGroup;
    data: AttentionRow[];
}

const keyOf = (row: AttentionRow, i: number) => `${row.source}:${row.code}:${row.targetId ?? i}`;
const renderRow: SectionListRenderItem<AttentionRow, GroupSection> = ({ item }) => <AttentionRowView row={item} />;

/** Headed by its source: each row under it says its own sentence. */
function GroupHeading({ group }: { group: AttentionGroup }) {
    const t = useTranslation();
    const words = sourceWords(group);
    const title = 'key' in words ? t(words.key, words.fallback) : words.text;
    return <SectionLabel label={group.rows.length > 1 ? `${title} · ${group.rows.length}` : title} />;
}

const renderHeading = ({ section }: { section: SectionListData<AttentionRow, GroupSection> }) => <GroupHeading group={section.group} />;

function Notes({ attention }: { attention: StudioAttention }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const line = attentionLineText(attention, t);
    const more = attention.total - attention.rows.length;
    const notes = [
        line,
        more > 0 ? nOf(t, 'studio.attention.more', more, ['{count} more was found but is not shown here.', '{count} more were found but are not shown here.']) : null,
        attention.gated.length > 0 ? t('studio.attention.skipped', 'Some checks only run for the people who can act on them.') : null,
    ].filter((note): note is string => Boolean(note));
    if (notes.length === 0) return null;
    return (
        <View style={styles.notes} testID="studio-attention-notes">
            {notes.map((note) => (
                <Text key={note} variant="caption" tone={attention.complete ? 'tertiary' : 'secondary'}>
                    {note}
                </Text>
            ))}
        </View>
    );
}

function Body({ attention }: { attention: StudioAttention }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const sections: GroupSection[] = groupAttention(attention.rows).map((group) => ({ key: group.key, group, data: group.rows }));
    return (
        <SectionList
            sections={sections}
            keyExtractor={keyOf}
            renderItem={renderRow}
            renderSectionHeader={renderHeading}
            stickySectionHeadersEnabled={false}
            ListHeaderComponent={<Notes attention={attention} />}
            ListEmptyComponent={attention.complete ? <EmptyState title={t('studio.attention.empty', 'Nothing needs attention.')} /> : null}
            contentContainerStyle={styles.content}
            testID="studio-attention-list"
        />
    );
}

/** Access has answered: until then "not for you" would flash for someone it is for. */
function accessKnown(nav: ReturnType<typeof useStudioNav>): boolean {
    return nav.access.permissionsLoaded && nav.access.entitlementsState !== 'loading';
}

export function AttentionScreen() {
    const t = useTranslation();
    const nav = useStudioNav();
    const query = useStudioAttention(nav.canSee);
    let body: React.ReactNode;
    if (query.data) body = <Body attention={query.data} />;
    else if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    // Reached from the A–Z list by anyone: without Studio the query never
    // runs, and a spinner that never ends said nothing.
    else if (!nav.canSee && accessKnown(nav)) {
        body = (
            <EmptyState
                icon="TriangleAlert"
                title={t('mobile.studio.attention_unavailable', 'Studio is not part of your account')}
                message={t('mobile.studio.attention_unavailable_hint', 'This list shows what needs fixing in Studio. An administrator or a builder in your organisation sees it.')}
            />
        );
    } else body = <LoadingState />;
    return (
        <Screen edges={['top']}>
            <ScreenHeader title={t('studio.attention.title', 'Needs attention')} showBack />
            {body}
        </Screen>
    );
}

const makeStyles = (theme: Theme) => ({
    content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl } satisfies ViewStyle,
    notes: { gap: theme.spacing[1], paddingBottom: theme.spacing[2] } satisfies ViewStyle,
});
