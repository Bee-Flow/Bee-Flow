import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CellValue, { alignFor, initialsOf, labelForCell, toneForCell } from './cellValue';

/**
 * The shared cell — one module, two importers (AppDataGrid, AppTable).
 *
 * Extracting the format switch out of those two components would have taken
 * their "no hex colours in the source" guard with it, so that assertion is
 * repeated at the bottom of this file. It travels with the code it protects.
 */

const at = (ui) => render(ui).container;

describe('cellValue — formats', () => {
    it('renders an empty value as a muted em-dash, whatever the format', () => {
        for (const format of ['text', 'number', 'badge', 'user', 'date']) {
            const c = at(<CellValue value={null} format={format} />);
            expect(c.textContent).toBe('—');
            expect(c.querySelector('span').getAttribute('style')).toContain('--text-muted');
        }
    });

    it('breakdown splits a quantity list into one chip per part', () => {
        // "2x M5 + 4x M8 + 3x M6" as plain text wraps to several lines in a
        // narrow column and drags every row's height with it. As chips it is a
        // list you can count, and the count reads apart from what is counted.
        const c = at(<CellValue value="2x M5 + 4x M8 + 3x M6" format="breakdown" />);
        const chips = c.querySelectorAll('[data-app-cell-breakdown] > span');
        expect(chips.length).toBe(3);
        expect(chips[0].textContent).toBe('2×M5');
        expect(chips[2].textContent).toBe('3×M6');
        expect(c.querySelector('[data-app-cell-breakdown]').getAttribute('data-app-cell-breakdown')).toBe('3');
    });

    it('breakdown leaves a part it cannot parse whole rather than reshaping it', () => {
        // Not everything in these columns is count-then-label, and inventing a
        // count for "M8 doorlopend" would be worse than showing it as written.
        const c = at(<CellValue value="M8 doorlopend + 4x ⌀11" format="breakdown" />);
        const chips = c.querySelectorAll('[data-app-cell-breakdown] > span');
        expect(chips.length).toBe(2);
        expect(chips[0].textContent).toBe('M8 doorlopend');
        expect(chips[1].textContent).toBe('4×⌀11');
    });

    it('breakdown shows the muted dash when there is nothing to break down', () => {
        expect(at(<CellValue value={null} format="breakdown" />).textContent).toBe('—');
        expect(at(<CellValue value="" format="breakdown" />).textContent).toBe('—');
    });

    it('a check column treats false as an answer, not as a gap', () => {
        // Every other format reads empty as "nothing here". A tick box is
        // different: "no" is a value someone recorded.
        const c = at(<CellValue value={false} format="check" />);
        expect(c.textContent).not.toBe('—');
        expect(c.querySelector('[aria-label="No"]')).toBeTruthy();
        expect(at(<CellValue value format="check" />).querySelector('[aria-label="Yes"]')).toBeTruthy();
    });

    it('formats numbers, currency and percent distinctly', () => {
        expect(at(<CellValue value={1234} format="number" />).textContent).toBe((1234).toLocaleString());
        expect(at(<CellValue value={12} format="percent" />).textContent).toBe('12%');
        expect(at(<CellValue value={1234} format="currency" />).textContent)
            .toBe((1234).toLocaleString(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }));
    });

    it('a non-numeric value in a numeric column falls back to the raw text', () => {
        expect(at(<CellValue value="n/a" format="number" />).textContent).toBe('n/a');
        expect(at(<CellValue value="n/a" format="currency" />).textContent).toBe('n/a');
    });

    it('date shows the day, datetime shows the time too', () => {
        const iso = '2026-03-04T15:30:00.000Z';
        const dateOnly = at(<CellValue value={iso} format="date" />).textContent;
        const withTime = at(<CellValue value={iso} format="datetime" />).textContent;
        expect(dateOnly).toBe(new Date(iso).toLocaleDateString());
        expect(withTime.length).toBeGreaterThan(dateOnly.length);
    });

    it('relative time measures against the clock it is given, not the wall clock', () => {
        // One clock per screen: two rows written in the same second must not
        // disagree about how long ago that was.
        const now = Date.parse('2026-03-04T12:00:00.000Z');
        expect(at(<CellValue value="2026-03-04T09:00:00.000Z" format="relative" now={now} />).textContent).toBe('3h ago');
        expect(at(<CellValue value="2026-03-01T12:00:00.000Z" format="relative" now={now} />).textContent).toBe('3d ago');
        expect(at(<CellValue value="2026-03-04T14:00:00.000Z" format="relative" now={now} />).textContent).toBe('in 2h');
    });

    it('an unparseable date passes through instead of printing Invalid Date', () => {
        for (const format of ['date', 'datetime', 'relative']) {
            expect(at(<CellValue value="not a date" format={format} />).textContent).toBe('not a date');
        }
    });

    it('relative with no clock shows the timestamp rather than inventing a now', () => {
        // "3h ago" is unanswerable without a reference point, and reading the
        // wall clock mid-render would be both impure and inconsistent between
        // rows. Falling back to the absolute time is the honest answer.
        const iso = '2026-03-04T15:30:00.000Z';
        expect(at(<CellValue value={iso} format="relative" />).textContent)
            .toBe(new Date(iso).toLocaleString());
    });

    it('link only linkifies http(s) — anything else stays text', () => {
        expect(at(<CellValue value="https://example.com" format="link" />).querySelector('a')).toBeTruthy();
        expect(at(<CellValue value="javascript:alert(1)" format="link" />).querySelector('a')).toBeNull();
        expect(at(<CellValue value="not a url" format="link" />).querySelector('a')).toBeNull();
    });

    it('tags splits a comma string and an array alike', () => {
        expect(at(<CellValue value="a, b, c" format="tags" />).querySelectorAll('[data-app-cell-tone]')).toHaveLength(3);
        expect(at(<CellValue value={['a', 'b']} format="tags" />).querySelectorAll('[data-app-cell-tone]')).toHaveLength(2);
    });

    // A multiselect column arrives as TEXT holding JSON (dataModel stores it
    // that way on purpose), so the comma split used to chip the punctuation
    // itself: `["laadpaal"` and `"zonnepanelen"]`.
    it('tags parses a JSON array string without chipping the punctuation', () => {
        const el = at(<CellValue value={'["laadpaal","zonnepanelen"]'} format="tags" />);
        const chips = [...el.querySelectorAll('[data-app-cell-tone]')].map((n) => n.textContent);
        expect(chips).toEqual(['laadpaal', 'zonnepanelen']);
    });

    it('tags relabels each chip from the toneMap, like a badge column does', () => {
        const col = { toneMap: [{ value: 'laadpaal', label: 'Laadpaal', tone: 'info' }] };
        const el = at(<CellValue value={'["laadpaal","airco"]'} format="tags" col={col} />);
        const chips = [...el.querySelectorAll('[data-app-cell-tone]')].map((n) => n.textContent);
        expect(chips).toEqual(['Laadpaal', 'airco']);
    });

    it('tags falls back to the comma split when the string only looks like JSON', () => {
        const el = at(<CellValue value="[niet echt json, tweede" format="tags" />);
        const chips = [...el.querySelectorAll('[data-app-cell-tone]')].map((n) => n.textContent);
        expect(chips).toEqual(['[niet echt json', 'tweede']);
    });

    it('progress clamps to its column max and never overflows the bar', () => {
        const bar = (value, max) => at(<CellValue value={value} format="progress" col={{ max }} />)
            .querySelector('[role="img"]').getAttribute('aria-label');
        expect(bar(5, 10)).toBe('50%');
        expect(bar(99, 10)).toBe('100%');
        expect(bar(-4, 10)).toBe('0%');
    });

    it('a user cell shows a monogram beside the name', () => {
        const c = at(<CellValue value="Anna de Vries" format="user" />);
        expect(c.querySelector('[data-app-cell-monogram]').textContent).toBe('AV');
        expect(c.textContent).toContain('Anna de Vries');
    });

    it('a user column storing an id shows the name from labelFrom', () => {
        // The id is what the row stores; the name is what the person is called.
        const c = at(
            <CellValue
                value="usr_123"
                format="user"
                col={{ labelFrom: 'assignee_name' }}
                row={{ assignee_name: 'Bas Jansen' }}
            />,
        );
        expect(c.textContent).toContain('Bas Jansen');
        expect(c.textContent).not.toContain('usr_123');
    });

    it('falls back to the stored id when no name is beside it — ugly, but honest', () => {
        const c = at(<CellValue value="usr_123" format="user" col={{ labelFrom: 'missing' }} row={{}} />);
        expect(c.textContent).toContain('usr_123');
    });
});

describe('cellValue — tone', () => {
    it('a badge with no tone configured stays neutral, exactly as before', () => {
        const c = at(<CellValue value="todo" format="badge" />);
        expect(c.querySelector('[data-app-cell-tone]').getAttribute('data-app-cell-tone')).toBe('neutral');
    });

    it('toneMap colours a pill by value and can relabel it', () => {
        const col = { toneMap: [{ value: 'done', label: 'Done', tone: 'success' }] };
        const c = at(<CellValue value="done" format="badge" col={col} />);
        expect(c.querySelector('[data-app-cell-tone]').getAttribute('data-app-cell-tone')).toBe('success');
        expect(c.textContent).toBe('Done');
    });

    it('toneFrom reads the tone off a sibling column — the config table case', () => {
        // Every Setup table already stores a `color` next to its rows; before
        // this, that column was rendered and then ignored.
        const c = at(
            <CellValue value="In progress" format="badge" col={{ toneFrom: 'color' }} row={{ color: 'warning' }} />,
        );
        expect(c.querySelector('[data-app-cell-tone]').getAttribute('data-app-cell-tone')).toBe('warning');
    });

    it('toneFrom beats toneMap — the row is more specific than the column', () => {
        const col = { toneFrom: 'color', toneMap: [{ value: 'x', tone: 'danger' }] };
        expect(toneForCell({ col, row: { color: 'info' }, value: 'x' })).toBe('info');
    });

    it('an unknown tone degrades to neutral rather than throwing', () => {
        const c = at(<CellValue value="x" format="badge" col={{ toneFrom: 'color' }} row={{ color: 'chartreuse' }} />);
        expect(c.querySelector('[data-app-cell-tone]')).toBeTruthy();
        expect(c.textContent).toBe('x');
    });

    it('labelForCell leaves the value alone when no map matches', () => {
        expect(labelForCell({ col: { toneMap: [{ value: 'a', label: 'A' }] }, value: 'b' })).toBe('b');
        expect(labelForCell({ col: null, value: 'b' })).toBe('b');
    });
});

describe('cellValue — alignment', () => {
    it('auto puts figures on the right and words on the left', () => {
        for (const format of ['number', 'currency', 'percent', 'progress']) {
            expect(alignFor({ format })).toBe('right');
        }
        for (const format of ['text', 'badge', 'date', 'user', undefined]) {
            expect(alignFor({ format })).toBe('left');
        }
    });

    it('an explicit align always wins', () => {
        expect(alignFor({ format: 'number', align: 'left' })).toBe('left');
        expect(alignFor({ format: 'text', align: 'center' })).toBe('center');
        // A junk value is not an alignment — fall back to the automatic rule.
        expect(alignFor({ format: 'number', align: 'sideways' })).toBe('right');
    });
});

describe('cellValue — monogram', () => {
    it('takes first and last initials, and copes with one word or none', () => {
        expect(initialsOf('Anna de Vries')).toBe('AV');
        expect(initialsOf('chidi')).toBe('C');
        expect(initialsOf('')).toBe('?');
        expect(initialsOf(null)).toBe('?');
    });

    it('gives the same person the same colour every time', () => {
        // A monogram that re-rolled its hue per render would be worse than no
        // colour at all — you could not learn a colleague by their chip.
        const toneOf = (name) => at(<CellValue value={name} format="user" />)
            .querySelector('[data-app-cell-monogram]').getAttribute('data-app-cell-monogram');
        expect(toneOf('Anna de Vries')).toBe(toneOf('Anna de Vries'));
    });
});

describe('cellValue — cell extensions (subtext, dot badge, flag, tabular digits)', () => {
    it('a column with the new props at their defaults renders byte-identically', () => {
        // The defaults ARE the identity: explicitly set, they must change
        // nothing against a column that has never heard of them.
        const base = { toneMap: [{ value: 'open', tone: 'info' }], truncate: true };
        const withDefaults = {
            ...base, badgeStyle: 'pill', subtextFrom: null, subtextToneFrom: null, flagFrom: null, flagTone: 'warning',
        };
        for (const [value, format] of [['open', 'badge'], ['hello', 'text'], [12, 'number']]) {
            const a = render(<CellValue value={value} format={format} col={base} row={{ x: 1 }} />).container.innerHTML;
            const b = render(<CellValue value={value} format={format} col={withDefaults} row={{ x: 1 }} />).container.innerHTML;
            expect(b).toBe(a);
        }
    });

    it('subtextFrom renders a second line under the value, muted by default', () => {
        const c = at(
            <CellValue value="Frame 250x80" format="text" col={{ subtextFrom: 'issue' }} row={{ issue: 'Materiaal ontbreekt' }} />,
        );
        const sub = c.querySelector('[data-app-cell-subtext]');
        expect(sub).toBeTruthy();
        expect(sub.textContent).toBe('Materiaal ontbreekt');
        expect(sub.getAttribute('data-app-cell-subtext')).toBe('muted');
        expect(sub.getAttribute('style')).toContain('--text-muted');
        expect(c.textContent).toContain('Frame 250x80');
    });

    it('subtextToneFrom maps the sibling value through the column toneMap', () => {
        const col = { subtextFrom: 'issue', subtextToneFrom: 'status', toneMap: [{ value: 'Onvolledig', tone: 'danger' }] };
        const c = at(<CellValue value="Frame" format="text" col={col} row={{ issue: 'Vraag klant', status: 'Onvolledig' }} />);
        const sub = c.querySelector('[data-app-cell-subtext]');
        expect(sub.getAttribute('data-app-cell-subtext')).toBe('danger');
        // roleTextColor mixes the hue with --text-primary so dark mode reads.
        expect(sub.getAttribute('style')).toContain('color-mix');
    });

    it('subtextToneFrom accepts a sibling that IS a tone name', () => {
        const c = at(
            <CellValue value="x" format="text" col={{ subtextFrom: 'note', subtextToneFrom: 'sev' }} row={{ note: 'ok', sev: 'success' }} />,
        );
        expect(c.querySelector('[data-app-cell-subtext]').getAttribute('data-app-cell-subtext')).toBe('success');
    });

    it('renders no subtext line when the sibling is empty', () => {
        const c = at(<CellValue value="x" format="text" col={{ subtextFrom: 'note' }} row={{ note: '' }} />);
        expect(c.querySelector('[data-app-cell-subtext]')).toBeNull();
    });

    it("badgeStyle:'dot' adds a tone dot inside the pill; 'pill' does not", () => {
        const toneMap = [{ value: 'done', tone: 'success' }];
        const c = at(<CellValue value="done" format="badge" col={{ badgeStyle: 'dot', toneMap }} />);
        const dot = c.querySelector('[data-app-cell-dot]');
        expect(dot).toBeTruthy();
        expect(dot.getAttribute('data-app-cell-dot')).toBe('success');
        // The label still renders beside the dot, in the same pill.
        expect(c.querySelector('[data-app-cell-tone="success"]').textContent).toBe('done');
        expect(at(<CellValue value="done" format="badge" col={{ toneMap }} />).querySelector('[data-app-cell-dot]')).toBeNull();
    });

    it('flagFrom renders a truthy sibling as an inline flag, warning by default', () => {
        const c = at(<CellValue value="Zijpaneel" format="text" col={{ flagFrom: 'rush' }} row={{ rush: 'SPOED' }} />);
        const flag = c.querySelector('[data-app-cell-flag]');
        expect(flag).toBeTruthy();
        expect(flag.textContent).toBe('SPOED');
        expect(flag.getAttribute('data-app-cell-flag')).toBe('warning');
        expect(c.textContent).toContain('Zijpaneel');
    });

    it('flagTone picks the flag colour; a falsy sibling renders no flag', () => {
        const withTone = at(
            <CellValue value="x" format="text" col={{ flagFrom: 'rush', flagTone: 'danger' }} row={{ rush: 'NU' }} />,
        );
        expect(withTone.querySelector('[data-app-cell-flag]').getAttribute('data-app-cell-flag')).toBe('danger');
        for (const rush of [null, '', 0, false]) {
            const c = at(<CellValue value="x" format="text" col={{ flagFrom: 'rush' }} row={{ rush }} />);
            expect(c.querySelector('[data-app-cell-flag]')).toBeNull();
        }
    });

    it('flag and subtext combine on one cell', () => {
        const col = { subtextFrom: 'issue', flagFrom: 'rush' };
        const c = at(<CellValue value="Paneel" format="text" col={col} row={{ issue: 'Dikte mist', rush: 'SPOED' }} />);
        expect(c.querySelector('[data-app-cell-flag]').textContent).toBe('SPOED');
        expect(c.querySelector('[data-app-cell-subtext]').textContent).toBe('Dikte mist');
    });

    it('number, currency and percent set their digits in tabular-nums', () => {
        for (const format of ['number', 'currency', 'percent']) {
            expect(at(<CellValue value={12} format={format} />).querySelector('.tabular-nums')).toBeTruthy();
        }
    });
});

it('introduces no hex colors in the component source', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'cellValue.jsx'), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
});

describe('cellValue — a gap as a defect, and tone on plain text', () => {
    it('emptyTone colours the dash of a column where a gap is a problem', () => {
        // The material a part cannot be cut without: its missing value has to
        // read as a defect, not as the muted absence every other column shows.
        const c = at(<CellValue value={null} format="text" col={{ emptyTone: 'danger' }} />);
        expect(c.textContent).toBe('—');
        expect(c.querySelector('[data-app-cell-empty="danger"]')).toBeTruthy();
        expect(c.querySelector('span').getAttribute('style')).not.toContain('--text-muted');
    });

    it('an unknown emptyTone falls back to the muted dash', () => {
        const c = at(<CellValue value={null} format="number" col={{ emptyTone: 'purple' }} />);
        expect(c.querySelector('span').getAttribute('style')).toContain('--text-muted');
        expect(c.querySelector('[data-app-cell-empty]')).toBe(null);
    });

    it('toneFrom maps the sibling value through the toneMap before taking it as a tone name', () => {
        // A status column holds "onvolledig", not "danger": without the map,
        // that word could never colour anything.
        const col = { toneFrom: 'check', toneMap: [{ value: 'onvolledig', tone: 'danger' }] };
        expect(toneForCell({ col, row: { check: 'onvolledig' }, value: 'x' })).toBe('danger');
        // A value the map does not name is still a tone name in its own right.
        expect(toneForCell({ col, row: { check: 'warning' }, value: 'x' })).toBe('warning');
    });

    it('a text cell takes the colour of a resolved tone — and nothing else changes', () => {
        const col = { toneFrom: 'check', toneMap: [{ value: 'onvolledig', tone: 'danger' }] };
        const toned = at(<CellValue value="tekening ontbreekt" format="text" col={col} row={{ check: 'onvolledig' }} />);
        expect(toned.querySelector('span').getAttribute('style')).toContain('color');
        // No tone resolved → the exact bare rendering of before.
        const plain = at(<CellValue value="tekening ontbreekt" format="text" col={col} row={{ check: 'ok' }} />);
        expect(plain.querySelector('span')).toBe(null);
        const none = at(<CellValue value="tekening ontbreekt" format="text" col={{ key: 'x' }} row={{}} />);
        expect(none.querySelector('span')).toBe(null);
    });
});
