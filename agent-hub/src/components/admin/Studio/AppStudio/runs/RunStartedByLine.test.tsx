import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import RunStartedByLine from './RunStartedByLine';

beforeEach(() => cleanup());

describe('<RunStartedByLine>', () => {
    it('names the event, the table, the row and the kind of writer', () => {
        render(<RunStartedByLine startedBy={{ kind: 'record', event: 'update', tableId: 'tbl_orders', rowId: 'r7', by: 'public' }} />);
        expect(screen.getByTestId('run-started-by').textContent).toBe('Started by: Row changed in tbl_orders, row r7 (by a visitor)');
    });

    it('shows nothing for a start it does not know', () => {
        render(<RunStartedByLine startedBy={{ kind: 'webhook', event: 'call', tableId: '', rowId: '', by: '' }} />);
        expect(screen.queryByTestId('run-started-by')).toBeNull();
    });
});
