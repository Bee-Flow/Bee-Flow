import type { Option } from './controls';

type Tr = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** The English for every knob value (the keys are forms.style.<knob>_<value>). */
const FALLBACK: Record<string, string> = {
    width_narrow: 'Narrow', width_medium: 'Medium', width_wide: 'Wide',
    align_left: 'Left', align_center: 'Centre',
    radius_none: 'Square', radius_sm: 'Slight', radius_md: 'Medium', radius_lg: 'Round', radius_xl: 'Extra round',
    density_compact: 'Compact', density_comfortable: 'Comfortable', density_spacious: 'Spacious',
    text_sm: 'Small', text_md: 'Medium', text_lg: 'Large',
    font_system: 'System', font_inter: 'Inter', font_serif: 'Serif', font_mono: 'Monospace', font_rounded: 'Rounded',
    label_above: 'Above the field', label_inside: 'Inside the field',
    input_outlined: 'Outlined', input_filled: 'Filled', input_underlined: 'Underlined',
    button_width_auto: 'Fit the text', button_width_full: 'Full width',
    shape_square: 'Square', shape_rounded: 'Rounded', shape_pill: 'Pill',
};

/** The choices of one knob, each labelled through forms.style.<knob>_<value>. */
export function optionsOf(t: Tr, knob: string, values: readonly string[]): Option[] {
    return values.map(v => ({ value: v, label: t(`forms.style.${knob}_${v}`, FALLBACK[`${knob}_${v}`] || v) }));
}
