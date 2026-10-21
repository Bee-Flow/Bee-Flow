import type { TableOption } from './TableSourceField';

interface FieldLike { key: string; path: string; sample?: unknown; children?: FieldLike[] }
interface GroupLike { id: string; label: string; kind: string; fields?: FieldLike[] }

const MAX_DEPTH = 3;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A form's file answer, or the handle of a file an earlier step made. */
function fileKind(field: FieldLike): 'upload' | 'generated' | null {
    if (isRecord(field.sample) && field.sample.kind === 'form_upload') return 'upload';
    if (field.key === 'sourceHandle' && isRecord(field.sample) && field.sample.kind === 'generated_file') return 'generated';
    return null;
}

/**
 * The files a Read table step can open: the file answers of the form that
 * started the automation, and the files that earlier steps wrote (a document,
 * a presentation). Found in the fields the earlier steps offer, so nothing is
 * suggested that the run will not have.
 */
export function fileOptions(groups: readonly GroupLike[]): TableOption[] {
    const out: TableOption[] = [];
    const seen = new Set<string>();
    const walk = (group: GroupLike, fields: readonly FieldLike[], depth: number) => {
        for (const f of fields) {
            const kind = fileKind(f);
            if (kind && !seen.has(f.path)) {
                seen.add(f.path);
                out.push({ path: f.path, stepId: group.id, label: kind === 'upload' ? `${group.label} · ${f.key}` : group.label });
            } else if (depth < MAX_DEPTH && f.children) walk(group, f.children, depth + 1);
        }
    };
    for (const g of groups) walk(g, g.fields || [], 0);
    return out;
}
