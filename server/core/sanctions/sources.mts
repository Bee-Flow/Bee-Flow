/**
 * sources.mts: the official, free sanctions lists Bee Flow imports, where each is published and
 * how its file is read.
 *
 *   eu_fsf        European Commission, Financial Sanctions Files: the consolidated list of persons,
 *                 groups and entities subject to EU financial sanctions (XML 1.1, public token).
 *   un_sc         United Nations Security Council Consolidated List (XML).
 *   nl_terrorism  Nationale sanctielijst terrorisme, Dutch government (OpenDocument spreadsheet).
 *   us_ofac_sdn   US Treasury OFAC Specially Designated Nationals (SDN.CSV + ALT.CSV, a few MB,
 *                 instead of the ~100 MB XML).
 *   uk_fcdo       UK Sanctions List, FCDO (XML). It replaced the OFSI Consolidated List, which
 *                 stopped being published in January 2026.
 *
 * Every address is fixed here, in the code: the refresh job fetches them with fetchFixedEndpoint
 * and never a URL from a request, a user or a model. `minEntities` is the floor below which a
 * download counts as broken (a truncated file, an error page that happened to parse): the
 * stored list is then kept. The floors sit far below today's sizes (EU ~5,800, UN ~1,000,
 * NL ~120, OFAC ~18,000, UK ~6,400 entries) for a first import; after that the refresh job
 * also refuses a download below 70% of the stored count (SHRINK_FLOOR, jobs/sanctionsListRefresh.mts)
 * unless the platform admin forces the refresh.
 */

import type { ParsedEntity } from './entity.mts';
import { parseEuFsf, parseUkFcdo, parseUnSc } from './xmlLists.mts';
import { parseNlTerrorism, parseOfacSdn } from './tabularLists.mts';

export interface SourceFile {
    /** The key the parser reads it under. */
    key: string;
    url: string;
    as: 'text' | 'binary';
}

export interface ListSource {
    id: string;
    label: string;
    publisher: string;
    /** The public page that describes the list, for people. */
    infoUrl: string;
    files: SourceFile[];
    minEntities: number;
    parse: (files: Record<string, string | Buffer>) => ParsedEntity[] | Promise<ParsedEntity[]>;
}

const text = (files: Record<string, string | Buffer>, key: string): string => {
    const v = files[key];
    return typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : '';
};

/**
 * The downloaded bytes as the parser reads them: a text file decoded as UTF-8, a binary one as a
 * Buffer over the same memory. Each raw file is dropped from `raw` once decoded, so the bytes
 * and the text of a file are never both held longer than the decode itself.
 */
export function decodeFiles(source: ListSource, raw: Record<string, Uint8Array>): Record<string, string | Buffer> {
    const out: Record<string, string | Buffer> = {};
    for (const file of source.files) {
        const name = file.key;
        const bytes = raw[name];
        delete raw[name];
        if (!bytes) continue;
        const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        out[name] = file.as === 'binary' ? buf : buf.toString('utf8');
    }
    return out;
}

export const LIST_SOURCES: readonly ListSource[] = Object.freeze([
    {
        id: 'eu_fsf', label: 'EU consolidated financial sanctions list', publisher: 'European Commission',
        infoUrl: 'https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions',
        // The token is the Commission's published public one (base64 of "token-2017"), not a credential.
        files: [{ key: 'xml', as: 'text', url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw' }], // gitleaks:allow
        minEntities: 1000,
        parse: (f) => parseEuFsf(text(f, 'xml')),
    },
    {
        id: 'un_sc', label: 'UN Security Council consolidated list', publisher: 'United Nations Security Council',
        infoUrl: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list',
        files: [{ key: 'xml', as: 'text', url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml' }],
        minEntities: 200,
        parse: (f) => parseUnSc(text(f, 'xml')),
    },
    {
        id: 'nl_terrorism', label: 'Dutch national terrorism sanctions list', publisher: 'Government of the Netherlands',
        infoUrl: 'https://www.rijksoverheid.nl/documenten/rapporten/2015/08/27/nationale-terrorismelijst',
        files: [{ key: 'ods', as: 'binary', url: 'https://www.rijksoverheid.nl/site/binaries/site-content/collections/documents/2015/08/27/nationale-terrorismelijst/ned-terrorismelijst.ods' }],
        minEntities: 20,
        parse: (f) => {
            const v = f.ods;
            return parseNlTerrorism(Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8'));
        },
    },
    {
        id: 'us_ofac_sdn', label: 'OFAC Specially Designated Nationals (SDN) list', publisher: 'US Department of the Treasury, OFAC',
        infoUrl: 'https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists',
        files: [
            { key: 'sdn', as: 'text', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV' },
            { key: 'alt', as: 'text', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV' },
        ],
        minEntities: 3000,
        parse: (f) => parseOfacSdn(text(f, 'sdn'), text(f, 'alt')),
    },
    {
        id: 'uk_fcdo', label: 'UK Sanctions List', publisher: 'UK Foreign, Commonwealth and Development Office',
        infoUrl: 'https://www.gov.uk/government/publications/the-uk-sanctions-list',
        files: [{ key: 'xml', as: 'text', url: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml' }],
        minEntities: 1000,
        parse: (f) => parseUkFcdo(text(f, 'xml')),
    },
]);

export const LIST_IDS: readonly string[] = Object.freeze(LIST_SOURCES.map((s) => s.id));

export function sourceById(id: string): ListSource | null {
    return LIST_SOURCES.find((s) => s.id === id) ?? null;
}
