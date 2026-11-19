/**
 * Tool definitions (OpenAI function-calling format) and argument schemas (zod)
 * for the 2BA integration. Pure data and parsing: the executor is twobaTools.mts.
 *
 * Every argument is shape-checked before anything goes to 2BA: the supplier GLN
 * is 13 digits with a valid check digit, codes are short printable text, the
 * number of lines is capped (TWOBA_MAX_ITEMS, default 200, 0 = unlimited). A
 * quantity may come as text from a spreadsheet ("30", "2,5").
 */

import { createRequire } from 'node:module';
import { isValidGln } from './twobaPricing.mts';

const nodeRequire = createRequire(import.meta.url);
const { z } = nodeRequire('../utils/zod.js') as typeof import('../utils/zod.js');
const { envInt } = nodeRequire('../utils/envNumber.mts') as typeof import('../utils/envNumber.mts');

export const DEFAULT_MAX_ITEMS = 200;
export const PROCESS_MODES = ['DoNotProcess', 'ProcessIfAllOk', 'ProcessAlways'] as const;

/** Lines per twoba_find_trade_items call; Infinity when TWOBA_MAX_ITEMS is 0. */
export function maxItems(): number {
    const n = envInt('TWOBA_MAX_ITEMS', DEFAULT_MAX_ITEMS, { min: 0 });
    return n === 0 ? Infinity : n;
}

/** One tool in the OpenAI function-calling format. */
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
    ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required } } });
export type ToolDef = ReturnType<typeof tool>;
const text = (description: string) => ({ type: 'string', description });
const GLN = text('GLN of the supplier (wholesaler) whose prices to use: 13 digits, such as 8711389000001.');
const PROJECT = text('Project number agreed with the supplier, for project prices from the Online Condition Server (optional).');

export const TWOBA_TOOLS: ToolDef[] = [
    tool('twoba_find_trade_items',
        'Look up the lines of a bill of materials at one supplier in 2BA and get the NET purchase price per line, computed by 2BA from the condition files (discount agreements) in the customer\'s 2BA Online Condition Server. '
        + 'Give per line the supplier article number (tradeItemId) and/or the GTIN (EAN), the quantity and the unit as written in the list (m, st, rol, ...). '
        + 'Returns per line a status (matched, not_found, multiple, code_mismatch), the trade item with its units and packaging, the price block (gross and net, conditionId, scenario, termsType), '
        + 'unitNetPrice (per use unit, so per metre for a cable priced per 100 m), lineTotalExVat (quantity x unitNetPrice, only when the unit matches the use unit), priceDate and flags that mark lines to check, plus a summary with counts and the total.',
        {
            supplierGln: GLN,
            items: {
                type: 'array',
                description: `The lines (at most ${DEFAULT_MAX_ITEMS} by default). Each needs a tradeItemId or a gtin.`,
                items: {
                    type: 'object',
                    properties: {
                        ref: text('Your own reference for the line, such as the row number; returned unchanged.'),
                        tradeItemId: text('The supplier\'s article number.'),
                        gtin: text('GTIN / EAN code (8, 12, 13 or 14 digits).'),
                        quantity: { type: 'number', description: 'Quantity in the unit below.' },
                        unit: text('Unit as written in the list: m, mtr, st, stuks, pcs, rol, doos, ... Left out: the quantity counts in the article\'s use unit.'),
                    },
                },
            },
            projectNumber: PROJECT,
        }, ['supplierGln', 'items']),
    tool('twoba_net_price',
        'Get the NET purchase price of one article at one supplier from 2BA (computed from the customer\'s condition files), optionally for a project number and an order quantity (quantity breaks). Give the tradeItemId, or a GTIN to find it.',
        {
            supplierGln: GLN,
            tradeItemId: text('The supplier\'s article number.'),
            gtin: text('GTIN / EAN code, used when there is no tradeItemId.'),
            projectNumber: PROJECT,
            orderQuantity: { type: 'number', description: 'Order quantity, for quantity-dependent prices (optional).' },
        }, ['supplierGln']),
    tool('twoba_list_condition_databases',
        'List the Online Condition Server databases of the customer\'s 2BA company (id, name, created), and which database the connection currently prices with.',
        {}),
    tool('twoba_upload_conditions',
        'Upload a condition file (ICC 1.1 as .txt or .icc, or INSBOU/DICO .xml) of a supplier into one Online Condition Server database of the customer. Only inside an automation run: the file is one of the run (a form upload or a file an earlier step made). '
        + 'process: DoNotProcess (default; import only, check it in 2BA first), ProcessIfAllOk (activate when no row failed) or ProcessAlways (activate, skipping failed rows). '
        + 'Returns what 2BA reports per imported file, and the sha256 of the file sent, to record which condition file version was used.',
        {
            databaseId: { type: 'integer', description: 'Id of the Online Condition Server database (twoba_list_condition_databases).' },
            sourceHandle: { type: 'object', description: 'The file: { kind: "form_upload" | "generated_file", fileId } from a form or an earlier step.' },
            process: { type: 'string', enum: [...PROCESS_MODES], description: 'What 2BA does after the import (default DoNotProcess).' },
        }, ['databaseId', 'sourceHandle']),
];

export const TWOBA_TOOL_NAMES: ReadonlySet<string> = new Set(TWOBA_TOOLS.map((t) => t.function.name));

/** The tool that changes data at 2BA. */
export const TWOBA_WRITE_TOOLS: ReadonlySet<string> = new Set(['twoba_upload_conditions']);

// ─── Argument schemas ────────────────────────────────────────────

/** null and '' (an empty spreadsheet cell) count as not given. */
const absent = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v);

function printable(v: string): boolean {
    for (let i = 0; i < v.length; i += 1) {
        const c = v.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return false;
    }
    return true;
}

const code = (label: string, max: number) => z.preprocess((v) => absent(typeof v === 'number' ? String(v) : v), z.string({ error: () => `${label} must be text.` })
    .trim().min(1, `${label} is empty.`).max(max, `${label} is at most ${max} characters.`).refine(printable, `${label} holds control characters.`).optional());

/** A positive number; text with a decimal comma or point is read as a number. */
const quantity = (label: string) => z.preprocess((v) => {
    const given = absent(v);
    return typeof given === 'string' ? Number(given.trim().split(',').join('.')) : given;
}, z.number({ error: () => `${label} must be a number.` }).finite(`${label} must be a number.`).positive(`${label} must be more than 0.`).optional());

const supplierGln = z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string({ error: () => 'supplierGln is required: the 13-digit GLN of the supplier.' })
    .trim().refine(isValidGln, 'supplierGln must be the 13-digit GLN of the supplier, with a valid check digit.'));

const itemSchema = z.object({
    ref: code('ref', 200),
    tradeItemId: code('tradeItemId', 64),
    gtin: code('gtin', 32),
    quantity: quantity('quantity'),
    unit: code('unit', 32),
}, { error: () => 'Each item is an object with a tradeItemId or a gtin.' }).refine((i) => i.tradeItemId !== undefined || i.gtin !== undefined, 'Each item needs a tradeItemId or a gtin.');

export const FindItemsArgs = z.object({
    supplierGln,
    items: z.array(itemSchema, { error: () => 'items must be a list of lines.' }).min(1, 'items is empty: give at least one line.'),
    projectNumber: code('projectNumber', 64),
});

export const NetPriceArgs = z.object({
    supplierGln,
    tradeItemId: code('tradeItemId', 64),
    gtin: code('gtin', 32),
    projectNumber: code('projectNumber', 64),
    orderQuantity: quantity('orderQuantity'),
}).refine((a) => a.tradeItemId !== undefined || a.gtin !== undefined, 'Give a tradeItemId or a gtin.');

export const ListDatabasesArgs = z.object({});

export const UploadArgs = z.object({
    databaseId: z.coerce.number({ error: () => 'databaseId must be the id of an Online Condition Server database.' }).int('databaseId must be a whole number.').positive('databaseId must be the id of an Online Condition Server database.'),
    sourceHandle: z.record(z.string(), z.unknown(), { error: () => 'sourceHandle is the file of this run: { kind: "form_upload" | "generated_file", fileId }.' }),
    process: z.preprocess(absent, z.enum(PROCESS_MODES, { error: () => 'process is DoNotProcess, ProcessIfAllOk or ProcessAlways.' }).default('DoNotProcess')),
});

export type FindItemsInput = ReturnType<typeof FindItemsArgs.parse>;
export type NetPriceInput = ReturnType<typeof NetPriceArgs.parse>;
export type UploadInput = ReturnType<typeof UploadArgs.parse>;
