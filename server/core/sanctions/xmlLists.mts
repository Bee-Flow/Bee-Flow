/**
 * xmlLists.mts: the three lists published as XML, parsed into ParsedEntity (entity.mts).
 *
 *   parseEuFsf(xml)   EU Financial Sanctions Files (FSF), "xmlFullSanctionsList_1_1": <export>
 *                     <sanctionEntity logicalId euReferenceNumber> with <nameAlias wholeName>,
 *                     <birthdate birthdate|year>, <citizenship countryIso2Code>, <regulation programme>.
 *   parseUnSc(xml)    UN Security Council Consolidated List: <CONSOLIDATED_LIST> <INDIVIDUALS>
 *                     <INDIVIDUAL> (FIRST_NAME .. FOURTH_NAME, INDIVIDUAL_ALIAS, NATIONALITY,
 *                     INDIVIDUAL_DATE_OF_BIRTH) and <ENTITIES> <ENTITY> (FIRST_NAME, ENTITY_ALIAS).
 *   parseUkFcdo(xml)  UK Sanctions List (FCDO, the list that replaced the OFSI Consolidated List):
 *                     <Designations> <Designation> with UniqueID, Names/Name (Name1..Name6),
 *                     NonLatinNames, RegimeName, IndividualEntityShip, IndividualDetails (DOBs,
 *                     Nationalities), Addresses.
 *
 * fast-xml-parser with attributes under '@', no value parsing (everything stays text) and no
 * namespace prefixes. A document without the expected root throws: the refresh job then keeps
 * the stored list as it is instead of replacing it with nothing.
 */

import { createRequire } from 'node:module';
import { asArray, makeEntity, type EntityKind, type ParsedEntity } from './entity.mts';

const nodeRequire = createRequire(import.meta.url);
type XmlParserCtor = new (o: Record<string, unknown>) => { parse: (xml: string) => unknown };
const { XMLParser } = nodeRequire('fast-xml-parser') as { XMLParser: XmlParserCtor };

type Node = Record<string, unknown>;

function parseXml(xml: string): Node {
    const parser = new XMLParser({
        ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true,
        parseTagValue: false, parseAttributeValue: false, trimValues: true,
    });
    const out = parser.parse(xml);
    return (out && typeof out === 'object' ? out : {}) as Node;
}

const node = (v: unknown): Node => (v && typeof v === 'object' && !Array.isArray(v) ? v as Node : {});
const nodes = (v: unknown): Node[] => asArray(v as Node | Node[] | undefined).map(node);
/** An element's text, whether it was parsed as a plain value or as { '#text': ... } next to attributes. */
const txt = (v: unknown): string => {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') return String(v);
    const t = node(v)['#text'];
    return typeof t === 'string' ? t.trim() : '';
};
const texts = (v: unknown): string[] => asArray(v as unknown).map(txt).filter(Boolean);

function rootOf(doc: Node, name: string, list: string): Node {
    const root = doc[name];
    if (!root || typeof root !== 'object') throw new Error(`${list}: the document has no <${name}> root`);
    return node(root);
}

// ── EU ──────────────────────────────────────────────────────────────

function euKind(code: string): EntityKind {
    if (code === 'person') return 'person';
    if (code === 'enterprise') return 'entity';
    return 'unknown';
}

export function parseEuFsf(xml: string): ParsedEntity[] {
    const root = rootOf(parseXml(xml), 'export', 'EU FSF');
    const out: ParsedEntity[] = [];
    for (const e of nodes(root.sanctionEntity)) {
        const regulations = nodes(e.regulation);
        const entity = makeEntity({
            entityId: e['@logicalId'],
            kind: euKind(txt(node(e.subjectType)['@code'])),
            names: nodes(e.nameAlias).map((a) => a['@wholeName'] || [a['@firstName'], a['@middleName'], a['@lastName']].filter(Boolean).join(' ')),
            birthDates: nodes(e.birthdate).map((b) => b['@birthdate'] || b['@year']),
            countries: [
                ...nodes(e.citizenship).map((c) => c['@countryIso2Code'] || c['@countryDescription']),
                ...nodes(e.birthdate).map((b) => b['@countryIso2Code']),
            ],
            programmes: regulations.map((r) => r['@programme']),
            reference: e['@euReferenceNumber'] || null,
            url: regulations.map((r) => txt(r.publicationUrl)).find(Boolean) || null,
        });
        if (entity) out.push(entity);
    }
    return out;
}

// ── UN ──────────────────────────────────────────────────────────────

const UN_LIST_URL = 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list';

function unDates(person: Node): string[] {
    const out: string[] = [];
    for (const d of nodes(person.INDIVIDUAL_DATE_OF_BIRTH)) {
        for (const v of [txt(d.DATE), txt(d.YEAR), txt(d.FROM_YEAR), txt(d.TO_YEAR)]) if (v) out.push(v);
    }
    return out;
}

function unAliases(n: Node, tag: string): string[] {
    return nodes(n[tag]).map((a) => txt(a.ALIAS_NAME)).filter(Boolean);
}

export function parseUnSc(xml: string): ParsedEntity[] {
    const root = rootOf(parseXml(xml), 'CONSOLIDATED_LIST', 'UN SC');
    const out: ParsedEntity[] = [];
    for (const p of nodes(node(root.INDIVIDUALS).INDIVIDUAL)) {
        const whole = [p.FIRST_NAME, p.SECOND_NAME, p.THIRD_NAME, p.FOURTH_NAME].map(txt).filter(Boolean).join(' ');
        const entity = makeEntity({
            entityId: txt(p.DATAID), kind: 'person',
            names: [whole, txt(p.NAME_ORIGINAL_SCRIPT), ...unAliases(p, 'INDIVIDUAL_ALIAS')],
            birthDates: unDates(p),
            countries: [...texts(node(p.NATIONALITY).VALUE), ...nodes(p.INDIVIDUAL_ADDRESS).map((a) => txt(a.COUNTRY))],
            programmes: [txt(p.UN_LIST_TYPE)],
            reference: txt(p.REFERENCE_NUMBER) || null, url: UN_LIST_URL,
        });
        if (entity) out.push(entity);
    }
    for (const o of nodes(node(root.ENTITIES).ENTITY)) {
        const entity = makeEntity({
            entityId: txt(o.DATAID), kind: 'entity',
            names: [txt(o.FIRST_NAME), txt(o.NAME_ORIGINAL_SCRIPT), ...unAliases(o, 'ENTITY_ALIAS')],
            countries: nodes(o.ENTITY_ADDRESS).map((a) => txt(a.COUNTRY)),
            programmes: [txt(o.UN_LIST_TYPE)],
            reference: txt(o.REFERENCE_NUMBER) || null, url: UN_LIST_URL,
        });
        if (entity) out.push(entity);
    }
    return out;
}

// ── UK ──────────────────────────────────────────────────────────────

const UK_LIST_URL = 'https://www.gov.uk/government/publications/the-uk-sanctions-list';

function ukKind(v: string): EntityKind {
    const k = v.toLowerCase();
    if (k === 'individual') return 'person';
    if (k === 'entity') return 'entity';
    if (k === 'ship') return 'vessel';
    return 'unknown';
}

function ukName(n: Node): string {
    return ['Name1', 'Name2', 'Name3', 'Name4', 'Name5', 'Name6'].map((k) => txt(n[k])).filter(Boolean).join(' ');
}

export function parseUkFcdo(xml: string): ParsedEntity[] {
    const root = rootOf(parseXml(xml), 'Designations', 'UK FCDO');
    const out: ParsedEntity[] = [];
    for (const d of nodes(root.Designation)) {
        const individual = node(node(d.IndividualDetails).Individual);
        const entity = makeEntity({
            entityId: txt(d.UniqueID),
            kind: ukKind(txt(d.IndividualEntityShip)),
            names: [
                ...nodes(node(d.Names).Name).map(ukName),
                ...nodes(node(d.NonLatinNames).NonLatinName).map((n) => txt(n.NameNonLatinScript)),
            ],
            birthDates: texts(node(individual.DOBs).DOB),
            countries: [
                ...texts(node(individual.Nationalities).Nationality),
                ...nodes(node(d.Addresses).Address).map((a) => txt(a.AddressCountry)),
            ],
            programmes: [txt(d.RegimeName)],
            reference: txt(d.UniqueID) || null, url: UK_LIST_URL,
        });
        if (entity) out.push(entity);
    }
    return out;
}
