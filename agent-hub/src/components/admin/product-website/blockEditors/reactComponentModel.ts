/**
 * The pure part of the React component block editor: the block's content
 * shape, compiler diagnostics as editor markers, and the field list edits.
 * No React, no Monaco, no esbuild: everything here is a function of its input.
 */
import { FIELD_TYPES, isPropName } from '@shared/cmsReact/compile.mjs';

export interface ReactField {
    name: string;
    label?: string;
    type: string;
    options?: string[];
    help?: string;
}

/** A type, not an interface: it has to fit the editors' `Record<string, unknown>` content blob. */
export type ReactComponentData = {
    source?: string;
    css?: string;
    fields?: ReactField[];
    props?: Record<string, unknown>;
    width?: string;
    minHeight?: number;
    compiled?: string;
    compileError?: string;
};

export interface CompileDiagnostic { line: number; column: number; text: string }

export type CompileResult =
    | { ok: true; code: string; diagnostics: CompileDiagnostic[] }
    | { ok: false; error: string; diagnostics: CompileDiagnostic[] };

/** Monaco's IMarkerData, without a Monaco import. */
export interface EditorMarker {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    message: string;
    severity: number;
    source: string;
}

/** Monaco's MarkerSeverity.Error. */
const SEVERITY_ERROR = 8;

export const FIELD_TYPE_LIST: readonly string[] = FIELD_TYPES;

/**
 * One marker per diagnostic. esbuild's line is 1-based and its column
 * 0-based; a diagnostic without a place (0/0) marks the first line.
 */
export function markersFromDiagnostics(diagnostics: CompileDiagnostic[] | null | undefined): EditorMarker[] {
    return (diagnostics || []).map((d) => {
        const line = Number.isFinite(d.line) && d.line > 0 ? d.line : 1;
        const column = Number.isFinite(d.column) && d.column >= 0 ? d.column + 1 : 1;
        return {
            startLineNumber: line,
            startColumn: column,
            endLineNumber: line,
            endColumn: column + 1,
            message: d.text,
            severity: SEVERITY_ERROR,
            source: 'esbuild',
        };
    });
}

/** The well-formed fields of a block (an AI or an import may hand anything). */
export function fieldsOf(data: ReactComponentData | null | undefined): ReactField[] {
    const list = Array.isArray(data?.fields) ? data.fields : [];
    return list.filter((f): f is ReactField => !!f && typeof f === 'object' && typeof f.name === 'string' && typeof f.type === 'string');
}

export function propsOf(data: ReactComponentData | null | undefined): Record<string, unknown> {
    const p = data?.props;
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

/** The value a new prop of this type starts with. */
export function emptyValueFor(type: string, options?: string[]): unknown {
    if (type === 'number') return 0;
    if (type === 'boolean') return false;
    if (type === 'select') return options && options.length ? options[0] : '';
    if (type === 'link') return { kind: 'external', url: '' };
    return '';
}

/** A free prop name: `prop`, `prop2`, … */
export function nextFieldName(fields: ReactField[]): string {
    const taken = new Set(fields.map((f) => f.name));
    if (!taken.has('prop')) return 'prop';
    let i = 2;
    while (taken.has(`prop${i}`)) i += 1;
    return `prop${i}`;
}

/** Why a field's name cannot be used ('' when it can). */
export function fieldNameProblem(name: string, index: number, fields: ReactField[]): 'invalid' | 'duplicate' | '' {
    if (!isPropName(name)) return 'invalid';
    if (fields.some((f, i) => i !== index && f.name === name)) return 'duplicate';
    return '';
}

/**
 * The fields after one field changed, with the props kept in step: a renamed
 * field takes its value along, a field whose type changes starts from that
 * type's empty value.
 */
export function updateField(
    fields: ReactField[],
    props: Record<string, unknown>,
    index: number,
    next: ReactField,
): { fields: ReactField[]; props: Record<string, unknown> } {
    const prev = fields[index];
    const outFields = fields.map((f, i) => (i === index ? next : f));
    const outProps = { ...props };
    if (prev && prev.name !== next.name) {
        if (prev.name in outProps && !(next.name in outProps)) outProps[next.name] = outProps[prev.name];
        delete outProps[prev.name];
    }
    if (prev && prev.type !== next.type) outProps[next.name] = emptyValueFor(next.type, next.options);
    return { fields: outFields, props: outProps };
}

/**
 * The props after the field list changed as a whole (added, removed, moved):
 * a removed field's value goes, a new field gets its type's empty value, and
 * a prop no field declares (set through the MCP tool, say) stays.
 */
export function propsForFields(prev: ReactField[], next: ReactField[], props: Record<string, unknown>): Record<string, unknown> {
    const kept = new Set(next.map((f) => f.name));
    const out: Record<string, unknown> = { ...props };
    for (const f of prev) if (!kept.has(f.name)) delete out[f.name];
    for (const f of next) if (!(f.name in out)) out[f.name] = emptyValueFor(f.type, f.options);
    return out;
}

/** "a, b , c" -> ['a', 'b', 'c'] */
export function parseOptions(text: string): string[] {
    return text.split(',').map((s) => s.trim()).filter(Boolean);
}
