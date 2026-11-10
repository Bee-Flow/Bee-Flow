import { describe, expect, it } from 'vitest';
import { resolveOpenUrl, resolveScreenId, withResolvedText } from './dynamicSteps';
import type { RunStep } from './core';

/** The pure half of the formula forms of the client steps. */

const tr = (_key: string, fallback?: string, params?: Record<string, unknown>) => (fallback || '').replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k] ?? ''));
const scope = { vars: { n: 3, name: 'Ada', empty: '', obj: { a: 1 } } };

describe('withResolvedText', () => {
    it('returns the very same step when it has no formula field', () => {
        const step: RunStep = { kind: 'toast', message: 'hi', tone: 'info' };
        expect(withResolvedText(step, scope)).toBe(step);
    });

    it('works out the formula and writes it into the literal field, leaving the step itself alone', () => {
        const step: RunStep = { kind: 'toast', messageExpr: "concat('Hi ', vars.name)", tone: 'info' };
        expect(withResolvedText(step, scope)).toEqual({ kind: 'toast', messageExpr: "concat('Hi ', vars.name)", tone: 'info', message: 'Hi Ada' });
        expect(step.message).toBeUndefined();
    });

    it('keeps the literal when the formula gives nothing usable', () => {
        for (const expr of ['vars.empty', 'vars.missing', 'vars.obj', 'concat(']) {
            expect(withResolvedText({ kind: 'toast', message: 'fallback', messageExpr: expr }, scope).message, expr).toBe('fallback');
        }
    });

    it('turns numbers into text and caps each field at the length its literal allows', () => {
        expect(withResolvedText({ kind: 'toast', messageExpr: 'vars.n' }, scope).message).toBe('3');
        const long = "concat('" + 'x'.repeat(600) + "')";
        expect(String(withResolvedText({ kind: 'toast', messageExpr: long }, scope).message)).toHaveLength(500);
        expect(String(withResolvedText({ kind: 'confirm', titleExpr: long }, scope).title)).toHaveLength(120);
        expect(String(withResolvedText({ kind: 'confirm', confirmLabelExpr: long }, scope).confirmLabel)).toHaveLength(80);
    });
});

describe('resolveScreenId', () => {
    const screens = [{ id: 'scr_a' }, { id: 'scr_b' }];

    it('returns the literal screenId when there is no formula', () => {
        expect(resolveScreenId({ kind: 'navigate', screenId: 'scr_a' }, scope, screens, tr)).toBe('scr_a');
    });

    it('accepts the id of an own screen', () => {
        expect(resolveScreenId({ kind: 'navigate', screenExpr: "'scr_b'" }, scope, screens, tr)).toBe('scr_b');
    });

    it('refuses anything that is not an own screen, whatever it looks like', () => {
        for (const expr of ["'scr_zzz'", "'/admin'", "'https://x.test'", "'../scr_a'", 'vars.obj']) {
            expect(() => resolveScreenId({ kind: 'navigate', screenExpr: expr }, scope, screens, tr), expr).toThrow();
        }
    });

    it('refuses when the app has no screen list to check against', () => {
        expect(() => resolveScreenId({ kind: 'navigate', screenExpr: "'scr_a'" }, scope, undefined, tr)).toThrow(/not part of this app/);
    });

    it('falls back to the literal screenId when the formula gives nothing', () => {
        expect(resolveScreenId({ kind: 'navigate', screenId: 'scr_a', screenExpr: 'vars.empty' }, scope, screens, tr)).toBe('scr_a');
        expect(() => resolveScreenId({ kind: 'navigate', screenExpr: 'vars.empty' }, scope, screens, tr)).toThrow(/no screen/);
    });
});

describe('resolveOpenUrl', () => {
    const hosts = ['example.com'];

    it('says "use the literal url" (empty) when the step has no formula', () => {
        expect(resolveOpenUrl({ kind: 'open_url', url: 'https://example.com' }, scope, hosts, tr)).toBe('');
    });

    it('returns an https address on a listed host, matching the host in any letter case', () => {
        expect(resolveOpenUrl({ kind: 'open_url', urlExpr: "'https://Example.com/a?b=1'" }, scope, hosts, tr)).toBe('https://example.com/a?b=1');
    });

    it('refuses other schemes, other hosts, subdomains, ports and credentials', () => {
        for (const url of ['http://example.com/', 'https://example.org/', 'https://sub.example.com/', 'https://example.com:444/', 'https://u@example.com/', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,x', '//example.com/', 'example.com']) {
            expect(() => resolveOpenUrl({ kind: 'open_url', urlExpr: JSON.stringify(url).replace(/"/g, "'") }, scope, hosts, tr), url).toThrow();
        }
    });

    it('opens nothing without a list, or with a list that is not a list', () => {
        for (const list of [undefined, [], 'example.com', null]) {
            expect(() => resolveOpenUrl({ kind: 'open_url', urlExpr: "'https://example.com/'" }, scope, list, tr)).toThrow(/allowed hosts/);
        }
    });

    it('uses the literal url when the formula gives nothing and the step has one', () => {
        expect(resolveOpenUrl({ kind: 'open_url', url: 'https://example.com', urlExpr: 'vars.empty' }, scope, hosts, tr)).toBe('');
        expect(() => resolveOpenUrl({ kind: 'open_url', urlExpr: 'vars.empty' }, scope, hosts, tr)).toThrow(/no address/);
    });
});
