// @vitest-environment node
/**
 * Language-specific demo fixtures (issue 249): the sample data is written in
 * Dutch, so a demo framed by an English page must show English names.
 *
 * Run: cd agent-hub && npx vitest run src/demo/demoLocale.test.ts --maxWorkers=2
 */
import { describe, it, expect } from 'vitest';
import { createDemoTransport } from './demoTransport';
import type { DemoRoutes } from './demoTransport';
import { demoTextLocaliser, DUTCH_SAMPLE_TERMS } from './demoLocale';
import { COMMON_ROUTES } from './fixtures/common';
import * as compliance from './fixtures/compliance';
import * as privacyShield from './fixtures/privacyShield';

describe('demoTextLocaliser', () => {
    it('leaves Dutch (the language of the fixtures) and a missing language alone', () => {
        expect(demoTextLocaliser('nl')).toBeUndefined();
        expect(demoTextLocaliser(null)).toBeUndefined();
    });

    it('turns the Dutch sample names into English for any other language', () => {
        const en = demoTextLocaliser('en');
        expect(en?.('Polisintake')).toBe('Policy intake');
        expect(en?.('Agent Schadebeoordeling and Klachtdossier')).toBe('Agent Claims assessment and Complaint file');
        expect(en?.('Van Dael Assurantiën B.V.')).toBe('Van Dael Insurance Brokers B.V.');
        expect(demoTextLocaliser('de')?.('Polisintake')).toBe('Policy intake');
        expect(en?.('nothing to change')).toBe('nothing to change');
    });
});

describe('the transport with a localiser', () => {
    const routes: DemoRoutes = { 'GET /api/x': () => ({ name: 'Polisintake', list: ['Klachtdossier'], n: 3 }) };

    it('localises string values of a JSON answer, not keys or numbers', async () => {
        const fetch = createDemoTransport(routes, {}, demoTextLocaliser('en')) as (u: string) => Promise<Response>;
        expect(await (await fetch('/api/x')).json()).toEqual({ name: 'Policy intake', list: ['Complaint file'], n: 3 });
    });

    it('answers in the source language without a localiser', async () => {
        const fetch = createDemoTransport(routes, {}) as (u: string) => Promise<Response>;
        expect((await (await fetch('/api/x')).json()).name).toBe('Polisintake');
    });
});

describe('the compliance and privacy-shield demos in English', () => {
    const modules = { compliance, privacyShield } as Record<string, { ROUTES: DemoRoutes; createState: () => object }>;

    for (const [name, mod] of Object.entries(modules)) {
        it(`${name}: no list answer still carries a Dutch sample name`, async () => {
            const state = mod.createState();
            const fetch = createDemoTransport({ ...COMMON_ROUTES, ...mod.ROUTES }, state, demoTextLocaliser('en')) as (u: string) => Promise<Response>;
            const params = (pattern: string) => pattern.replace(/:orgId/g, 'org_demo_vandael');
            let answered = 0;
            for (const key of Object.keys(mod.ROUTES)) {
                const [method, pattern] = key.split(' ');
                if (method !== 'GET' || pattern.includes('*') || /:[a-z]/i.test(params(pattern))) continue;
                const res = await fetch(params(pattern));
                if (!res.ok) continue;
                answered += 1;
                const text = await res.text();
                for (const term of Object.keys(DUTCH_SAMPLE_TERMS)) expect(text, `${key} → ${term}`).not.toContain(term);
            }
            expect(answered).toBeGreaterThan(0);
        });
    }
});
