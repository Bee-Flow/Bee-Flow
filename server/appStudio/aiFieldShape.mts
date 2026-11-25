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

export interface SchemaField extends FieldShape<SchemaField> {
    name: string;
    type: string;
    description: string;
    required: boolean;
}

type PropertySchema = {
    type: string;
    description?: string;
    items?: PropertySchema;
    properties?: ObjectSchema['properties'];
    additionalProperties?: boolean;
};

type ObjectSchema = {
    type: 'object';
    properties: Record<string, Omit<PropertySchema, 'type'> & { type: string | string[] }>;
    required: string[];
    additionalProperties: boolean;
};

/** A normalized output field or item declaration → JSON Schema. */
function fieldToJsonSchema(field: SchemaField): PropertySchema {
    const description = field.description?.trim();
    const annotations = description ? { description } : {};
    switch (field.type) {
        case 'date': return { type: 'string', description: [description, 'ISO 8601 date (YYYY-MM-DD)'].filter(Boolean).join(' — ') };
        case 'array': {
            const item = field.items;
            const items = item?.type === 'object' ? objectSchema(item.fields || []) : { type: item?.type || 'string' };
            return { type: 'array', items, ...annotations };
        }
        case 'object':
            // A legacy free-form object still takes the non-strict tool route.
            return { ...(field.fields ? objectSchema(field.fields) : { type: 'object', properties: {}, additionalProperties: true }), ...annotations };
        default: return { type: field.type, ...annotations };
    }
}

export function objectSchema(fields: SchemaField[]): ObjectSchema {
    const properties: ObjectSchema['properties'] = {};
    for (const field of fields) {
        const schema = fieldToJsonSchema(field);
        properties[field.name] = field.required ? schema : { ...schema, type: [schema.type, 'null'] };
    }
    return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
