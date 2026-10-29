import { describe, expect, it, vi } from 'vitest';
import { refOpener, skillTabs, usageReading } from './SkillDetailParts';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { UsageRow } from '@/hooks/useUsage';

const t: TranslateFn = (_key, fallback) => (typeof fallback === 'string' ? fallback : '');
const rows: UsageRow[] = [{ kind: 'agent', id: 'a1', title: 'Helper' }];

describe('usageReading', () => {
    it('passes an answered read through, with what the server could not check', () => {
        expect(usageReading(rows, ['automation'], null)).toEqual({ knownUsage: rows, uncheckedKinds: ['automation'] });
    });

    it('turns a failed read into "not known" with every kind unchecked', () => {
        expect(usageReading([], [], 'boom')).toEqual({ knownUsage: null, uncheckedKinds: ['agent', 'automation'] });
    });
});

describe('skillTabs', () => {
    it('counts examples and known usage only', () => {
        const tabs = skillTabs(t, 2, rows);
        expect(tabs.map((tab) => tab.id)).toEqual(['method', 'examples', 'test', 'usage']);
        expect(tabs[1].count).toBe(2);
        expect(tabs[3].count).toBe(1);
        const unknown = skillTabs(t, 0, null);
        expect(unknown[1].count).toBeUndefined();
        expect(unknown[3].count).toBeUndefined();
    });
});

describe('refOpener', () => {
    it('is null without a host to navigate', () => {
        expect(refOpener(null)).toBeNull();
    });

    it('opens a reference through its studio link and ignores kinds without a page', () => {
        const navigate = vi.fn();
        const open = refOpener(navigate);
        open?.({ kind: 'table', id: 't1' });
        open?.({ kind: 'mystery', id: 'x' });
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledWith('studio/datatables/t1');
    });
});
