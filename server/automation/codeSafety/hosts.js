/**
 * Host names: the lists two rules match against, and the one matcher the
 * analyser, the validator and the run-time host manifest all use, so "is this
 * host listed" has exactly one answer everywhere.
 *
 * `allowedHosts` entries are host names (`api.example.com`) or a wildcard for
 * the sub-domains of one (`*.example.com`, which matches `a.example.com` and
 * `a.b.example.com` but not `example.com` itself). No scheme, no port, no path.
 */

'use strict';

// Known mining pools and browser miners. A step that names one has one
// purpose. Matched on the domain boundary, so `notsupportxmr.com.example` and
// `2miners.com.au` are not the pool.
const MINING_DOMAINS = Object.freeze([
    'minexmr.com', 'supportxmr.com', 'xmrpool.eu', 'moneroocean.stream', 'nanopool.org',
    '2miners.com', 'f2pool.com', 'ethermine.org', 'hashvault.pro', 'minergate.com',
    'coinhive.com', 'coin-hive.com', 'crypto-loot.com', 'cryptoloot.pro', 'webminepool.com',
    'nicehash.com', 'herominers.com', 'unmineable.com', 'c3pool.com', 'miningpoolhub.com',
    'slushpool.com', 'antpool.com', 'viabtc.com', 'poolin.com', 'dwarfpool.com',
    'monerohash.com', 'zpool.ca', 'prohashing.com', 'zergpool.com', 'woolypooly.com',
    'kryptex.network', 'k1pool.com', 'xmrig.com', 'gulf.moneroocean.stream', 'pool.hashvault.pro',
]);

// `stratum+tcp://`, `stratum+ssl://`, `stratum2+tcp://`: the mining protocol.
const STRATUM_RE = /\bstratum\d?\+(?:tcp|ssl|tls|ws|wss)?:\/\//i;

// Addresses whose whole job is to collect or forward what is posted to them:
// request bins, paste sites, tunnels to a laptop, chat webhooks.
const COLLECTION_DOMAINS = Object.freeze([
    'webhook.site', 'requestbin.com', 'requestbin.net', 'requestbin.io', 'pipedream.net',
    'pastebin.com', 'hastebin.com', 'paste.ee', 'ghostbin.co', 'rentry.co',
    'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'ngrok.dev', 'ngrok-free.dev',
    'trycloudflare.com', 'loca.lt', 'localtunnel.me', 'serveo.net', 'localhost.run',
    'beeceptor.com', 'requestcatcher.com', 'hookbin.com', 'postb.in', 'ptsv2.com', 'ptsv3.com',
    'interact.sh', 'oast.pro', 'oast.live', 'oast.site', 'oast.online', 'oast.fun', 'oast.me',
    'burpcollaborator.net', 'oastify.com', 'canarytokens.com', 'transfer.sh', 'file.io',
]);

// A path on an otherwise ordinary host that is a collection endpoint.
const COLLECTION_URL_RE = [
    /\b(?:discord|discordapp)\.com\/api\/webhooks\//i,
    /\bapi\.telegram\.org\/bot/i,
];

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lowercase, no trailing dot; '' for anything that is not a string. */
function normaliseHost(host) {
    if (typeof host !== 'string') return '';
    return host.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Is `entry` a valid allowedHosts entry? A host name, or `*.` plus a host name
 * with at least one dot (`*.com` would allow a whole top-level domain).
 */
function isValidHostEntry(entry) {
    const e = normaliseHost(entry);
    if (!e) return false;
    if (e.startsWith('*.')) {
        const rest = e.slice(2);
        return rest.includes('.') && HOSTNAME_RE.test(rest);
    }
    return HOSTNAME_RE.test(e);
}

/** The valid entries of an allowedHosts list, normalised and de-duplicated. */
function cleanHostList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        const e = normaliseHost(raw);
        if (isValidHostEntry(e) && !out.includes(e)) out.push(e);
    }
    return out;
}

/** Does `host` match one entry (a host name or a `*.domain` wildcard)? */
function hostMatchesEntry(host, entry) {
    const h = normaliseHost(host);
    const e = normaliseHost(entry);
    if (!h || !e) return false;
    if (e.startsWith('*.')) return h.endsWith(e.slice(1)) && h.length > e.length - 1;
    return h === e;
}

/** Is `host` listed in `manifest` (host names and wildcards)? */
function hostListed(host, manifest) {
    return (manifest || []).some((entry) => hostMatchesEntry(host, entry));
}

/** Does `host` sit on `domain` or one of its sub-domains? */
function onDomain(host, domain) {
    const h = normaliseHost(host);
    return h === domain || h.endsWith(`.${domain}`);
}

/**
 * The host names a piece of text mentions: every `scheme://host` in it, plus
 * bare `host:port` / `host/path` forms of the listed domains. Used to match
 * string constants against the mining and collection lists.
 */
function hostsInText(text) {
    const out = new Set();
    const s = String(text || '');
    const re = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#'"`<>\\]+)/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
        let authority = m[1];
        const at = authority.lastIndexOf('@');
        if (at >= 0) authority = authority.slice(at + 1);
        const host = authority.replace(/:\d*$/, '').replace(/^\[|\]$/g, '');
        if (host) out.add(normaliseHost(host));
    }
    return [...out];
}

/**
 * The first of `domains` the text names as a host, or null. A match must sit
 * on a host boundary: before it a dot (a sub-domain) or a non-host character;
 * after it anything but more host (`webhook.site.example` is another domain,
 * `webhook.site.` at the end of a sentence is not).
 */
function mentionsDomain(text, domains) {
    const s = String(text || '').toLowerCase();
    const hostChar = /[a-z0-9-]/;
    for (const d of domains) {
        for (let i = s.indexOf(d); i >= 0; i = s.indexOf(d, i + 1)) {
            const before = i === 0 ? '' : s[i - 1];
            const after = s[i + d.length] || '';
            const next = s[i + d.length + 1] || '';
            const startsOk = !before || !hostChar.test(before);
            const endsOk = !after || (!hostChar.test(after) && !(after === '.' && /[a-z0-9]/.test(next)));
            if (startsOk && endsOk) return d;
        }
    }
    return null;
}

/** Does the text name a mining pool or the stratum protocol? */
function mentionsMining(text) {
    if (STRATUM_RE.test(String(text || ''))) return true;
    return mentionsDomain(text, MINING_DOMAINS) !== null;
}

/** Does the text name a collection endpoint (request bin, tunnel, chat webhook)? */
function mentionsCollection(text) {
    const s = String(text || '');
    if (COLLECTION_URL_RE.some((re) => re.test(s))) return true;
    return mentionsDomain(s, COLLECTION_DOMAINS) !== null;
}

/**
 * The host of a URL prefix known at authoring time, or null when the host is
 * decided at run time.
 *
 *   complete  the prefix IS the whole URL (a literal, or constants joined).
 *   partial   more text follows at run time; the host is known only when the
 *             prefix already runs past it (`https://api.x.com/` + id), never
 *             when the next piece could still extend it (`https://api.x` + tld).
 */
function hostOfUrlPrefix(text, complete) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored scheme://host prefix with negated classes: linear
    const s = String(text || '');
    if (complete) {
        try {
            const u = new URL(s);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
            return normaliseHost(u.hostname) || null;
        } catch (_) {
            return null;
        }
    }
    const m = /^(https?):\/\/([^/?#]*)[/?#]/i.exec(s);
    if (!m) return null;
    try {
        return normaliseHost(new URL(`${m[1]}://${m[2]}/`).hostname) || null;
    } catch (_) {
        return null;
    }
}

module.exports = {
    MINING_DOMAINS, COLLECTION_DOMAINS,
    normaliseHost, isValidHostEntry, cleanHostList, hostMatchesEntry, hostListed, onDomain,
    hostsInText, mentionsMining, mentionsCollection, hostOfUrlPrefix,
};
