/**
 * Changing a saved field's type while its table holds rows: which types the
 * designer offers, and the conversions the server refused or previewed
 * (PUT /:id/schema). Its own module: TableDesigner and useDataModel both read
 * it, and tablesManagerModel already imports TableDesigner.
 */

/**
 * The types a SAVED field may change to while its table holds rows: the
 * conversions the server runs in place (text ⇄ select, number ⇄ text; whole
 * numbers are a number too). The field's own type is always first. Mirrors
 * SAFE_CONVERSIONS in server/core/dataEngine/dataModel/fieldConversion.mts.
 */
const SAFE_TARGETS: Record<string, string[]> = {
    text: ['select', 'number'],
    select: ['text'],
    number: ['text'],
};

export function safeTargetTypes(savedType: string | undefined): string[] {
    const own = savedType || 'text';
    return [own, ...(SAFE_TARGETS[own] || [])];
}

/** One conversion the server refused or previewed (PUT /:id/schema report). */
export interface ConversionEntry {
    tableId?: string;
    table?: string;
    fieldId?: string;
    field?: string;
    from?: string;
    to?: string;
    rows?: number | null;
    unconvertible?: number | null;
    samples?: string[];
}

/** The conversions that hold values the new type cannot store. */
export function blockedConversions(list: ConversionEntry[] | null | undefined): ConversionEntry[] {
    return (Array.isArray(list) ? list : []).filter((c) => typeof c.unconvertible === 'number' && c.unconvertible > 0);
}
