/**
 * "Add existing" — file something you already made into this Solution (the
 * web's SolutionAddResource). Pick a kind, then one of your own things of
 * that kind; the server is the authority on whether you may (editor on the
 * project AND owner of the item), and a refusal is shown in its own words
 * rather than guessed at by a filter that could drift from the rule.
 *
 * Approvals are not offered: an approval is a record stamped with its project
 * when it is raised, never re-filed.
 */

import React, { useState } from 'react';
import { FlatList, View, type ListRenderItem, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, FilterPills, InsetDivider, KindTile, ListRow, LoadingState, Sheet, Text } from '@/shared/ui';

import type { Candidate } from '../api/solutionEndpoints';
import { useFileResource } from '../hooks/mutations';
import { useCandidates } from '../hooks/solutionQueries';
import { MOVABLE_SECTIONS, sectionLabel, type SectionDef } from '../model/sections';

const candidateKey = (c: Candidate) => c.id;

function CandidateList({ section, filed, onPick }: { section: SectionDef; filed: ReadonlySet<string>; onPick: (c: Candidate) => void }) {
    const t = useTranslation();
    const candidates = useCandidates(section.kind);
    if (candidates.isLoading) return <LoadingState />;
    if (candidates.isError) {
        return <Banner tone="warning">{t('solutions.add_list_failed', 'That list could not be loaded. Try again shortly.')}</Banner>;
    }
    const rows = (candidates.data ?? []).filter((c) => !filed.has(`${section.kind}:${c.id}`));
    if (rows.length === 0) {
        return (
            <Text variant="body" tone="tertiary">
                {t('solutions.add_nothing_left', 'Nothing of yours left to add here.')}
            </Text>
        );
    }
    const renderItem: ListRenderItem<Candidate> = ({ item }) => (
        <ListRow
            title={item.label ?? t('solutions.depends_unnamed', 'Untitled')}
            leading={section.tile ? <KindTile kind={section.tile} size={24} /> : null}
            onPress={() => onPick(item)}
            chevron={false}
        />
    );
    return <FlatList data={rows} keyExtractor={candidateKey} renderItem={renderItem} ItemSeparatorComponent={InsetDivider} />;
}

export function AddResourceSheet({
    projectId,
    visible,
    filed,
    onClose,
}: {
    projectId: string;
    visible: boolean;
    /** `kind:id` of what is already in the Solution. */
    filed: ReadonlySet<string>;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [kind, setKind] = useState<string>(MOVABLE_SECTIONS[0]?.kind ?? 'app');
    const file = useFileResource(projectId, { onSuccess: onClose });
    const section = MOVABLE_SECTIONS.find((s) => s.kind === kind) ?? MOVABLE_SECTIONS[0];

    return (
        <Sheet visible={visible} onClose={onClose} title={t('projects.add_existing', 'Add existing')} scroll={false} tall>
            <View style={styles.body}>
                <FilterPills
                    value={kind}
                    onChange={(next) => {
                        file.reset();
                        setKind(next);
                    }}
                    scroll
                    accessibilityLabel={t('solutions.add_pick_kind', 'Choose a kind…')}
                    options={MOVABLE_SECTIONS.map((s) => ({ value: s.kind, label: sectionLabel(s.key, t) }))}
                />
                {file.error ? (
                    <Banner tone="error">{describeError(file.error).message || t('solutions.add_failed', 'That could not be added.')}</Banner>
                ) : null}
                {section ? (
                    <CandidateList
                        section={section}
                        filed={filed}
                        onPick={(c) => file.mutate({ kind: section.kind, itemId: c.id, attach: true })}
                    />
                ) : null}
            </View>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { flex: 1, gap: theme.spacing.md } satisfies ViewStyle,
});
