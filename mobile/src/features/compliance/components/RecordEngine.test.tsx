/**
 * The record engine's extension points, through a fake register rendered by
 * RecordList and RecordDetail: filters with counts (and the pills surviving
 * an empty filter), the header pill, a rowView with a clock, panels running
 * actions, edit.when, the remove label, a failed detail read, dynamic
 * confirm, response-based success, errorText, openAfter, afterSuccess back,
 * disabledReason and an errorState without retry.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Pressable, Text } from 'react-native';

import { api, ApiError } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { RecordDetail } from './RecordDetail';
import { RecordList } from './RecordList';
import type { DetailPanelProps, RecordPanels } from './recordPanels';
import type { ComplianceGate } from '../hooks/useComplianceAccess';
import { recordRoute } from '../model/navigation';
import type { Label, Rec, RecordType } from '../model/types';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn(), canGoBack: () => true, dismissTo: jest.fn(), canDismiss: () => false };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({}), Stack: { Screen: () => null } }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const L = (en: string): Label => ({ i18nKey: `x.${en.replace(/\W/g, '_')}`, en });
const NOW = Date.UTC(2026, 9, 5, 12);
const H = 3_600_000;

const ROWS: Rec[] = [
    { id: 'a', title: 'Alpha', state: 'open', due: new Date(NOW + 5 * H).toISOString(), started: new Date(NOW - 67 * H).toISOString() },
    { id: 'b', title: 'Beta', state: 'closed' },
];

const GATE = { access: { state: 'open' }, open: true, hint: '' } as unknown as ComplianceGate;

function makeType(over: Partial<RecordType> = {}): RecordType {
    return {
        id: 'fake',
        section: 'fake',
        noun: L('Thing'),
        plural: L('Things'),
        icon: 'FileText',
        list: { paths: ['/fake'], select: (p) => ({ rows: p[0] as Rec[], context: null }) },
        idOf: (r) => String(r.id),
        titleOf: (r) => String(r.title),
        facts: [{ key: 'title', label: L('Title'), kind: 'text' }],
        empty: { title: L('Nothing here') },
        filters: [
            {
                id: 'state',
                options: [
                    { id: 'all', label: L('All'), match: () => true },
                    { id: 'open', label: L('Open'), match: (r) => r.state === 'open' },
                    { id: 'never', label: L('Never'), match: () => false },
                ],
            },
        ],
        header: (set) => ({ pill: { text: `${set.rows.length} in the register`, tone: 'warning' }, lines: ['Art. 33 · 72 hours'] }),
        rowView: (rec) => ({
            meta: `meta ${String(rec.id)}`,
            clock: rec.due ? { dueAt: String(rec.due), startedAt: String(rec.started), urgentBelowMs: 24 * H } : null,
            accent: rec.state === 'open' ? 'error' : null,
        }),
        create: {
            label: L('New thing'),
            submitLabel: L('Record it'),
            fields: [{ key: 'title', label: L('Title'), kind: 'text', required: true }],
            request: (v) => ({ method: 'POST', path: '/fake', body: { title: v.title } }),
            success: (res) => `Made ${(res as Rec).id as string}`,
            openAfter: (res) => String((res as Rec).id),
        },
        ...over,
    };
}

beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    for (const fn of [get, post, mockRouter.push, mockRouter.back]) fn.mockReset();
    get.mockImplementation((path: string) => Promise.resolve(path === '/fake' ? ROWS : {}));
});
afterEach(() => {
    jest.useRealTimers();
});

describe('RecordList', () => {
    it('counts each filter and keeps the pills when a filter leaves no rows', async () => {
        await renderScreen(<RecordList type={makeType()} />);
        await screen.findByText('Alpha', {}, { timeout: 5000 });
        expect(screen.getByTestId('filter-state-all')).toHaveTextContent(/2/);
        expect(screen.getByTestId('filter-state-open')).toHaveTextContent(/1/);
        await fireEvent.press(screen.getByTestId('filter-state-open'));
        expect(screen.queryByText('Beta')).toBeNull();
        await fireEvent.press(screen.getByTestId('filter-state-never'));
        expect(screen.queryByText('Alpha')).toBeNull();
        expect(screen.getByTestId('filter-state-all')).toBeTruthy();
    });

    it('shows the header pill and lines', async () => {
        await renderScreen(<RecordList type={makeType()} />);
        expect(await screen.findByText('2 in the register')).toBeTruthy();
        expect(screen.getByText('Art. 33 · 72 hours')).toBeTruthy();
    });

    it('draws a rowView with its meta line and deadline clock', async () => {
        await renderScreen(<RecordList type={makeType()} />);
        await screen.findByText('Alpha');
        expect(screen.getByText('meta a')).toBeTruthy();
        expect(screen.getByTestId('record-fake-a-clock-label')).toHaveTextContent('5 h left');
        expect(screen.queryByTestId('record-fake-b-clock')).toBeNull();
    });

    it('toasts the response and opens the created record', async () => {
        post.mockResolvedValue({ id: 'new1' });
        await renderScreen(<RecordList type={makeType()} />);
        await fireEvent.press(await screen.findByTestId('create-fake'));
        await fireEvent.changeText(screen.getByTestId('field-title'), 'Gamma');
        await fireEvent.press(screen.getByText('Record it'));
        await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(recordRoute('fake', 'new1')));
        expect(await screen.findByText('Made new1')).toBeTruthy();
    });

    it("shows a create failure in the register's own words", async () => {
        post.mockRejectedValue(new ApiError('Boom', { status: 409 }));
        const base = makeType();
        await renderScreen(<RecordList type={makeType({ create: { ...base.create!, errorText: () => 'That name is taken.' } })} />);
        await fireEvent.press(await screen.findByTestId('create-fake'));
        await fireEvent.changeText(screen.getByTestId('field-title'), 'Gamma');
        await fireEvent.press(screen.getByText('Record it'));
        expect(await screen.findByText('That name is taken.')).toBeTruthy();
        expect(mockRouter.push).not.toHaveBeenCalled();
    });

    it('renders an errorState without a retry', async () => {
        get.mockRejectedValue(new ApiError('Not set up', { status: 404 }));
        await renderScreen(<RecordList type={makeType({ errorState: () => ({ title: L('Not set up yet'), retry: false }) })} />);
        expect(await screen.findByText('Not set up yet')).toBeTruthy();
        expect(screen.queryByText('Try again')).toBeNull();
    });

    it('renders the list panel', async () => {
        const panels: RecordPanels = { ListTop: ({ set }) => <Text>{`panel ${set.rows.length}`}</Text> };
        await renderScreen(<RecordList type={makeType()} panels={panels} />);
        expect(await screen.findByText('panel 2')).toBeTruthy();
    });
});

function detailType(over: Partial<RecordType> = {}): RecordType {
    return makeType({
        actions: [
            {
                id: 'close',
                label: L('Close it'),
                confirm: (rec) => `Close ${String(rec.title)} for good?`,
                request: (rec) => ({ method: 'POST', path: `/fake/${String(rec.id)}/close`, body: {} }),
                success: (res) => `Closed after ${(res as Rec).n as number} steps`,
                afterSuccess: 'back',
            },
            { id: 'fail', label: L('Try this'), request: () => ({ method: 'POST', path: '/fake/fail', body: {} }), errorText: () => 'The authority refused it.' },
            { id: 'locked', label: L('Notify'), request: () => ({ method: 'POST', path: '/x', body: {} }), disabledReason: () => L('Waiting for the first report') },
        ],
        edit: { fields: [{ key: 'title', label: L('Title'), kind: 'text' }], request: () => ({ method: 'PUT', path: '/x', body: {} }), when: (rec) => rec.state === 'open' },
        remove: { confirm: L('Archive this?'), label: L('Archive'), icon: 'Archive', request: () => ({ method: 'DELETE', path: '/x' }) },
        ...over,
    });
}

describe('RecordDetail', () => {
    it('confirms in words about the record, toasts the response and goes back', async () => {
        post.mockResolvedValue({ n: 3 });
        await renderScreen(<RecordDetail type={detailType()} id="a" gate={GATE} />);
        await fireEvent.press(await screen.findByTestId('action-close'));
        expect(await screen.findByText('Close Alpha for good?')).toBeTruthy();
        const buttons = screen.getAllByText('Close it');
        await fireEvent.press(buttons[buttons.length - 1]!);
        expect(await screen.findByText('Closed after 3 steps')).toBeTruthy();
        expect(post).toHaveBeenCalledWith('/fake/a/close', {});
        expect(mockRouter.back).toHaveBeenCalled();
    });

    it("toasts a failed action in the action's own words", async () => {
        post.mockRejectedValue(new ApiError('Boom', { status: 500 }));
        await renderScreen(<RecordDetail type={detailType()} id="a" gate={GATE} />);
        await fireEvent.press(await screen.findByTestId('action-fail'));
        expect(await screen.findByText('The authority refused it.')).toBeTruthy();
    });

    it('shows a disabled action with its reason and does not run it', async () => {
        await renderScreen(<RecordDetail type={detailType()} id="a" gate={GATE} />);
        expect(await screen.findByText('Waiting for the first report')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('action-locked'));
        expect(post).not.toHaveBeenCalled();
    });

    it('offers edit only when edit.when allows it, and labels remove', async () => {
        await renderScreen(<RecordDetail type={detailType()} id="a" gate={GATE} />);
        expect(await screen.findByTestId('record-edit')).toBeTruthy();
        expect(screen.getByTestId('record-remove').props.accessibilityLabel).toBe('Archive');
    });

    it('hides edit for a record edit.when refuses', async () => {
        await renderScreen(<RecordDetail type={detailType()} id="b" gate={GATE} />);
        await screen.findByTestId('record-remove');
        expect(screen.queryByTestId('record-edit')).toBeNull();
    });

    it('runs actions from a panel', async () => {
        post.mockResolvedValue({ n: 1 });
        const Top = ({ runAction }: DetailPanelProps) => (
            <Pressable testID="panel-run" onPress={() => runAction('fail')}>
                <Text>run</Text>
            </Pressable>
        );
        await renderScreen(<RecordDetail type={detailType()} id="a" gate={GATE} panels={{ DetailTop: Top }} />);
        await fireEvent.press(await screen.findByTestId('panel-run'));
        await waitFor(() => expect(post).toHaveBeenCalledWith('/fake/fail', {}));
    });

    it('says a failed detail read with a retry and offers nothing to change', async () => {
        get.mockImplementation((path: string) => (path === '/fake' ? Promise.resolve(ROWS) : Promise.reject(new ApiError('Boom', { status: 500 }))));
        const type = detailType({ detail: { path: (id) => `/fake/${id}`, select: (raw) => raw as Rec, errorText: L('This document could not be read.') } });
        await renderScreen(<RecordDetail type={type} id="a" gate={GATE} />);
        expect(await screen.findByText('This document could not be read.')).toBeTruthy();
        expect(screen.queryByTestId('record-edit')).toBeNull();
        expect(screen.queryByTestId('action-close')).toBeNull();
        get.mockImplementation((path: string) => Promise.resolve(path === '/fake' ? ROWS : { id: 'a', body: 'Draft' }));
        await fireEvent.press(screen.getByTestId('record-detail-retry'));
        expect(await screen.findByTestId('action-close')).toBeTruthy();
    });
});
