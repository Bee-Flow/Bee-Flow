import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ReactComponentEditor } from './ReactComponentEditor';
import type { ReactCodeEditorProps } from './ReactComponentCode';
import type { CompileResult, ReactComponentData } from './reactComponentModel';
import { BLOCK_CATALOGUE, BLOCK_EDITORS } from './catalogue';
import { getCapabilities } from '../controls/styleCapabilities';
import { validateBlocks } from '../blockSchema';

/** A plain code box: the markers it is handed are shown as JSON. */
function FakeCode({ value, onChange, markers, ariaLabel }: ReactCodeEditorProps) {
    return (
        <>
            <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
            <output data-testid="markers">{JSON.stringify(markers)}</output>
        </>
    );
}

const fakeCompile = vi.fn(async (source: string): Promise<CompileResult> => (
    source.includes('oops')
        ? { ok: false, error: 'component.tsx:2:4: Unexpected "oops"', diagnostics: [{ line: 2, column: 3, text: 'Unexpected "oops"' }] }
        : { ok: true, code: `CJS(${source.length})`, diagnostics: [] }
));

function Harness({ initial, onWrite, compile = fakeCompile }: {
    initial: ReactComponentData;
    onWrite: (d: ReactComponentData) => void;
    compile?: (s: string) => Promise<CompileResult>;
}) {
    const [data, setData] = useState<ReactComponentData>(initial);
    return (
        <ReactComponentEditor
            data={data}
            onChange={(next) => { setData(next); onWrite(next); }}
            compile={compile}
            CodeEditor={FakeCode}
        />
    );
}

const codeBox = () => screen.getByLabelText('React component code (TSX)');

// The cards remember whether they are open; every test starts from the defaults.
beforeEach(() => { try { window.localStorage.clear(); } catch { /* no storage in this environment */ } });

describe('ReactComponentEditor', () => {
    it('opening a block the server already compiled only sets the markers: the page stays unchanged', async () => {
        const onWrite = vi.fn();
        fakeCompile.mockClear();
        render(<Harness initial={{ source: 'export default () => null', compiled: 'SERVER', compileError: '' }} onWrite={onWrite} />);
        await waitFor(() => expect(fakeCompile).toHaveBeenCalledWith('export default () => null'));
        await screen.findByText('Compiles without errors.');
        expect(onWrite).not.toHaveBeenCalled();
    });

    it('compiles as the author types and writes the result for the live preview', async () => {
        const onWrite = vi.fn();
        render(<Harness initial={{ source: '', compiled: '', compileError: 'no code' }} onWrite={onWrite} />);
        await userEvent.type(codeBox(), 'abc');
        await waitFor(() => expect(onWrite).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'abc', compiled: 'CJS(3)', compileError: '' })));
    });

    it('a compile error becomes compileError, an alert and a marker at the right place', async () => {
        const onWrite = vi.fn();
        render(<Harness initial={{ source: 'x', compiled: 'OLD', compileError: '' }} onWrite={onWrite} />);
        await userEvent.clear(codeBox());
        await userEvent.type(codeBox(), 'oops');
        await waitFor(() => expect(onWrite).toHaveBeenLastCalledWith(expect.objectContaining({ compiled: '', compileError: 'component.tsx:2:4: Unexpected "oops"' })));
        expect(await screen.findByRole('alert')).toHaveTextContent('Unexpected "oops"');
        const markers = JSON.parse(screen.getByTestId('markers').textContent || '[]');
        expect(markers).toEqual([expect.objectContaining({ startLineNumber: 2, startColumn: 4, message: 'Unexpected "oops"', severity: 8 })]);
    });

    it('says so when the browser cannot load the compiler, and writes nothing', async () => {
        const onWrite = vi.fn();
        const failing = vi.fn(() => Promise.reject(new Error('wasm blocked')));
        render(<Harness initial={{ source: 'a' }} onWrite={onWrite} compile={failing} />);
        expect(await screen.findByText(/could not load its compiler/)).toBeInTheDocument();
        expect(onWrite).not.toHaveBeenCalled();
    });

    it('a field added under Fields gets a prop and an input under Props', async () => {
        const onWrite = vi.fn();
        const user = userEvent.setup();
        render(<Harness initial={{ source: 'a', compiled: 'C', fields: [], props: {} }} onWrite={onWrite} />);
        expect(screen.getByText(/No fields yet/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Fields' }));
        await user.click(screen.getByRole('button', { name: /Add field/ }));
        expect(onWrite).toHaveBeenLastCalledWith(expect.objectContaining({
            fields: [{ name: 'prop', label: '', type: 'text' }],
            props: { prop: '' },
        }));
        const propsCard = screen.getByRole('button', { name: 'Props' }).parentElement as HTMLElement;
        await user.type(within(propsCard).getByLabelText('prop'), 'Hi');
        expect(onWrite).toHaveBeenLastCalledWith(expect.objectContaining({ props: { prop: 'Hi' } }));
    });

    it('renaming a field takes its value along', async () => {
        const onWrite = vi.fn();
        const user = userEvent.setup();
        render(<Harness initial={{ source: 'a', compiled: 'C', fields: [{ name: 'title', label: 'Title', type: 'text' }], props: { title: 'Keep me' } }} onWrite={onWrite} />);
        await user.click(screen.getByRole('button', { name: 'Fields' }));
        await user.click(screen.getByRole('button', { name: /Title/ }));
        const name = screen.getByRole('textbox', { name: 'Prop name' });
        await user.type(name, 'X');
        expect(onWrite).toHaveBeenLastCalledWith(expect.objectContaining({
            fields: [expect.objectContaining({ name: 'titleX' })],
            props: { titleX: 'Keep me' },
        }));
    });
});

describe('react-component registration (admin)', () => {
    it('is in the catalogue as "React component" with the Atom icon, has an editor and the motion knobs', () => {
        expect(BLOCK_CATALOGUE['react-component']).toEqual({ type: 'react-component', label: 'React component', icon: 'Atom', category: 'Content' });
        expect(typeof (BLOCK_EDITORS as Record<string, { component: unknown }>)['react-component'].component).toBe('function');
        expect(getCapabilities('react-component')).toEqual({ columns: false, motion: true });
    });

    it('accepts the aliases react, reactcomponent and react_component', () => {
        const r = validateBlocks([{ type: 'react' }, { type: 'ReactComponent' }, { type: 'react_component' }]);
        expect(r.dropped).toEqual([]);
        expect(r.normalizedBlocks.map((b) => b.type)).toEqual(['react-component', 'react-component', 'react-component']);
    });
});
