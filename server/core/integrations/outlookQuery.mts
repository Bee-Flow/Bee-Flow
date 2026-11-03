/**
 * The Graph request behind one Outlook mailbox listing.
 *
 * Outlook has no labels; it has categories, and Graph's $search cannot reach
 * them (KQL there knows from, subject, received and the like, not category).
 * So the connector's "Only mail matching" query is split in two:
 *
 *   - category terms, written `category:"Name"`, `category:Name`, `label:"Name"`
 *     or `label:Name` (Gmail's spelling), become an exact categories $filter;
 *   - everything else goes UNCHANGED to $search as KQL (from:, hasattachments:,
 *     received>=, OR / AND / NOT, parentheses, quotes).
 *
 * Categories combine with OR, AND (explicit, or by adjacency) and parentheses:
 * `(category:"A" OR category:B) AND label:"C D"`. The query is read with a
 * small tokenizer and a recursive-descent parser (no regular expression runs
 * over it) and split at the top-level AND:
 *
 *   category:A OR category:B   from:x   ->  $filter A or B, $search from:x
 *
 * Graph refuses $search and $filter in one request, so with text present the
 * category expression is applied to the results by the caller (`matches`), and
 * the date filter is lost exactly as before ($search cannot be combined with
 * $filter or $orderby). A conjunct that MIXES categories and other terms under
 * OR or NOT (`category:A OR from:x`) cannot be split and is refused.
 *
 * NOT on a category is evaluated here when text forced a $search, but is
 * refused for the $filter: it is not certain that Graph accepts
 * `not(categories/any(...))` on messages, and a guess would answer with an
 * empty list.
 */

/** Parse guard; the validator caps a saved query at 512 characters. */
const MAX_PARSE_LEN = 2000;

export class MailboxQueryError extends Error {
    status = 422;
    code = 'mailbox_query_invalid';
}

type Node =
    | { t: 'cat'; name: string; start: number; end: number }
    | { t: 'text'; start: number; end: number }
    | { t: 'and' | 'or'; items: Node[]; start: number; end: number }
    | { t: 'not'; item: Node; start: number; end: number };

type Tok = { k: '(' | ')' | 'w'; s: string; start: number; end: number };

const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/** Words and parentheses. Quotes keep spaces and parentheses inside a word; `from:(a OR b)` stays one word. */
function tokenize(q: string): Tok[] {
    const toks: Tok[] = [];
    let i = 0;
    while (i < q.length) {
        const ch = q[i];
        if (isSpace(ch)) { i += 1; continue; }
        if (ch === '(' || ch === ')') { toks.push({ k: ch, s: ch, start: i, end: i + 1 }); i += 1; continue; }
        const start = i;
        let inQuote = false;
        while (i < q.length && (inQuote || (!isSpace(q[i]) && q[i] !== '(' && q[i] !== ')'))) {
            if (q[i] === '"') inQuote = !inQuote;
            i += 1;
        }
        if (q[i - 1] === ':' && q[i] === '(') {
            let depth = 0;
            inQuote = false;
            while (i < q.length) {
                if (q[i] === '"') inQuote = !inQuote;
                else if (!inQuote && q[i] === '(') depth += 1;
                else if (!inQuote && q[i] === ')') depth -= 1;
                i += 1;
                if (depth === 0 && !inQuote) break;
            }
        }
        toks.push({ k: 'w', s: q.slice(start, i), start, end: i });
    }
    return toks;
}

/** The category a word names (`category:` / `label:`, optionally negated with `-`), or null. */
function categoryOf(word: string): { name: string; negated: boolean } | null {
    const negated = word.startsWith('-');
    const body = negated ? word.slice(1) : word;
    const lower = body.slice(0, 9).toLowerCase();
    let value: string;
    if (lower === 'category:') value = body.slice(9);
    else if (lower.startsWith('label:')) value = body.slice(6);
    else return null;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    const name = value.trim();
    if (!name) throw new MailboxQueryError('category: needs a category name, for example category:"Orders".');
    return { name, negated };
}

class Parser {
    private pos = 0;
    private readonly toks: Tok[];
    constructor(toks: Tok[]) { this.toks = toks; }

    parse(): Node {
        const node = this.or();
        if (this.pos < this.toks.length) throw new MailboxQueryError('The search has an unmatched closing parenthesis.');
        return node;
    }

    private peekWord(): string | null {
        const tok = this.toks[this.pos];
        return tok && tok.k === 'w' ? tok.s : null;
    }

    private or(): Node {
        const items = [this.and()];
        while (this.peekWord() === 'OR') { this.pos += 1; items.push(this.and()); }
        return items.length === 1 ? items[0] : { t: 'or', items, start: items[0].start, end: items[items.length - 1].end };
    }

    private and(): Node {
        const items = [this.unary()];
        for (;;) {
            const tok = this.toks[this.pos];
            if (!tok || tok.k === ')' || this.peekWord() === 'OR') break;
            if (this.peekWord() === 'AND') this.pos += 1;
            items.push(this.unary());
        }
        return items.length === 1 ? items[0] : { t: 'and', items, start: items[0].start, end: items[items.length - 1].end };
    }

    private unary(): Node {
        const tok = this.toks[this.pos];
        if (tok && tok.k === 'w' && tok.s === 'NOT') {
            this.pos += 1;
            const item = this.unary();
            return { t: 'not', item, start: tok.start, end: item.end };
        }
        return this.primary();
    }

    private primary(): Node {
        const tok = this.toks[this.pos];
        if (!tok) throw new MailboxQueryError('The search ends where a term was expected.');
        if (tok.k === ')') throw new MailboxQueryError('The search has an unmatched closing parenthesis.');
        this.pos += 1;
        if (tok.k === '(') {
            const inner = this.or();
            const close = this.toks[this.pos];
            if (!close || close.k !== ')') throw new MailboxQueryError('The search has an unclosed parenthesis.');
            this.pos += 1;
            return { ...inner, start: tok.start, end: close.end };
        }
        if (tok.s === 'OR' || tok.s === 'AND') throw new MailboxQueryError(`The search has a stray ${tok.s}.`);
        const cat = categoryOf(tok.s);
        if (!cat) return { t: 'text', start: tok.start, end: tok.end };
        const leaf: Node = { t: 'cat', name: cat.name, start: tok.start, end: tok.end };
        return cat.negated ? { t: 'not', item: leaf, start: tok.start, end: tok.end } : leaf;
    }
}

const has = (node: Node, kind: 'cat' | 'text'): boolean => {
    if (node.t === kind) return true;
    if (node.t === 'and' || node.t === 'or') return node.items.some((n) => has(n, kind));
    if (node.t === 'not') return has(node.item, kind);
    return false;
};

/** The top-level AND conjuncts; a parenthesised AND that holds a category is opened up too. */
function conjuncts(node: Node): Node[] {
    if (node.t === 'and' && has(node, 'cat')) return node.items.flatMap(conjuncts);
    return [node];
}

const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The OData form of a category-only expression. `or` inside `and` is parenthesised. */
function odata(node: Node, parent: 'top' | 'and' | 'or'): string {
    if (node.t === 'cat') return `categories/any(c:c eq ${quoted(node.name)})`;
    if (node.t === 'not') {
        throw new MailboxQueryError('NOT on a category is not supported for Outlook; list the categories you want instead.');
    }
    if (node.t === 'text') return '';
    const joined = node.items.map((n) => odata(n, node.t as 'and' | 'or')).join(` ${node.t} `);
    return node.t === 'or' && parent === 'and' ? `(${joined})` : joined;
}

/** Does a message with these (lower-cased) categories satisfy the expression? */
function holds(node: Node, have: Set<string>): boolean {
    switch (node.t) {
        case 'cat': return have.has(node.name.toLowerCase());
        case 'not': return !holds(node.item, have);
        case 'and': return node.items.every((n) => holds(n, have));
        case 'or': return node.items.some((n) => holds(n, have));
        default: return true;
    }
}

export type OutlookQueryPlan = {
    /** KQL for $search, verbatim from the query; '' when there is none. */
    text: string;
    /** OData clauses (without the date) for the categories; only when there is no text. */
    filters: Array<{ sql: string; or: boolean }>;
    /** Applies the category expression to a message's categories (all pass when the query names none). */
    matches: (categories: string | string[] | null | undefined) => boolean;
};

const snippet = (q: string, node: Node) => q.slice(node.start, node.end).slice(0, 80);

/**
 * Split a query into $search text and a category expression. Throws a
 * MailboxQueryError (status 422, safe to show) for what cannot be split.
 */
export function planOutlookQuery(query: string | null | undefined): OutlookQueryPlan {
    const q = String(query || '').trim();
    const all = () => true;
    if (!q) return { text: '', filters: [], matches: all };
    if (q.length > MAX_PARSE_LEN) throw new MailboxQueryError('The search is too long.');
    const toks = tokenize(q);
    let tree: Node;
    try {
        tree = new Parser(toks).parse();
    } catch (err) {
        // A query without categories is Graph's to judge, as before.
        if (!toks.some((t) => t.k === 'w' && categoryOf(t.s))) return { text: q, filters: [], matches: all };
        throw err;
    }
    if (!has(tree, 'cat')) return { text: q, filters: [], matches: all };

    const catParts: Node[] = [];
    const textParts: string[] = [];
    for (const part of conjuncts(tree)) {
        const isCat = has(part, 'cat');
        if (isCat && has(part, 'text')) {
            throw new MailboxQueryError(
                `category: can only be combined with other search terms by AND — \`${snippet(q, part)}\` mixes them.`,
            );
        }
        if (isCat) catParts.push(part);
        else textParts.push(q.slice(part.start, part.end));
    }
    const text = textParts.join(' AND ');
    const expr: Node = catParts.length === 1
        ? catParts[0]
        : { t: 'and', items: catParts, start: 0, end: q.length };
    const matches = (categories: string | string[] | null | undefined) => {
        const list = Array.isArray(categories) ? categories : String(categories || '').split(',');
        return holds(expr, new Set(list.map((c) => c.trim().toLowerCase()).filter(Boolean)));
    };
    const filters = text ? [] : catParts.map((p) => ({ sql: odata(p, 'top'), or: p.t === 'or' }));
    return { text, filters, matches };
}

/** The query string of one listing request, and the check the caller applies to the results. */
export function outlookListQuery({ query, sinceIso, select, top }: {
    query?: string | null; sinceIso?: string | null; select: string; top: number;
}): { qs: string; matches: OutlookQueryPlan['matches'] } {
    const { text, filters, matches } = planOutlookQuery(query);
    const params = new URLSearchParams();
    params.set('$select', select);
    params.set('$top', String(top));
    if (text) {
        // $search cannot be combined with $filter or ordered. Inner double quotes
        // would end the literal, so they are dropped; the rest is the user's KQL.
        params.set('$search', `"${text.replace(/"/g, '')}"`);
    } else {
        // The watermark is on lastModifiedDateTime, not receivedDateTime: adding a
        // category to an OLD message bumps lastModifiedDateTime but not the
        // received time, and "label the requests the app should pick up" is the
        // intended workflow. Graph requires a $orderby property to be in the
        // $filter, in the same order; without a since the order stays by received.
        params.set('$orderby', sinceIso ? 'lastModifiedDateTime desc' : 'receivedDateTime desc');
        // An OR among several clauses needs its own parentheses.
        const many = filters.length + (sinceIso ? 1 : 0) > 1;
        const clauses = [
            sinceIso ? `lastModifiedDateTime ge ${sinceIso}` : null,
            ...filters.map((f) => (many && f.or ? `(${f.sql})` : f.sql)),
        ].filter(Boolean);
        if (clauses.length) params.set('$filter', clauses.join(' and '));
    }
    // URLSearchParams writes a space as '+', which OData reads literally.
    return { qs: params.toString().replace(/\+/g, '%20'), matches: text ? matches : () => true };
}
