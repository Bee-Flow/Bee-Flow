/**
 * Every response, newest first, a page at a time from the answers table
 * itself — narrowed to one question's answers by "See all answers". Each
 * opens its ResponseSheet.
 *
 * The list can grow without bound, so its renderItem is declared at module
 * level (ARCHITECTURE, Performance) and reads what a row needs — the
 * questions, the yes/no words and the open handler — from RowContext.
 */

import React, { createContext, useContext, useMemo } from 'react';
import { FlatList, View, type ListRenderItem, type ViewStyle } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useAnswerRows } from '@/features/forms/hooks/answers';
import { answerText, isAnswered } from '@/features/forms/model/answersView';
import type { AnswerQuestion, AnswerRow } from '@/features/forms/model/answerTypes';
import { Button, Divider, ErrorState, ListRow, Sheet, Spinner, Text } from '@/shared/ui';

import type { OpenResponse } from './ResponseSheet';

interface RowContextValue {
    questions: readonly AnswerQuestion[];
    words: { yes: string; no: string; response: string };
    onOpen: (r: OpenResponse) => void;
}

const RowContext = createContext<RowContextValue>({ questions: [], words: { yes: '', no: '', response: '' }, onOpen: () => undefined });

/** A row of the table as a list line: its first three answered live questions. */
function rowLine(row: AnswerRow, questions: readonly AnswerQuestion[], words: { yes: string; no: string }): string {
    return questions
        .filter((q) => !q.retired && isAnswered(row[q.key]))
        .slice(0, 3)
        .map((q) => answerText(row[q.key], q.columnType, words))
        .join(' · ');
}

const createdAt = (row: AnswerRow): string | null => (typeof row.created_at === 'string' ? row.created_at : null);

function ResponseLine({ row }: { row: AnswerRow }) {
    const { questions, words, onOpen } = useContext(RowContext);
    return (
        <ListRow
            title={rowLine(row, questions, words) || words.response}
            meta={timeAgo(createdAt(row))}
            onPress={() => onOpen({ rowId: row.id, submittedAt: createdAt(row), runId: typeof row.run_id === 'string' ? row.run_id : null, by: null })}
        />
    );
}

const renderItem: ListRenderItem<AnswerRow> = ({ item }) => <ResponseLine row={item} />;
const keyOf = (row: AnswerRow) => row.id;

export interface AllResponsesSheetProps {
    datatableId: string;
    visible: boolean;
    focus: AnswerQuestion | null;
    questions: readonly AnswerQuestion[];
    onClearFocus: () => void;
    onClose: () => void;
    onOpen: (r: OpenResponse) => void;
}

export function AllResponsesSheet({ datatableId, visible, focus, questions, onClearFocus, onClose, onOpen }: AllResponsesSheetProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const rows = useAnswerRows(visible ? datatableId : '', focus?.key ?? null);
    const yes = t('forms.answers.q_yes', 'Yes');
    const no = t('forms.answers.q_no', 'No');
    const response = t('forms.answers.drawer_title', 'Response');
    const context = useMemo(() => ({ questions, words: { yes, no, response }, onOpen }), [questions, yes, no, response, onOpen]);
    const data = (rows.data?.pages ?? []).flatMap((p) => p.rows);
    return (
        <Sheet visible={visible} onClose={onClose} title={t('forms.answers.all_title', 'All responses')} tall scroll={false}>
            {focus ? (
                <View style={styles.focus}>
                    <Text variant="caption" tone="secondary">
                        {t('forms.answers.all_filtered', 'Showing the responses that answered “{label}”.', { label: focus.label })}
                    </Text>
                    <Button size="sm" variant="ghost" label={t('forms.answers.all_clear', 'Show every response')} onPress={onClearFocus} />
                </View>
            ) : null}
            {rows.isError ? <ErrorState error={rows.error} onRetry={() => void rows.refetch()} /> : null}
            <RowContext.Provider value={context}>
                <FlatList
                    data={data}
                    keyExtractor={keyOf}
                    ItemSeparatorComponent={Divider}
                    onEndReached={() => rows.hasNextPage && !rows.isFetchingNextPage && void rows.fetchNextPage()}
                    ListFooterComponent={rows.isFetching ? <Spinner /> : null}
                    renderItem={renderItem}
                />
            </RowContext.Provider>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    focus: { gap: theme.spacing.xs, paddingBottom: theme.spacing.sm } satisfies ViewStyle,
});
