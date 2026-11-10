import { QueryClientProvider } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeTestQueryClient, renderWithClient } from '@/test/render';
import snapshot from '../catalogSnapshot.generated.json';
import { DataProvider, type DataState } from '../DataContext';
import { FormContext, type FormContextValue } from '../formContext';
import { dataCacheKey } from '../resolveBinding';
import { DEFAULT_RUNTIME, RuntimeProvider, buildScope } from '../RuntimeContext';
import { CANDIDATE_LIMIT } from './comboBox';
import AppDatasetUpload from './AppDatasetUpload';
import AppFilterBar from './AppFilterBar';
import AppForm from './AppForm';
import AppInputCheckbox from './AppInputCheckbox';
import AppInputDate from './AppInputDate';
import AppInputDatetime from './AppInputDatetime';
import AppInputDocument from './AppInputDocument';
import AppInputFile from './AppInputFile';
import AppInputHtml from './AppInputHtml';
import AppInputMultiselect from './AppInputMultiselect';
import AppInputNumber from './AppInputNumber';
import AppInputPerson from './AppInputPerson';
import AppInputRelation from './AppInputRelation';
import AppInputRichtext from './AppInputRichtext';
import AppInputSelect from './AppInputSelect';
import AppInputText from './AppInputText';
import AppInputTextarea from './AppInputTextarea';

/**
 * Part classes of the input family: the form, every input_* type and the filter bar.
 *
 * Each type declares `parts` in its spec (the catalogue the CSS editor and the AI read). This
 * mounts every type in the state that shows all of its parts and holds the two lists equal:
 * a declared part that does not render, or a `bfa-` class that is not declared, fails here.
 */

type Parts = Record<string, { parts?: string[] }>;
const TYPES = snapshot.types as unknown as Parts;

const FAMILY = [
    'form', 'input_text', 'input_textarea', 'input_number', 'input_select', 'input_checkbox', 'input_date',
    'input_file', 'input_dataset', 'input_richtext', 'input_html', 'input_datetime', 'input_relation',
    'input_person', 'input_multiselect', 'input_document', 'filter_bar',
];

const OPTIONS = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
const FILE = { kind: 'studio_attachment', fileId: 'f1', name: 'plan.pdf', mime: 'application/pdf', size: 3 };
const DATASET = { kind: 'studio_dataset', datasetId: 'ds_1', name: 'me.vcf', build: 'GRCh38' };

interface Case {
    node: Record<string, unknown>;
    Component: (p: { node: never }) => ReactElement | null;
    value?: unknown;
    /** Open the picker's list (focus the combobox). */
    focus?: boolean;
    /** Click the textarea (which already holds a lone slash) so its snippet list opens. */
    click?: boolean;
    dataState?: DataState;
    /** The app the picker belongs to; only the document picker needs one (its list is seeded). */
    appId?: string;
}

const node = (type: string, props: Record<string, unknown>) => ({
    id: `cmp_${type}`, type, visible: true, style: {}, props: { name: 'f', label: 'Label', ...props },
});

const CASES: Record<string, Case> = {
    input_text: { node: node('input_text', {}), Component: AppInputText as Case['Component'] },
    input_textarea: {
        node: node('input_textarea', { snippets: { kind: 'static', value: [{ shortcut: 'hi', title: 'Greeting', body: 'Hello' }] } }),
        Component: AppInputTextarea as Case['Component'], value: '/', click: true,
    },
    input_number: { node: node('input_number', {}), Component: AppInputNumber as Case['Component'] },
    input_select: { node: node('input_select', { options: OPTIONS }), Component: AppInputSelect as Case['Component'] },
    input_checkbox: { node: node('input_checkbox', {}), Component: AppInputCheckbox as Case['Component'] },
    input_date: { node: node('input_date', {}), Component: AppInputDate as Case['Component'] },
    input_datetime: { node: node('input_datetime', {}), Component: AppInputDatetime as Case['Component'] },
    input_file: { node: node('input_file', { multiple: true }), Component: AppInputFile as Case['Component'], value: [FILE] },
    input_dataset: { node: node('input_dataset', {}), Component: AppDatasetUpload as Case['Component'], value: DATASET },
    input_richtext: { node: node('input_richtext', {}), Component: AppInputRichtext as Case['Component'] },
    input_html: { node: node('input_html', {}), Component: AppInputHtml as Case['Component'] },
    input_multiselect: { node: node('input_multiselect', { options: OPTIONS }), Component: AppInputMultiselect as Case['Component'], value: ['a'] },
    input_relation: {
        node: node('input_relation', { tableId: 'tbl_x', displayField: 'name' }), Component: AppInputRelation as Case['Component'], value: 'r1', focus: true,
        dataState: {
            [dataCacheKey({ kind: 'records', tableId: 'tbl_x', limit: CANDIDATE_LIMIT }) as string]: {
                status: 'success', result: [{ id: 'r1', name: 'One' }, { id: 'r2', name: 'Two' }],
            },
        },
    },
    input_person: { node: node('input_person', { multiple: true, allowMe: true }), Component: AppInputPerson as Case['Component'], value: ['zz'], focus: true,
        dataState: {
            [dataCacheKey({ kind: 'dataset', datasetId: 'sys_org_members' }) as string]: { status: 'success', result: [{ id: 'u2', name: 'Bo' }] },
        },
    },
    input_document: { node: node('input_document', {}), Component: AppInputDocument as Case['Component'], value: 'd1', focus: true, appId: 'app_1' },
};

/** The form context a field reads: its value and its error are set, nothing else moves. */
function fieldContext(value: unknown): FormContextValue {
    return {
        values: { f: value }, errors: { f: 'Something is wrong' },
        setValue: () => {}, register: () => {}, unregister: () => {}, pending: false,
    };
}

function runtime(dataState: DataState = {}) {
    return {
        ...DEFAULT_RUNTIME,
        dataState,
        mode: 'run' as const,
        scope: buildScope({ now: '2026-01-01T00:00:00.000Z', currentUser: { id: 'u1', name: 'Una' } }),
    };
}

/** Seeded so the document picker lists two documents without a request. */
function seededClient() {
    const client = makeTestQueryClient();
    client.setQueryData(['studio-app-documents', 'options', 'app_1', 'cmp_input_document', false], [
        { id: 'd1', name: 'Quarterly plan' }, { id: 'd2', name: 'Budget' },
    ]);
    return client;
}

async function renderCase(c: Case) {
    const { Component } = c;
    const view = render(
        <QueryClientProvider client={seededClient()}>
            <DataProvider appId={c.appId ?? null}>
                <RuntimeProvider value={runtime(c.dataState)}>
                    <FormContext.Provider value={fieldContext(c.value)}><Component node={c.node as never} /></FormContext.Provider>
                </RuntimeProvider>
            </DataProvider>
        </QueryClientProvider>,
    );
    if (c.focus) act(() => (view.container.querySelector('[role="combobox"]') as HTMLElement).focus());
    if (c.click) await userEvent.setup().click(view.container.querySelector('textarea') as Element);
    return view.container;
}

/** The part names (`bfa-<type>__<part>`) rendered under `root`, for `type`; any other bfa- class is reported whole. */
function renderedParts(root: Element, type: string) {
    const found = new Set<string>();
    for (const el of Array.from(root.querySelectorAll('[class*="bfa-"]'))) {
        for (const token of el.className.toString().split(/\s+/).filter((x) => x.startsWith('bfa-'))) {
            found.add(token.startsWith(`bfa-${type}__`) ? token.slice(`bfa-${type}__`.length) : token);
        }
    }
    return Array.from(found).sort();
}

describe('input family: part classes', () => {
    it('declares parts for every type of the family', () => {
        for (const type of FAMILY) {
            const parts = TYPES[type]?.parts;
            expect(parts, type).toBeTruthy();
            expect(parts!.length, type).toBeGreaterThanOrEqual(3);
            expect(parts!.length, type).toBeLessThanOrEqual(8);
            expect(new Set(parts).size, type).toBe(parts!.length);
        }
    });

    for (const [type, c] of Object.entries(CASES)) {
        it(`${type} renders exactly the parts it declares`, async () => {
            const root = await renderCase(c);
            expect(renderedParts(root, type)).toEqual([...TYPES[type].parts!].sort());
        });
    }

    it('filter_bar renders exactly the parts it declares', () => {
        const fields = [
            { name: 'q', label: 'Search', type: 'search', options: [] },
            { name: 's', label: 'Status', type: 'select', options: OPTIONS },
        ];
        const { container } = renderWithClient(
            <RuntimeProvider value={runtime()}><AppFilterBar node={node('filter_bar', { fields }) as never} /></RuntimeProvider>,
        );
        expect(renderedParts(container, 'filter_bar')).toEqual([...TYPES.filter_bar.parts!].sort());
    });

    it('form renders exactly the parts it declares', () => {
        const runtimeValue = { ...runtime(), actionState: { act_1: { status: 'error', error: 'Failed' } } };
        const formNode = { ...node('form', { showReset: true, submitLabel: 'Go' }), onSubmit: 'act_1', children: [] };
        const { container } = renderWithClient(
            <RuntimeProvider value={runtimeValue as never}><AppForm node={formNode as never}>{null}</AppForm></RuntimeProvider>,
        );
        expect(renderedParts(container, 'form')).toEqual([...TYPES.form.parts!].sort());
    });
});

describe('part classes stay out of the product stylesheets', () => {
    const sheets = import.meta.glob('/src/**/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

    it('no stylesheet of the app references a bfa- class', () => {
        const offenders = Object.entries(sheets).filter(([, css]) => css.includes('bfa-')).map(([file]) => file);
        expect(Object.keys(sheets).length).toBeGreaterThan(0);
        expect(offenders).toEqual([]);
    });
});
