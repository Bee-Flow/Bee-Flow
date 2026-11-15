/**
 * `images` of an ai_step / data_extraction as the builder hands them in: a
 * list of bindings to the image a "read file" step read (its `sourceHandle`,
 * or the whole output of a read that ran per file). A bare path string is
 * upgraded to a ref; anything else is refused with a sentence the model can
 * act on. The same shape the validator holds them to
 * (validate/stepRules/imageRules.mts), so an added and a patched step agree.
 */

import { MAX_IMAGE_BINDINGS } from '../validate/stepRules/imageRules.mts';

const BINDING_KINDS = new Set(['ref', 'template', 'literal', 'expr']);

export type ImageBinding = { kind: string; [key: string]: unknown };

const SHAPE = 'images is a list of bindings to an image a "read file" step read, e.g. [{kind:"ref", path:"steps.<read>.output.sourceHandle"}].';

/** `{ images }` (empty when nothing was given), or a model-readable `{ error }`. */
export function sanitizeImageBindings(raw: unknown): { images: ImageBinding[]; error?: undefined } | { error: string; images?: undefined } {
    if (raw === undefined || raw === null) return { images: [] };
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length > MAX_IMAGE_BINDINGS) return { error: `images: at most ${MAX_IMAGE_BINDINGS} bindings. Bind the output of the read step that read them all once instead.` };
    const images: ImageBinding[] = [];
    for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (typeof b === 'string' && b.trim()) { images.push({ kind: 'ref', path: b.trim() }); continue; }
        if (b && typeof b === 'object' && !Array.isArray(b) && typeof (b as { kind?: unknown }).kind === 'string' && BINDING_KINDS.has((b as { kind: string }).kind)) {
            images.push(b as ImageBinding);
            continue;
        }
        return { error: `images[${i}]: not a binding. ${SHAPE}` };
    }
    return { images };
}
