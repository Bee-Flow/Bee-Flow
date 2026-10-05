/**
 * The loop's editor — the web's LoopFields and LoopOverPicker: what to repeat
 * over, picked by name from the lists the steps before it produce ("Search ▸
 * Results — 10 items") rather than typed as a path; what to call each item
 * (bound as `loop.<name>`); how many at a time and the safety cap. The steps
 * inside the loop are listed below, in the order they run, and each opens in
 * its own editor — they are added and moved in the outline.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { suggestItemVar } from '@/features/flow-editor/bindings';
import { BindingInput, NumberField } from '@/features/flow-editor/components/fields';
import { Button, Icon, OptionRow, Text, TextField } from '@/shared/ui';

import { Band } from '../shared/Band';
import { Note } from '../shared/Note';
import type { StepEditorProps } from '../types';
import { LoopBodyList } from './LoopBodyList';
import { friendlyPath, loopLists, pickLoopList, typedItemVar } from './loopModel';

/** What an item is called until someone names it. */
const DEFAULT_ITEM_VAR = 'item';

function LoopOver(editor: StepEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { draft, setMany, ctx } = editor;
    const [advanced, setAdvanced] = useState(false);
    const overRef = typeof draft.overRef === 'string' ? draft.overRef : '';
    const itemVar = typeof draft.itemVar === 'string' && draft.itemVar ? draft.itemVar : 'item';
    const lists = loopLists(ctx.groups, ctx.sampleRoot, ctx.stepLabelById, t);
    return (
        <>
            <Text variant="caption" weight="medium" tone="secondary">
                {t('mobile.flow.loop.run_for_each', 'Run this step for each…')}
            </Text>
            {overRef ? (
                <View style={styles.current}>
                    <Icon name="Repeat" size={14} color={styles.accent.color} />
                    <Text variant="body" numberOfLines={2} style={styles.grow}>
                        {friendlyPath(overRef, ctx.stepLabelById, t) || overRef}
                    </Text>
                </View>
            ) : null}
            {lists.length ? (
                <View style={styles.lists}>
                    <Text variant="label" tone="tertiary">
                        {t('mobile.flow.loop.lists', 'Lists you can repeat over')}
                    </Text>
                    {lists.map((l) => (
                        <OptionRow
                            key={l.path}
                            label={l.label}
                            description={l.preview}
                            selected={overRef === l.path}
                            onPress={() => setMany(pickLoopList(draft, l.path, suggestItemVar(l.key)))}
                            disabled={ctx.disabled}
                        />
                    ))}
                </View>
            ) : (
                <Note>{t('mobile.flow.loop.no_lists', 'No upstream lists detected — open Advanced to enter one by hand.')}</Note>
            )}
            <TextField
                label={t('mobile.flow.loop.name_each', 'Name each item')}
                // What is typed, even nothing: snapping an emptied box back to
                // "item" made retyping the name produce "itemorder". The save
                // still stores "item" for an empty name.
                value={typeof draft.itemVar === 'string' ? draft.itemVar : DEFAULT_ITEM_VAR}
                onChangeText={(v) => setMany({ itemVar: typedItemVar(v) })}
                placeholder={DEFAULT_ITEM_VAR}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!ctx.disabled}
            />
            <Note>{t('mobile.flow.loop.available_as_each', 'The steps inside read each item as “Each {name}”; pick it with Insert data.', { name: itemVar })}</Note>
            <Button size="sm" variant="ghost" iconName={advanced ? 'ChevronDown' : 'ChevronRight'} label={t('mobile.flow.section.advanced', 'Advanced')} onPress={() => setAdvanced((v) => !v)} />
            {advanced ? (
                <BindingInput
                    mode="path"
                    list
                    value={overRef}
                    onChange={(v) => setMany({ overRef: String(v), itemVar })}
                    label={t('mobile.flow.loop.list_path', 'List path (expression)')}
                    prompt={t('mobile.flow.loop.list_path_prompt', 'Tap Insert data to pick a list')}
                    disabled={ctx.disabled}
                />
            ) : null}
        </>
    );
}

export function LoopEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, set } = editor;
    return (
        <>
            <Band editor={editor} sectionKey="loop" title={t('mobile.flow.loop.loop', 'Loop')} defaultOpen>
                <LoopOver {...editor} />
                <NumberField
                    label={t('mobile.flow.loop.batch_size', 'Batch size')}
                    hint={t(
                        'mobile.flow.loop.batch_size_hint',
                        'Items per iteration. 1 = one at a time; higher values hand the steps inside a LIST of that many items instead of a single item.',
                    )}
                    value={draft.batchSize ?? 1}
                    min={1}
                    max={1000}
                    integer
                    onChange={(n) => set('batchSize', n)}
                    disabled={editor.ctx.disabled}
                />
                <NumberField
                    label={t('automations.canvas.loop_max_title', 'Max iterations')}
                    hint={t('mobile.flow.loop.max_iterations_hint', 'Safety cap. 1–1000.')}
                    value={draft.maxIterations ?? 100}
                    min={1}
                    max={1000}
                    integer
                    onChange={(n) => set('maxIterations', n)}
                    disabled={editor.ctx.disabled}
                />
            </Band>
            <Band editor={editor} sectionKey="body" title={t('mobile.flow.loop.body', 'Steps inside the loop')} defaultOpen>
                <Note>{t('mobile.flow.loop.body_order', 'These run once per item, top to bottom.')}</Note>
                <LoopBodyList {...editor} />
            </Band>
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    current: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        padding: theme.spacing.sm,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.accentText,
    } satisfies ViewStyle,
    accent: { color: theme.colors.accentText },
    grow: { flex: 1 },
    lists: { gap: theme.spacing.xs, marginHorizontal: -theme.spacing.md } satisfies ViewStyle,
});
