/**
 * The rows between the cards: a lane's label, a loop body's or a parallel
 * branch's fold, the "+" slots, a jump to a step shown elsewhere, and a
 * section heading. `OutlineRowView` picks the one a row needs.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import type { OutlineRow } from '@/features/flow-editor/model/outline';
import { Icon, Text } from '@/shared/ui';

import { cardModel } from './cardModel';
import { useOutline } from './OutlineContext';
import { indentFor, makeOutlineStyles } from './outlineStyles';
import { rowWords } from './rowWords';
import { StepCard } from './StepCard';

type Row<K extends OutlineRow['kind']> = Extract<OutlineRow, { kind: K }>;

function LaneHeader({ row }: { row: Row<'lane'> }) {
    const styles = useThemedStyles(makeOutlineStyles);
    const t = useTranslation();
    return (
        <View style={[indentFor(styles, row.depth), styles.lane]} accessibilityRole="header">
            <View style={[styles.laneDot, styles.laneTone[row.tone]]} />
            <Text variant="label" weight="semibold" tone="secondary" style={styles.sectionText}>
                {rowWords(row.text, t)}
            </Text>
        </View>
    );
}

function GroupHeader({ row }: { row: Row<'group'> }) {
    const styles = useThemedStyles(makeOutlineStyles);
    const t = useTranslation();
    const { onToggleGroup } = useOutline();
    const words = rowWords(row.text, t);
    const count = t('routines.canvas.summary_steps', '{n} steps', { n: row.count });
    return (
        <Pressable
            onPress={() => onToggleGroup(row.key)}
            accessibilityRole="button"
            accessibilityState={{ expanded: !row.collapsed }}
            accessibilityLabel={`${words}, ${count}`}
            style={[indentFor(styles, row.depth), styles.group]}
        >
            <Icon name={row.collapsed ? 'ChevronRight' : 'ChevronDown'} size={16} color={styles.groupGlyph.color} />
            <Text variant="label" weight="semibold" tone="secondary" style={styles.sectionText}>
                {words}
            </Text>
            <Text variant="caption" tone="tertiary">
                {count}
            </Text>
        </Pressable>
    );
}

function AddSlot({ row }: { row: Row<'add'> }) {
    const styles = useThemedStyles(makeOutlineStyles);
    const t = useTranslation();
    const { onAdd, locked } = useOutline();
    const label = row.target.kind === 'root' ? t('mobile.flow.add_trigger', 'Add a trigger') : t('routines.ribbon.search_label', 'Add a step');
    if (row.end) {
        return (
            <View style={indentFor(styles, row.depth)}>
                <Pressable
                    onPress={() => onAdd(row.target)}
                    disabled={locked}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ disabled: locked }}
                    style={({ pressed }) => [styles.addEnd, pressed ? styles.pressed : null]}
                >
                    <Icon name="Plus" size={16} color={styles.addGlyph.color} />
                    <Text variant="caption" tone="secondary">
                        {label}
                    </Text>
                </Pressable>
            </View>
        );
    }
    // The whole row between two cards is the button, not just the 28dp
    // circle drawn on the line: a thumb aiming between two cards lands here.
    return (
        <Pressable
            onPress={() => onAdd(row.target)}
            disabled={locked}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.flow.insert_step', 'Insert a step here')}
            accessibilityState={{ disabled: locked }}
            style={[indentFor(styles, row.depth), styles.add]}
        >
            {({ pressed }) => (
                <>
                    <View style={styles.addLine} />
                    <View style={[styles.addButton, pressed ? styles.addPressed : null]}>
                        <Icon name="Plus" size={14} color={styles.addGlyph.color} />
                    </View>
                </>
            )}
        </Pressable>
    );
}

function JumpRow({ row }: { row: Row<'jump'> }) {
    const styles = useThemedStyles(makeOutlineStyles);
    const t = useTranslation();
    const { definition, card, onJump } = useOutline();
    const name = cardModel(definition, row.toId, card)?.name ?? row.toId;
    const words = row.back
        ? t('mobile.flow.jump_back', 'Goes back to {name}', { name })
        : t('mobile.flow.jump_on', 'Continues at {name}', { name });
    return (
        <Pressable onPress={() => onJump(row.toId)} accessibilityRole="button" style={[indentFor(styles, row.depth), styles.jump]}>
            <Icon name={row.back ? 'CornerUpLeft' : 'CornerDownRight'} size={16} color={styles.jumpGlyph.color} />
            <Text variant="caption" tone="secondary" numberOfLines={1}>
                {words}
            </Text>
        </Pressable>
    );
}

function SectionRow({ row }: { row: Row<'section'> }) {
    const styles = useThemedStyles(makeOutlineStyles);
    const t = useTranslation();
    return (
        <View style={styles.section} accessibilityRole="header">
            <Text variant="label" weight="semibold" tone="tertiary" style={styles.sectionText}>
                {rowWords(row.text, t)}
            </Text>
        </View>
    );
}

export function OutlineRowView({ row }: { row: OutlineRow }) {
    switch (row.kind) {
        case 'trigger':
            return <StepCard address={row.nodeId} depth={row.depth} />;
        case 'step':
            return <StepCard address={row.address} depth={row.depth} />;
        case 'lane':
            return <LaneHeader row={row} />;
        case 'group':
            return <GroupHeader row={row} />;
        case 'add':
            return <AddSlot row={row} />;
        case 'jump':
            return <JumpRow row={row} />;
        default:
            return <SectionRow row={row} />;
    }
}
