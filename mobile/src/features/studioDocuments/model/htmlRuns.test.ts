import { applyRunEdits, decodeEntities, escapeText, textRuns } from './htmlRuns';

const INVOICE =
    '<header class="doc-header"><div class="doc-logo"></div><p>Invoice · {{date}}</p></header>' +
    '<h1>Invoice</h1><section data-doc-section="overview"><h2>{{customer.name}}</h2><p>{{summary}}</p></section>' +
    '<table><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody>{{#each lines}}<tr><td>{{description}}</td>' +
    '<td>{{amount}}</td></tr>{{/each}}</tbody></table><p>Total: {{total}}</p>' +
    '<footer class="doc-footer">{{customer.name}} · {{date}}</footer>';

describe('textRuns', () => {
    it('finds every stretch of text with the block it sits in', () => {
        const runs = textRuns(INVOICE);
        expect(runs.map((r) => [r.text, r.block, r.tag])).toEqual([
            ['Invoice · {{date}}', 'paragraph', 'p'],
            ['Invoice', 'heading', 'h1'],
            ['{{customer.name}}', 'heading', 'h2'],
            ['{{summary}}', 'paragraph', 'p'],
            ['Description', 'cell', 'th'],
            ['Amount', 'cell', 'th'],
            ['{{#each lines}}', 'text', ''],
            ['{{description}}', 'cell', 'td'],
            ['{{amount}}', 'cell', 'td'],
            ['{{/each}}', 'text', ''],
            ['Total: {{total}}', 'paragraph', 'p'],
            ['{{customer.name}} · {{date}}', 'footer', 'footer'],
        ]);
    });

    it('marks template control markers and knows the section of each run', () => {
        const runs = textRuns(INVOICE);
        expect(runs.filter((r) => r.marker).map((r) => r.text)).toEqual(['{{#each lines}}', '{{/each}}']);
        expect(runs.filter((r) => r.section === 'overview').map((r) => r.text)).toEqual(['{{customer.name}}', '{{summary}}']);
    });

    it('skips styles, scripts, comments and void elements', () => {
        const html = '<style>p { color: red }</style><!-- note --><p>A<br>B<img src="x"/></p><script>x()</script><p>C</p>';
        expect(textRuns(html).map((r) => r.text)).toEqual(['A', 'B', 'C']);
    });

    it('decodes entities for display', () => {
        expect(textRuns('<p>Smith &amp; Sons &lt;3 &#233;&#x20AC;&nbsp;</p>')[0]?.text).toBe('Smith & Sons <3 é€');
        expect(decodeEntities('&unknown; &QUOT;')).toBe('&unknown; "');
    });

    it('treats a stray < in text as text', () => {
        expect(textRuns('<p>a < b</p>').map((r) => r.text)).toEqual(['a', '< b']);
    });
});

describe('applyRunEdits', () => {
    it('rewrites only the edited runs and keeps every tag byte for byte', () => {
        const runs = textRuns(INVOICE);
        const edits = new Map([
            [1, 'Factuur'],
            [10, 'Totaal: {{total}}'],
        ]);
        const out = applyRunEdits(INVOICE, runs, edits);
        expect(out).toBe(INVOICE.replace('<h1>Invoice</h1>', '<h1>Factuur</h1>').replace('Total: {{total}}', 'Totaal: {{total}}'));
    });

    it('escapes what was typed and keeps the whitespace around the run', () => {
        const html = '<p>\n  Old &amp; tired\n</p>';
        const out = applyRunEdits(html, textRuns(html), new Map([[0, 'R&D <new>']]));
        expect(out).toBe('<p>\n  R&amp;D &lt;new&gt;\n</p>');
    });

    it('keeps every kind of surrounding whitespace, tabs, CRLF and no-break spaces included', () => {
        const html = '<td>\t\r\n  Old \t </td>';
        const out = applyRunEdits(html, textRuns(html), new Map([[0, 'New']]));
        expect(out).toBe('<td>\t\r\n  New \t </td>');
    });

    it('stays linear on a run with a long stretch of spaces inside it', () => {
        // A /\s*$/ scan of this run takes seconds (quadratic); a linear one, milliseconds.
        const html = `<p> a${' '.repeat(200_000)}b </p>`;
        const runs = textRuns(html);
        const t0 = Date.now();
        const out = applyRunEdits(html, runs, new Map([[0, 'c']]));
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(out).toBe('<p> c </p>');
    });

    it('leaves an unchanged run with its original entities alone', () => {
        const html = '<p>A &amp; B</p>';
        expect(applyRunEdits(html, textRuns(html), new Map([[0, 'A & B']]))).toBe(html);
    });

    it('escapes ampersands and angle brackets only', () => {
        expect(escapeText('"quotes" & <tags>')).toBe('"quotes" &amp; &lt;tags&gt;');
    });
});
