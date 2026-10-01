import { lowerPick, sourceFromPath } from '@shared/mapping/index.mjs';
import type { Slot } from '@shared/mapping/index.mjs';
import { Eye } from 'lucide-react';
import { useState } from 'react';
import previewBindingJs, { previewBindingShape as previewShapeJs } from './bindingPreview';
import { useTranslation } from '../../../../hooks/useTranslation';
import { AMBER_NOTE, listBadgeClass as listBadgeClassJs } from '../flow/settings/formStyles';
import PickOptions from '../valueSlot/PickOptions';
import { lowerable, makePick } from '../valueSlot/slotModel';

const previewBinding = previewBindingJs as (b: unknown, root: unknown) => string | null;
const previewBindingShape = previewShapeJs as (b: unknown, root: unknown) => { isList: boolean; count: number | null; empty: boolean } | null;
const listBadgeClass = listBadgeClassJs as (extra?: string) => string;

const ONE_VALUE = new Set(['number', 'date', 'yesno']);

/**
 * The lines under the formula editor, made SHAPE-HONEST: "Here's how it
 * looks", a "list of 3" pill, and, for a reference that resolves to a list
 * in a field that wants one value, the amber note with "Choose how to use
 * the list". That opens the same options a value slot offers (PickOptions,
 * with live previews); the answer is written in the spelling this editor
 * holds (`join(p, "\n")`, `first(p)`).
 *
 * Everything is worked out from the binding the field holds NOW, on every
 * render: the old inline box kept the path it was opened for and, after the
 * field was edited, overwrote the new text with a binding to the old path.
 */
export default function BindingFieldPreview({ binding, sample, slot, expectShape, showValue, label, onChoose }: {
    binding: { kind: string; path?: string };
    sample: object | null | undefined;
    slot: Slot;
    expectShape?: string | null;
    showValue: boolean;
    label?: string | null;
    onChoose: (binding: unknown) => void;
}) {
    const { t } = useTranslation();
    const [choosing, setChoosing] = useState(false);
    const preview = previewBinding(binding, sample);
    const shape = previewBindingShape(binding, sample);
    const source = binding.kind === 'ref' ? sourceFromPath(binding.path) : null;
    const wantsOne = expectShape === 'scalar' || ONE_VALUE.has(slot.as);
    const listIntoOne = !!shape?.isList && !shape.empty && wantsOne;

    return (
        <>
            {preview != null && showValue && (
                <div className="text-[10px] text-[var(--text-tertiary)] flex items-center gap-1.5 min-w-0">
                    <Eye size={11} className="shrink-0" />
                    <span>{t('routines.builder.how_it_looks', "Here's how it looks:")}</span>
                    <span className="font-mono text-[var(--text-secondary)] truncate">{preview}</span>
                    {shape?.isList && !shape.empty && (
                        <span className={listBadgeClass()}>{t('routines.builder.list_of_n', 'list of {n}', { n: shape.count })}</span>
                    )}
                </div>
            )}
            {shape?.isList && shape.empty && (
                <div className={AMBER_NOTE}>
                    {t('routines.builder.list_empty_sample', 'Nothing found here in the sample data — check the field name, or run the step above to get real data.')}
                </div>
            )}
            {listIntoOne && (
                <div className={`${AMBER_NOTE} flex items-center gap-2 flex-wrap`} data-testid="formula-list-note">
                    {t('routines.builder.list_wants_one', 'This field wants one value, but you gave it a list of {n}.', { n: shape.count })}
                    {source && (
                        <button type="button" onClick={() => setChoosing(c => !c)} aria-expanded={choosing} className="underline hover:no-underline">
                            {t('routines.builder.choose_list_use', 'Choose how to use the list')}
                        </button>
                    )}
                </div>
            )}
            {listIntoOne && source && choosing && (
                <PickOptions
                    source={source}
                    sample={sample}
                    slot={slot}
                    value={{ take: 'one', as: 'native' }}
                    label={label || undefined}
                    canUse={lowerable}
                    onSelect={(intent) => {
                        const next = lowerPick(makePick(source, intent), sample);
                        setChoosing(false);
                        if (next) onChoose(next);
                    }}
                />
            )}
        </>
    );
}
