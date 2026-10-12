/**
 * "Run once per item" — the web's ForEachSection (collectionEditors.jsx): the
 * step runs once per element of an upstream list with the element bound as
 * `loop.<itemVar>`. Off by default; on, it asks for the list, what to call
 * each item and the safety cap, and says how many runs the sample means.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { walkPath, type ForEach } from '@/features/flow-editor/bindings';
import { BindingInput, NumberField } from '@/features/flow-editor/components/fields';
import { Text, TextField } from '@/shared/ui';

import { ToggleBox } from './ToggleBox';

/** The name a new iteration binds its item under, as the web defaults it. */
const DEFAULT_ITEM_VAR = 'item';

/** How many times the step would run over the sample, or null when that is not known. */
export function forEachCount(forEach: ForEach | null | undefined, sampleRoot: unknown): number | null {
    if (!forEach?.overRef || !sampleRoot) return null;
    const list = walkPath(forEach.overRef, sampleRoot);
    return Array.isArray(list) ? list.length : null;
}

function ForEachFields({ fe, onChange, disabled }: { fe: ForEach; onChange: (next: ForEach | null) => void; disabled?: boolean }) {
    const t = useTranslation();
    return (
        <>
            <BindingInput
                mode="path"
                list
                value={fe.overRef || ''}
                onChange={(overRef) => onChange({ ...fe, overRef: String(overRef) })}
                label={t('mobile.flow.foreach.over', 'Loop over')}
                prompt={t('mobile.flow.foreach.over_prompt', 'Tap Insert data to pick a list')}
                disabled={disabled}
            />
            <TextField
                label={t('mobile.flow.foreach.item_var', 'Call each item')}
                value={fe.itemVar || ''}
                onChangeText={(itemVar) => onChange({ ...fe, itemVar })}
                placeholder={DEFAULT_ITEM_VAR}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!disabled}
            />
            <NumberField
                label={t('automations.canvas.loop_max_title', 'Max iterations')}
                hint={t('automations.loop_fields.safety_cap_1_1000', 'Safety cap. 1–1000.')}
                value={fe.maxIterations ?? 100}
                min={1}
                max={1000}
                integer
                onChange={(n) => onChange({ ...fe, maxIterations: Number(n) || 100 })}
                disabled={disabled}
            />
        </>
    );
}

export function ForEachRow({
    value,
    onChange,
    sampleRoot,
    hint,
    disabled,
}: {
    value: ForEach | null | undefined;
    onChange: (next: ForEach | null) => void;
    sampleRoot: unknown;
    hint?: string | null;
    disabled?: boolean;
}) {
    const t = useTranslation();
    const fe = value || null;
    const count = forEachCount(fe, sampleRoot);
    const toggle = (on: boolean) =>
        onChange(on ? { overRef: fe?.overRef || '', itemVar: fe?.itemVar || 'item', maxIterations: fe?.maxIterations ?? 100 } : null);
    return (
        <ToggleBox
            on={!!fe}
            onToggle={toggle}
            disabled={disabled}
            label={t('automations.collection_editors.run_once_per_item', 'Run once per item')}
            description={hint ?? t('automations.collection_editors.each_row_is_available_to_this', 'Each row is available to this step as its current row.')}
            status={
                count !== null ? (
                    <Text variant="caption" tone="secondary" weight="medium">
                        {t('mobile.flow.foreach.count', 'This step will run {n} times — once for each row.', { n: count })}
                    </Text>
                ) : null
            }
        >
            {fe ? <ForEachFields fe={fe} onChange={onChange} disabled={disabled} /> : null}
        </ToggleBox>
    );
}
