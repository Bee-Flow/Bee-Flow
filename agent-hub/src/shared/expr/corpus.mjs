/**
 * Golden expression corpus — the anti-drift contract.
 *
 * Imported by BOTH the server test (shared/expr/engine.test.mjs under
 * `node --test`) and the client parity test (agent-hub vitest), and each side
 * asserts `evaluate(expr, scope)` deepEquals `expected`. Because both import
 * the identical engine AND the client test additionally cross-checks against
 * the server's re-export, any divergence between Node and the browser build is
 * a test failure.
 *
 * Add a case here (not in one runner) whenever the grammar/whitelist changes.
 */

export const SCOPE = {
    actions: { search: { status: 'success', result: { count: 3, rows: [{ name: 'A' }, { name: 'B' }] } } },
    form: { amount: 120, email: 'a@b.com', qty: 0 },
    item: { total: 50, region: 'EU', tags: ['x', 'y'] },
    currentUser: { id: 'u1', role: 'manager', name: 'Tom' },
    vars: { rate: 1.21 },
    now: '2026-07-04T12:00:00Z',
    today: '2026-07-04',
    weird: { constructor: 'SHOULD_NOT_LEAK', __proto__: { poisoned: true } },
    rawJson: '{"user":{"name":"Ada"},"items":[{"sku":"a1","qty":2},{"sku":"b2","qty":0}]}',
    badJson: '{oops',
    // Fixtures for the formatting helpers. Shape AND values are copied from
    // functions.format.test.mjs (the group at its line 85, the rows at 94), so
    // the expected strings below are that file's assertions verbatim instead
    // of a second, independently invented truth.
    group: { customer_name: 'Alice', amount: 1500000, tags: ['a', 'b'], address: { city: 'Delft', zip: '2611' } },
    table: [{ bank: 'ING', ratio: 1.2 }, { bank: 'ABN | AMRO', ratio: 0.9, note: 'x' }],
    // A mail with files, for the rule functions (equals, fileType, anyOf/everyOf/noneOf).
    mail: {
        none: [],
        attachments: [
            { filename: 'Factuur.pdf', mimeType: 'application/pdf' },
            { filename: 'Tarieven.PPTX', mimeType: 'application/octet-stream' },
            { filename: 'logo.png', mimeType: 'image/png' },
        ],
    },
};

export const CASES = [
    // literals + arithmetic
    { expr: '1 + 2 * 3', expected: 7 },
    { expr: '(1 + 2) * 3', expected: 9 },
    { expr: '10 % 3', expected: 1 },
    { expr: '-5 + 3', expected: -2 },
    { expr: '2.5 + 0.5', expected: 3 },
    // strings + booleans + ternary
    { expr: '"a" + "b"', expected: 'ab' },
    { expr: 'true && false', expected: false },
    { expr: 'true || false', expected: true },
    { expr: '!false', expected: true },
    { expr: '1 < 2 ? "yes" : "no"', expected: 'yes' },
    // comparison (loose vs strict)
    { expr: '1 == "1"', expected: true },
    { expr: '1 === "1"', expected: false },
    { expr: '2 != 3', expected: true },
    // path access (dot + bracket)
    { expr: 'form.amount', expected: 120 },
    { expr: 'actions.search.result.count', expected: 3 },
    { expr: 'actions.search.result.rows[0].name', expected: 'A' },
    { expr: 'actions.search.result.rows[1].name', expected: 'B' },
    { expr: 'item.tags[1]', expected: 'y' },
    { expr: 'missing.path.here', expected: undefined },
    { expr: 'currentUser.role == "manager"', expected: true },
    // string members — a PRIMITIVE is read with the same own-property rule as
    // an object (server/automation/bind.js resolveTokens has always done this,
    // relying on hasOwnProperty.call auto-boxing). The engine used to gate
    // member access on `typeof cur === 'object'`, so `…body.length > 5` was
    // permanently false in a condition while the identical path in a ref
    // binding resolved to a number. These cases pin the two together.
    { expr: 'form.email.length', expected: 7 },
    { expr: 'form.email.length > 5', expected: true },
    { expr: 'currentUser.name[0]', expected: 'T' },
    { expr: 'item.tags[0].length', expected: 1 },
    { expr: 'form.email.toUpperCase', expected: undefined },  // string prototype method stays blocked
    { expr: 'form.amount.toFixed', expected: undefined },     // a number has no own properties at all
    // original whitelist
    { expr: 'contains(form.email, "@")', expected: true },
    { expr: 'startsWith(currentUser.name, "T")', expected: true },
    { expr: 'endsWith(form.email, ".com")', expected: true },
    { expr: 'lower(currentUser.name)', expected: 'tom' },
    { expr: 'upper(item.region)', expected: 'EU' },
    { expr: 'len(item.tags)', expected: 2 },
    { expr: 'isEmpty("")', expected: true },
    { expr: 'isEmpty(item.tags)', expected: false },
    // extended: numeric
    { expr: 'number("42")', expected: 42 },
    { expr: 'number("nope")', expected: null },
    { expr: 'round(3.14159, 2)', expected: 3.14 },
    { expr: 'round(2.5)', expected: 3 },
    // round() wraps nearly every scientific formula, so it obeys the same
    // totality rule: 10^400 is Infinity, and Infinity/Infinity used to hand
    // back the literal text "NaN".
    { expr: 'round(1.5, 400)', expected: null },
    { expr: 'floor(2.9)', expected: 2 },
    { expr: 'ceil(2.1)', expected: 3 },
    { expr: 'abs(-7)', expected: 7 },
    { expr: 'min(3, 1, 2)', expected: 1 },
    { expr: 'max(3, 1, 2)', expected: 3 },
    { expr: 'clamp(15, 0, 10)', expected: 10 },
    { expr: 'sum(item.tags)', expected: 0 },
    { expr: 'form.amount * vars.rate', expected: 145.2 },
    // extended: maths (scientific). Every one of these is TOTAL — a domain
    // error, a pole or an overflow returns null, never NaN/Infinity, so a
    // formula can never paint the text "NaN" into a stat. Float results are
    // pinned through round() so the corpus states an exact decimal.
    { expr: 'round(PI(), 5)', expected: 3.14159 },   // constants are ZERO-ARG CALLS, not scope roots
    { expr: 'round(E(), 5)', expected: 2.71828 },
    { expr: 'PI', expected: undefined },             // …so a bare `PI` is just an unset scope path
    { expr: 'pow(2, 10)', expected: 1024 },
    { expr: 'pow(2, 0.5) == sqrt(2)', expected: true },
    { expr: 'pow(0, -1)', expected: null },          // pole → null, NOT Infinity
    { expr: 'pow(2, 10000)', expected: null },       // overflow → null
    { expr: 'pow(-8, 1 / 3)', expected: null },      // NaN in IEEE-754 → null; use cbrt
    { expr: 'pow(2, missing.x)', expected: null },
    { expr: 'sqrt(16)', expected: 4 },
    { expr: 'sqrt("16")', expected: 4 },             // same string coercion as every other numeric helper
    { expr: 'sqrt(-1)', expected: null },
    { expr: 'sqrt(missing.x)', expected: null },
    { expr: 'cbrt(-27)', expected: -3 },
    { expr: 'exp(0)', expected: 1 },
    { expr: 'round(exp(1), 5)', expected: 2.71828 },
    { expr: 'exp(1000)', expected: null },
    { expr: 'ln(1)', expected: 0 },
    { expr: 'ln(E())', expected: 1 },
    { expr: 'ln(0)', expected: null },
    { expr: 'ln(-1)', expected: null },
    { expr: 'log10(1000)', expected: 3 },
    { expr: 'log(1000)', expected: 3 },              // log() defaults to base 10 (ln() is the natural one)
    { expr: 'log(8, 2)', expected: 3 },
    { expr: 'log(100, 1)', expected: null },         // base 1 is undefined
    { expr: 'log(100, 0)', expected: null },
    { expr: 'log(0)', expected: null },
    { expr: 'round(sin(radians(30)), 10)', expected: 0.5 },
    { expr: 'cos(0)', expected: 1 },
    { expr: 'round(tan(radians(45)), 10)', expected: 1 },
    { expr: 'acos(1)', expected: 0 },
    { expr: 'asin(2)', expected: null },             // outside [-1, 1] → null
    { expr: 'acos(-2)', expected: null },
    { expr: 'round(atan(1), 10)', expected: 0.7853981634 },
    { expr: 'round(atan2(1, 1), 10)', expected: 0.7853981634 },
    { expr: 'sinh(0)', expected: 0 },
    { expr: 'cosh(0)', expected: 1 },
    { expr: 'tanh(0)', expected: 0 },
    { expr: 'sinh(1000)', expected: null },          // overflow → null
    { expr: 'degrees(PI())', expected: 180 },
    { expr: 'round(radians(180), 10)', expected: 3.1415926536 },
    { expr: 'sign(-3)', expected: -1 },
    { expr: 'sign(0)', expected: 0 },
    { expr: 'sign(4)', expected: 1 },
    { expr: 'sign(missing.x)', expected: null },
    { expr: 'trunc(-2.7)', expected: -2 },           // toward zero…
    { expr: 'floor(-2.7)', expected: -3 },           // …unlike floor
    { expr: 'mod(-1, 12)', expected: 11 },           // TRUE modulo: sign of the divisor
    { expr: '-1 % 12', expected: -1 },               // the % OPERATOR is a remainder: sign of the dividend
    { expr: 'mod(7, 3)', expected: 1 },
    { expr: 'mod(-6, 3)', expected: 0 },
    { expr: 'mod(7, 0)', expected: null },
    { expr: 'hypot(3, 4)', expected: 5 },
    { expr: 'hypot(3, 4, 12)', expected: 13 },
    { expr: 'hypot()', expected: null },
    { expr: 'hypot("nope")', expected: null },
    { expr: 'factorial(0)', expected: 1 },
    { expr: 'factorial(5)', expected: 120 },
    { expr: 'factorial(-1)', expected: null },
    { expr: 'factorial(2.5)', expected: null },
    { expr: 'factorial(171)', expected: null },      // 171! is Infinity in a double
    { expr: 'factorial(1000000000)', expected: null }, // guard is also the loop bound — returns instantly
    // The `^` OPERATOR. Right-associative, and binding TIGHTER than unary
    // minus — the two decisions this file exists to pin. Same answers as
    // Python; JS refuses to choose and makes `-2 ** 2` a syntax error.
    { expr: '2 ^ 10', expected: 1024 },
    { expr: '2 ^ 3 ^ 2', expected: 512 },            // right-assoc: 2^(3^2), NOT (2^3)^2 = 64
    { expr: '-2 ^ 2', expected: -4 },                // -(2^2), NOT (-2)^2 = 4
    { expr: '(-2) ^ 2', expected: 4 },               // …brackets get the other reading
    { expr: '2 ^ -2', expected: 0.25 },              // unary minus is fine on the RIGHT
    { expr: '2 * 3 ^ 2', expected: 18 },             // ^ binds tighter than *
    { expr: '2 ^ 3 * 2', expected: 16 },             // …and looser than nothing on its left
    { expr: '1 + 2 ^ 3', expected: 9 },
    { expr: '2 ^ 10 == pow(2, 10)', expected: true },// the operator IS pow()
    { expr: '2 ^ 10000', expected: null },           // …so it inherits pow's totality
    { expr: 'form.amount ^ 0', expected: 1 },
    // `/` is DELIBERATELY NOT total: 1/0 has been Infinity since the engine's
    // first commit and stored definitions + automation conditions depend on it.
    // Only the new maths surface gets the null rule. Pinned so a future
    // "let's make everything total" change has to face the decision.
    { expr: '1 / 0', expected: Infinity },
    { expr: '-1 / 0', expected: -Infinity },
    // extended: null/logic
    { expr: 'coalesce(missing.x, form.qty, 99)', expected: 0 },
    { expr: 'coalesce(missing.x, missing.y)', expected: null },
    { expr: 'default(missing.x, "fallback")', expected: 'fallback' },
    { expr: 'ifNull(form.amount, 0)', expected: 120 },
    // extended: string
    { expr: 'trim("  hi  ")', expected: 'hi' },
    { expr: 'concat("a", "-", "b")', expected: 'a-b' },
    { expr: 'replace("a.b.c", ".", "/")', expected: 'a/b/c' },
    { expr: 'join(item.tags, ",")', expected: 'x,y' },
    { expr: 'substring("hello", 1, 3)', expected: 'el' },
    { expr: 'toStr(form.amount)', expected: '120' },
    // sumCounts — derive a total from a "2x M5 + 4x M8" breakdown so the two
    // can never disagree. Only n-times-something counts: a dimension pair
    // ("100 x 80") and a thread pitch ("M8x1.25") are NOT quantities, and a
    // string with no groups gives null rather than a confident zero.
    { expr: 'sumCounts("2x M5 + 4x M8")', expected: 6 },
    { expr: 'sumCounts("2x M5 + 4x M8 + 3x M6")', expected: 9 },
    { expr: 'sumCounts("4 x ⌀6,4 THRU")', expected: 4 },
    // Two breakdowns where a naive count goes wrong. Kept here rather than in
    // an app's tests because they are what proves the ARITHMETIC reproduces
    // the target — the reading is the model's job, the adding up is this
    // function's.
    // A plate with two single M8 callouts and one 2x M4 → 4, not 6.
    { expr: 'sumCounts("1x M8 + 1x M8 + 2x M4")', expected: 4 },
    // Ten callouts on a long strip, with the "6x M5 THRU" group left out
    // because a THRU callout is a hole, not a tapping operation → 32, not 38.
    { expr: 'sumCounts("2x M4 + 4x M5 + 2x M4 + 4x M5 + 2x M4 + 4x M5 + 4x M5 + 2x M4 + 8x M4")', expected: 32 },
    { expr: 'sumCounts("100 x 80")', expected: null },
    { expr: 'sumCounts("M8x1.25")', expected: null },
    { expr: 'sumCounts("geen tappen")', expected: null },
    { expr: 'sumCounts("")', expected: null },
    { expr: 'sumCounts(null)', expected: null },
    { expr: 'isEmpty("") ? "" : concat(toStr(sumCounts("")), ".00")', expected: '' },
    { expr: 'isEmpty("2x M5 + 4x M8") ? "" : concat(toStr(sumCounts("2x M5 + 4x M8")), ".00")', expected: '6.00' },
    // extended: array
    { expr: 'first(item.tags)', expected: 'x' },
    { expr: 'last(item.tags)', expected: 'y' },
    { expr: 'includes(item.tags, "y")', expected: true },
    { expr: 'count(actions.search.result.rows)', expected: 2 },
    // positional navigation — at/index_of/pluck (the prev/next trio)
    { expr: 'at(item.tags, 1)', expected: 'y' },
    { expr: 'at(item.tags, -1)', expected: 'y' },       // negative counts from the end
    { expr: 'at(item.tags, 2)', expected: null },       // out of range → null, never a crash
    { expr: 'at("xy", 0)', expected: null },            // a string is not a list (matches first/last)
    { expr: 'index_of(item.tags, "Y")', expected: 1 },  // text matches case-insensitively, like includes()
    { expr: 'index_of(item.tags, "z")', expected: -1 },
    { expr: 'index_of("xy", "x")', expected: -1 },
    { expr: 'pluck(actions.search.result.rows, "name")', expected: ['A', 'B'] },
    { expr: 'pluck(actions.search.result.rows, "missing")', expected: [null, null] },
    { expr: 'pluck(item.tags, "length")', expected: [null, null] },        // non-object items → null (no auto-boxing)
    // find — the live row behind a selection
    { expr: 'find(actions.search.result.rows, "name", "B")', expected: { name: 'B' } },
    { expr: 'find(actions.search.result.rows, "name", "b")', expected: { name: 'B' } },   // text matches like includes(): case-insensitive
    { expr: 'find(actions.search.result.rows, "name", "Z")', expected: null },
    { expr: 'find(item.tags, "x", 1)', expected: null },                                  // non-object items are skipped
    { expr: 'find(vars.nothing, "id", 1)', expected: null },
    { expr: 'pluck(actions.search.result.rows, "constructor")', expected: [null, null] }, // own-property gate holds
    { expr: 'pluck(form, "amount")', expected: [] },    // not a list at all
    // …and the exact pattern the trio exists for: the row AFTER the current one
    { expr: 'at(pluck(actions.search.result.rows, "name"), index_of(pluck(actions.search.result.rows, "name"), "a") + 1)', expected: 'B' },
    // extended: date (UTC-deterministic)
    { expr: 'year(now)', expected: 2026 },
    { expr: 'month(today)', expected: 7 },
    { expr: 'day(today)', expected: 4 },
    { expr: 'formatDate(now, "YYYY-MM-DD")', expected: '2026-07-04' },
    { expr: 'formatDate(now, "HH:mm")', expected: '12:00' },
    { expr: 'dateDiff("2026-07-10", today, "day")', expected: 6 },
    { expr: 'isBefore(today, "2026-12-31")', expected: true },
    { expr: 'isAfter(now, "2026-01-01T00:00:00Z")', expected: true },
    { expr: 'formatDate(dateAdd(today, 1, "day"), "YYYY-MM-DD")', expected: '2026-07-05' },
    // extended: formatting helpers (the builder's "· as € 1.500.000" pills).
    // These five carry a LOCALE TABLE rather than Intl, which is exactly why
    // they belong here: the corpus is the only test that runs them through
    // BOTH runtimes, and a table that drifted between the two copies — or an
    // Intl call that sneaked in — would show up as a locale answering
    // differently in Node than in the browser. Expected values are copied
    // verbatim from functions.format.test.mjs.
    { expr: 'formatNumber(group.amount, "amount")', expected: '\u20ac 1.500.000' },
    { expr: 'formatNumber(group.amount, "plain")', expected: '1.500.000' },
    { expr: 'formatNumber(0.125, "percent")', expected: '12,5%' },          // the value is the fraction
    { expr: 'formatNumber(-12.5, "amount")', expected: '-\u20ac 12,50' },      // cents only when there are any
    { expr: 'formatNumber("1234.5")', expected: '1.234,5' },                // no style reads as plain
    { expr: 'formatNumber(1234.5678, "plain", "nl", 2)', expected: '1.234,57' },
    { expr: 'formatNumber(1234, "amount", "nl", 2)', expected: '\u20ac 1.234,00' },
    { expr: 'formatNumber(5, "nonsense")', expected: '5' },                 // unknown style reads as plain
    // …the locale TABLE, not Intl: separators, currency side and the space
    // before % are per-language constants that must be identical on both sides.
    { expr: 'formatNumber(group.amount, "amount", "en")', expected: '\u20ac1,500,000' },
    { expr: 'formatNumber(group.amount, "amount", "de")', expected: '1.500.000 \u20ac' },
    { expr: 'formatNumber(group.amount, "amount", "fr")', expected: '1 500 000 \u20ac' },
    { expr: 'formatNumber(0.125, "percent", "de")', expected: '12,5 %' },
    { expr: 'formatNumber(group.amount, "amount", "xx")', expected: '\u20ac 1.500.000' }, // unknown locale → nl
    // total: nothing numeric gives a clean empty slot, never "NaN"
    { expr: 'formatNumber(missing.x, "amount")', expected: '' },
    { expr: 'formatNumber("twelve", "amount")', expected: '' },
    // formatDate month/weekday NAMES come from the same table
    { expr: 'formatDate("2026-09-02", "D MMMM YYYY")', expected: '2 september 2026' },
    { expr: 'formatDate("2026-09-02", "D MMMM YYYY", "en")', expected: '2 September 2026' },
    { expr: 'formatDate("2026-09-02", "D MMMM YYYY", "fr")', expected: '2 septembre 2026' },
    { expr: 'formatDate("2026-01-15", "D MMMM YYYY", "de")', expected: '15 Januar 2026' }, // a second month, so one name is not the whole table
    { expr: 'formatDate("2026-09-02", "dddd D MMM", "nl")', expected: 'woensdag 2 sep' },
    { expr: 'formatDate("2026-09-02", "ddd D/M", "en")', expected: 'We 2/9' },
    { expr: 'formatDate("2026-09-02", "DD-MM-YYYY")', expected: '02-09-2026' },
    { expr: 'formatDate("2026-09-02T10:26:05Z", "D MMMM YYYY, HH:mm", "de")', expected: '2 September 2026, 10:26' },
    // …and the two ways a date reaches formatDate WITHOUT being strict ISO.
    // Both belong in the corpus and nowhere else, because both are about the
    // two runtimes agreeing rather than about one function's output:
    //   1. An unpadded or slashed date is read as that UTC day. It used to go
    //      through `Date.parse`, which reads it in the AMBIENT zone — so this
    //      very case rendered '2 september' under TZ=UTC and '1 september'
    //      under TZ=Europe/Amsterdam, i.e. the builder's preview and the run
    //      it previews disagreeing by a day. Pinned here so the corpus fails
    //      if anyone puts the fallback back.
    { expr: 'formatDate("2026-9-2", "D MMMM YYYY", "nl")', expected: '2 september 2026' },
    { expr: 'formatDate("2026/09/02", "D MMMM YYYY", "nl")', expected: '2 september 2026' },
    { expr: 'formatDate("2026-9-2 7:05", "D MMMM YYYY HH:mm", "nl")', expected: '2 september 2026 07:05' },
    //   2. Text nobody can read the same way twice is not read at all. Month
    //      names in prose are engine-defined for Date.parse (V8 and JSC need
    //      not agree), so '' — the same benign answer 'not a date' has always
    //      given — is the only answer both runtimes can promise.
    { expr: 'formatDate("Sep 2, 2026", "D MMMM YYYY", "nl")', expected: '' },
    { expr: 'isBefore("Sep 2, 2026", "2026-09-03")', expected: false },
    //   3. A NUMBER outside the range a Date can hold is not a date either.
    //      A nanosecond epoch (Prometheus, k8s, many webhooks) is finite and
    //      arrives through an HTTP step as a matter of course; it used to make
    //      the month table index on NaN and throw a bare TypeError out of a
    //      null-safe file — which surfaced as a silently empty field, a raw JS
    //      error string in a condition's output, and a dropped trigger event.
    { expr: 'formatDate(1757376000000000000, "D MMMM YYYY", "nl")', expected: '' },
    { expr: 'formatDate(1757376000000000000, "YYYY-MM-DD", "nl")', expected: '' },
    { expr: 'formatDate(1757376000000, "D MMMM YYYY", "nl")', expected: '9 september 2025' },
    { expr: 'year(1757376000000000000)', expected: null },
    // yesNoText — the word for each state, silent when undecidable
    { expr: 'yesNoText(true, "wel", "niet")', expected: 'wel' },
    { expr: 'yesNoText(false, "wel", "niet")', expected: 'niet' },
    { expr: 'yesNoText("ja", "wel", "niet")', expected: 'wel' },
    { expr: 'yesNoText(0, "wel", "niet")', expected: 'niet' },
    { expr: 'yesNoText(true)', expected: 'yes' },
    { expr: 'yesNoText("maybe", "wel", "niet")', expected: '' },     // undecidable → '', never a wrong "niet"
    { expr: 'yesNoText(missing.x, "wel", "niet")', expected: '' },
    // groupSummary / asTable — one readable line per field, one Markdown row
    // per record; nested values are flattened, pipes escaped.
    { expr: 'groupSummary(group)', expected: 'Customer name: Alice\nAmount: 1500000\nTags: a, b\nAddress: City: Delft, Zip: 2611' },
    { expr: 'groupSummary(missing.x)', expected: '' },
    { expr: 'asTable(table)', expected: '| Bank | Ratio | Note |\n| --- | --- | --- |\n| ING | 1.2 |  |\n| ABN \\| AMRO | 0.9 | x |' },
    { expr: 'asTable(item.tags)', expected: '| value |\n| --- |\n| x |\n| y |' },  // a list of scalars is one column
    { expr: 'asTable(currentUser.name)', expected: '' },                          // not a list at all
    { expr: 'asTable(missing.x)', expected: '' },
    // composition — a call as an ARGUMENT is fine; a member access ON a call
    // result is not (same grammar limit as parseJson below).
    { expr: 'concat("Totaal: ", formatNumber(group.amount, "amount"))', expected: 'Totaal: \u20ac 1.500.000' },
    { expr: 'yesNoText(isEmpty(item.tags), "leeg", "gevuld")', expected: 'gevuld' },
    // extended: JSON (parseJson never throws; two-arg path form because the
    // grammar has no member access on a call result)
    { expr: 'parseJson(rawJson, "user.name")', expected: 'Ada' },
    { expr: 'parseJson(rawJson, "items[0].qty")', expected: 2 },
    { expr: 'parseJson(rawJson, "items[*].sku")', expected: ['a1', 'b2'] },
    { expr: 'join(parseJson(rawJson, "items[*].sku"), ",")', expected: 'a1,b2' }, // composition
    { expr: 'parseJson(badJson)', expected: null },
    { expr: 'parseJson(missing.x)', expected: null },
    { expr: 'parseJson("   ")', expected: null },
    { expr: 'parseJson(item, "total")', expected: 50 },          // object passthrough
    { expr: 'parseJson(rawJson, "missing.x")', expected: undefined },
    { expr: 'parseJson(rawJson, "user.constructor")', expected: undefined }, // proto gate holds inside parsed JSON
    { expr: 'default(parseJson(badJson), "fb")', expected: 'fb' },
    // rules (rules.mjs): equals ignores case and surrounding spaces, "5" equals 5
    { expr: 'equals("Open ", "open")', expected: true },
    { expr: 'equals(5, "5")', expected: true },
    { expr: 'equals("007", "7")', expected: false },
    { expr: 'equals("0612345678", "612345678")', expected: false },
    { expr: 'equals("1234567890123456789", "1234567890123456788")', expected: false },
    { expr: 'equals(5, " 5 ")', expected: true },
    { expr: 'equals(mail.none, "")', expected: false },
    { expr: 'equals(null, "")', expected: false },
    { expr: 'equals(true, "true")', expected: true },
    { expr: 'equals("x,y", item.tags)', expected: false },
    { expr: 'equals(item.region, " eu ")', expected: true },
    { expr: '!equals(item.region, "us")', expected: true },
    // fileType: MIME first, the name's extension when the MIME says nothing
    { expr: 'fileType(mail.attachments[0])', expected: 'pdf' },
    { expr: 'fileType(mail.attachments[1])', expected: 'powerpoint' },
    { expr: 'fileType("report.xlsx")', expected: 'excel' },
    { expr: 'fileType("image/png")', expected: 'image' },
    { expr: 'fileType(mail.attachments)', expected: ['pdf', 'powerpoint', 'image'] },
    { expr: 'fileType(mail.attachments[*])', expected: ['pdf', 'powerpoint', 'image'] },
    { expr: 'fileType(null)', expected: null },
    { expr: 'fileType(missing.file)', expected: null },
    // anyOf / everyOf / noneOf: an explicit quantifier over a list
    { expr: 'anyOf(item.tags, "equals", "X")', expected: true },
    { expr: 'everyOf(item.tags, "contains", "x")', expected: false },
    { expr: 'everyOf(item.tags, "!equals", "z")', expected: true },
    { expr: 'noneOf(item.tags, "equals", "z")', expected: true },
    { expr: 'anyOf(item.tags, "!isEmpty")', expected: true },
    { expr: 'anyOf(mail.none, "equals", "x")', expected: false },
    { expr: 'everyOf(mail.none, "isEmpty")', expected: false },
    { expr: 'noneOf(mail.none, "isEmpty")', expected: true },
    { expr: 'anyOf(missing.list, "equals", "x")', expected: false },
    { expr: 'anyOf(fileType(mail.attachments[*]), "equals", "pdf")', expected: true },
    { expr: 'noneOf(fileType(mail.attachments[*]), "equals", "word")', expected: true },
    { expr: 'anyOf(mail.attachments[*].mimeType, "contains", "pdf")', expected: true },
    { expr: 'everyOf(mail.attachments[*].filename, "endsWith", ".pdf")', expected: false },
    { expr: 'anyOf(form.amount, ">", 100)', expected: true },
    // SECURITY: prototype access resolves to undefined, never leaks
    { expr: 'weird.constructor', expected: 'SHOULD_NOT_LEAK' }, // own prop is fine
    { expr: 'weird.poisoned', expected: undefined },            // inherited → undefined
    { expr: 'form["constructor"]', expected: undefined },       // inherited on plain obj → undefined
    { expr: 'form.toString', expected: undefined },             // prototype method → undefined
];

// Expressions that MUST throw at parse time (no arbitrary calls / bad grammar).
export const REJECT = [
    'fetch("http://evil")',
    'require("fs")',
    'process.exit(1)',
    'constructor("return 1")()',
    '1 +',
    '(1 + 2',
    'form.',
    'unknownFn(1)',
    '"unterminated',
    // `^` is a real operator now, so its grammar errors must still be errors.
    '2 ^',
    '^ 2',
    'pi()',      // the constants are PI()/E() — case-sensitive, like every other name
    // A host function (topics.mjs) only parses where the caller passes its
    // host. Everywhere else it is an unknown function, exactly as before.
    'isAbout(item.region, "a region")',
];

// ── Host functions: isAbout (topics.mjs) ─────────────────────────────────
// Evaluated with `{ host: makeTopicHost(new Map(Object.entries(HOST_SCORES)),
// { defaultThreshold: 0.5 }) }` against SCOPE. The keys of HOST_SCORES are
// normalised texts (normalizeTopicText) of SCOPE values.
export const HOST_SCORES = {
    EU: { 'a person': 0.12, 'a region': 0.91 },
    Tom: { 'a person': 0.77, 'a region': 0.08 },
};

export const HOST_CASES = [
    { expr: 'isAbout(item.region, "a region")', expected: true },
    { expr: 'isAbout(item.region, "a person")', expected: false },
    { expr: 'isAbout(item.region, "a person", 0.1)', expected: true },
    { expr: 'isAbout(item.region, "a region", 0.95)', expected: false },
    { expr: '!isAbout(item.region, "a person")', expected: true },
    { expr: 'isAbout(item.region, "  a region ")', expected: true },          // topics are trimmed
    { expr: 'isAbout(currentUser.name, "a person") && item.total > 10', expected: true },
    { expr: 'isAbout(form.missing, "a region")', expected: false },           // no text is never a match
    { expr: 'isAbout(item.region, "a region") ? "route" : "other"', expected: 'route' },
    { expr: 'vars[isAbout(item.region, "a region") ? "rate" : "none"]', expected: 1.21 },
];

// Host calls that must throw at parse time even WITH the host.
export const HOST_REJECT = [
    'isAbout(item.region)',                          // no topic
    'isAbout(item.region, form.email)',              // topic must be a literal
    'isAbout(item.region, "")',                      // empty topic
    'isAbout(item.region, "a region", 1.5)',         // threshold out of range
    'isAbout(item.region, "a region", -0.5)',        // a negative is not a literal
    'isAbout(item.region, "a region", form.qty)',    // threshold must be a literal
    'isAbout(item.region, "a region", 0.5, 1)',      // too many arguments
    'isAbout(isAbout(item.region, "a"), "b")',       // nested host call
];

// ── Flatten a list (flatten.mjs) ─────────────────────────────────────────
// Each case runs `flattenRows(root, step, opts)`; every key of `expect` is
// compared with the output (`keys` is the first row's keys, `first`/`last`
// the first and last row). Demo data is invented (Fabrikam, Contoso).

const LOGOS = ['logo-header.png', 'icon-facebook.png', 'icon-linkedin.png', 'icon-x.png', 'icon-instagram.png',
    'icon-youtube.png', 'badge-iso.png', 'badge-thuiswinkel.png', 'banner-q4.png', 'spacer.png', 'footer-logo.png',
    'qr-pay.png', 'stars.png', 'app-store.png'];
const MAILS = [
    ['19a01f3c7d2e4b10', 'Fabrikam Facturen <facturen@fabrikam.example>', 'Je Fabrikam factuur F-2026-1001', 'F-2026-1001'],
    ['19a06b2e91c4d877', 'Fabrikam Facturen <facturen@fabrikam.example>', 'Je Fabrikam factuur F-2026-1002', 'F-2026-1002'],
    ['19a0c4d1a8e35f02', 'Fabrikam Facturen <facturen@fabrikam.example>', 'Je Fabrikam factuur F-2026-1003', 'F-2026-1003'],
    ['19a11e7b3f0c6a59', 'Contoso Billing <billing@contoso.example>', 'Invoice C-77012', 'C-77012'],
];

function mailAttachment(id, thread, filename, n) {
    const ext = filename.slice(filename.lastIndexOf('.') + 1);
    const mimeType = { png: 'image/png', pdf: 'application/pdf', xml: 'application/xml' }[ext];
    const size = { png: 1000 + n * 500, pdf: 80000 + n * 1000, xml: 10000 + n * 300 }[ext];
    return { attachmentId: `att_${id.slice(-4)}_${n}`, filename, mimeType, size, canOCR: ext !== 'xml', messageId: id, threadId: thread };
}

/** Four invoice mails with sixteen attachments each (14 logos, a PDF and an XML). */
export function flattenMailRoot() {
    const messages = MAILS.map(([id, from, subject, invoice], i) => {
        const thread = `t${id.slice(1)}`;
        const names = [...LOGOS, `${invoice}.pdf`, `${invoice}.xml`];
        return {
            id, threadId: thread, from, to: 'crediteuren@contoso.example', subject, date: `2026-09-0${i + 2}T09:15:00Z`,
            body: `Beste klant, hierbij de factuur ${invoice}. `.repeat(36),
            attachments: names.map((name, n) => mailAttachment(id, thread, name, n)),
        };
    });
    return { steps: { g_read_many: { output: { messages, count: messages.length } } } };
}

const MAIL_ROUTE = 'steps.g_read_many.output.messages[*].attachments';

/** The stored step auto-map writes for the mail table (J1). */
export const FLATTEN_MAIL_STEP = Object.freeze({
    id: 'mf_flatten', type: 'flatten', label: 'One row per attachment', arrayRef: MAIL_ROUTE,
    parents: [{
        overRef: 'steps.g_read_many.output.messages', itemVar: 'message', auto: true,
        fields: [
            { from: 'id', to: 'messageId', mode: 'fill' },
            { from: 'threadId', to: 'threadId', mode: 'fill' },
            { from: 'from', to: 'from', mode: 'copy' },
            { from: 'to', to: 'to', mode: 'copy' },
            { from: 'subject', to: 'subject', mode: 'copy' },
            { from: 'date', to: 'date', mode: 'copy' },
        ],
    }],
});

const LINE = (id, sku, quantity, price, extra = {}) => ({ id, sku, description: `Item ${sku}`, quantity, price, status: 'open', ...extra });

/** Five Contoso webshop orders: one without lines, one with its line as an object. */
export function flattenOrdersRoot({ taxes = false, asText = false } = {}) {
    const tax = (rate) => (taxes ? { taxes: [{ rate, amount: rate * 10 }] } : {});
    const orders = [
        { id: 'o1', number: 'CO-2026-0410', customer: 'Fabrikam BV', status: 'paid', total: 120, shipping: { city: 'Delft' }, notes: 'Leave at reception',
            lines: [LINE('l1', 'FB-100', 2, 30, tax(21)), LINE('l2', 'FB-200', 1, 60, tax(9))] },
        { id: 'o2', number: 'CO-2026-0411', customer: 'Northwind Traders', status: 'paid', total: 75, shipping: { city: 'Gouda' }, notes: '',
            lines: [LINE('l3', 'NW-1', 1, 25, tax(21)), LINE('l4', 'NW-2', 1, 25, tax(21)), LINE('l5', 'NW-3', 1, 25, tax(21))] },
        { id: 'o3', number: 'CO-2026-0412', customer: 'Contoso Retail', status: 'shipped', total: 40, shipping: { city: 'Breda' }, notes: 'Gift wrap',
            lines: [LINE('l6', 'CR-7', 1, 20, tax(9)), LINE('l7', 'CR-8', 1, 20, tax(9))] },
        { id: 'o4', number: 'CO-2026-0413', customer: 'Fabrikam BV', status: 'open', total: 0, shipping: { city: 'Delft' }, notes: '', lines: [] },
        { id: 'o5', number: 'CO-2026-0414', customer: 'Northwind Traders', status: 'paid', total: 15, shipping: { city: 'Gouda' }, notes: '',
            lines: LINE('l8', 'NW-9', 1, 15, tax(21)) },
    ];
    const body = { orders };
    return { steps: { http: { output: { status: 200, body: asText ? JSON.stringify(body) : body } } } };
}

const ORDER_ROUTE = 'steps.http.output.body.orders[*].lines';

export const FLATTEN_CASES = [
    {
        name: 'Gmail: 4 mails × 16 attachments, the stored plan',
        root: flattenMailRoot(),
        step: FLATTEN_MAIL_STEP,
        expect: {
            count: 64, inputCount: 4, emptyCount: 0, dead: false, over: false,
            keys: ['attachmentId', 'filename', 'mimeType', 'size', 'canOCR', 'messageId', 'threadId', 'from', 'to', 'subject', 'date'],
            first: { attachmentId: 'att_4b10_0', filename: 'logo-header.png', mimeType: 'image/png', size: 1000, canOCR: true,
                messageId: '19a01f3c7d2e4b10', threadId: 't9a01f3c7d2e4b10', from: 'Fabrikam Facturen <facturen@fabrikam.example>',
                to: 'crediteuren@contoso.example', subject: 'Je Fabrikam factuur F-2026-1001', date: '2026-09-02T09:15:00Z' },
            last: { attachmentId: 'att_6a59_15', filename: 'C-77012.xml', mimeType: 'application/xml', size: 14500, canOCR: false,
                messageId: '19a11e7b3f0c6a59', threadId: 't9a11e7b3f0c6a59', from: 'Contoso Billing <billing@contoso.example>',
                to: 'crediteuren@contoso.example', subject: 'Invoice C-77012', date: '2026-09-05T09:15:00Z' },
        },
    },
    {
        name: 'Outlook: the attachment has its own id, so the mail id is copied as messageId',
        root: { steps: { o: { output: { messages: [
            { id: 'AAMk1', subject: 'Offerte Q4', from: 'sales@fabrikam.example', attachments: [{ id: 'AT1', filename: 'offerte-q4.pdf', size: 48213 }] },
        ] } } } },
        step: { type: 'flatten', arrayRef: 'steps.o.output.messages[*].attachments' },
        expect: { count: 1, items: [{ id: 'AT1', filename: 'offerte-q4.pdf', size: 48213, messageId: 'AAMk1', subject: 'Offerte Q4', from: 'sales@fabrikam.example' }] },
    },
    {
        name: 'orders: generic status, an object line, an empty order left out',
        root: flattenOrdersRoot(),
        step: { type: 'flatten', arrayRef: ORDER_ROUTE },
        expect: {
            count: 8, inputCount: 5, emptyCount: 1,
            keys: ['id', 'sku', 'description', 'quantity', 'price', 'status', 'orderId', 'number', 'customer', 'orderStatus', 'total', 'notes'],
            last: { id: 'l8', sku: 'NW-9', description: 'Item NW-9', quantity: 1, price: 15, status: 'open', orderId: 'o5',
                number: 'CO-2026-0414', customer: 'Northwind Traders', orderStatus: 'paid', total: 15, notes: '' },
        },
    },
    {
        name: 'orders with keepEmpty: the empty order gets one row with empty line fields',
        root: flattenOrdersRoot(),
        step: { type: 'flatten', arrayRef: ORDER_ROUTE, keepEmpty: true },
        expect: {
            count: 9, inputCount: 5, emptyCount: 1,
            row7: { id: null, sku: null, description: null, quantity: null, price: null, status: null, orderId: 'o4',
                number: 'CO-2026-0413', customer: 'Fabrikam BV', orderStatus: 'open', total: 0, notes: '' },
        },
    },
    {
        name: 'three levels: one row per tax, with its line and its order',
        root: flattenOrdersRoot({ taxes: true }),
        step: { type: 'flatten', arrayRef: 'steps.http.output.body.orders[*].lines[*].taxes' },
        expect: {
            count: 8, inputCount: 5, emptyCount: 0,
            first: { rate: 21, amount: 210, lineId: 'l1', sku: 'FB-100', quantity: 2, price: 30, lineStatus: 'open',
                orderId: 'o1', number: 'CO-2026-0410', customer: 'Fabrikam BV', orderStatus: 'paid', total: 120, notes: 'Leave at reception' },
        },
    },
    {
        name: 'a list of plain values: labelIds gives one labelId per row',
        root: { steps: { g: { output: { messages: [{ id: 'm1', labelIds: ['INBOX', 'UNREAD'] }, { id: 'm2', labelIds: ['INBOX'] }] } } } },
        step: { type: 'flatten', arrayRef: 'steps.g.output.messages[*].labelIds' },
        expect: { count: 3, items: [{ labelId: 'INBOX', messageId: 'm1' }, { labelId: 'UNREAD', messageId: 'm1' }, { labelId: 'INBOX', messageId: 'm2' }] },
    },
    {
        name: 'a child list called data: each value is called value',
        root: { steps: { s: { output: { records: [{ name: 'Fabrikam', data: [1, 2] }] } } } },
        step: { type: 'flatten', arrayRef: 'steps.s.output.records[*].data' },
        expect: { count: 2, items: [{ value: 1, recordName: 'Fabrikam' }, { value: 2, recordName: 'Fabrikam' }] },
    },
    {
        name: 'a JSON text body flattens like the parsed one',
        root: flattenOrdersRoot({ asText: true }),
        step: { type: 'flatten', arrayRef: ORDER_ROUTE },
        expect: { count: 8, inputCount: 5, emptyCount: 1 },
    },
    {
        name: 'a route that fits nothing is dead',
        root: flattenMailRoot(),
        step: { type: 'flatten', arrayRef: 'steps.g_read_many.output.messages[*].files' },
        expect: { count: 0, inputCount: 4, emptyCount: 4, dead: true, items: [] },
    },
    {
        name: 'the limit stops the walk and says it is over',
        root: flattenMailRoot(),
        step: FLATTEN_MAIL_STEP,
        opts: { limit: 10 },
        expect: { count: 10, inputCount: 4, over: true },
    },
    {
        name: 'the stored plan keeps its keys on other data (attachments without messageId)',
        root: { steps: { g_read_many: { output: { messages: [
            { id: 'm9', threadId: 't9', from: 'facturen@fabrikam.example', to: 'crediteuren@contoso.example', subject: 'F-2026-1009', date: '2026-09-20',
                attachments: [{ attachmentId: 'a9', filename: 'F-2026-1009.pdf', mimeType: 'application/pdf', size: 90000, canOCR: true }] },
        ] } } } },
        step: FLATTEN_MAIL_STEP,
        expect: {
            keys: ['attachmentId', 'filename', 'mimeType', 'size', 'canOCR', 'messageId', 'threadId', 'from', 'to', 'subject', 'date'],
            first: { attachmentId: 'a9', filename: 'F-2026-1009.pdf', mimeType: 'application/pdf', size: 90000, canOCR: true,
                messageId: 'm9', threadId: 't9', from: 'facturen@fabrikam.example', to: 'crediteuren@contoso.example', subject: 'F-2026-1009', date: '2026-09-20' },
        },
    },
    {
        name: 'run-time clash: the attachment has its own subject, which moves aside',
        root: { steps: { g_read_many: { output: { messages: [
            { id: 'm1', threadId: 't1', from: 'a@fabrikam.example', to: 'b@contoso.example', subject: 'Mail', date: '2026-09-01',
                attachments: [{ attachmentId: 'a1', subject: 'Own' }, { attachmentId: 'a2' }] },
        ] } } } },
        step: FLATTEN_MAIL_STEP,
        expect: {
            warning: '1 rows had a field called subject on the item itself; it is kept as attachmentSubject.',
            first: { attachmentId: 'a1', subject: 'Mail', attachmentSubject: 'Own', messageId: 'm1', threadId: 't1', from: 'a@fabrikam.example', to: 'b@contoso.example', date: '2026-09-01' },
        },
    },
];
