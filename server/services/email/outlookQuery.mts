/**
 * The Graph request behind one Outlook mailbox listing, with Gmail's label
 * syntax understood.
 *
 * Outlook has no labels; it has categories, and Graph's $search cannot reach
 * them (KQL there knows from, subject, received and the like, not category).
 * Handed to $search, `label:daniel` became free text and the date filter was
 * dropped with it. So `label:` terms are pulled out of the query and become a
 * categories filter, written the way a Gmail user already writes them:
 *
 *   label:a label:b          both (AND)
 *   label:a OR label:b       either (OR)
 *   label:a OR label:b label:c   (a or b) and c
 *   label:"Daniel B"         a name with a space
 *
 * Whatever else the query holds stays a $search. Graph refuses $search and
 * $filter in one request, so with text present the labels are applied to the
 * results here instead (`labelGroups`), and the date filter is lost exactly as
 * before; without text, labels and date go to Graph as one $filter.
 */

/** Label groups: every group must match, any label within a group will do. */
export type LabelGroups = string[][];

const TOKEN = /-?label:"[^"]*"|-?label:\S+|"[^"]*"|\S+/gi;

/** The `label:` terms of a query as AND-of-OR groups, and the text left over. */
export function parseLabelQuery(query: string | null | undefined): { text: string; groups: LabelGroups } {
    const groups: LabelGroups = [];
    const text: string[] = [];
    let lastWasLabel = false;
    let orPending = false;
    for (const token of String(query || '').match(TOKEN) || []) {
        const label = /^label:/i.test(token) ? token.slice(6).replace(/^"|"$/g, '').trim() : null;
        if (label) {
            if (orPending && lastWasLabel) groups[groups.length - 1].push(label);
            else groups.push([label]);
            lastWasLabel = true;
            orPending = false;
        } else if (token === 'OR' && lastWasLabel) {
            orPending = true;
        } else {
            if (orPending) text.push('OR');
            text.push(token);
            lastWasLabel = false;
            orPending = false;
        }
    }
    return { text: text.join(' ').trim(), groups };
}

const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** One OData clause for the groups: `categories/any(c:c eq 'a' or c eq 'b') and categories/any(c:c eq 'c')`. */
export function categoriesFilter(groups: LabelGroups): string | null {
    if (!groups.length) return null;
    return groups
        .map((group) => `categories/any(c:${group.map((name) => `c eq ${quoted(name)}`).join(' or ')})`)
        .join(' and ');
}

/** Do these categories satisfy the groups? Case-insensitive, like Outlook's own category names. */
export function matchesLabelGroups(categories: string | string[] | null | undefined, groups: LabelGroups): boolean {
    if (!groups.length) return true;
    const list = Array.isArray(categories) ? categories : String(categories || '').split(',');
    const have = new Set(list.map((c) => c.trim().toLowerCase()).filter(Boolean));
    return groups.every((group) => group.some((name) => have.has(name.toLowerCase())));
}

/**
 * The query string of one listing request, and the label groups the caller
 * still has to apply itself (only when text forced a $search).
 */
export function outlookListQuery({ query, sinceIso, select, top }: {
    query?: string | null; sinceIso?: string | null; select: string; top: number;
}): { qs: string; labelGroups: LabelGroups } {
    const { text, groups } = parseLabelQuery(query);
    const params = new URLSearchParams();
    params.set('$select', select);
    params.set('$top', String(top));
    if (text) {
        // $search cannot be combined with $filter or ordered.
        params.set('$search', `"${text.replace(/"/g, '')}"`);
    } else {
        params.set('$orderby', 'receivedDateTime desc');
        const clauses = [sinceIso ? `receivedDateTime ge ${sinceIso}` : null, categoriesFilter(groups)].filter(Boolean);
        if (clauses.length) params.set('$filter', clauses.join(' and '));
    }
    // URLSearchParams writes a space as '+', which OData reads literally.
    return { qs: params.toString().replace(/\+/g, '%20'), labelGroups: text ? groups : [] };
}
