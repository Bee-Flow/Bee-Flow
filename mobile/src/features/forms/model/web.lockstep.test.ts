/**
 * The forms port against the web's own modules:
 *
 *   DIFFERENTIAL  answersRange.js runs beside answersRange.ts; isBlankForm
 *                 (AiDraftPanel.jsx), formLiveness / publicFormPath /
 *                 canOpenAutomation / canOpenForm (FormsStudio.jsx) and
 *                 fileSize / fileKind / txtFilename / initialValues
 *                 (PublicFormRenderer.jsx) are cut out of their component
 *                 files and run beside the ports on the same inputs;
 *   TEXTUAL       the Form page's tabs, the poll's pacing, the closing
 *                 page's "long" threshold and the theme tables.
 *
 * When this fails the web side changed. Update the port; don't loosen the test.
 */

import { isBlankForm } from './aiDraft';
import { defaultRange, PRESETS, rangeToQuery, type AnswersRange } from './answersRange';
import { initialValues } from './contract';
import type { FillField } from './fillTypes';
import { fileKind, fileSize, LONG_ENDING_CHARS, POLL_CEILING_MS, POLL_MAX_MS, POLL_MIN_MS, POLL_STEP_MS, SESSION_RE, txtFilename } from './fillValues';
import { DENSITY_MULT, RADIUS_PX } from './formLook';
import { canOpenForm, canOpenAutomation, formLiveness, publicFormPath, TABS_OWNER, TABS_VIEWER } from './formPage';
import { readWeb, requireWeb, constText, functionText } from '../testing/sources';

type Fn = (...args: unknown[]) => unknown;
const FORMS = 'components/admin/Studio/Forms';

/** Functions cut out of a component file, run as the web wrote them. */
function cut(rel: string, names: string[], prelude = ''): Record<string, Fn> {
    const src = readWeb(rel);
    const body = `${prelude}\n${names.map((n) => functionText(src, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
    return new Function(body)() as Record<string, Fn>;
}

describe('answersRange.js', () => {
    const web = requireWeb<{ PRESETS: readonly string[]; defaultRange: Fn; rangeToQuery: Fn }>(`${FORMS}/answers/answersRange.js`);
    const NOW = [new Date(2026, 8, 25, 14, 30), new Date(2026, 0, 1, 0, 5), new Date(2024, 1, 29, 23, 59)];
    const RANGES: Partial<AnswersRange>[] = [
        ...PRESETS.map((preset) => ({ preset, from: '', to: '' })),
        { preset: 'custom', from: '2026-01-01', to: '2026-01-31' },
        { preset: 'custom', from: '01-01-2026', to: '' },
        { preset: 'bogus' as never, from: '', to: '' },
        {},
    ];

    it('has the web’s presets and default', () => {
        expect([...PRESETS]).toEqual([...web.PRESETS]);
        expect(defaultRange()).toEqual(web.defaultRange());
    });

    it.each(RANGES.map((r) => [JSON.stringify(r), r]))('rangeToQuery(%s) matches', (_l, range) => {
        for (const now of NOW) expect(rangeToQuery(range as AnswersRange, now)).toEqual(web.rangeToQuery(range, now));
    });
});

describe('AiDraftPanel.jsx isBlankForm', () => {
    const web = cut(`${FORMS}/form/AiDraftPanel.jsx`, ['isBlankForm'], `const DEFAULT_NAMES = ${constText(readWeb(`${FORMS}/form/AiDraftPanel.jsx`), 'DEFAULT_NAMES')};`);
    const three = [{ name: 'name' }, { name: 'email' }, { name: 'message' }];
    const FORMS_IN: unknown[] = [
        null, {}, { fields: [] }, { fields: three }, { fields: three, title: 'Get in touch' }, { fields: three, title: 'Leave request' },
        { fields: [{ name: 'name' }, { name: 'email' }] }, { fields: [...three, { name: 'x' }] }, { fields: [{ name: 'email' }, { name: 'name' }, { name: 'message' }] },
    ];
    it.each(FORMS_IN.map((f) => [JSON.stringify(f), f]))('isBlankForm(%s)', (_l, form) => {
        expect(isBlankForm(form as never)).toBe(web.isBlankForm?.(form));
    });
});

describe('FormsStudio.jsx and FormPage.jsx', () => {
    const web = cut(`${FORMS}/FormsStudio.jsx`, ['formLiveness', 'publicFormPath', 'canOpenAutomation', 'canOpenForm']);
    const ROWS: unknown[] = [
        null, {}, { live: true }, { live: false }, { live: 'yes' },
        { id: 'abc', url: '/f/abc' }, { id: 'abc', url: '//evil' }, { id: 'abc' }, { url: 'https://x/f/1' },
        { mine: true, automationId: 'a1' }, { mine: 'true', automationId: 'a1' }, { mine: true, automationId: '' },
        { mine: false, automationId: 'a1', answers: { grade: 'viewer' } }, { mine: false, automationId: 'a1', answers: { grade: null } },
    ];
    it.each(ROWS.map((r) => [JSON.stringify(r), r]))('reads %s as the web does', (_l, row) => {
        expect(formLiveness(row as never)).toBe(web.formLiveness?.(row));
        expect(publicFormPath(row as never)).toBe(web.publicFormPath?.(row));
        expect(canOpenAutomation(row as never)).toBe(web.canOpenAutomation?.(row));
        expect(canOpenForm(row as never)).toBe(web.canOpenForm?.(row));
    });

    it('gives the owner and a colleague the web’s tabs', () => {
        const src = readWeb(`${FORMS}/FormPage.jsx`);
        const list = (name: string) => new Function(`return ${constText(src, name)};`)() as string[];
        expect([...TABS_OWNER]).toEqual(list('TABS_OWNER'));
        expect([...TABS_VIEWER]).toEqual(list('TABS_VIEWER'));
    });
});

describe('PublicFormRenderer.jsx and PublicFormPage.jsx', () => {
    const rendererSrc = readWeb('components/forms/PublicFormRenderer.jsx');
    const web = cut('components/forms/PublicFormRenderer.jsx', ['fileSize', 'fileKind', 'txtFilename', 'initialValues'], `const DISPLAY_FIELD_TYPES = ['download', 'notebook']; const isDisplayField = (f) => DISPLAY_FIELD_TYPES.includes(f?.type);`);

    it.each([[0], [-1], [512], [1023], [1024], [900 * 1024], [1024 * 1024], [5.55 * 1024 * 1024], ['12'], [null], ['x']])('fileSize(%s)', (bytes) => {
        expect(fileSize(bytes)).toBe(web.fileSize?.(bytes));
    });

    it.each([['cv.pdf'], ['Report.DOCX'], ['archive.tar.gz'], ['noext'], [''], [null], ['weird.toolongext']])('fileKind(%s)', (name) => {
        expect(fileKind(name)).toBe(web.fileKind?.(name));
    });

    it.each([['Your summary'], ['  Ünïcode — title!  '], [''], [null], ['a'.repeat(80)], ['***']])('txtFilename(%s)', (title) => {
        expect(txtFilename(title)).toBe(web.txtFilename?.(title));
    });

    it('starts a page with the web’s empty answers', () => {
        const fields = ['text', 'textarea', 'number', 'checkbox', 'file', 'download', 'notebook'].map((type) => ({ name: `f_${type}`, type }));
        const picks = [{ name: 'one', type: 'app_pick', multiple: false }, { name: 'many', type: 'app_pick', multiple: true }];
        const all = [...fields, ...picks] as unknown as FillField[];
        expect(initialValues(all)).toEqual(web.initialValues?.(all));
    });

    it('keeps the web’s pacing and thresholds', () => {
        const page = readWeb('pages/PublicFormPage.jsx');
        expect(POLL_MIN_MS).toBe(Number(constText(page, 'POLL_MIN_MS')));
        expect(POLL_MAX_MS).toBe(Number(constText(page, 'POLL_MAX_MS')));
        expect(POLL_STEP_MS).toBe(Number(constText(page, 'POLL_STEP_MS')));
        expect(POLL_CEILING_MS).toBe(new Function(`return ${constText(page, 'POLL_CEILING_MS')};`)());
        expect(SESSION_RE.toString()).toBe(constText(page, 'SESSION_RE'));
        expect(LONG_ENDING_CHARS).toBe(Number(constText(rendererSrc, 'LONG_ENDING_CHARS')));
    });
});

describe('App Studio themeVars.js', () => {
    it('maps a form’s corners and spacing as the web does', () => {
        const src = readWeb('components/admin/Studio/AppStudio/runtime/themeVars.js');
        const radius = new Function(`return ${constText(src, 'RADIUS_PX')};`)() as Record<string, string>;
        const density = new Function(`return ${constText(src, 'DENSITY_MULT')};`)() as Record<string, string>;
        expect(Object.fromEntries(Object.entries(radius).map(([k, v]) => [k, parseInt(v, 10)]))).toEqual(RADIUS_PX);
        expect(Object.fromEntries(Object.entries(density).map(([k, v]) => [k, Number(v)]))).toEqual(DENSITY_MULT);
    });
});
