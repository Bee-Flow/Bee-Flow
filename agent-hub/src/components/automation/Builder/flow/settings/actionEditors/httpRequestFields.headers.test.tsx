/**
 * The Headers editor is two columns that share the row: a bounded name and a
 * value that takes the rest. As a flex row the name input's own `w-full`
 * took the whole width and squeezed the value (and its pills) off the edge.
 */
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestFields as FieldsJs } from './httpRequestFields';

const HttpRequestFields = FieldsJs as unknown as ComponentType<Record<string, unknown>>;

afterEach(() => cleanup());

describe('HTTP request headers', () => {
    it('lays each header out as a name column and a value column that may shrink', () => {
        render(
            <HttpRequestFields
                draft={{ url: 'https://erp.example/api', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': '{{trigger.output.id}}' } }}
                set={vi.fn()}
                groups={[]}
                // Opens the (collapsed by default) Headers band.
                errorSections={new Set(['headers'])}
            />,
        );
        const rows = screen.getAllByTestId('http-header-row');
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.className).toContain('grid-cols-[minmax(6rem,32%)_minmax(0,1fr)_auto]');
            expect(row.querySelector('[data-testid="http-header-value"]')?.className).toContain('min-w-0');
            expect(row.querySelector('input')?.className).not.toContain('w-36');
        }
    });
});
