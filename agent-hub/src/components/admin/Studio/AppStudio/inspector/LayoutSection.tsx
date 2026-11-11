import { NumberField } from './panels/kit';
import { knobLabel } from './styleKnobMeta';
import Disclosure from '@/components/shared/Disclosure';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { GRID_CONTAINER_TYPES, gridColumns } from '../runtime/styleResolver';

/**
 * The layout knobs of a node or a section (knob groups `grid_columns` and `placement`):
 *
 *   a grid (the section, card, container, form, tab, modal, repeater)
 *       Columns 1..12 and whether a tablet may rearrange it;
 *   a node with a width (every type that has `span`)
 *       its width on a tablet and on a phone, how many rows it covers, where it sits in its
 *       row and whether it sticks while the page scrolls.
 *
 * Every control commits `null` for the value that means "nothing set" (12 columns, automatic,
 * one row, stretch, not sticky, an empty width). The canonicalizer leaves a null knob out, so
 * touching a control and putting it back stores nothing.
 */
interface LayoutSectionProps {
    /** The node's type; null for a section. */
    type: string | null;
    /** The type's own style knob list (the section's for a section). */
    knobs: string[];
    style: Record<string, unknown>;
    patch: (p: Record<string, unknown>) => void;
    disabled: boolean;
}

interface FieldsProps {
    style: Record<string, unknown>;
    patch: (p: Record<string, unknown>) => void;
    disabled: boolean;
    t: TranslateFn;
}

const whole = (v: unknown, lo: number, hi: number): number | null =>
    (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** The whole numbers lo..hi as the options of a segmented control. */
const countOptions = (lo: number, hi: number): { value: number; label: string }[] =>
    Array.from({ length: hi - lo + 1 }, (_, i) => ({ value: lo + i, label: String(lo + i) }));

/** A typed width: a whole number 1..12, or null for an empty field or anything outside that. */
const widthOrNull = (n: number | null): number | null => (n === null ? null : whole(Math.round(n), 1, 12));

function GridFields({ style, patch, disabled, t }: FieldsProps) {
    const columns = gridColumns(style);
    const manual = style.responsive === 'manual';
    return (
        <>
            <NumberField
                label={knobLabel('columns', t)}
                value={columns < 12 ? columns : null}
                onChange={(n) => patch({ columns: n === null ? null : whole(Math.round(n), 1, 11) })}
                placeholder="12"
                hint={t('studio_apps_layout.hints.columns', '1 to 12. Empty: the standard 12 columns.')}
                step={1}
                disabled={disabled}
            />
            <FormField
                label={knobLabel('responsive', t)}
                hint={columns < 12
                    ? t('studio_apps_layout.hints.responsive_columns', 'A grid with its own column count is never rearranged. Give a block a tablet width where it needs one.')
                    : t('studio_apps_layout.hints.responsive', 'Rearrange: narrow blocks become half the row on a tablet, wide ones the full row. Keep: every block keeps its width.')}
            >
                <SegmentedControl
                    value={columns < 12 || manual ? 'manual' : 'auto'}
                    onChange={(v) => patch({ responsive: v === 'manual' ? 'manual' : null })}
                    options={[
                        { value: 'auto', label: t('studio_apps_layout.values.responsive_auto', 'Rearrange') },
                        { value: 'manual', label: t('studio_apps_layout.values.responsive_manual', 'Keep') },
                    ]}
                    size="sm"
                    fullWidth
                    disabled={disabled || columns < 12}
                    ariaLabel={knobLabel('responsive', t)}
                />
            </FormField>
        </>
    );
}

/** Sticky on or off, and the distance from the edge once it is on. */
function StickyFields({ style, patch, disabled, t }: FieldsProps) {
    const sticky = style.sticky === 'top' || style.sticky === 'bottom' ? style.sticky : 'none';
    return (
        <>
            <FormField
                label={knobLabel('sticky', t)}
                hint={t('studio_apps_layout.hints.sticky', 'The block stays in view next to taller content in the same row. Not shown while editing: use Preview.')}
            >
                <SegmentedControl
                    value={sticky}
                    onChange={(v) => patch(v === 'none' ? { sticky: null, stickyOffset: null } : { sticky: v })}
                    options={[
                        { value: 'none', label: t('studio_apps_layout.values.sticky_none', 'Off') },
                        { value: 'top', label: t('studio_apps_layout.values.top', 'Top') },
                        { value: 'bottom', label: t('studio_apps_layout.values.bottom', 'Bottom') },
                    ]}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={knobLabel('sticky', t)}
                />
            </FormField>
            {sticky !== 'none' ? (
                <FormField label={knobLabel('stickyOffset', t)}>
                    <SegmentedControl
                        value={whole(style.stickyOffset, 0, 6) ?? 0}
                        onChange={(v) => patch({ stickyOffset: v <= 0 ? null : v })}
                        options={countOptions(0, 6)}
                        size="sm"
                        fullWidth
                        disabled={disabled}
                        ariaLabel={knobLabel('stickyOffset', t)}
                    />
                </FormField>
            ) : null}
        </>
    );
}

function PlacementFields({ style, patch, disabled, t }: FieldsProps) {
    const alignSelf = style.alignSelf === 'start' || style.alignSelf === 'center' || style.alignSelf === 'end' ? style.alignSelf : 'stretch';
    return (
        <>
            <NumberField
                label={knobLabel('spanMd', t)}
                value={whole(style.spanMd, 1, 12)}
                onChange={(n) => patch({ spanMd: widthOrNull(n) })}
                placeholder={t('studio_apps_layout.values.automatic', 'Automatic')}
                hint={t('studio_apps_layout.hints.span_md', 'Columns between 640 and 1023 px wide. Empty: decided by the grid.')}
                step={1}
                disabled={disabled}
            />
            <NumberField
                label={knobLabel('spanSm', t)}
                value={whole(style.spanSm, 1, 12)}
                onChange={(n) => patch({ spanSm: widthOrNull(n) })}
                placeholder={t('studio_apps_layout.values.full_width', 'Full width')}
                hint={t('studio_apps_layout.hints.span_sm', 'Columns below 640 px wide. Empty: the block takes the full width, like every block on a phone.')}
                step={1}
                disabled={disabled}
            />
            <FormField label={knobLabel('rowSpan', t)}>
                <SegmentedControl
                    value={whole(style.rowSpan, 1, 6) ?? 1}
                    onChange={(v) => patch({ rowSpan: v <= 1 ? null : v })}
                    options={countOptions(1, 6)}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={knobLabel('rowSpan', t)}
                />
            </FormField>
            <FormField label={knobLabel('alignSelf', t)}>
                <SegmentedControl
                    value={alignSelf}
                    onChange={(v) => patch({ alignSelf: v === 'stretch' ? null : v })}
                    options={[
                        { value: 'stretch', label: t('studio_apps_layout.values.stretch', 'Fill') },
                        { value: 'start', label: t('studio_apps_layout.values.top', 'Top') },
                        { value: 'center', label: t('studio_apps_layout.values.middle', 'Middle') },
                        { value: 'end', label: t('studio_apps_layout.values.bottom', 'Bottom') },
                    ]}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={knobLabel('alignSelf', t)}
                />
            </FormField>
            <StickyFields style={style} patch={patch} disabled={disabled} t={t} />
        </>
    );
}

/** The `type` LayoutSection takes: null for a section, else the node's type. */
export function layoutTypeOf(isSection: boolean, node: { type?: string } | null | undefined): string | null {
    return isSection ? null : (node?.type ?? '');
}

export default function LayoutSection({ type, knobs, style, patch, disabled }: LayoutSectionProps) {
    const { t } = useTranslation();
    const isGrid = type === null || GRID_CONTAINER_TYPES.includes(type);
    const hasWidth = knobs.includes('span');
    if (!isGrid && !hasWidth) return null;
    return (
        <Disclosure
            title={t('studio_apps_layout.section.title', 'Layout')}
            hint={isGrid
                ? t('studio_apps_layout.section.hint_grid', 'Columns, tablet and phone')
                : t('studio_apps_layout.section.hint_node', 'Tablet and phone width, rows, sticky')}
        >
            <div className="flex flex-col gap-4 pt-3" data-testid="layout-section">
                {isGrid ? <GridFields style={style} patch={patch} disabled={disabled} t={t} /> : null}
                {hasWidth ? <PlacementFields style={style} patch={patch} disabled={disabled} t={t} /> : null}
            </div>
        </Disclosure>
    );
}
