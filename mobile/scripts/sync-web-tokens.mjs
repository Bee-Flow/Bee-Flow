/**
 * Generate src/core/theme/generated/webTokens.generated.ts: every design token
 * the web app paints with, per theme, as the phone can use it.
 *
 * The web declares its tokens as CSS custom properties in
 * agent-hub/src/index.css. Metro cannot read CSS and React Native has no
 * custom properties, so this script does the part of a browser's work that
 * matters: for each theme it computes what `<html data-theme="…">` ends up
 * with.
 *
 *   - The cascade. `:root` is the dark theme and applies to every theme; a
 *     `[data-theme="x"]` block (alone or in a comma list, like the two-set
 *     `--type-*` / `--kind-*` groups) overrides it by coming later at the same
 *     specificity. `[data-theme^="glass"]` and `html[…]` count too. Anything
 *     with a descendant combinator styles some other element and is ignored.
 *   - `var(--x, fallback)`, resolved on the root element, which is what makes
 *     `--type-end: var(--text-primary)` the theme's own ink everywhere.
 *   - `color-mix(in srgb, X n%, transparent)`, which is X at alpha n%: RN has
 *     no colour arithmetic in styles.
 *
 * What the web derives from `--accent-primary` at paint time (an org accent
 * moves it) is emitted twice: resolved with the theme's own accent, and as a
 * recipe (WEB_ACCENT_TINTS, WEB_ACCENT_SHADOWS) that derive.ts applies to an
 * org accent. A token that depends on the accent in any other shape stops
 * the script: derive.ts has to learn it first.
 *
 * Also read: the `--radius-*` base sizes (before `--radius-scale`) and the
 * font choices in agent-hub/src/components/theme/applyTheme.js (FONT_STACKS).
 *
 * Run:    cd mobile && npm run sync:tokens
 * Check:  node scripts/sync-web-tokens.mjs --check   (exit 1 when out of date)
 * Print:  node scripts/sync-web-tokens.mjs --print   (the file, to stdout;
 *         src/core/theme/webTokens.lockstep.test.ts compares it in Jest)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '..');
const WEB_CSS = path.resolve(MOBILE, '../agent-hub/src/index.css');
const WEB_APPLY_THEME = path.resolve(MOBILE, '../agent-hub/src/components/theme/applyTheme.js');
const OUT = path.join(MOBILE, 'src/core/theme/generated/webTokens.generated.ts');

/** The per-theme colours, by CSS name. Keys are the camelCase of the name. */
export const COLOR_VARS = [
    '--bg-primary',
    '--bg-secondary',
    '--bg-tertiary',
    '--bg-card',
    '--bg-card-hover',
    '--accent-primary',
    '--accent-secondary',
    '--accent-primary-hover',
    '--accent-primary-fg',
    '--accent-glow',
    '--success',
    '--success-ink',
    '--warning',
    '--warning-ink',
    '--error',
    '--error-ink',
    '--info',
    '--info-ink',
    '--pinned',
    '--text-primary',
    '--text-secondary',
    '--text-muted',
    '--text-tertiary',
    '--border-subtle',
    '--border-default',
    '--user-bubble-bg',
    '--user-bubble-fg',
    '--bg-tooltip',
    '--text-tooltip',
    '--item-hover-bg',
    '--item-active-bg',
];

/**
 * Token families read by prefix, so a family member the web adds (a new
 * `--kind-*`) shows up here — and in the lockstep test — without anyone
 * remembering to list it. `list` families are numbered slots.
 */
export const GROUPS = [
    { key: 'stepType', prefix: '--type-', doc: 'Flow-editor step families (`--type-*`).' },
    { key: 'kind', prefix: '--kind-', doc: 'Studio object kinds (`--kind-*`).' },
    { key: 'chart', prefix: '--chart-', list: true, doc: 'Chart series, in slot order (`--chart-1…`).' },
    { key: 'pii', prefix: '--pii-cat-', list: true, doc: 'PII categories, in slot order (`--pii-cat-1…`).' },
    { key: 'learn', prefix: '--learn-', doc: 'Learning Center progress colours (`--learn-*`).' },
    { key: 'shadows', prefix: '--shadow-', shadow: true, doc: 'Box shadows (`--shadow-*`), as RN `boxShadow` strings.' },
];

const ACCENT = '--accent-primary';
const ACCENT_SLOT = '{accent}';
const RADII = ['sm', 'md', 'lg', 'xl'];

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/** Index of the bracket that closes the one at `open`, skipping strings. */
function closing(src, open, pair = '{}') {
    let depth = 0;
    let quote = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === quote && src[i - 1] !== '\\') quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === pair[0]) depth++;
        else if (c === pair[1] && --depth === 0) return i;
    }
    throw new Error(`Unbalanced ${pair} from offset ${open}`);
}

/** Split on `sep` where no bracket or string is open. */
export function splitTop(text, sep) {
    const out = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote && text[i - 1] !== '\\') quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === sep && depth === 0) {
            out.push(text.slice(start, i));
            start = i + 1;
        }
    }
    out.push(text.slice(start));
    return out;
}

/** `prop: value` pairs of a block; nested rules (none today) are skipped. */
function declarations(body) {
    const out = [];
    for (const part of splitTop(body, ';')) {
        if (part.includes('{')) continue;
        const colon = part.indexOf(':');
        if (colon === -1) continue;
        const prop = part.slice(0, colon).trim();
        let value = part.slice(colon + 1).trim().replace(/\s+/g, ' ');
        const important = /!important$/.test(value);
        if (important) value = value.replace(/\s*!important$/, '');
        if (prop.startsWith('--')) out.push({ prop, value, important });
    }
    return out;
}

/** Top-level style rules in source order; at-rules (@media, @keyframes, …) are skipped. */
export function parseRules(css) {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    let i = 0;
    while (i < src.length) {
        const brace = src.indexOf('{', i);
        const semi = src.indexOf(';', i);
        const head = src.slice(i, brace === -1 ? src.length : brace).trim();
        if (brace === -1) break;
        if (head.startsWith('@') && semi !== -1 && semi < brace) {
            i = semi + 1; // statement at-rule: @import, @custom-variant
            continue;
        }
        const end = closing(src, brace);
        if (!head.startsWith('@')) {
            rules.push({
                selectors: splitTop(head, ',').map((s) => s.trim().replace(/\s+/g, ' ')),
                decls: declarations(src.slice(brace + 1, end)),
            });
        }
        i = end + 1;
    }
    return rules;
}

const ROOT_SELECTOR = /^(html)?(:root)?((?:\[data-theme(?:\^=|=)"[^"]+"\])*)$/;

/**
 * The specificity with which `selector` matches `<html data-theme="theme">`,
 * as one comparable number, or null when it styles some other element.
 */
export function rootSpecificity(selector, theme) {
    const m = ROOT_SELECTOR.exec(selector);
    if (!m || selector === '') return null;
    const attrs = [...m[3].matchAll(/\[data-theme(\^=|=)"([^"]+)"\]/g)];
    const ok = attrs.every(([, op, v]) => (op === '=' ? theme === v : theme.startsWith(v)));
    if (!ok) return null;
    return ((m[2] ? 1 : 0) + attrs.length) * 100 + (m[1] ? 1 : 0);
}

/** Every custom property on the root element for one theme, unresolved. */
export function cascade(rules, theme) {
    const winners = new Map();
    rules.forEach((rule, order) => {
        const specs = rule.selectors.map((s) => rootSpecificity(s, theme)).filter((s) => s !== null);
        if (!specs.length) return;
        const spec = Math.max(...specs);
        for (const d of rule.decls) {
            const rank = [d.important ? 1 : 0, spec, order];
            const prev = winners.get(d.prop);
            if (!prev || compareRank(rank, prev.rank) >= 0) winners.set(d.prop, { value: d.value, rank });
        }
    });
    return new Map([...winners].map(([prop, w]) => [prop, w.value]));
}

function compareRank(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

/**
 * `value` with every `var()` substituted. `deps` collects each property the
 * value reads, transitively; with `accentSlot`, `--accent-primary` becomes
 * the `{accent}` placeholder instead of its value.
 */
export function substitute(value, props, { deps = new Set(), accentSlot = false, stack = [] } = {}) {
    let out = '';
    let i = 0;
    for (;;) {
        const at = value.indexOf('var(', i);
        if (at === -1) return out + value.slice(i);
        out += value.slice(i, at);
        const end = closing(value, at + 3, '()');
        const [name, ...rest] = splitTop(value.slice(at + 4, end), ',');
        const prop = name.trim();
        const fallback = rest.length ? rest.join(',').trim() : null;
        deps.add(prop);
        if (accentSlot && prop === ACCENT) out += ACCENT_SLOT;
        else if (props.has(prop)) {
            if (stack.includes(prop)) throw new Error(`var() cycle: ${[...stack, prop].join(' → ')}`);
            out += substitute(props.get(prop), props, { deps, accentSlot, stack: [...stack, prop] });
        } else if (fallback !== null) out += substitute(fallback, props, { deps, accentSlot, stack });
        else throw new Error(`${prop} is not declared and has no fallback`);
        i = end + 1;
    }
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const alpha = (a) => String(Number(a));

/** `#ABC` → `#abc`; any rgb()/rgba() → `rgba(r, g, b, a)`; `transparent` as is. */
export function normaliseColor(value) {
    const v = value.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v.toLowerCase();
    if (v === 'transparent') return v;
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
    if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha(m[4] ?? '1')})`;
    const mix = /^color-mix\(in srgb, (#[0-9a-f]{3,6}) ([\d.]+)%, transparent\)$/i.exec(v);
    if (mix) {
        const hex = mix[1].slice(1);
        const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
        const [r, g, b] = [0, 2, 4].map((o) => parseInt(full.slice(o, o + 2), 16));
        return `rgba(${r}, ${g}, ${b}, ${alpha(Number(mix[2]) / 100)})`;
    }
    throw new Error(`Not a colour React Native can paint: ${value}`);
}

/** Every rgba() inside a box-shadow list normalised; lengths kept as written. */
export function normaliseShadow(value) {
    const out = splitTop(value, ',')
        .map((layer) =>
            splitTop(layer.trim(), ' ')
                .filter(Boolean)
                .map((part) => (/^(#|rgba?\()/.test(part) ? normaliseColor(part) : part))
                .join(' '),
        )
        .join(', ');
    for (const layer of splitTop(out, ',')) {
        const lengths = splitTop(layer.trim(), ' ').filter((p) => !/^(#|rgba?\(|\{accent\})/.test(p));
        if (lengths.length < 2 || lengths.length > 4 || !lengths.every((l) => /^-?[\d.]+(px)?$/.test(l))) {
            throw new Error(`Not a box-shadow React Native can parse: ${value}`);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const camel = (name) => name.replace(/^--/, '').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
/** `--shadow-card-hover` in the `--shadow-` family → `cardHover`. */
const member = (prop, prefix) => camel(`--${prop.slice(prefix.length)}`);

/** `:root` (dark) plus every `[data-theme="x"]` block that declares a palette, in source order. */
export function themeNames(rules) {
    const names = ['dark'];
    for (const rule of rules) {
        if (!rule.decls.some((d) => d.prop === '--bg-primary')) continue;
        for (const s of rule.selectors) {
            const m = /^\[data-theme="([^"]+)"\]$/.exec(s);
            if (m && !names.includes(m[1])) names.push(m[1]);
        }
    }
    return names;
}

/** Members of a prefix family, in order of first declaration. */
function familyMembers(rules, prefix) {
    const seen = [];
    for (const rule of rules) {
        for (const d of rule.decls) {
            if (d.prop.startsWith(prefix) && !seen.includes(d.prop)) seen.push(d.prop);
        }
    }
    return seen;
}

function accentRecipe(raw, what) {
    const tint = /^color-mix\(in srgb, \{accent\} ([\d.]+)%, transparent\)$/.exec(raw);
    if (!tint) throw new Error(`${what} follows ${ACCENT} as "${raw}": teach derive.ts that shape first`);
    return Number(tint[1]) / 100;
}

function extractTheme(rules, theme, members, tints, accentShadows) {
    const props = cascade(rules, theme);
    const read = (prop, shadowPrefix) => {
        if (!props.has(prop)) throw new Error(`${prop} is not declared for ${theme}`);
        const deps = new Set();
        const value = substitute(props.get(prop), props, { deps });
        if (shadowPrefix) {
            if (deps.has(ACCENT)) {
                const recipe = normaliseShadow(substitute(props.get(prop), props, { accentSlot: true }));
                (accentShadows[theme] ??= {})[member(prop, shadowPrefix)] = recipe;
            }
            return normaliseShadow(value);
        }
        if (deps.has(ACCENT) && prop !== ACCENT) {
            const key = camel(prop);
            const recipe = substitute(props.get(prop), props, { accentSlot: true });
            const a = accentRecipe(recipe, `${prop} (${theme})`);
            if (key in tints && tints[key] !== a) throw new Error(`${prop} tints the accent differently per theme`);
            tints[key] = a;
        }
        return normaliseColor(value);
    };
    const out = { colors: Object.fromEntries(COLOR_VARS.map((v) => [camel(v), read(v)])) };
    for (const group of GROUPS) {
        const entries = members[group.key].map((prop) => [
            member(prop, group.prefix),
            read(prop, group.shadow ? group.prefix : null),
        ]);
        out[group.key] = group.list ? entries.map(([, v]) => v) : Object.fromEntries(entries);
    }
    return { props, tokens: out };
}

function listMembers(members, prefix) {
    const nums = members.map((p) => Number(p.slice(prefix.length)));
    if (!nums.every((n, i) => n === i + 1)) {
        throw new Error(`${prefix}* is not numbered 1…${nums.length} in order`);
    }
    return members;
}

function radiiBase(props) {
    return Object.fromEntries(
        RADII.map((size) => {
            const raw = props.get(`--radius-${size}`) ?? '';
            const m = /^calc\(([\d.]+)px \* var\(--radius-scale(?:, ?1)?\)\)$/.exec(raw);
            if (!m) throw new Error(`--radius-${size} is not calc(Npx * var(--radius-scale)): "${raw}"`);
            return [size, Number(m[1])];
        }),
    );
}

/** `export const FONT_STACKS = { system: "…", … }` from applyTheme.js. */
export function fontStacks(src) {
    const body = /export const FONT_STACKS\s*=\s*\{([\s\S]*?)\};/.exec(src)?.[1];
    if (!body) throw new Error('No FONT_STACKS object in applyTheme.js');
    const stacks = Object.fromEntries([...body.matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!Object.keys(stacks).length) throw new Error('FONT_STACKS is empty');
    return stacks;
}

/** Everything the generated file holds, as data. */
export function extract({ css, applyThemeSrc }) {
    const rules = parseRules(css);
    const themes = themeNames(rules);
    const members = Object.fromEntries(
        GROUPS.map((g) => {
            const found = familyMembers(rules, g.prefix);
            if (!found.length) throw new Error(`No ${g.prefix}* tokens in index.css`);
            return [g.key, g.list ? listMembers(found, g.prefix) : found];
        }),
    );
    const tints = {};
    const accentShadows = {};
    const tokens = {};
    let radii = null;
    for (const theme of themes) {
        const { props, tokens: t } = extractTheme(rules, theme, members, tints, accentShadows);
        tokens[theme] = t;
        const r = radiiBase(props);
        if (radii && JSON.stringify(radii) !== JSON.stringify(r)) {
            throw new Error(`${theme} has its own --radius-* base`);
        }
        radii = r;
    }
    return { themes, tokens, tints, accentShadows, radii, fonts: fontStacks(applyThemeSrc) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A TS string literal: single-quoted unless the text holds a single quote. */
const q = (s) => {
    if (s.includes("'") && !s.includes('"')) return `"${s}"`;
    return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
};
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k));
const pad = (n) => ' '.repeat(n);

/** A value as a TS literal, 4-space indented, one entry per line. */
function renderValue(value, depth) {
    const inner = pad(depth + 4);
    if (Array.isArray(value)) {
        return `[\n${value.map((v) => `${inner}${q(v)},`).join('\n')}\n${pad(depth)}]`;
    }
    if (typeof value === 'object') {
        const lines = Object.entries(value).map(([k, v]) => `${inner}${key(k)}: ${renderValue(v, depth + 4)},`);
        return `{\n${lines.join('\n')}\n${pad(depth)}}`;
    }
    return typeof value === 'number' ? String(value) : q(value);
}

function renderInterface(name, doc, keys) {
    const fields = keys.map((k) => `    ${key(k)}: string;`).join('\n');
    return `/** ${doc} */\nexport interface ${name} {\n${fields}\n}`;
}

function renderTuple(name, doc, length) {
    return `/** ${doc} */\nexport type ${name} = readonly [${Array(length).fill('string').join(', ')}];`;
}

export function render(data) {
    const first = data.tokens[data.themes[0]];
    const iface = (g) => `Web${g.key.charAt(0).toUpperCase()}${g.key.slice(1)}`;
    const interfaces = [
        renderInterface('WebColors', 'Per-theme colours, as the web computes them on the root element.', [
            ...Object.keys(first.colors),
        ]),
        ...GROUPS.filter((g) => !g.list).map((g) => renderInterface(iface(g), g.doc, Object.keys(first[g.key]))),
        ...GROUPS.filter((g) => g.list).map((g) => renderTuple(iface(g), g.doc, first[g.key].length)),
    ];
    const fields = GROUPS.map((g) => `    ${g.key}: ${iface(g)};`).join('\n');
    const accentShadowType = `Partial<Record<WebTheme, Partial<Record<keyof WebShadows, string>>>>`;

    return `/**
 * GENERATED by scripts/sync-web-tokens.mjs — do not edit. Run
 * \`npm run sync:tokens\` when agent-hub/src/index.css or
 * agent-hub/src/components/theme/applyTheme.js changes
 * (webTokens.lockstep.test.ts fails until then).
 *
 * Each theme's values are what the web computes on <html data-theme="…">:
 * the cascade of :root and the theme's own blocks, var() resolved, and
 * color-mix(…, transparent) turned into rgba().
 */
/* eslint-disable max-lines -- generated: one literal per theme */

/** The web's themes, \`:root\` (dark) first, then in stylesheet order. */
export const WEB_THEMES = [
${data.themes.map((t) => `    ${q(t)},`).join('\n')}
] as const;

export type WebTheme = (typeof WEB_THEMES)[number];

${interfaces.join('\n\n')}

export interface WebThemeTokens {
    colors: WebColors;
${fields}
}

export const WEB_TOKENS: Record<WebTheme, WebThemeTokens> = ${renderValue(data.tokens, 0)};

/**
 * Colours the web mixes from \`--accent-primary\` at paint time: the accent at
 * this alpha. An org accent moves them (derive.ts).
 */
export const WEB_ACCENT_TINTS: Partial<Record<keyof WebColors, number>> = ${renderValue(data.tints, 0)};

/** Shadows that draw in \`--accent-primary\`, with \`${ACCENT_SLOT}\` where the accent goes. */
export const WEB_ACCENT_SHADOWS: ${accentShadowType} = ${renderValue(data.accentShadows, 0)};

/** \`--radius-*\` in px, before \`--radius-scale\`. */
export const WEB_RADII = ${renderValue(data.radii, 0)} as const;

/** The admin font choices (applyTheme.js FONT_STACKS) and the CSS stack each one sets. */
export const WEB_FONT_STACKS = ${renderValue(data.fonts, 0)} as const;
`;
}

/** The file, from the two web sources' text. Pure: the lockstep test runs it. */
export function generate({ css, applyThemeSrc }) {
    return render(extract({ css, applyThemeSrc }));
}

function main() {
    const out = generate({
        css: fs.readFileSync(WEB_CSS, 'utf8'),
        applyThemeSrc: fs.readFileSync(WEB_APPLY_THEME, 'utf8'),
    });
    if (process.argv.includes('--print')) {
        process.stdout.write(out);
        return;
    }
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (process.argv.includes('--check')) {
        if (current !== out) {
            console.error(`${path.relative(MOBILE, OUT)} is out of date: run npm run sync:tokens`);
            process.exit(1);
        }
        return;
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    if (current !== out) fs.writeFileSync(OUT, out);
    console.log(`${path.relative(MOBILE, OUT)}: ${current === out ? 'up to date' : 'written'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
