/**
 * What a public CMS site states about the organisation behind it, read from
 * the site settings every CMS site already has: the header brand and nav, the
 * footer blurb, copyright line, social links and accountability block
 * (address, registration, VAT number, contact links) and the external links
 * of the footer columns.
 *
 * The Organization node of the JSON-LD graph (core/seo/jsonld.js), the
 * SoftwareApplication licence and the facts and links of /llms.txt
 * (core/seo/sitemap.js) all come from here, so they cannot disagree with the
 * footer a visitor sees. Nothing is hard-coded about any one site: this code
 * serves every CMS customer.
 */

export interface SiteLink {
    title: string;
    url: string;
}

export interface SiteFacts {
    /** The brand, as the header shows it. */
    name: string;
    /**
     * The legal name from the copyright line ("© Acme B.V." → "Acme B.V."), or null.
     * Only a name that ends in a legal form (B.V., GmbH, Ltd, Inc, ...): any other
     * copyright text is not a legal name.
     */
    legalName: string | null;
    /** The footer blurb: what the organisation is. */
    description: string | null;
    /** The first e-mail address among the accountability links. */
    email: string | null;
    /** The registered address, as written in the footer. */
    address: string | null;
    /** The registration line, e.g. "KvK 97632430". */
    registration: string | null;
    vat: string | null;
    /** External profiles: the footer's social links, nothing else. */
    profiles: string[];
    /** The external (absolute http(s)) links of the footer columns, with their labels. */
    links?: SiteLink[];
    /** The first footer column link whose label names a licence, or null. */
    licenseUrl?: string | null;
}

type Doc = Record<string, unknown>;

function isDoc(v: unknown): v is Doc {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function text(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

/** An absolute http(s) URL, else ''. */
function absoluteUrl(v: unknown): string {
    const s = text(v);
    const lower = s.toLowerCase();
    return lower.startsWith('https://') || lower.startsWith('http://') ? s : '';
}

/** The href a CMS link object or a plain link item points at. */
export function linkHref(item: unknown): string {
    if (!isDoc(item)) return '';
    const link = isDoc(item.link) ? item.link : null;
    return text(link?.url) || text(link?.href) || text(item.href) || text(item.url);
}

/**
 * The external profiles among the footer's social links (absolute http(s) URLs only).
 * These are the only links the site marks as its own profiles: a header nav link to
 * a known host can just as well be a third party's repository, a video or a post,
 * and sameAs would then claim it as this organisation's identity.
 */
export function footerProfiles(footer: unknown): string[] {
    if (!isDoc(footer)) return [];
    const out: string[] = [];
    for (const s of list(footer.socials)) {
        if (!isDoc(s) || s.enabled === false) continue;
        const href = absoluteUrl(linkHref(s));
        if (href) out.push(href);
    }
    return out;
}

/**
 * The external links of the footer columns (absolute http(s) URLs only), titled
 * by their label: documentation, source code, a licence, an app store page.
 */
export function footerLinks(footer: unknown): SiteLink[] {
    if (!isDoc(footer)) return [];
    const out: SiteLink[] = [];
    const seen = new Set<string>();
    for (const col of list(footer.columns)) {
        if (!isDoc(col) || col.enabled === false) continue;
        for (const item of list(col.links)) {
            if (!isDoc(item) || item.enabled === false) continue;
            const url = absoluteUrl(linkHref(item));
            const title = text(item.label);
            if (!url || !title || seen.has(url)) continue;
            seen.add(url);
            out.push({ title, url });
        }
    }
    return out;
}

/** Words in a link label that name a licence (English, Dutch, German). */
const LICENSE_WORDS: readonly string[] = ['license', 'licence', 'licentie', 'lizenz'];

/** The first footer link whose label names a licence, or null. */
export function licenseLink(links: readonly SiteLink[]): string | null {
    const hit = links.find(l => LICENSE_WORDS.some(w => l.title.toLowerCase().includes(w)));
    return hit ? hit.url : null;
}

/**
 * Legal forms, without dots or slashes and lower-cased ("B.V." → "bv", "A/S" → "as").
 * A word only counts when it starts with a capital, as legal forms are written.
 */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
    'bv', 'nv', 'vof', 'cv', 'cvba', 'bvba', 'sprl', 'srl', 'sa', 'sas', 'sarl', 'spa', 'sl', 'slu',
    'gmbh', 'ag', 'kg', 'ug', 'ohg', 'ev', 'eg', 'se', 'ltd', 'limited', 'plc', 'llp', 'llc', 'inc',
    'incorporated', 'corp', 'corporation', 'co', 'pty', 'ab', 'as', 'aps', 'oy', 'oyj', 'kft', 'sro', 'pte',
]);

/** A copyright-line word without its trailing comma or semicolon. */
function bareWord(word: string): string {
    let w = word;
    while (w.endsWith(',') || w.endsWith(';')) w = w.slice(0, -1);
    return w;
}

function isLegalForm(word: string | undefined): boolean {
    if (!word) return false;
    const w = bareWord(word);
    const first = w[0] ?? '';
    if (first === first.toLowerCase()) return false;
    return LEGAL_FORMS.has(w.toLowerCase().split('.').join('').split('/').join(''));
}

/**
 * The legal name in a copyright line: "© 2026 Acme B.V. All rights reserved." → "Acme B.V.".
 * The name runs up to and including its legal form (B.V., GmbH, Ltd, Pty Ltd, ...).
 * Null when the line names no legal form: "© 2026 Acme. Made with love in Amsterdam"
 * states no legal entity, and a guess would put text in the structured data that
 * the page does not claim.
 */
export function legalNameFrom(copyright: unknown): string | null {
    let s = text(copyright);
    for (const mark of ['©', '(c)', '(C)', 'Copyright', 'copyright']) s = s.split(mark).join(' ');
    const words = s.split(/\s+/).filter(Boolean);
    // Leading years ("2024", "2024-2026", "2024–").
    while (words.length && /^\d{4}([-–]\d{0,4})?,?$/.test(words[0])) words.shift();
    for (let i = 1; i < words.length; i++) {
        if (!isLegalForm(words[i])) continue;
        let end = i;
        // A legal form of two words ("Pty Ltd", "Co. KG").
        while (isLegalForm(words[end + 1])) end++;
        return [...words.slice(0, end), bareWord(words[end])].join(' ');
    }
    return null;
}

/** The facts the site settings state. `site` is the published site (name, header, footer). */
export function siteFacts(site: unknown): SiteFacts {
    const s = isDoc(site) ? site : {};
    const header = isDoc(s.header) ? s.header : {};
    const footer = isDoc(s.footer) ? s.footer : {};
    const acc = isDoc(footer.accountability) ? footer.accountability : {};
    const name = text(header.logoText) || text(isDoc(header.logo) ? header.logo.text : '') || text(s.name);
    const legal = legalNameFrom(footer.copyright);
    const email = list(acc.links).map(linkHref).find(h => h.toLowerCase().startsWith('mailto:'));
    const links = footerLinks(footer);
    return {
        name,
        legalName: legal,
        description: text(footer.blurb) || null,
        email: email ? email.slice('mailto:'.length).split('?')[0] || null : null,
        address: text(acc.address) || null,
        registration: text(acc.registration) || null,
        vat: text(acc.vat) || null,
        profiles: [...new Set(footerProfiles(footer))],
        links,
        licenseUrl: licenseLink(links),
    };
}

const COUNTRY_CODES: Readonly<Record<string, string>> = {
    netherlands: 'NL', 'the netherlands': 'NL', nederland: 'NL', belgium: 'BE', 'belgië': 'BE', belgie: 'BE',
    germany: 'DE', deutschland: 'DE', france: 'FR', luxembourg: 'LU', austria: 'AT', 'österreich': 'AT',
    switzerland: 'CH', spain: 'ES', italy: 'IT', ireland: 'IE', 'united kingdom': 'GB', uk: 'GB',
    denmark: 'DK', sweden: 'SE', norway: 'NO', finland: 'FI', poland: 'PL', portugal: 'PT',
};

export interface PostalAddress {
    '@type': 'PostalAddress';
    streetAddress: string;
    postalCode?: string;
    addressLocality?: string;
    addressCountry?: string;
}

/**
 * "Street 6, 1185 XE Town, Netherlands" as a PostalAddress; the text itself
 * when it does not split into street and postal-code-plus-town.
 */
export function postalAddress(address: string): PostalAddress | string {
    const parts = address.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 3) return address;
    const tokens = parts[1].split(/\s+/);
    let last = -1;
    tokens.forEach((t, i) => { if (/\d/.test(t)) last = i; });
    if (last === -1 || last === tokens.length - 1) return address;
    // A letter suffix that belongs to the postal code (NL "1185 XE").
    const next = tokens[last + 1];
    if (last + 2 < tokens.length && /^[A-Z]{1,3}$/.test(next)) last += 1;
    const node: PostalAddress = {
        '@type': 'PostalAddress',
        streetAddress: parts[0],
        postalCode: tokens.slice(0, last + 1).join(' '),
        addressLocality: tokens.slice(last + 1).join(' '),
    };
    if (parts[2]) node.addressCountry = COUNTRY_CODES[parts[2].toLowerCase()] || parts[2];
    return node;
}

/** "KvK 97632430" as a PropertyValue (scheme + number); the text itself when it has no scheme. */
export function registrationIdentifier(registration: string): { '@type': 'PropertyValue', propertyID: string, value: string } | string {
    const words = registration.split(/[\s:]+/).filter(Boolean);
    const value = words.at(-1) || '';
    if (words.length < 2 || !/\d/.test(value)) return registration;
    return { '@type': 'PropertyValue', propertyID: words.slice(0, -1).join(' '), value };
}

/**
 * The Organization fields the facts support (no name/url/logo: the caller owns those).
 * Only what the footer states; an absent fact is left out, never guessed.
 */
export function organizationFields(facts: SiteFacts): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (facts.legalName && facts.legalName !== facts.name) out.legalName = facts.legalName;
    if (facts.description) out.description = facts.description;
    if (facts.email) out.email = facts.email;
    if (facts.address) out.address = postalAddress(facts.address);
    if (facts.registration) out.identifier = registrationIdentifier(facts.registration);
    if (facts.vat) out.vatID = facts.vat;
    return out;
}

const CURRENCY_SIGNS: readonly string[] = ['€', '$', '£', '¥', '₹'];
const CURRENCY_WORDS: ReadonlySet<string> = new Set([
    ...CURRENCY_SIGNS, 'eur', 'euro', 'euros', 'usd', 'dollar', 'dollars', 'gbp', 'pound', 'pounds', 'chf',
]);
/** Multipliers that may sit between an amount and its currency ("6 k EUR", "2 million euro"). */
const MULTIPLIERS: ReadonlySet<string> = new Set(['k', 'm', 'mln', 'million', 'miljoen']);
/**
 * "per user", "a seat", "/licence": a bare amount followed by one of these is a price.
 * Only units of a sale: a bare amount per month or per year is as often a count
 * ("Top 3 per year", "365 a year") as a price, so it needs a currency to count.
 */
const RATE_UNITS: ReadonlySet<string> = new Set([
    'user', 'users', 'seat', 'seats', 'gebruiker', 'gebruikers', 'licence', 'licences', 'license', 'licenses',
]);
const RATE_LEADS: ReadonlySet<string> = new Set(['per', 'a', '/']);
const EDGE_PUNCTUATION = '.,;:!?()[]{}"\'«»-';

function trimPunctuation(token: string): string {
    let start = 0;
    let end = token.length;
    while (start < end && EDGE_PUNCTUATION.includes(token[start])) start++;
    while (end > start && EDGE_PUNCTUATION.includes(token[end - 1])) end--;
    return token.slice(start, end);
}

function isDigit(ch: string | undefined): boolean {
    return ch !== undefined && ch >= '0' && ch <= '9';
}

function isAmount(token: string | undefined): boolean {
    if (!token || !isDigit(token[0])) return false;
    for (const ch of token) if (!isDigit(ch) && ch !== '.' && ch !== ',') return false;
    return true;
}

/**
 * The lower-cased words of a text, with currency signs, slashes and the border
 * between a number and a word ("6EUR", "€6") split off as their own tokens.
 */
function priceTokens(s: string): string[] {
    let spaced = '';
    let prev = '';
    for (const ch of s.toLowerCase()) {
        if (CURRENCY_SIGNS.includes(ch) || ch === '/') spaced += ` ${ch} `;
        else if (prev && ((isDigit(prev) && ch >= 'a' && ch <= 'z') || (isDigit(ch) && prev >= 'a' && prev <= 'z'))) spaced += ` ${ch}`;
        else spaced += ch;
        prev = ch;
    }
    return spaced.split(/\s+/).map(trimPunctuation).filter(Boolean);
}

/**
 * Does the text state an amount of money? An amount next to a currency sign,
 * code or word ("€6", "6 EUR", "$ 10", "6 euros", "10 dollars"), or a bare
 * amount followed by a sale unit ("6 per user per month", "6/user", "6 a seat").
 * A bare amount per month or year without a currency is not a price here.
 * Used to keep prices out of what is written for language models: a price
 * belongs on the site's own pricing page, where it is kept current.
 */
export function statesPrice(value: unknown): boolean {
    const s = text(value);
    if (!s) return false;
    const tokens = priceTokens(s);
    for (let i = 0; i < tokens.length; i++) {
        if (!isAmount(tokens[i])) continue;
        let next = i + 1;
        if (MULTIPLIERS.has(tokens[next])) next++;
        if (CURRENCY_WORDS.has(tokens[i - 1]) || CURRENCY_WORDS.has(tokens[next])) return true;
        if (RATE_LEADS.has(tokens[next]) && RATE_UNITS.has(tokens[next + 1])) return true;
    }
    return false;
}

/**
 * The facts block of /llms.txt: one line per fact the site states, no prices.
 * Empty when the site states nothing beyond its name.
 */
export function llmsFactLines(facts: SiteFacts): string[] {
    const lines: string[] = [];
    const push = (label: string, value: string | null) => {
        if (value && !statesPrice(value)) lines.push(`- ${label}: ${value}`);
    };
    if (facts.name) push('Name', facts.name);
    push('What it is', facts.description);
    const entity = [facts.legalName, facts.registration, facts.vat ? `VAT ${facts.vat}` : null].filter(Boolean).join(', ');
    push('Legal entity', entity || null);
    push('Registered address', facts.address);
    push('Contact', facts.email);
    for (const p of facts.profiles) push('Profile', p);
    return lines.length > 1 ? lines : [];
}
