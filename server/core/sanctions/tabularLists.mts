/**
 * tabularLists.mts: the two lists published as tables, parsed into ParsedEntity (entity.mts).
 *
 *   parseOfacSdn(sdnCsv, altCsv)
 *       OFAC Specially Designated Nationals, the two CSV files of the Sanctions List Service:
 *       SDN.CSV (ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage, GRT,
 *       Vess_flag, Vess_owner, Remarks) and ALT.CSV (ent_num, alt_num, alt_type, alt_name,
 *       alt_remarks). No header row; "-0-" is an empty field. Birth dates and nationalities sit
 *       in Remarks ("DOB 10 Jun 1961; POB Baghdad, Iraq; nationality Iraq; ...").
 *   parseNlTerrorism(ods)
 *       The Dutch national terrorism sanctions list (Nationale sanctielijst terrorisme), an
 *       OpenDocument spreadsheet: a title row, then a header row starting with "Achternaam"
 *       (Achternaam, Voornaam/namen, Alias, Geboortedatum, Geboorteplaats, Datum ministeriële
 *       beslissing, Link officiële bekendmaking), then one row per person or organisation.
 *       The list has no ids: an entry's id is built from its name and birth date.
 *
 * A file that does not have the expected shape throws, so the stored list stays as it is.
 */

import { createRequire } from 'node:module';
import { parseCsv } from './csv.mts';
import { asArray, makeEntity, type EntityKind, type ParsedEntity } from './entity.mts';
import { foldText } from './normalize.mts';

const nodeRequire = createRequire(import.meta.url);

// ── OFAC ────────────────────────────────────────────────────────────

const OFAC_DETAIL_URL = 'https://sanctionssearch.ofac.treas.gov/Details.aspx?id=';

const field = (v: string | undefined): string => {
    const t = (v ?? '').trim();
    return t === '-0-' ? '' : t;
};

function ofacKind(t: string): EntityKind {
    const k = t.toLowerCase();
    if (k === 'individual') return 'person';
    if (k === 'vessel') return 'vessel';
    if (k === 'aircraft') return 'aircraft';
    return 'entity';
}

/** "DOB 10 Jun 1961", "DOB circa 1960", "DOB 1955 to 1958" and the nationality/citizen parts of Remarks. */
export function ofacRemarks(remarks: string): { birthDates: string[]; countries: string[] } {
    const birthDates: string[] = [];
    const countries: string[] = [];
    for (const raw of remarks.split(';')) {
        const part = raw.trim().replace(/^alt\.\s+/i, '');
        const lower = part.toLowerCase();
        if (lower.startsWith('dob ')) {
            const value = part.slice(4).replace(/^circa\s+/i, '').trim();
            for (const piece of value.split(' to ')) if (piece.trim()) birthDates.push(piece.trim());
        } else if (lower.startsWith('nationality ')) {
            countries.push(part.slice('nationality '.length).trim());
        } else if (lower.startsWith('citizen ')) {
            countries.push(part.slice('citizen '.length).trim());
        }
    }
    return { birthDates, countries };
}

const cleanCsv = (s: string): string => s.replace(/\u001a/g, '');

export function parseOfacSdn(sdnCsv: string, altCsv: string): ParsedEntity[] {
    const sdnRows = parseCsv(cleanCsv(sdnCsv));
    if (!sdnRows.length || sdnRows[0].length < 12) throw new Error('OFAC SDN: SDN.CSV does not have the 12 SDN columns');
    const aliases = new Map<string, string[]>();
    for (const r of parseCsv(cleanCsv(altCsv))) {
        const id = field(r[0]);
        const name = field(r[3]);
        if (!id || !name) continue;
        const list = aliases.get(id) ?? [];
        list.push(name);
        aliases.set(id, list);
    }
    const out: ParsedEntity[] = [];
    for (const r of sdnRows) {
        const id = field(r[0]);
        if (!/^\d+$/.test(id)) continue;
        const { birthDates, countries } = ofacRemarks(field(r[11]));
        const entity = makeEntity({
            entityId: id, kind: ofacKind(field(r[2])),
            names: [field(r[1]), ...(aliases.get(id) ?? [])],
            birthDates, countries: [...countries, field(r[9])],
            programmes: field(r[3]).replace(/^\[|\]$/g, '').split('] ['),
            reference: `SDN ${id}`, url: `${OFAC_DETAIL_URL}${id}`,
        });
        if (entity) out.push(entity);
    }
    return out;
}

// ── NL ──────────────────────────────────────────────────────────────

export const NL_LIST_URL = 'https://www.rijksoverheid.nl/documenten/rapporten/2015/08/27/nationale-terrorismelijst';
/** A cell repeated more often than this is the empty rest of the row: never expanded. */
const MAX_REPEAT = 20;

type Node = Record<string, unknown>;
const node = (v: unknown): Node => (v && typeof v === 'object' && !Array.isArray(v) ? v as Node : {});

/** All text under an ODS cell (text:p, text:span, text:a), paragraphs joined by a space. */
function cellText(v: unknown): string {
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join(' ');
    if (!v || typeof v !== 'object') return '';
    return Object.entries(v as Node).filter(([k]) => !k.startsWith('@')).map(([, c]) => cellText(c)).filter(Boolean).join(' ');
}

function rowCells(row: Node): string[] {
    const out: string[] = [];
    for (const c of asArray(row['table-cell'] as Node | Node[] | undefined)) {
        const cell = node(c);
        const repeat = Math.min(MAX_REPEAT, Number(cell['@number-columns-repeated']) || 1);
        const value = cellText(cell).replace(/\s+/g, ' ').trim();
        for (let i = 0; i < repeat; i++) out.push(value);
    }
    return out;
}

/** The rows of the first sheet of an OpenDocument spreadsheet, as text cells. */
export async function odsRows(ods: Buffer | Uint8Array): Promise<string[][]> {
    const JSZip = nodeRequire('jszip') as { loadAsync: (d: Buffer | Uint8Array) => Promise<{ file: (n: string) => { async: (t: 'string') => Promise<string> } | null }> };
    const zip = await JSZip.loadAsync(ods);
    const content = zip.file('content.xml');
    if (!content) throw new Error('NL terrorism list: the file is not an OpenDocument spreadsheet');
    const xml = await content.async('string');
    const { XMLParser } = nodeRequire('fast-xml-parser') as { XMLParser: new (o: Record<string, unknown>) => { parse: (x: string) => unknown } };
    const doc = node(new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true }).parse(xml));
    const sheet = asArray(node(node(node(doc['document-content']).body).spreadsheet).table as Node | Node[] | undefined)[0];
    return asArray(node(sheet)['table-row'] as Node | Node[] | undefined).map((r) => rowCells(node(r)));
}

export async function parseNlTerrorism(ods: Buffer | Uint8Array): Promise<ParsedEntity[]> {
    const rows = await odsRows(ods);
    const header = rows.findIndex((r) => foldText(r[0]) === 'achternaam');
    if (header < 0) throw new Error('NL terrorism list: no header row starting with "Achternaam"');
    const out: ParsedEntity[] = [];
    for (const r of rows.slice(header + 1)) {
        const [last = '', first = '', alias = '', dob = '', , , notice = ''] = r;
        if (!last && !first) continue;
        const whole = [first, last].filter(Boolean).join(' ');
        const entity = makeEntity({
            entityId: foldText(`${last} ${first} ${dob}`).replace(/ /g, '-'),
            kind: first ? 'person' : 'entity',
            names: [whole, ...alias.split(/[;\n]/)],
            birthDates: [dob], programmes: ['Sanctieregeling terrorisme 2007-II'],
            reference: notice || null, url: NL_LIST_URL,
        });
        if (entity) out.push(entity);
    }
    return out;
}
