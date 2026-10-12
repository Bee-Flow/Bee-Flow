/**
 * A list's path as a person reads it: "Read the purchasing inbox ▸ Value ▸
 * Attachments (inside each row)" for `steps.s1.output.value[*].attachments`.
 *
 * The naming itself lives in the shared engine (vendor/pathLabel.mjs, the
 * web's file byte for byte); this wrapper only supplies the phone's own
 * humanizeFieldKey. deepen.lockstep.test.ts holds the two together.
 */
import { listPathLabel as sharedListPathLabel } from '@/shared/expr';
import { humanizeFieldKey } from '@/shared/lib/humanizeKey';

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;
type Lookup = Pick<Map<string, string>, 'get'> | null | undefined;

/**
 * `stepTypeById` (optional) tells which steps are Conditions, so the list one
 * keeps (`items`) reads as the Condition's name rather than "Items".
 *
 * `compact` is the canvas card's form: a list inside each row of another
 * reads as the step and the inner list only ("Read many ▸ Attachments"), no
 * note in brackets; the editor's "Working through" shows the whole chain.
 */
export function listPathLabel(
    path: string,
    stepLabelById: Lookup = null,
    t: Translate | null = null,
    { compact = false, stepTypeById = null }: { compact?: boolean; stepTypeById?: Lookup } = {},
): string {
    return sharedListPathLabel(path, stepLabelById, t, { compact, stepTypeById, humanize: humanizeFieldKey });
}
