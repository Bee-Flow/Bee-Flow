/**
 * The field-label contract (port of agent-hub
 * `Builder/mapping/upstream/routeFieldLabel.ts`): a field the runner files
 * under an internal key carries the name a person gave it. A Condition's
 * outputs live at `steps.<id>.output.matchesByCase.<name>`; the variable
 * picker and the rule's field options then show "pdf" and "Otherwise", not
 * "matchesByCase.pdf" or "default".
 *
 * `label` is already in words; `labelKey`, when set, is its i18n key (the
 * label is that key's English), so the field itself stays language-free and
 * equal to the web's (upstream.lockstep.test.ts).
 */
import { parsePath } from '@/shared/expr';

export interface FieldLabel {
    label: string;
    labelKey?: string;
}

// The English of the key, read only through fieldLabelText's t(labelKey, label).
const OTHERWISE_FALLBACK = 'Otherwise';
const OTHERWISE: FieldLabel = Object.freeze({ label: OTHERWISE_FALLBACK, labelKey: 'condition_node.otherwise.label' });

type Token = { type: string; key?: unknown };

/** The label of a Condition output's path, or null for any other path. */
export function routeFieldLabel(path: string): FieldLabel | null {
    // Cheap gate first: the tree builds thousands of fields.
    if (typeof path !== 'string' || !path.includes('matchesByCase')) return null;
    const tokens = parsePath(path) as Token[] | null;
    if (!tokens || tokens.length !== 5 || tokens.some((tk) => tk.type !== 'prop')) return null;
    const [steps, , output, byCase, name] = tokens.map((tk) => tk.key);
    if (steps !== 'steps' || output !== 'output' || byCase !== 'matchesByCase' || typeof name !== 'string' || !name) return null;
    return name === 'default' ? { ...OTHERWISE } : { label: name };
}

type Translate = (key: string, fallback: string) => string;

/** A field's own label in the reader's language, or null when it carries none. */
export function fieldLabelText(field: { label?: unknown; labelKey?: unknown } | null | undefined, t: Translate): string | null {
    if (!field || typeof field.label !== 'string' || !field.label) return null;
    return typeof field.labelKey === 'string' && field.labelKey ? t(field.labelKey, field.label) : field.label;
}
