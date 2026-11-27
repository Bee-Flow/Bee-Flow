/**
 * What a public CMS site states about the organisation behind it, read from
 * the site settings every CMS site already has: the header brand and nav, the
 * footer blurb, copyright line, social links and accountability block
 * (address, registration, VAT number, contact links).
 *
 * The Organization node of the JSON-LD graph (core/seo/jsonld.js) and the
 * facts block of /llms.txt (core/seo/sitemap.js) both come from here, so they
 * cannot disagree with the footer a visitor sees. Nothing is hard-coded about
 * any one site: this code serves every CMS customer.
 */

export interface SiteFacts {
    /** The brand, as the header shows it. */
    name: string;
    /** The legal name from the copyright line ("© Acme B.V." → "Acme B.V."), or null. */
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
    /** External profiles (footer socials, header nav links to profile hosts). */
    profiles: string[];
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

/** Hosts whose pages are an organisation's own profile, for sameAs. */
const PROFILE_HOSTS: readonly string[] = [
    'github.com', 'gitlab.com', 'codeberg.org', 'linkedin.com', 'x.com', 'twitter.com', 'facebook.com',
    'instagram.com', 'youtube.com', 'bsky.app', 'mastodon.social', 'apps.nextcloud.com', 'wikidata.org',
    'crunchbase.com', 'tiktok.com', 'threads.net',
];

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

function isProfileUrl(url: string): boolean {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    return PROFILE_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}

/** The external profiles among the footer's social links (absolute http(s) URLs only). */
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

/** Every link item in the header nav: top entries, their children and dropdown columns. */
function navItems(entries: unknown): Doc[] {
    const out: Doc[] = [];
    for (const e of list(entries)) {
        if (!isDoc(e) || e.enabled === false) continue;
        out.push(e);
        out.push(...navItems(e.children));
        const dropdown = isDoc(e.dropdown) ? e.dropdown : null;
        for (const col of list(dropdown?.columns)) {
            if (isDoc(col)) out.push(...navItems(col.items));
        }
    }
    return out;
}

/** Header nav links that point at a known profile host (a repository, a company page). */
export function headerProfiles(header: unknown): string[] {
    if (!isDoc(header)) return [];
    return navItems(header.nav).map(linkHref).map(absoluteUrl).filter(u => u && isProfileUrl(u));
}

/**
 * The legal name in a copyright line: "© 2026 Acme B.V. All rights reserved." → "Acme B.V.".
 * Null when nothing is left.
 */
export function legalNameFrom(copyright: unknown): string | null {
    let s = text(copyright);
    for (const mark of ['©', '(c)', '(C)', 'Copyright', 'copyright']) s = s.split(mark).join(' ');
    const words = s.split(/\s+/).filter(Boolean);
    // Leading years ("2024", "2024-2026", "2024–") and a trailing "All rights reserved".
    while (words.length && /^\d{4}([-–]\d{0,4})?,?$/.test(words[0])) words.shift();
    let out = words.join(' ').trim();
    const cut = out.toLowerCase().indexOf('all rights reserved');
    if (cut !== -1) out = out.slice(0, cut).trim();
    // A trailing comma or semicolon is punctuation; a trailing dot can be part of the name ("B.V.").
    while (out.endsWith(',') || out.endsWith(';')) out = out.slice(0, -1).trim();
    return out || null;
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
    return {
        name,
        legalName: legal,
        description: text(footer.blurb) || null,
        email: email ? email.slice('mailto:'.length).split('?')[0] || null : null,
        address: text(acc.address) || null,
        registration: text(acc.registration) || null,
        vat: text(acc.vat) || null,
        profiles: [...new Set([...footerProfiles(footer), ...headerProfiles(header)])],
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
    if (facts.legalName && facts.legalName !== facts.name) {
        out.legalName = facts.legalName;
        out.alternateName = facts.legalName;
    }
    if (facts.description) out.description = facts.description;
    if (facts.email) out.email = facts.email;
    if (facts.address) out.address = postalAddress(facts.address);
    if (facts.registration) out.identifier = registrationIdentifier(facts.registration);
    if (facts.vat) out.vatID = facts.vat;
    return out;
}

const CURRENCY_SIGNS = ['€', '$', '£', '¥', '₹', 'CHF', 'EUR', 'USD', 'GBP'];

/**
 * Does the text state an amount of money ("€6", "6 EUR", "$ 10")? Used to keep
 * prices out of what is written for language models: a price belongs on the
 * site's own pricing page, where it is kept current.
 */
export function statesPrice(value: unknown): boolean {
    const s = text(value);
    if (!s) return false;
    for (const sign of CURRENCY_SIGNS) {
        let at = s.indexOf(sign);
        while (at !== -1) {
            const before = s.slice(Math.max(0, at - 12), at).trimEnd();
            const after = s.slice(at + sign.length, at + sign.length + 12).trimStart();
            if (/^\d/.test(after) || /\d[\d.,]*(\s?(k|m|mln|million))?$/i.test(before)) return true;
            at = s.indexOf(sign, at + sign.length);
        }
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
