/**
 * The declarative format's semantics, pure: how a field reads and writes the
 * draft, when it shows, what its words say, and how a spec's step becomes a
 * draft and its draft a patch (formState's pair, plus the spec's own keys).
 * DeclarativeEditor renders with these; specs.test.ts runs every spec's
 * round trip through them without rendering anything.
 */

import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, deepEqual, extractFormState, type FormDraft, type StepPatch } from '@/features/flow-editor/formState';

import type { EditorSpec, FieldSpec, Msg, OptionSpec, Options, SpecContext, Words } from './spec';

type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** `a.b.c` inside a draft. */
export function getPath(obj: unknown, path: string): unknown {
    let cur: unknown = obj;
    for (const seg of path.split('.')) {
        if (!isRecord(cur)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/** A copy of `obj` with `a.b.c` set, every object on the way copied (never mutated). */
export function setPath(obj: FormDraft, path: string, value: unknown): FormDraft {
    const [head, ...rest] = path.split('.');
    const key = head as string;
    if (!rest.length) return { ...obj, [key]: value };
    const inner = isRecord(obj[key]) ? (obj[key] as FormDraft) : {};
    return { ...obj, [key]: setPath(inner, rest.join('.'), value) };
}

export function fieldId(field: FieldSpec): string {
    return field.id ?? field.key ?? field.kind;
}

export function readField(field: FieldSpec, draft: FormDraft, ctx: SpecContext): unknown {
    if (field.read) return field.read(draft, ctx);
    return field.key ? getPath(draft, field.key) : undefined;
}

/** The draft after a field changes. */
export function writeField(field: FieldSpec, value: unknown, draft: FormDraft, ctx: SpecContext): FormDraft {
    if (field.write) return { ...draft, ...field.write(value, draft, ctx) };
    return field.key ? setPath(draft, field.key, value) : draft;
}

export function isVisible(field: FieldSpec, draft: FormDraft, ctx: SpecContext): boolean {
    return field.visibleWhen ? field.visibleWhen(draft, ctx) : true;
}

export function resolveWords(words: Words | undefined, draft: FormDraft, ctx: SpecContext): Msg | null {
    if (!words) return null;
    return typeof words === 'function' ? words(draft, ctx) : words;
}

export function say(t: Translate, words: Msg | string | null | undefined): string {
    if (words == null) return '';
    return typeof words === 'string' ? words : t(words[0], words[1], words[2] as Record<string, string | number> | undefined);
}

export function resolveOptions(options: Options, draft: FormDraft, ctx: SpecContext): readonly OptionSpec[] {
    return typeof options === 'function' ? options(draft, ctx) : options;
}

/** The step as the spec's form edits it. */
export function specDraft(spec: EditorSpec | null | undefined, step: FlowNode): FormDraft {
    const base = extractFormState(step);
    return spec?.extract ? { ...base, ...spec.extract(step) } : base;
}

/**
 * The draft as the patch to save: formState's (only what changed), plus the
 * spec's own keys, again only where they differ from the step.
 */
export function specPatch(spec: EditorSpec | null | undefined, step: FlowNode, draft: FormDraft): StepPatch {
    const patch = buildPatch(step, draft);
    if (!spec?.patch) return patch;
    const own: StepPatch = {};
    spec.patch(own, step, draft);
    for (const [k, v] of Object.entries(own)) {
        if (!deepEqual(v, step[k])) patch[k] = v;
    }
    return patch;
}

/**
 * The draft keys a spec's plain fields edit — each must be a key its step's
 * draft carries, or buildPatch would drop the edit (the "looks saved, saves
 * nothing" bug the web's formState keeps a post-mortem list of).
 */
export function specKeys(spec: EditorSpec): string[] {
    const keys = new Set<string>();
    for (const section of spec.sections) {
        for (const field of section.fields) {
            if (field.key && !field.write) keys.add(field.key.split('.')[0] as string);
        }
    }
    return [...keys];
}
