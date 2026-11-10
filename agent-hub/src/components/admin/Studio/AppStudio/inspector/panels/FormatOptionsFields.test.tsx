import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import FormatOptionsFields, { withFormatOptions } from './FormatOptionsFields';
import FormatSection, { withAppFormat } from '../themeSections/format';
import { THEME_SECTIONS } from '../themeSections';
import TableInspector from './TableInspector';
import { stub } from '@/test/mocks';
import type { ComponentProps } from 'react';
import type { AppDefinition } from '../appDefinition';

/**
 * The editor's value-format controls: the app's Value format section (themeSections/format.tsx)
 * and the formatOptions controls of a column, a chart and a stat. Empty means "as before", so
 * clearing the last field removes the key.
 */

type Obj = Record<string, unknown> | undefined;

/** The controls with their value held the way a panel holds it, every change recorded. */
function Held({ kind, start, seen }: { kind: string; start?: Obj; seen: (v: Obj) => void }) {
    const [value, setValue] = useState<Obj>(start);
    return <FormatOptionsFields kind={kind} value={value} onChange={(v) => { seen(v); setValue(v); }} />;
}

describe('formatOptions controls', () => {
    it('shows the controls that fit the kind, and none for a text column', () => {
        const none = render(<FormatOptionsFields kind="text" value={undefined} onChange={() => {}} />).container;
        expect(none.querySelector('[data-format-options]')).toBeNull();
        const money = render(<FormatOptionsFields kind="currency" value={undefined} onChange={() => {}} />).container;
        expect(money.querySelector('input[aria-label="Currency"]')).toBeTruthy();
        expect(money.querySelector('select[aria-label="Decimals"]')).toBeTruthy();
        const date = render(<FormatOptionsFields kind="date" value={undefined} onChange={() => {}} />).container;
        expect(date.querySelector('input[aria-label="Date pattern"]')).toBeTruthy();
    });

    it('commits only clean values and drops the shape when the last key goes', async () => {
        const seen = vi.fn();
        const { container } = render(<Held kind="currency" seen={seen} />);
        const currency = container.querySelector('input[aria-label="Currency"]') as HTMLInputElement;
        await userEvent.type(currency, 'us');
        expect(seen).not.toHaveBeenCalled();
        expect(container.querySelector('[role="alert"]')).toBeTruthy();
        await userEvent.type(currency, 'd');
        expect(seen).toHaveBeenLastCalledWith({ currency: 'USD' });
        await userEvent.selectOptions(container.querySelector('select[aria-label="Decimals"]') as HTMLSelectElement, '2');
        expect(seen).toHaveBeenLastCalledWith({ currency: 'USD', decimals: 2 });
        await userEvent.selectOptions(container.querySelector('select[aria-label="Decimals"]') as HTMLSelectElement, '');
        await userEvent.clear(currency);
        expect(seen).toHaveBeenLastCalledWith(undefined);
    });

    it('withFormatOptions sets or removes the key', () => {
        expect(withFormatOptions({ key: 'a', formatOptions: { decimals: 1 } }, undefined)).toEqual({ key: 'a' });
        expect('formatOptions' in withFormatOptions({ key: 'a' }, undefined)).toBe(false);
        expect(withFormatOptions({ key: 'a' }, { decimals: 2 })).toEqual({ key: 'a', formatOptions: { decimals: 2 } });
    });

    it('the table column editor carries the controls', () => {
        const definition = stub<AppDefinition>({ screens: [{ id: 's', name: 'S', sections: [{ id: 'x', style: {}, children: [] }] }] });
        const node = { id: 'cmp_t', type: 'table', props: { columns: [{ key: 'amount', format: 'currency' }] } };
        const { container } = render(
            <TableInspector node={stub<ComponentProps<typeof TableInspector>['node']>(node)} definition={definition} onCommit={vi.fn()} />,
        );
        expect(container.querySelector('[data-format-options="currency"]')).toBeTruthy();
    });
});

describe('the app Value format section', () => {
    const base = stub<AppDefinition>({ meta: { name: 'A' }, screens: [] });

    /** The section with the definition held like the editor holds it. */
    function HeldSection({ start, seen }: { start: AppDefinition; seen: (d: AppDefinition) => void }) {
        const [definition, setDefinition] = useState(start);
        const { Section } = FormatSection;
        return <Section definition={definition} onCommit={(d) => { seen(d); setDefinition(d); }} disabled={false} screenId={null} />;
    }

    it('is a registered theme-panel section', () => {
        expect(THEME_SECTIONS.map((s) => s.name)).toContain('format');
    });

    it('writes a cleaned format and removes the key when it is emptied', () => {
        expect(withAppFormat(base, { currency: 'usd', currencyDecimals: 2 }).format).toEqual({ currency: 'USD', currencyDecimals: 2 });
        expect('format' in withAppFormat({ ...base, format: { currency: 'USD' } }, {})).toBe(false);
    });

    it('commits a language, a date pattern, and shows what the app writes', async () => {
        const seen = vi.fn();
        const { container } = render(<HeldSection start={{ ...base, format: { language: 'en-US', currency: 'USD', currencyDecimals: 2 } }} seen={seen} />);
        expect(container.querySelector('[data-app-format-sample]')!.textContent).toContain('$1,234.50');
        const language = container.querySelector('input[aria-label="Language"]') as HTMLInputElement;
        await userEvent.clear(language);
        expect(seen.mock.calls.at(-1)![0].format).toEqual({ currency: 'USD', currencyDecimals: 2 });
        await userEvent.type(language, 'nl-nl');
        expect(seen.mock.calls.at(-1)![0].format).toEqual({ language: 'nl-NL', currency: 'USD', currencyDecimals: 2 });
        expect(container.querySelector('[data-app-format-sample]')!.textContent).toContain('1.234,50');
        await userEvent.selectOptions(container.querySelector('select[aria-label="Dates"]') as HTMLSelectElement, 'pattern');
        expect(seen.mock.calls.at(-1)![0].format.dateFormat).toBe('dd-MM-yyyy');
    });
});
