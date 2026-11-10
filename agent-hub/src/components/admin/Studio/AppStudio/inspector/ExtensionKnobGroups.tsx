import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import Disclosure from '@/components/shared/Disclosure';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import Slider from '@/components/shared/Slider';
import { SelectField } from './panels/kit';
import { STYLE_KNOBS, clampKnob, knobLabel, valueLabel } from './styleKnobMeta';
import { STYLE_VALUE_CONTROLS, isBaseValueType } from './styleValueControls';
import TokenColorField from './TokenColorField';
import { earnedKnobGroups, type EarnedKnobGroup } from './extensionKnobGroups';
import type { AppDefinition, AppNode } from './appDefinition';
import type { KnobSpec } from './styleKnobMeta.types';

/**
 * The controls of the style knob groups added after the base (componentSpecs/styleKnobGroups),
 * one closed disclosure per group the node's type (or the section) earns. StyleSection draws
 * the type's own list; these knobs are in no such list, so without this block only the AI
 * builder could set them.
 *
 * A knob that is not set stays out of the definition: the controls show the knob's default
 * until one is moved, a colour set back to "Theme" removes the key, and "Reset" removes every
 * knob of the group.
 */

type EnumSpec = Extract<KnobSpec, { type: 'enum' }>;
/** Above this many values an enum is a select: pills overflow the 320px panel. */
const MAX_PILLS = 4;

interface GroupProps {
    group: EarnedKnobGroup;
    style: Record<string, unknown>;
    patch: (p: Record<string, unknown>) => void;
    definition: AppDefinition;
    disabled: boolean;
}

function enumOptions(group: EarnedKnobGroup, knob: string, t: TranslateFn) {
    const labels = group.handler?.valueLabels?.[knob];
    return ((STYLE_KNOBS[knob] as EnumSpec).values as (string | number | null)[])
        .filter((v): v is string | number => v !== null)
        .map((v) => {
            const entry = labels && Object.hasOwn(labels, String(v)) ? labels[String(v)] : null;
            return { value: v, label: entry ? t(entry[0], entry[1]) : valueLabel(v, t) };
        });
}

function KnobControl({ group, knob, style, patch, definition, disabled }: GroupProps & { knob: string }) {
    const { t } = useTranslation();
    const spec = STYLE_KNOBS[knob];
    if (!spec) return null;
    const label = knobLabel(knob, t);
    const value = style[knob];
    const commit = (v: unknown) => patch({ [knob]: v === null || v === undefined ? undefined : clampKnob(knob, v as string | number, style) });

    if (!isBaseValueType(spec.type)) {
        const Control = STYLE_VALUE_CONTROLS[spec.type];
        return Control ? <Control knob={knob} spec={spec} value={value} onChange={(v) => patch({ [knob]: v ?? undefined })} definition={definition} disabled={disabled} /> : null;
    }
    if (spec.type === 'int') {
        return (
            <Slider label={label} value={(Number.isFinite(value) ? value : spec.default) as number} onChange={commit}
                min={spec.min} max={spec.max} step={spec.step} disabled={disabled} />
        );
    }
    if (spec.type === 'colorOrRole') {
        return (
            <FormField label={label}>
                <TokenColorField value={(value as string | null | undefined) ?? null} onChange={commit}
                    themePrimary={(definition?.theme as { primary?: string } | undefined)?.primary || null} disabled={disabled} />
            </FormField>
        );
    }
    if (spec.type !== 'enum') return null;
    const options = enumOptions(group, knob, t);
    const current = (spec.values.includes(value as never) ? value : spec.default) as string | number;
    if (options.length > MAX_PILLS) {
        return <SelectField label={label} value={current} onChange={commit} options={options} disabled={disabled} />;
    }
    return (
        <FormField label={label}>
            <SegmentedControl value={current} onChange={commit} options={options} size="sm" fullWidth disabled={disabled} ariaLabel={label} />
        </FormField>
    );
}

function KnobGroup(props: GroupProps) {
    const { t } = useTranslation();
    const { group, style, patch, disabled } = props;
    const title = group.handler?.title ? t(group.handler.title[0], group.handler.title[1]) : group.name;
    const anySet = group.knobs.some((k) => style[k] !== undefined && style[k] !== null);
    return (
        <Disclosure title={title}>
            <div className="flex flex-col gap-4 pt-3" data-knob-group={group.name}>
                {group.knobs.map((knob) => <KnobControl key={knob} {...props} knob={knob} />)}
                {anySet ? (
                    <button
                        type="button"
                        className="self-start text-xs underline text-[var(--text-secondary)] disabled:opacity-60"
                        onClick={() => patch(Object.fromEntries(group.knobs.map((k) => [k, undefined])))}
                        disabled={disabled}
                    >
                        {t('studio_apps_box.reset', 'Reset')}
                    </button>
                ) : null}
            </div>
        </Disclosure>
    );
}

interface ExtensionKnobGroupsProps {
    /** The type's (or the section's) own knob list. */
    knobs: readonly string[];
    /** The selected node; ignored for a section. */
    node?: AppNode | null;
    isSection: boolean;
    style: Record<string, unknown>;
    patch: (p: Record<string, unknown>) => void;
    definition: AppDefinition;
    disabled: boolean;
}

export default function ExtensionKnobGroups({ knobs, node, isSection, ...rest }: ExtensionKnobGroupsProps) {
    const groups = earnedKnobGroups(knobs, isSection ? null : (node?.type ?? null));
    if (!groups.length) return null;
    return <>{groups.map((group) => <KnobGroup key={group.name} group={group} {...rest} />)}</>;
}
