// Colour roles and the label style: the design values -> CSS custom properties.
//
// The brand colour (`primary`) used to paint everything. Four optional roles
// split that: cta (buttons, focus ring), link (text links), highlight (eyebrows,
// badges, hover borders) and tile (icon tile fill and glyph). An empty role
// emits nothing, so it keeps following the primary colour and a site that
// never set one renders as before. A role is accepted only as #rrggbb; the
// label style is an enum member that selects a fixed table entry.

export interface ColorRoles {
    cta?: string;
    link?: string;
    highlight?: string;
    tile?: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const ROLE_PROPS: Array<[keyof ColorRoles, string]> = [
    ['cta', '--cta-color'],
    ['link', '--link-color'],
    ['highlight', '--highlight-color'],
    ['tile', '--tile-color'],
];

// The label style uses the vocabulary of a block's style.labelStyle (mono | plain).
// 'mono' is the identity and emits nothing; blocks override these properties with
// the classes cms-label-plain / cms-label-mono (blockWrap.ts, marketing.css).
const LABEL_STYLES = new Map<string, Record<string, string>>([
    ['plain', {
        '--label-font': 'var(--font-body)',
        '--label-transform': 'none',
        '--label-tracking': 'normal',
        '--label-size': 'var(--text-small)',
    }],
]);

/** Every custom property the roles and the label style can set. */
export const ROLE_VAR_PROPS: string[] = [
    ...ROLE_PROPS.map(([, prop]) => prop),
    '--cta-bg', '--highlight-border',
    '--label-font', '--label-transform', '--label-tracking', '--label-size',
];

/** The role colour when it is a legal #rrggbb, else ''. */
export function roleColor(value: unknown): string {
    return typeof value === 'string' && HEX.test(value) ? value : '';
}

/** Custom properties for the colour roles and the label style. */
export function roleVars(colors: ColorRoles | null | undefined, labelStyle: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [role, prop] of ROLE_PROPS) {
        const value = roleColor(colors?.[role]);
        if (value) out[prop] = value;
    }
    if (out['--cta-color']) out['--cta-bg'] = out['--cta-color'];
    if (out['--highlight-color']) {
        out['--highlight-border'] = `color-mix(in srgb, ${out['--highlight-color']} 30%, transparent)`;
    }
    return { ...out, ...(typeof labelStyle === 'string' ? LABEL_STYLES.get(labelStyle) ?? {} : {}) };
}

/** Apply the role and label properties, first removing the ones a previous design set. */
export function applyRoleVars(style: CSSStyleDeclaration, colors: ColorRoles | null | undefined, labelStyle: unknown): void {
    for (const prop of ROLE_VAR_PROPS) style.removeProperty(prop);
    for (const [prop, value] of Object.entries(roleVars(colors, labelStyle))) style.setProperty(prop, value);
}

/** The legal label style names, for the lockstep test against the server enum. */
export const LABEL_STYLE_NAMES: string[] = [...LABEL_STYLES.keys()];
