/**
 * A template as a file: Bee Flow's own `.bftemplate`, to take a template from
 * one Bee Flow to another (or keep a copy) with everything that makes it look
 * and behave the same: its body, its stylesheet, its fields and sections, its
 * design or slide look, and whether it follows the house style.
 *
 * The file is JSON:
 *
 *   { "format": "beeflow-template", "version": 1, "exportedAt": "<iso>",
 *     "template": { "name", "description", "docType", "bodyHtml", "css",
 *                   "settings": { contract?, design?, deck?, houseStyle?, locale? },
 *                   "categories": [] } }
 *
 * WHAT GOES IN is an allow-list (SETTINGS_KEYS), never "the settings minus a
 * few": a key added to a document's settings next year (a filled-in value, a
 * link to a chat, a stored copy of the house style) stays out unless someone
 * decides it belongs in a template file. Filled-in values, section choices,
 * the "made from" link and the chat link are never exported.
 *
 * PICTURES. A presentation points at its pictures by storage key
 * (`users/<id>/…`), which means nothing on another Bee Flow. The export reads
 * each one the exporter may read and puts it in as a data: URL, so the file
 * stands on its own; a picture it may not read keeps its key (it will not show
 * on another Bee Flow) and is reported (`skippedImages`).
 *
 * IMPORT checks the file before anything is stored: the format and version,
 * the kind of document (a designed document or a presentation; never a page,
 * a notebook or a spreadsheet, which are not templates), the text sizes and the
 * field contract (documentContract.normalizeContract, the same check a save
 * runs). The body and stylesheet are stored as written, like a template typed
 * in the editor: they are sanitised when the document is rendered
 * (services/documentCompose.js), not here.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const TEMPLATE_FILE_FORMAT = 'beeflow-template';
export const TEMPLATE_FILE_VERSION = 1;
export const TEMPLATE_FILE_EXTENSION = 'bftemplate';
export const TEMPLATE_FILE_MIME = 'application/vnd.beeflow.template+json';

/** The settings a template file carries; everything else stays home. */
const SETTINGS_KEYS = ['contract', 'design', 'deck', 'houseStyle', 'locale'] as const;
/** Document kinds that are not templates (a page, a notebook, a spreadsheet). */
const NOT_A_TEMPLATE = new Set(['page', 'notebook', 'spreadsheet']);

const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;
const MAX_CATEGORIES = 20;
/** Characters of body plus stylesheet; the store's own caps still apply on create. */
const MAX_TEXT = 5_000_000;
/** What the export puts in as pictures, in characters of data: URL. */
const MAX_INLINED = 8_000_000;

export interface TemplateFileTemplate {
    name: string;
    description: string;
    docType: string;
    bodyHtml: string;
    css: string;
    settings: Record<string, unknown>;
    categories: string[];
}

export interface TemplateFile {
    format: typeof TEMPLATE_FILE_FORMAT;
    version: typeof TEMPLATE_FILE_VERSION;
    exportedAt: string;
    template: TemplateFileTemplate;
}

export interface ExportableDoc {
    name?: string;
    description?: string;
    docType?: string;
    bodyHtml?: string;
    css?: string;
    settings?: Record<string, unknown> | null;
    categories?: unknown;
}

type ImageResolver = (ref: { storageKey: string }) => Promise<string | null>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function refusal(message: string, errorClass = 'template_file_invalid'): Error {
    return Object.assign(new Error(message), { status: 422, errorClass });
}

/** Whether a document of this kind can be a template file. */
export function canExport(docType: unknown): boolean {
    return !NOT_A_TEMPLATE.has(str(docType) || 'document');
}

function pickSettings(settings: unknown): Record<string, unknown> {
    if (!isObject(settings)) return {};
    const out: Record<string, unknown> = {};
    for (const key of SETTINGS_KEYS) if (settings[key] !== undefined) out[key] = settings[key];
    return out;
}

function categoriesOf(raw: unknown): string[] {
    return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string' && c.trim() !== '').slice(0, MAX_CATEGORIES) : [];
}

/** The file for a document (a template, or a designed document saved as one). */
export function templateFileOf(doc: ExportableDoc, exportedAt: string = new Date().toISOString()): TemplateFile {
    return {
        format: TEMPLATE_FILE_FORMAT,
        version: TEMPLATE_FILE_VERSION,
        exportedAt,
        template: {
            name: str(doc.name).slice(0, MAX_NAME) || 'Template',
            description: str(doc.description).slice(0, MAX_DESCRIPTION),
            docType: str(doc.docType) || 'document',
            bodyHtml: str(doc.bodyHtml),
            css: str(doc.css),
            settings: pickSettings(doc.settings),
            categories: categoriesOf(doc.categories),
        },
    };
}

const KEY_END = new Set([' ', '\n', '\r', '\t', ')', '(', '"', '\'', '<', '>', ']', '[', ',', '`']);

/** Every storage key (`users/<id>/…`) in a text, once each, found with plain string scanning. */
export function storageKeysIn(text: string): string[] {
    const found = new Set<string>();
    let from = 0;
    for (;;) {
        const at = text.indexOf('users/', from);
        if (at === -1) break;
        let end = at;
        while (end < text.length && !KEY_END.has(text[end])) end++;
        const before = at === 0 ? '' : text[at - 1];
        const key = text.slice(at, end);
        // A key stands on its own (not the tail of a longer path or URL), and has a file after the owner.
        if ((before === '' || KEY_END.has(before)) && key.split('/').length >= 3) found.add(key);
        from = end > at ? end : at + 6;
    }
    return [...found];
}

/** The file with every picture the exporter may read put in as a data: URL. */
export async function inlineImages(file: TemplateFile, resolve: ImageResolver): Promise<{ file: TemplateFile, skippedImages: string[] }> {
    const { bodyHtml, css } = file.template;
    const keys = storageKeysIn(`${bodyHtml}\n${css}`);
    const skippedImages: string[] = [];
    let body = bodyHtml;
    let sheet = css;
    let budget = MAX_INLINED;
    for (const key of keys) {
        const dataUrl = await resolve({ storageKey: key }).catch(() => null);
        if (!dataUrl || !dataUrl.startsWith('data:') || dataUrl.length > budget) { skippedImages.push(key); continue; }
        budget -= dataUrl.length;
        body = body.split(key).join(dataUrl);
        sheet = sheet.split(key).join(dataUrl);
    }
    return { file: { ...file, template: { ...file.template, bodyHtml: body, css: sheet } }, skippedImages };
}

function checkEnvelope(raw: unknown): Record<string, unknown> {
    if (!isObject(raw) || raw.format !== TEMPLATE_FILE_FORMAT) {
        throw refusal('This is not a Bee Flow template file (.bftemplate).', 'template_file_format');
    }
    if (raw.version !== TEMPLATE_FILE_VERSION) {
        throw refusal(`This template file has version ${String(raw.version)}; this Bee Flow reads version ${TEMPLATE_FILE_VERSION}.`, 'template_file_version');
    }
    if (!isObject(raw.template)) throw refusal('The template file has no template in it.');
    return raw.template;
}

function checkText(t: Record<string, unknown>): { bodyHtml: string, css: string } {
    if (typeof t.bodyHtml !== 'string' || typeof t.css !== 'string') throw refusal('The template file misses its body or stylesheet.');
    if (t.bodyHtml.length + t.css.length > MAX_TEXT) throw refusal('The template in this file is too large to import.', 'template_file_too_large');
    if (!t.bodyHtml.trim()) throw refusal('The template in this file is empty.');
    return { bodyHtml: t.bodyHtml, css: t.css };
}

/** The settings of an imported template, its field contract checked as a save checks it. */
function checkSettings(raw: unknown): Record<string, unknown> {
    const settings = pickSettings(raw);
    if (settings.contract !== undefined) {
        const { normalizeContract } = nodeRequire('./documentContract.js') as { normalizeContract: (c: unknown) => unknown };
        try { settings.contract = normalizeContract(settings.contract); } catch (e) {
            throw refusal(`The fields of this template are not valid: ${(e as Error).message}`, 'template_file_contract');
        }
    }
    return settings;
}

/** A parsed `.bftemplate` file, checked, as the fields a new template is created from. */
export function parseTemplateFile(raw: unknown): TemplateFileTemplate {
    const t = checkEnvelope(raw);
    const docType = str(t.docType) || 'document';
    if (!canExport(docType)) throw refusal('Only designed documents and presentations can be imported as a template.', 'template_file_kind');
    const name = str(t.name).trim().slice(0, MAX_NAME);
    if (!name) throw refusal('The template in this file has no name.');
    return {
        name,
        description: str(t.description).slice(0, MAX_DESCRIPTION),
        docType,
        ...checkText(t),
        settings: checkSettings(t.settings),
        categories: categoriesOf(t.categories),
    };
}
