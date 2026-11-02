/**
 * Builder tools: the advice and index fixes of the path check (refCheck.js),
 * split off to keep that file small. Pure helpers over path tokens and the
 * shape tree.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { formatPath, appendMatch } = nodeRequire('../expr');
const S = nodeRequire('./shapeTree');

export type Token = { type: string, key?: string | number, value?: unknown };

export const splice = (tokens: Token[], at: number, del: number, ...ins: Token[]): Token[] => [...tokens.slice(0, at), ...ins, ...tokens.slice(at + del)];

/**
 * The fixes that put an index in front of the key at `at`. [*] where a list is
 * wanted. Otherwise [0], except into the `results` of a forEach step: there
 * [0] reads ONLY the first iteration, so it is never applied by itself: both
 * stay candidates and the model picks (BFSF-487).
 */
export function indexFixes(tokens: Token[], at: number, { list, ins, why, wantList }: { list: any, ins: Token[], why: string, wantList?: boolean }) {
    const wild = { type: 'wild' };
    const first = { type: 'prop', key: 0 };
    const fix = (idx: Token, text: string) => ({ tokens: splice(tokens, at, 0, ...ins, idx), why: text });
    if (wantList) return [fix(wild, why)];
    if (list && list.item && list.item.envelope) {
        return [fix(wild, why), { ...fix(first, why), firstIteration: true }];
    }
    return [fix(first, why)];
}

/**
 * Advice for a path that resolves but indexes the `results` of a forEach step
 * by number: it reads one iteration only. Said, never rewritten (a path that
 * resolves is not changed); the index may be what the model means.
 */
export function firstIterationAdvice(root: any, tokens: Token[], from: number): string[] {
    const out: string[] = [];
    tokens.forEach((tok, i) => {
        const prev = tokens[i - 1];
        if (i <= from || tok.type !== 'prop' || typeof tok.key !== 'number' || !prev || prev.type !== 'prop' || prev.key !== 'results') return;
        const w = S.walk(root, tokens.slice(0, i), from, []);
        if (w.status !== 'ok' || !w.node || w.node.t !== 'arr' || !w.node.item || !w.node.item.envelope) return;
        const wild = formatPath(splice(tokens, i, 1, { type: 'wild' }));
        out.push(`${formatPath(tokens.slice(0, i + 1))} reads only the first iteration of a step that runs once per item; ${wild} reads every iteration`);
    });
    return out;
}

/**
 * Advice for a numeric index into a name/value list. The index is KEPT: it
 * is a path the run reads (`ranking[0]` is whoever ranks first, `headers[1]`
 * the second header even when two share a name), and a match would read
 * another entry — or freeze a sample value into the definition. Picking by
 * name is only SAID: when the lists seen disagree on their order, and when
 * the entry at the index had a name no other entry shares.
 */
export function pairIndexAdvice(tokens: Token[], hits: any[] | undefined): string | null {
    for (const h of hits || []) {
        const { nameKey, valueKey, names, byIndex } = h.list.pairs;
        const listPath = formatPath(tokens.slice(0, h.at));
        if (!byIndex) {
            return `${listPath} is a list of ${nameKey}/${valueKey} pairs whose order differs per record — [${h.index}] picks a different entry each time; select one by name, e.g. ${appendMatch(listPath, nameKey, names[0])}`;
        }
        const name = byIndex[h.index < 0 ? byIndex.length + h.index : h.index];
        if (name === undefined || byIndex.indexOf(name) !== byIndex.lastIndexOf(name)) return null;
        const byName = formatPath(splice(tokens, h.at, 1, { type: 'match', key: nameKey, value: name }));
        return `${listPath}[${h.index}] reads whichever entry sits there (in the sample: "${name}"); if you mean the entry named "${name}" on every record, bind ${byName}`;
    }
    return null;
}
