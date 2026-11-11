// @typecheck strict
/**
 * Golden corpus cases for the collection functions (sort, reverse, slice,
 * groupBy, keys, values, merge, range, reduce), the list and object literals
 * and `??`, evaluated against corpus.mjs's SCOPE. corpus.mjs spreads them into
 * CASES and REJECT, so every runner of the corpus (server, browser parity)
 * runs them too. Each of them was a parse error before it existed.
 */

const ING = { bank: 'ING', ratio: 1.2 };
const ABN = { bank: 'ABN | AMRO', ratio: 0.9, note: 'x' };

export const COLLECTION_CASES = [
    // list and object literals
    { expr: '[1, "a", true, null]', expected: [1, 'a', true, null] },
    { expr: '[]', expected: [] },
    { expr: '{}', expected: {} },
    { expr: '[1, 2,]', expected: [1, 2] },                                       // a trailing comma is allowed
    { expr: '{ name: currentUser.name, "the total": item.total * 2, }', expected: { name: 'Tom', 'the total': 100 } },
    { expr: '[form.amount, [item.region]]', expected: [120, ['EU']] },
    { expr: '{ a: { b: [1] } }.a.b[0]', expected: 1 },                           // a literal reads on like any value
    { expr: '[10, 20, 30][1]', expected: 20 },
    { expr: 'item.tags[0]', expected: 'x' },                                     // after a name `[` is still an index
    { expr: 'len([1, 2, 3])', expected: 3 },
    { expr: 'includes(["EU", "US"], item.region)', expected: true },
    { expr: 'form.qty > 0 ? [1] : []', expected: [] },
    { expr: '{ __proto__: 1 }.__proto__', expected: 1 },                         // a key is a key, never the prototype
    { expr: '{ a: 1 }.constructor', expected: undefined },                       // own properties only
    { expr: 'map(table, { bank: it.bank, high: it.ratio > 1 })', expected: [{ bank: 'ING', high: true }, { bank: 'ABN | AMRO', high: false }] },
    // ?? : the right side when the left is null or missing, and only then
    { expr: 'missing.x ?? "none"', expected: 'none' },
    { expr: 'form.qty ?? 5', expected: 0 },                                      // 0 is a value (|| would give 5)
    { expr: 'form.qty || 5', expected: 5 },
    { expr: 'null ?? missing.x ?? 7', expected: 7 },
    { expr: '"" ?? "x"', expected: '' },
    { expr: 'false ?? true', expected: false },
    { expr: 'missing.x ?? form.qty || 9', expected: 9 },                         // ?? binds looser than ||
    { expr: 'form.qty || missing.x ?? 3', expected: 3 },
    { expr: 'missing.x ?? 1 ? "a" : "b"', expected: 'a' },                       // and tighter than ?:
    { expr: '(form.none ?? item).region', expected: 'EU' },
    { expr: '1 + (missing.x ?? 2)', expected: 3 },
    // sort: a copy; numbers by value, text ignoring case, empty values last
    { expr: 'sort([3, 1, 2])', expected: [1, 2, 3] },
    { expr: 'sort([3, 1, 2], null, "desc")', expected: [3, 2, 1] },
    { expr: 'sort(["b", "A", "c"])', expected: ['A', 'b', 'c'] },
    { expr: 'sort([2, null, "a", 1, true])', expected: [1, 2, 'a', true, null] },
    { expr: 'sort([2, null, 1], null, "desc")', expected: [2, 1, null] },
    { expr: 'sort(table, "ratio")', expected: [ABN, ING] },
    { expr: 'sort(table, "bank", "desc")', expected: [ING, ABN] },
    { expr: 'map(sort(table, "ratio"), it.bank)[0] + first(table).bank', expected: 'ABN | AMROING' },   // the input keeps its order
    { expr: 'sort(missing.x)', expected: [] },
    { expr: 'sort(["10", "9"])', expected: ['10', '9'] },                        // text stays text
    // reverse, slice
    { expr: 'reverse(item.tags)', expected: ['y', 'x'] },
    { expr: 'reverse(reverse([1, 2, 3]))', expected: [1, 2, 3] },
    { expr: 'reverse("abc")', expected: [] },                                    // lists only
    { expr: 'slice([1, 2, 3, 4], 1)', expected: [2, 3, 4] },
    { expr: 'slice([1, 2, 3, 4], 1, 3)', expected: [2, 3] },
    { expr: 'slice([1, 2, 3, 4], -2)', expected: [3, 4] },
    { expr: 'slice([1, 2, 3, 4], 0, -1)', expected: [1, 2, 3] },
    { expr: 'slice(sort(table, "ratio", "desc"), 0, 1)', expected: [ING] },
    { expr: 'slice(missing.x, 0, 2)', expected: [] },
    // groupBy: { key, items } per value, in first-occurrence order
    { expr: 'first(groupBy(mail.attachments, "mimeType"))["key"]', expected: 'application/pdf' },
    { expr: 'map(groupBy([{ s: "a", n: 1 }, { s: "b", n: 2 }, { s: "a", n: 3 }], "s"), { s: it["key"], total: sum(it.items, "n") })', expected: [{ s: 'a', total: 4 }, { s: 'b', total: 2 }] },
    { expr: 'groupBy([1, "1", 1], null)', expected: [{ key: 1, items: [1, 1] }, { key: '1', items: ['1'] }] },
    { expr: 'groupBy([{ a: 1 }, {}], "a")', expected: [{ key: 1, items: [{ a: 1 }] }, { key: null, items: [{}] }] },
    { expr: 'groupBy(missing.x, "a")', expected: [] },
    // keys, values, merge
    { expr: 'keys(vars)', expected: ['rate'] },
    { expr: 'keys({ b: 1, a: 2 })', expected: ['b', 'a'] },
    { expr: 'values({ b: 1, a: 2 })', expected: [1, 2] },
    { expr: 'keys(item.tags)', expected: [] },                                   // an object, not a list
    { expr: 'keys(missing.x)', expected: [] },
    { expr: 'keys(weird)', expected: ['constructor'] },                          // own fields only
    { expr: 'merge({ a: 1, b: 2 }, { b: 3 }, null, [9], { c: 4 })', expected: { a: 1, b: 3, c: 4 } },
    { expr: 'merge(vars, { rate: 2 }).rate + vars.rate', expected: 3.21 },       // the input is not changed
    { expr: 'merge()', expected: {} },
    // range
    { expr: 'range(3)', expected: [0, 1, 2] },
    { expr: 'range(2, 5)', expected: [2, 3, 4] },
    { expr: 'range(0, 10, 4)', expected: [0, 4, 8] },
    { expr: 'range(3, 0, -1)', expected: [3, 2, 1] },
    { expr: 'range(0)', expected: [] },
    { expr: 'range(5, 2)', expected: [] },
    { expr: 'range(0, 5, 0)', expected: [] },
    { expr: 'range("x")', expected: [] },
    { expr: 'map(range(1, 4), it * it)', expected: [1, 4, 9] },
    // reduce: `it` is the item, `acc` the result so far
    { expr: 'reduce([1, 2, 3], acc + it, 0)', expected: 6 },
    { expr: 'reduce(table, acc + it.ratio * 10, 0)', expected: 21 },
    { expr: 'reduce(item.tags, acc + upper(it), "")', expected: 'XY' },
    { expr: 'reduce(missing.x, acc + it, "start")', expected: 'start' },
    { expr: 'reduce([], acc + it, 5)', expected: 5 },
    { expr: 'reduce([3, 9, 4], it > acc ? it : acc, 0)', expected: 9 },
    { expr: 'reduce(table, merge(acc, { n: acc.n + 1, last: it.bank }), { n: 0 })', expected: { n: 2, last: 'ABN | AMRO' } },
    { expr: 'reduce([1, 2], acc + reduce([10, 20], acc + it, 0) * it, 0)', expected: 90 },   // the inner acc and it are the inner ones
    { expr: 'reduce([1, 2], acc + sum(map([1, 1], it + acc)), 0)', expected: 8 },           // acc is still the result so far inside map()
    { expr: 'map([1, 2], reduce([10], acc + it, it))', expected: [11, 12] },                 // the start value reads the outer it
];

// Expressions that MUST throw at parse time.
export const COLLECTION_REJECT = [
    'reduce(item.tags, acc + it)',              // reduce needs its start value
    'reduce(item.tags)',
    'reduce(item.tags, acc, 0, 1)',
    '[1, 2',
    '[1 2]',
    '[,]',
    '{ a: 1',
    '{ a }',                                    // no shorthand
    '{ a: 1, a: 2 }',                           // a field once
    '{ 1: 2 }',                                 // a field name is a name or a quoted text
    '{ true: 1 }',
    '{ a: 1 }}',
    'a ??',
    '?? a',
    'a ? ? b',                                  // two question marks apart are still nothing
    'a ?. b',
    '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]',   // 33 deep: one past MAX_LITERAL_DEPTH
];
