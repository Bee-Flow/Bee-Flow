import type { StudioFieldOption } from './studioFieldOptions';

/**
 * The fixed values of the radio and select inputs of a definition, by the path a condition reads
 * them at (`form.<name>`), for the condition builder's right-hand side: "Status is [Open]"
 * instead of a text box the author must spell the value into. Only literal `options` count (an
 * input fed by `valueFrom`/`optionsFrom` has no list the editor knows); two inputs with one name
 * give the values of both. Bounded by the walk depth and the options each input may hold.
 */

export interface ValueChoice { value: string; label?: string }

const CHOICE_TYPES = new Set(['radio', 'input_select']);
const MAX_DEPTH = 32;

type Node = { type?: unknown; props?: { name?: unknown; options?: unknown }; children?: unknown };

function choicesOf(options: unknown): ValueChoice[] {
    if (!Array.isArray(options)) return [];
    const out: ValueChoice[] = [];
    for (const o of options) {
        if (typeof o === 'string' && o) out.push({ value: o });
        else if (o && typeof o === 'object' && typeof (o as ValueChoice).value === 'string' && (o as ValueChoice).value) {
            const { value, label } = o as ValueChoice;
            out.push(typeof label === 'string' && label ? { value, label } : { value });
        }
    }
    return out;
}

function walk(nodes: unknown, depth: number, into: Map<string, ValueChoice[]>): void {
    if (!Array.isArray(nodes) || depth > MAX_DEPTH) return;
    for (const raw of nodes) {
        const node = raw as Node | null;
        if (!node || typeof node !== 'object') continue;
        const name = node.props?.name;
        if (CHOICE_TYPES.has(String(node.type)) && typeof name === 'string' && name) {
            const list = into.get(`form.${name}`) ?? [];
            for (const c of choicesOf(node.props?.options)) if (!list.some((x) => x.value === c.value)) list.push(c);
            if (list.length) into.set(`form.${name}`, list);
        }
        walk(node.children, depth + 1, into);
    }
}

/** `form.<name>` → the literal values of the radio and select inputs with that name. */
export function inputValueOptions(definition: unknown): Map<string, ValueChoice[]> {
    const out = new Map<string, ValueChoice[]>();
    const screens = (definition as { screens?: unknown } | null | undefined)?.screens;
    for (const screen of Array.isArray(screens) ? screens : []) {
        const sections = (screen as { sections?: unknown } | null)?.sections;
        for (const section of Array.isArray(sections) ? sections : []) walk((section as { children?: unknown } | null)?.children, 0, out);
    }
    return out;
}

/** The field options with each radio or select input's values attached. */
export function withValueOptions(options: StudioFieldOption[], definition: unknown): Array<StudioFieldOption & { valueOptions?: ValueChoice[] }> {
    const values = inputValueOptions(definition);
    if (!values.size) return options;
    return options.map((o) => (values.has(o.path) ? { ...o, valueOptions: values.get(o.path) } : o));
}
