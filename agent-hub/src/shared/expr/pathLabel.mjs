/**
 * A list's path as a person reads it: "Read the purchasing inbox ▸ Value ▸
 * Attachments (inside each row)" for `steps.s1.output.value[*].attachments`.
 *
 * Every key on the way is named (a list three levels down is not "Trigger ▸
 * Data"), a `[*]` becomes the "(inside each row)" note, a match segment reads
 * as the entry it picks (`headers[name="Subject"]` → "Subject"), an index as
 * "#1", and the per-item envelope's own `output` key is left out. Never the
 * path syntax itself: the raw path belongs in a title attribute.
 *
 * One copy for the web builder and the phone (both wrap it with their own
 * humanizeFieldKey); it used to be written twice and drifted.
 */
import { parsePath } from './path.mjs';

const ROUTE_TYPES = new Set(['filter', 'switch']);

const MAX_PARTS = 4;

function fill(en, vars) {
    return en.replace(/\{(\w+)\}/g, (_, v) => String(vars[v] ?? ''));
}

function translator(t) {
    return (key, en, vars = {}) => (t ? t(key, en, vars) : fill(en, vars));
}

function headOf(tokens, stepLabelById, tr, humanize) {
    const k0 = String(tokens[0]?.key ?? '');
    const k1 = String(tokens[1]?.key ?? '');
    const afterOutput = (i) => (tokens[i]?.key === 'output' ? i + 1 : i);
    switch (k0) {
        case 'steps': return { head: stepLabelById?.get?.(k1) || tr('automations.builder.previous_step', 'Previous step'), from: afterOutput(2) };
        case 'loop': return { head: tr('automations.builder.each_named', 'Each {name}', { name: k1 || 'item' }), from: 2 };
        // A rule's own item (a Condition's `item.subject`): "Each item ▸ Subject".
        case 'item': return { head: tr('automations.builder.each_named', 'Each {name}', { name: 'item' }), from: 1 };
        case 'trigger': return { head: tr('automations.builder.trigger_word', 'Trigger'), from: afterOutput(1) };
        case 'vars': return { head: tr('automations.builder.variable_word', 'Variable'), from: 1 };
        default: return { head: humanize(k0), from: 1 };
    }
}

function keyAt(tokens, i) {
    const tok = tokens[i];
    return tok && tok.type === 'prop' ? String(tok.key) : '';
}

/**
 * A Condition's own output keys are how the runner files its result, not names
 * the author gave: `matchesByCase.<name>` reads as the output's name as typed
 * ("pdf"), its `default` as "Otherwise", and a list Condition's `items` (what
 * it keeps) as the Condition itself. `items` is only dropped when the step is
 * known to be a Condition: other steps have lists called "Items" too.
 */
function routeOutput(tokens, from, stepTypeById, tr) {
    const onStepOutput = from === 3 && keyAt(tokens, 0) === 'steps' && keyAt(tokens, 2) === 'output';
    if (!onStepOutput) return { lead: [], from };
    const key = keyAt(tokens, 3);
    const name = keyAt(tokens, 4);
    if (key === 'matchesByCase' && name) {
        return { lead: [name === 'default' ? tr('condition_node.otherwise.label', 'Otherwise') : name], from: 5 };
    }
    const type = stepTypeById?.get?.(keyAt(tokens, 1));
    return key === 'items' && ROUTE_TYPES.has(type ?? '') ? { lead: [], from: 4 } : { lead: [], from };
}

/** The named steps after the head; `inside` when a `[*]` has more path after it. */
function partsOf(tokens, from, humanize) {
    const parts = [];
    let inside = false;
    for (let i = from; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok) continue;
        if (tok.type === 'wild') { if (i < tokens.length - 1) inside = true; continue; }
        if (tok.type === 'match') { parts.push(String(tok.value)); continue; }
        if (typeof tok.key === 'number') { parts.push(`#${tok.key < 0 ? tok.key : tok.key + 1}`); continue; }
        // `results[*].output.x`: the envelope's `output` is how the runner files
        // one run's result, not something the author named.
        if (tok.key === 'output' && tokens[i - 1]?.type === 'wild' && tokens[i - 2]?.key === 'results') continue;
        parts.push(humanize(String(tok.key)));
    }
    return { parts, inside };
}

/**
 * `stepTypeById` (optional) tells which steps are Conditions, so the list one
 * keeps (`items`) reads as the Condition's name rather than "Items".
 *
 * `compact` is the canvas card's form: a list inside each row of another
 * reads as the step and the inner list only ("Read many ▸ Attachments"), no
 * note in brackets; the editor's "Working through" shows the whole chain.
 *
 * `humanize` turns one key into words ("fromEmail" → "From email"); the
 * caller passes its own, so the labels match the rest of its screen.
 *
 * @param {string} path
 * @param {{ get(key: string): string | undefined } | null} [stepLabelById]
 * @param {((key: string, fallback: string, vars?: Record<string, unknown>) => string) | null} [t]
 * @param {{ compact?: boolean, stepTypeById?: { get(key: string): string | undefined } | null, humanize?: (key: string) => string }} [opts]
 * @returns {string}
 */
export function listPathLabel(path, stepLabelById = null, t = null, opts = {}) {
    const { compact = false, stepTypeById = null, humanize = String } = opts || {};
    const tokens = parsePath(String(path || '').trim());
    if (!tokens || !tokens.length) return humanize(String(path || ''));
    const tr = translator(t);
    const { head, from: afterHead } = headOf(tokens, stepLabelById, tr, humanize);
    const { lead, from } = routeOutput(tokens, afterHead, stepTypeById, tr);
    const rest = partsOf(tokens, from, humanize);
    const parts = [...lead, ...rest.parts];
    if (compact && rest.inside) return [head, parts[parts.length - 1]].filter(Boolean).join(' ▸ ');
    const shown = parts.length > MAX_PARTS ? [parts[0], '…', ...parts.slice(-(MAX_PARTS - 1))] : parts;
    const label = [head, ...shown].join(' ▸ ');
    if (!rest.inside) return label;
    return tr('automations.builder.inside_each_row', '{label} (inside each row)', { label });
}
