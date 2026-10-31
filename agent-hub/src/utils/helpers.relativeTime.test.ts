// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRelativeTime, getToolIcon, toolNameToCatalogId } from './helpers';
import { malformed } from '@/test/mocks';

/**
 * getRelativeTime measures `now - then` in seconds. Pinned so the Date
 * arithmetic can be written with getTime() without changing a single answer:
 * Date#valueOf and Date#getTime are the same number, and an Invalid Date is NaN
 * both ways (every comparison is then false, so it falls through to the date).
 */

const NOW = new Date('2026-09-14T09:12:00Z');

describe('getRelativeTime', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it('says nothing for an absent date', () => {
        expect(getRelativeTime(undefined)).toBe('');
        expect(getRelativeTime(null)).toBe('');
        expect(getRelativeTime('')).toBe('');
        expect(getRelativeTime(0)).toBe('');
    });

    it('walks the ladder: now, minutes, hours, days, then the date', () => {
        const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
        expect(getRelativeTime(ago(0))).toBe('Just now');
        expect(getRelativeTime(ago(59))).toBe('Just now');
        expect(getRelativeTime(ago(60))).toBe('1m ago');
        expect(getRelativeTime(ago(3599))).toBe('59m ago');
        expect(getRelativeTime(ago(3600))).toBe('1h ago');
        expect(getRelativeTime(ago(86399))).toBe('23h ago');
        expect(getRelativeTime(ago(86400))).toBe('1d ago');
        expect(getRelativeTime(ago(604799))).toBe('6d ago');
        expect(getRelativeTime(ago(604800))).toBe(ago(604800).toLocaleDateString());
    });

    it('accepts an ISO string, an epoch number and a Date alike', () => {
        const then = NOW.getTime() - 3 * 3600 * 1000;
        expect(getRelativeTime(new Date(then).toISOString())).toBe('3h ago');
        expect(getRelativeTime(then)).toBe('3h ago');
        expect(getRelativeTime(new Date(then))).toBe('3h ago');
    });

    it('a future date is "Just now" (negative difference)', () => {
        expect(getRelativeTime(new Date(NOW.getTime() + 5 * 86400 * 1000))).toBe('Just now');
    });

    it('rounds the difference down to whole seconds', () => {
        expect(getRelativeTime(new Date(NOW.getTime() - 59999))).toBe('Just now');
        expect(getRelativeTime(new Date(NOW.getTime() - 60001))).toBe('1m ago');
    });

    it('an unreadable date falls through to the locale date of an Invalid Date', () => {
        expect(getRelativeTime('not a date')).toBe(new Date('not a date').toLocaleDateString());
        expect(getRelativeTime(malformed<Parameters<typeof getRelativeTime>[0]>({}))).toBe(new Date(malformed<string>({})).toLocaleDateString());
    });
});

describe('toolNameToCatalogId / getToolIcon', () => {
    it('maps a known tool and falls back for an unknown or missing one', () => {
        expect(toolNameToCatalogId('google_search')).toBe('tools.search');
        expect(toolNameToCatalogId('gamma_list_folders')).toBe('tools.gamma_folders');
        for (const name of [null, undefined, '', 'nope', 'null', 'undefined']) {
            expect(toolNameToCatalogId(name)).toBe('tools.fallback');
            expect(getToolIcon(name)).toBe('🔧');
        }
        expect(getToolIcon('python_interpreter')).toBe('🐍');
    });
});
