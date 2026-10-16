import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import UsedByTab, { adaptUsageRows, usageHref, usageKind } from './UsedByTab';

/**
 * The kind of a usage row can be missing. The per-kind lookups (the Studio
 * path, the extra-kind visual) are written with an explicit null check so they
 * can be typed; the answers for a row without a kind stay.
 */

describe('usageKind / usageHref without a kind', () => {
    it('usageKind is null for a row, kind or value that names nothing', () => {
        expect(usageKind(null)).toBeNull();
        expect(usageKind(undefined)).toBeNull();
        expect(usageKind({})).toBeNull();
        expect(usageKind({ kind: '' })).toBeNull();
        expect(usageKind({ kind: 42 })).toBeNull();
    });

    it('usageKind keeps an unknown kind as its own lowercase word', () => {
        expect(usageKind({ kind: ' Gizmo ' })).toBe('gizmo');
        expect(usageKind({ kind: 'chat' })).toBe('chat');
        expect(usageKind({ kind: 'Tables' })).toBe('datatable');
    });

    it('usageHref is null when there is no page for the kind', () => {
        expect(usageHref({ id: 'x' })).toBeNull();
        expect(usageHref({ kind: 'gizmo', id: 'x' })).toBeNull();
        expect(usageHref({ kind: 'chat', id: 'x' })).toBeNull();
        expect(usageHref(null)).toBeNull();
        expect(usageHref({ kind: 'agent', id: '' })).toBeNull();
        expect(usageHref({ kind: 'agent', id: null })).toBeNull();
    });

    it('usageHref is the Studio path, or the row href when it has one', () => {
        expect(usageHref({ kind: 'agent', id: 'a1' })).toBe('studio/agents/a1');
        expect(usageHref({ kind: 'agent', id: 'a1', href: '/x' })).toBe('/x');
        expect(usageHref({ kind: 'agent', id: 0 })).toBe('studio/agents/0');
    });
});

describe('UsedByTab — a row without a kind', () => {
    it('renders its title and the generic kind word, without an icon', () => {
        render(<UsedByTab rows={[{ id: 'z', title: 'Mystery', role: 'read' }]} />);
        expect(screen.getByText('Mystery')).toBeTruthy();
        expect(screen.getByTestId('usage-summary').textContent).toBe('1 item');
    });

    it('an untitled row names its kind', () => {
        render(<UsedByTab rows={[{ id: 'z', role: 'read' }]} />);
        expect(screen.getByText('Untitled item')).toBeTruthy();
    });
});

describe('adaptUsageRows — what survives', () => {
    it('drops falsy and non-object rows, keeps every object (arrays included)', () => {
        const kept = { id: 1 };
        const arr = [];
        expect(adaptUsageRows([null, undefined, 0, '', 'text', 7, false, kept, arr])).toEqual([kept, arr]);
    });

    it('applies the adapter first, then drops what it answers falsy', () => {
        const adapt = (r) => (r.keep ? { kind: 'agent', id: r.keep } : null);
        expect(adaptUsageRows([{ keep: 'a' }, { drop: true }, { keep: 'b' }], adapt)).toEqual([{ kind: 'agent', id: 'a' }, { kind: 'agent', id: 'b' }]);
    });

    it('is empty for a non-list', () => {
        expect(adaptUsageRows(null)).toEqual([]);
        expect(adaptUsageRows(undefined)).toEqual([]);
        expect(adaptUsageRows('rows')).toEqual([]);
    });
});
