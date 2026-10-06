import { describe, expect, it } from 'vitest';
import {
    PAGE_SIZE, canOpen, childPattern, crumbsOf, drill, jumpTo, levelPattern, openStack,
    pageView, patchTop, resolveLevels, returnOf, rootStack, up, type Level,
} from './levels';

/** 30 invented mails, each with two attachments, the PDF with invoice lines. */
const MAILS = Array.from({ length: 30 }, (_, m) => ({
    index: m,
    item: { subject: `Fabrikam factuur ${m}` },
    output: {
        subject: `Fabrikam factuur ${m}`,
        attachments: [
            { filename: `Factuur_${m}.pdf`, lines: [{ sku: `DSK-${m}`, taxes: [{ rate: 21 }] }] },
            { filename: `Contoso_logo_${m}.png`, lines: [] },
        ],
    },
    status: 'success',
}));

const ATTACHMENTS = { fromRow: 1, key: 'output.attachments', label: 'Attachments', rowName: 'Fabrikam factuur 1' };

function deep(): Level[] {
    const root = patchTop(rootStack(null), { query: 'factuur', page: 0, selected: 1 });
    return drill(root, ATTACHMENTS);
}

describe('the level stack', () => {
    it('drills without touching the parent, and goes up to it exactly', () => {
        const root = patchTop(rootStack(null), { query: 'factuur', page: 1, selected: 27 });
        const stack = drill(root, ATTACHMENTS);
        expect(stack).toHaveLength(2);
        expect(stack[0]).toBe(root[0]);
        expect(stack[1]).toEqual({ key: 'output.attachments', fromRow: 1, label: 'Attachments', rowName: 'Fabrikam factuur 1', query: '', page: 0, selected: null });
        expect(up(stack)).toEqual(root);
        expect(up(stack)[0]).toBe(root[0]);
    });

    it('returns the same stack when asked to go up from the root', () => {
        const root = rootStack(3);
        expect(up(root)).toBe(root);
        expect(root[0]).toMatchObject({ selected: 3, page: 0 });
        expect(rootStack(60)[0]).toMatchObject({ selected: 60, page: 2 });
    });

    it('opens from the drawer on the page that holds the row, with nothing selected', () => {
        const stack = openStack(27, 'output.attachments', 'Attachments', 'Fabrikam factuur 27');
        expect(stack[0]).toMatchObject({ key: null, selected: null, page: 1, query: '' });
        expect(stack[1]).toMatchObject({ key: 'output.attachments', fromRow: 27, selected: null });
    });

    it('opens the same level from a grid cell and from the row details', () => {
        const fromCell = drill(rootStack(null), { fromRow: 1, key: 'output.attachments', label: 'Attachments', rowName: 'r' });
        const fromDetail = drill(rootStack(null), { fromRow: 1, key: 'output.attachments', label: 'Attachments', rowName: 'r' });
        expect(fromCell).toEqual(fromDetail);
        expect(levelPattern(fromCell)).toBe(levelPattern(fromDetail));
    });
});

describe('going back up', () => {
    it('knows the list it left: its row, its path and what opened it', () => {
        const stack = drill(deep(), { fromRow: 0, key: 'lines', label: 'Lines', rowName: 'Factuur_1.pdf', from: 'detail' });
        expect(returnOf(stack, up(stack))).toEqual({ depth: 1, row: 0, path: 'lines', from: 'detail' });
        expect(returnOf(stack, jumpTo(stack, 0))).toEqual({ depth: 0, row: 1, path: 'output.attachments', from: 'cell' });
        expect(returnOf(up(stack), stack)).toBeNull();
        expect(returnOf(stack, stack)).toBeNull();
    });

    it('opens from the drawer as from a grid cell', () => {
        expect(openStack(2, 'output.attachments', 'Attachments', 'r')[1].from).toBe('cell');
    });
});

describe('the crumbs', () => {
    it('read root, then row and list per level, the last one current', () => {
        const stack = drill(deep(), { fromRow: 0, key: 'lines', label: 'Lines', rowName: 'Factuur_1.pdf' });
        expect(crumbsOf(stack, 'Continues on · Read')).toEqual([
            { text: 'Continues on · Read', current: false, target: 0 },
            { text: 'Fabrikam factuur 1', current: false, target: 1 },
            { text: 'Attachments', current: false, target: 2 },
            { text: 'Factuur_1.pdf', current: false, target: 3 },
            { text: 'Lines', current: true, target: 4 },
        ]);
        expect(crumbsOf(rootStack(null), 'Root')).toEqual([{ text: 'Root', current: true, target: 0 }]);
    });

    it('jump to the root with nothing selected, keeping its search', () => {
        const stack = jumpTo(deep(), 0);
        expect(stack).toHaveLength(1);
        expect(stack[0]).toMatchObject({ selected: null, query: 'factuur' });
    });

    it('jump to a row with its details open on the page that holds it', () => {
        const stack = drill(rootStack(null), { ...ATTACHMENTS, fromRow: 27 });
        const back = jumpTo(stack, 1, resolveLevels(MAILS, stack));
        expect(back).toHaveLength(1);
        expect(back[0]).toMatchObject({ selected: 27, page: 1 });
        // Without the rows the level keeps the page it was left on.
        const opened = openStack(27, 'output.attachments', 'Attachments', 'Fabrikam factuur 27');
        expect(jumpTo(opened, 1)[0]).toMatchObject({ selected: 27, page: 1 });
    });

    it('jump to an earlier list with nothing selected there', () => {
        const mid = patchTop(deep(), { selected: 1, query: 'pdf' });
        const stack = drill(mid, { fromRow: 0, key: 'lines', label: 'Lines', rowName: 'Factuur_1.pdf' });
        const back = jumpTo(stack, 2);
        expect(back).toHaveLength(2);
        expect(back[1]).toMatchObject({ key: 'output.attachments', selected: null, query: 'pdf' });
        expect(jumpTo(stack, 3)[1]).toMatchObject({ selected: 0 });
    });
});

describe('the rows of each level', () => {
    it('are resolved from the root and handed out by reference', () => {
        const stack = drill(deep(), { fromRow: 0, key: 'lines', label: 'Lines', rowName: 'Factuur_1.pdf' });
        const levels = resolveLevels(MAILS, stack);
        expect(levels).toHaveLength(3);
        expect(levels[0]).toBe(MAILS);
        expect(levels[1]).toBe(MAILS[1].output.attachments);
        expect(levels[2]).toBe(MAILS[1].output.attachments[0].lines);
    });

    it('cut the stack where a row is gone or the value is no longer a list of records', () => {
        const gone = drill(rootStack(null), { ...ATTACHMENTS, fromRow: 99 });
        expect(resolveLevels(MAILS, gone)).toHaveLength(1);
        const empty = drill(deep(), { fromRow: 1, key: 'lines', label: 'Lines', rowName: 'Contoso_logo_1.png' });
        expect(resolveLevels(MAILS, empty)).toHaveLength(2);
        const fresh = MAILS.map(m => ({ ...m, output: { subject: m.output.subject, attachments: 'none' } }));
        expect(resolveLevels(fresh, deep())).toHaveLength(1);
    });

    it('read a list of records written as JSON text', () => {
        const rows = [{ output: { attachments: JSON.stringify([{ filename: 'a.pdf' }]) } }];
        const levels = resolveLevels(rows, drill(rootStack(null), { ...ATTACHMENTS, fromRow: 0 }));
        expect(levels[1]).toEqual([{ filename: 'a.pdf' }]);
    });
});

describe('what can open', () => {
    it('is a list with at least one record', () => {
        expect(canOpen([])).toBe(false);
        expect(canOpen(['a'])).toBe(false);
        expect(canOpen([{}])).toBe(true);
        expect(canOpen(JSON.stringify([{ sku: 'DSK-180-OAK' }]))).toBe(true);
        expect(canOpen({ a: 1 })).toBe(false);
        expect(canOpen(null)).toBe(false);
    });
});

describe('the column pattern of a level', () => {
    it('is the same for the attachments of every mail', () => {
        const one = drill(rootStack(null), { ...ATTACHMENTS, fromRow: 0 });
        const two = drill(rootStack(null), { ...ATTACHMENTS, fromRow: 1 });
        expect(levelPattern(one)).toBe('output.attachments');
        expect(levelPattern(one)).toBe(levelPattern(two));
        expect(levelPattern(rootStack(null))).toBe('');
    });

    it('adds a wildcard per level and keeps odd keys bracketed', () => {
        expect(childPattern(null, 'output.attachments')).toBe('output.attachments');
        expect(childPattern('output.attachments', 'lines')).toBe('output.attachments[*].lines');
        expect(childPattern('lines', '["tax rates"]')).toBe('lines[*]["tax rates"]');
        const stack = drill(deep(), { fromRow: 0, key: 'lines', label: 'Lines', rowName: 'x' });
        expect(levelPattern(stack)).toBe('output.attachments[*].lines');
    });
});

describe('a page of a level', () => {
    it('pages by 25 and clamps the page', () => {
        const view = pageView(MAILS, '', 1);
        expect(PAGE_SIZE).toBe(25);
        expect(view.pageRows.map(r => r.index)).toEqual([25, 26, 27, 28, 29]);
        expect(view).toMatchObject({ from: 26, to: 30, pages: 2, safePage: 1 });
        expect(pageView(MAILS, '', 9).safePage).toBe(1);
        expect(pageView(MAILS, '', -1).safePage).toBe(0);
    });

    it('filters on values, keeping the original row numbers', () => {
        const view = pageView(MAILS, 'factuur 2', 0);
        expect(view.filtered.map(r => r.index)).toEqual([2, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
        expect(view.from).toBe(1);
        const none = pageView(MAILS, 'nothing like it', 0);
        expect(none).toMatchObject({ from: 0, to: 0, pages: 1, safePage: 0 });
    });
});
