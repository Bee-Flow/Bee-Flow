/**
 * What Bee Flow remembers about you, as a sheet on the Library tab.
 *
 * Memory is the part of an AI product people are most entitled to be uneasy
 * about, so this is built around inspection rather than around adding: every
 * row is readable in full, every row can be deleted on the spot, and the type
 * is always visible.
 *
 * The list is server-paged and server-searched, because a long-lived account
 * accumulates hundreds of rows.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, ConfirmSheet, Icon, SearchField, Sheet, useToast } from '@/shared/ui';

import { AddInstructionForm } from './AddInstructionForm';
import { MemorySheetList } from './MemorySheetList';
import { SheetTypeChips } from './SheetTypeChips';
import { useForgetMemory } from '../hooks/mutations';
import { useMemorySheetList } from '../hooks/queries';
import { memoryLine } from '../model/format';
import type { Memory } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { flexShrink: 1 },
        search: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
    });

export function MemorySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [search, setSearch] = useState('');
    const [type, setType] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);

    const query = useMemorySheetList(search, type, visible);
    const remove = useForgetMemory({
        onSuccess: () => {
            toast('Forgotten', 'success');
            setPendingDelete(null);
        },
    });
    const total = query.data?.total;

    return (
        <>
            <Sheet
                visible={visible}
                onClose={onClose}
                title="Memory"
                subtitle={
                    total !== undefined
                        ? `${total} thing${total === 1 ? '' : 's'} remembered`
                        : 'What Bee Flow carries between conversations'
                }
                scroll={false}
                tall
                footer={
                    adding ? undefined : (
                        <Button
                            label="Add an instruction"
                            variant="secondary"
                            fullWidth
                            onPress={() => setAdding(true)}
                            icon={<Icon name="Plus" size={16} color={theme.colors.textPrimary} />}
                        />
                    )
                }
            >
                <View style={styles.body}>
                    {adding ? <AddInstructionForm onClose={() => setAdding(false)} /> : null}
                    <View style={styles.search}>
                        <SearchField value={search} onChangeText={setSearch} placeholder="Search memory" />
                    </View>
                    <SheetTypeChips type={type} onChange={setType} />
                    <MemorySheetList query={query} searching={Boolean(search)} onDelete={setPendingDelete} />
                </View>
            </Sheet>

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title="Forget this?"
                message={pendingDelete ? memoryLine(pendingDelete) : ''}
                confirmLabel="Forget"
                busy={remove.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
            />
        </>
    );
}
