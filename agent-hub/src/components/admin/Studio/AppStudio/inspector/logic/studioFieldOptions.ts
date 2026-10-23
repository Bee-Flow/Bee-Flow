import { humanizeFieldKey } from '../../../../../automation/Builder/flow/displayHelpers';

/** One variable in a group: `path` is what an expression writes. */
export interface StudioScopeField {
    key: string;
    path: string;
    label?: string;
    sample: unknown;
    children?: StudioScopeField[];
}

/** One group of variables, as buildStudioScope returns it. */
export interface StudioFieldGroup {
    id: string;
    label: string;
    kind: string;
    basePath: string;
    fields: StudioScopeField[];
}

/** What FieldPicker lists. */
export interface StudioFieldOption {
    path: string;
    label: string;
    sample: unknown;
    group: string | undefined;
}

/**
 * Flatten the Studio variable GROUPS into the flat option list FieldPicker
 * wants, so the left-hand side of a condition row is a searchable list of
 * names — "Quantity", "Email", "Status" — instead of a box you must know to
 * fill with `form.quantity`.
 *
 * Groups come from buildStudioScope (StudioScopeProvider); the shape is
 * `{ label, fields: [{ key, path, sample, children? }] }`. Children are
 * flattened in too: a picker that lists `currentUser` but not
 * `currentUser.email` is a list of things you cannot compare.
 */
export default function studioFieldOptions(groups: StudioFieldGroup[] | null | undefined): StudioFieldOption[] {
    const out: StudioFieldOption[] = [];
    const push = (field: StudioScopeField | null | undefined, groupLabel: string | undefined): void => {
        if (!field || typeof field.path !== 'string' || !field.path) return;
        out.push({
            path: field.path,
            label: field.label || humanizeFieldKey(field.key || field.path),
            sample: field.sample,
            group: groupLabel,
        });
        for (const child of Array.isArray(field.children) ? field.children : []) {
            push(child, groupLabel);
        }
    };
    for (const group of Array.isArray(groups) ? groups : []) {
        for (const field of Array.isArray(group?.fields) ? group.fields : []) {
            push(field, group.label || group.id);
        }
    }
    return out;
}
