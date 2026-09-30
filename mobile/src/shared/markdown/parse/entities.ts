/**
 * HTML character references in Markdown text. marked leaves them in its
 * tokens (`&amp;`, `&#39;`, `&#x1F600;`) and expects its HTML renderer to pass
 * them to a browser; a native Text would print them literally.
 *
 * The named set is the one models and pasted web text actually produce;
 * anything else stays as written, which is what a browser shows for an
 * unknown name too.
 */

const NAMED: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    copy: '©',
    reg: '®',
    trade: '™',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    laquo: '«',
    raquo: '»',
    bull: '•',
    middot: '·',
    deg: '°',
    euro: '€',
    pound: '£',
    yen: '¥',
    times: '×',
    divide: '÷',
    plusmn: '±',
    larr: '←',
    rarr: '→',
    uarr: '↑',
    darr: '↓',
    harr: '↔',
    le: '≤',
    ge: '≥',
    ne: '≠',
    sect: '§',
    para: '¶',
    shy: '­',
    zwj: '‍',
    zwnj: '‌',
};

function fromCodePoint(code: number, raw: string): string {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return raw;
    return String.fromCodePoint(code);
}

export function decodeEntities(text: string): string {
    if (!text.includes('&')) return text;
    return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (raw, body: string) => {
        if (body[0] !== '#') return NAMED[body] ?? raw;
        const hex = body[1] === 'x' || body[1] === 'X';
        return fromCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10), raw);
    });
}
