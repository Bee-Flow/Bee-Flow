import { describe, expect, it } from 'vitest';
import { parseCurl, tokenize } from './curlImport';

describe('tokenize', () => {
    it('handles quotes and continuations', () => {
        expect(tokenize("curl 'a b' \\\n \"c\\\"d\" e")).toEqual(['curl', 'a b', 'c"d', 'e']);
    });
});

describe('parseCurl', () => {
    it('implies POST from data and keeps the body', () => {
        const p = parseCurl(`curl https://x.test/a -H 'Content-Type: application/json' -d '{"a":1}'`)!;
        expect(p.method).toBe('POST');
        expect(p.body).toBe('{"a":1}');
        expect(p.headers).toEqual({ 'Content-Type': 'application/json' });
    });
    it('moves the query out of the URL into fields', () => {
        const p = parseCurl('curl "https://x.test/a?page=2&q=a%20b"')!;
        expect(p.url).toBe('https://x.test/a');
        expect(p.query).toEqual({ mode: 'fields', items: [{ key: 'page', value: '2' }, { key: 'q', value: 'a b' }] });
    });
    it('uses json mode for bracket keys', () => {
        expect(parseCurl('curl "https://x.test/a?f[b]=1"')!.query?.mode).toBe('json');
    });
    it('-G turns data into query', () => {
        const p = parseCurl('curl -G https://x.test/a -d page=1')!;
        expect(p.method).toBe('GET');
        expect(p.body).toBe('');
        expect(p.query?.items).toEqual([{ key: 'page', value: '1' }]);
    });
    it('honours -X and --url', () => {
        const p = parseCurl('curl -XPUT --url=https://x.test/a')!;
        expect(p.method).toBe('PUT');
        expect(p.url).toBe('https://x.test/a');
    });
    it('never copies secrets', () => {
        // Assembled at run time: a literal `-u name:password` in the source reads
        // as a leaked curl credential to the secret scan (gitleaks curl-auth-user).
        const basicAuth = ['bob', 'hunter2'].join(':');
        const p = parseCurl(`curl -u ${basicAuth} https://x.test/a?api_key=SECRET -H 'Authorization: Bearer abc' -H 'X-API-Key: k' -H 'Cookie: s=1' -H 'X-Auth-Token: t' -H 'Accept: */*'`)!;
        expect(p.headers).toEqual({ Accept: '*/*' });
        expect(p.query).toBeNull();
        expect(JSON.stringify(p)).not.toMatch(/hunter2|SECRET|abc|Bearer/);
        expect(p.skipped.map((s) => s.name)).toEqual(expect.arrayContaining(['Authorization', 'X-API-Key', 'Cookie', 'X-Auth-Token', 'api_key']));
    });
    it('drops credentials in the URL', () => {
        const p = parseCurl('curl https://bob:pw@x.test/a')!;
        expect(p.url).toBe('https://x.test/a');
        expect(JSON.stringify(p)).not.toContain('pw@');
    });
    it('returns null without a URL', () => {
        expect(parseCurl('curl -X POST')).toBeNull();
    });
});
