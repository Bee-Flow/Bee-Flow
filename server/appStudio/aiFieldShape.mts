// Array item declarations share their nested field vocabulary with the enclosing AI step.
export const AI_ITEM_TYPES = ['string', 'number', 'boolean', 'object'];

type FieldShape<T> = { fields?: T[], items?: { type: string, fields?: T[] } };

export function cleanFieldShape<T>(
    field: { type?: unknown, fields?: unknown, items?: { type?: string, fields?: unknown } },
    cleanFields: (fields: unknown, suffix: string) => T[],
): FieldShape<T> {
    if (field.type === 'object' && Array.isArray(field.fields)) {
        return { fields: cleanFields(field.fields, 'fields') };
    }
    const item = field.items;
    if (field.type !== 'array' || !item?.type || !AI_ITEM_TYPES.includes(item.type)) return {};
    if (item.type === 'object' && Array.isArray(item.fields)) {
        return { items: { type: item.type, fields: cleanFields(item.fields, 'items.fields') } };
    }
    return { items: { type: item.type } };
}
