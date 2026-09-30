/**
 * What Bee Flow remembers about you.
 *
 * Memory is the part of an AI product people are most entitled to be uneasy
 * about, so this screen is built around reading and forgetting rather than
 * around adding: every entry is readable in full, every entry can be forgotten
 * on the spot, several at once, or all of them — and each confirmation says in
 * plain words what disappears.
 *
 * Scope, stated once because the confirmations depend on it: this view is the
 * user-global pool — `project_id IS NULL`. Memories a team shares on a project
 * are a different pool with different access rules, and nothing here touches
 * them, including "Forget everything".
 */

import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Screen, SearchField } from '@/shared/ui';

import { ForgetEverythingSheet } from '../components/ForgetEverythingSheet';
import { ForgetMemorySheet } from '../components/ForgetMemorySheet';
import { ForgetSelectedSheet } from '../components/ForgetSelectedSheet';
import { MemoryHeader } from '../components/MemoryHeader';
import { MemoryList } from '../components/MemoryList';
import { MemoryTypeChips } from '../components/MemoryTypeChips';
import { useMemoryPages, useMemoryStats } from '../hooks/queries';
import { typeChips } from '../model/format';
import type { Memory } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ search: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } });

/**
 * The search hits the database on every change of the settled value, so the
 * field's own value is kept separate and only settles after a pause.
 */
function useSettled(value: string): string {
    const [settled, setSettled] = useState('');
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value.trim()), 300);
        return () => clearTimeout(timer);
    }, [value]);
    return settled;
}

function useSelection() {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const toggle = (id: string): void =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    return { selected, toggle, clear: () => setSelected(new Set()) };
}

export function MemoryScreen() {
    const styles = useThemedStyles(makeStyles);
    const [search, setSearch] = useState('');
    const debounced = useSettled(search);
    const [type, setType] = useState<string | null>(null);
    const selection = useSelection();
    const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);
    const [confirmBulk, setConfirmBulk] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);

    const stats = useMemoryStats();
    const list = useMemoryPages(debounced, type);
    const chips = useMemo(() => typeChips(stats.data), [stats.data]);
    const loaded = (list.data?.pages ?? []).reduce((n, page) => n + page.memories.length, 0);
    const total = stats.data?.total ?? list.data?.pages[0]?.total ?? loaded;

    return (
        <Screen edges={['top', 'bottom']}>
            <MemoryHeader
                selectedCount={selection.selected.size}
                total={total}
                onCancelSelection={selection.clear}
                onForgetSelected={() => setConfirmBulk(true)}
                onForgetEverything={() => setConfirmClear(true)}
            />
            <View style={styles.search}>
                <SearchField value={search} onChangeText={setSearch} placeholder="Search what it remembers" />
            </View>
            <MemoryTypeChips chips={chips} type={type} onChange={setType} />
            <MemoryList
                list={list}
                filtered={Boolean(debounced || type)}
                selected={selection.selected}
                onToggle={selection.toggle}
                onDelete={setPendingDelete}
                onClearFilter={() => {
                    setSearch('');
                    setType(null);
                }}
            />

            <ForgetMemorySheet memory={pendingDelete} onDone={() => setPendingDelete(null)} />
            <ForgetSelectedSheet
                visible={confirmBulk}
                ids={[...selection.selected]}
                onCancel={() => setConfirmBulk(false)}
                onForgotten={() => {
                    setConfirmBulk(false);
                    selection.clear();
                }}
            />
            <ForgetEverythingSheet
                visible={confirmClear}
                total={total}
                onCancel={() => setConfirmClear(false)}
                onForgotten={() => {
                    setConfirmClear(false);
                    selection.clear();
                }}
            />
        </Screen>
    );
}
