import { useState } from 'react';
import { currentItemNoun } from '@shared/mapping/index.mjs';
import type { ComposeBinding, CurrentItem, PickPart, PickIntent, Slot } from '@shared/mapping/index.mjs';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useVariablePickerContext } from '../mapping/VariablePickerContext';
import PickOptions, { previewText, resolvePreview } from './PickOptions';
import { countAt, crossesList, groupLabelOf, itemShapeAt, shapeAt, withItemScope, type GroupLike } from './slotModel';
import { pickLabel } from './usePickLabel';
import ValueChip from './ValueChip';

/**
 * A text with values in it, in a whole-value field: what a value picked into
 * typed text becomes (the text is kept, the value comes after it). The text
 * parts stay editable, each value is a chip that opens its options, and a
 * chip's ✕ takes that value out.
 *
 * A stop-gap with a short life: text fields get the real editor (text with
 * label pills, inserted at the caret) in ComposeField.
 */
export default function ComposeParts({ compose, onChange, sample, slot, groups, stepLabelById, onFocus, disabled = false }: {
    compose: ComposeBinding;
    onChange: (next: unknown) => void;
    sample: object | null | undefined;
    slot: Slot;
    groups: readonly GroupLike[] | null | undefined;
    stepLabelById?: ReadonlyMap<string, string> | null;
    onFocus?: () => void;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    const { currentItem } = useVariablePickerContext() as { currentItem?: CurrentItem | null };
    const [open, setOpen] = useState<number | null>(null);
    const parts = compose.parts;
    const write = (next: Array<string | PickPart>) => {
        const kept = next.filter(p => p !== '');
        if (!kept.length) onChange({ kind: 'literal', value: '' });
        else if (kept.length === 1 && typeof kept[0] === 'string') onChange({ kind: 'literal', value: kept[0] });
        else onChange({ ...compose, parts: kept });
    };
    const setPart = (i: number, part: string | PickPart) => write(parts.map((p, j) => (j === i ? part : p)));
    const textSlot: Slot = { ...slot, as: 'text' };

    return (
        <div className="flex flex-col gap-1" data-testid="compose-parts">
            {parts.map((part, i) => {
                if (typeof part === 'string') {
                    return (
                        <input
                            key={`t${i}`}
                            type="text"
                            value={part}
                            disabled={disabled}
                            onFocus={onFocus}
                            onChange={(e) => setPart(i, e.target.value)}
                            aria-label={t('mapping.slot.compose.text', 'Text')}
                            className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)]"
                        />
                    );
                }
                const shape = shapeAt(part.from, sample);
                const itemShape = itemShapeAt(part, sample, currentItem);
                const many = itemShape === null && (shape === 'list' || shape === 'table');
                const name = pickLabel(t, part, {
                    groupLabel: groupLabelOf(part.from, groups, stepLabelById),
                    crossesList: crossesList(part.from, sample),
                    itemNoun: currentItemNoun(part.from, currentItem),
                });
                return (
                    <div key={`p${i}`} className="flex flex-col gap-1">
                        <ValueChip
                            label={name}
                            count={many ? countAt(part.from, sample) : null}
                            preview={previewText(resolvePreview(part.from, part, withItemScope(sample, currentItem)))}
                            disabled={disabled}
                            onOpen={() => setOpen(o => (o === i ? null : i))}
                            onRemove={() => write(parts.filter((_, j) => j !== i))}
                        />
                        {open === i && (
                            <PickOptions
                                source={part.from}
                                sample={sample}
                                slot={textSlot}
                                shape={shape}
                                repeating={itemShape !== null}
                                value={part}
                                label={name}
                                onSelect={(intent: PickIntent) => {
                                    const { join: _join, ...rest } = part;
                                    setPart(i, { ...rest, ...intent, as: 'text' });
                                    setOpen(null);
                                }}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}
