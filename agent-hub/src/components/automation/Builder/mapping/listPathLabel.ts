/**
 * A list's path as a person reads it: "Read the purchasing inbox ▸ Value ▸
 * Attachments (inside each row)" for `steps.s1.output.value[*].attachments`.
 *
 * Every key on the way is named (a list three levels down is not "Trigger ▸
 * Data"), a `[*]` becomes the "(inside each row)" note, a match segment reads
 * as the entry it picks (`headers[name="Subject"]` → "Subject"), an index as
 * "#1", and the per-item envelope's own `output` key is left out. Never the
 * path syntax itself: the raw path belongs in a title attribute.
 */
import { parsePath } from '@shared/expr/path.mjs';
import { humanizeFieldKey } from '../flow/displayHelpers';

type Tok = { type: string; key?: string | number; value?: unknown };
type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

const MAX_PARTS = 4;

function headOf(tokens: Tok[], stepLabelById: Pick<Map<string, string>, 'get'> | null | undefined, t: Translate | null): { head: string; from: number } {
    const tr = (key: string, en: string, vars: Record<string, unknown> = {}) => (t ? t(key, en, vars) : en.replace(/\{(\w+)\}/g, (_, v) => String(vars[v] ?? '')));
    const k0 = String(tokens[0]?.key ?? '');
    const k1 = String(tokens[1]?.key ?? '');
    const afterOutput = (i: number) => (tokens[i]?.key === 'output' ? i + 1 : i);
    switch (k0) {
        case 'steps': return { head: stepLabelById?.get?.(k1) || tr('automations.builder.previous_step', 'Previous step'), from: afterOutput(2) };
        case 'loop': return { head: tr('automations.builder.each_named', 'Each {name}', { name: k1 || 'item' }), from: 2 };
        case 'trigger': return { head: tr('automations.builder.trigger_word', 'Trigger'), from: afterOutput(1) };
        case 'vars': return { head: tr('automations.builder.variable_word', 'Variable'), from: 1 };
        default: return { head: humanizeFieldKey(k0), from: 1 };
    }
}

/** The named steps after the head; `inside` when a `[*]` has more path after it. */
function partsOf(tokens: Tok[], from: number): { parts: string[]; inside: boolean } {
    const parts: string[] = [];
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
        parts.push(humanizeFieldKey(String(tok.key)));
    }
    return { parts, inside };
}

export function listPathLabel(path: string, stepLabelById: Pick<Map<string, string>, 'get'> | null | undefined = null, t: Translate | null = null): string {
    const tokens = parsePath(String(path || '').trim()) as Tok[] | null;
    if (!tokens || !tokens.length) return humanizeFieldKey(String(path || ''));
    const { head, from } = headOf(tokens, stepLabelById, t);
    const { parts, inside } = partsOf(tokens, from);
    const shown = parts.length > MAX_PARTS ? [parts[0], '…', ...parts.slice(-(MAX_PARTS - 1))] : parts;
    const label = [head, ...shown].join(' ▸ ');
    if (!inside) return label;
    return t ? t('automations.builder.inside_each_row', '{label} (inside each row)', { label }) : `${label} (inside each row)`;
}
