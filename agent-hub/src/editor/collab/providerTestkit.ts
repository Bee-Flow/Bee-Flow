/**
 * providerTestkit.ts — a scripted co-editing server for the provider tests: a
 * real Y.Doc answers /sync, every request is recorded, and any endpoint can be
 * overridden per test (a held request, a failure, a size limit).
 */
import * as Y from 'yjs';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { CollabProvider, type CollabHttp } from './provider';

export class HttpError extends Error {
    status: number;
    body: { code?: string } | null;
    constructor(status: number, code?: string) {
        super(`HTTP ${status}`);
        this.status = status;
        this.body = code ? { code } : null;
    }
}

export interface Call { path: string; body: any }

export function makeServer({ canEdit = true } = {}) {
    const doc = new Y.Doc();
    const calls: Call[] = [];
    let seq = 3;
    const overrides = new Map<string, (body: any) => Promise<any>>();
    const http: CollabHttp = {
        post: async (path: string, body: unknown) => {
            calls.push({ path, body });
            for (const [suffix, fn] of overrides) if (path.endsWith(suffix)) return fn(body);
            if (path.endsWith('/docs')) return { docId: 'd1', seq, canEdit };
            if (path.endsWith('/sync')) {
                const sv = fromBase64((body as any).sv);
                return {
                    update: toBase64(Y.encodeStateAsUpdate(doc, sv)),
                    sv: toBase64(Y.encodeStateVector(doc)),
                    seq,
                    canEdit,
                };
            }
            if (path.endsWith('/updates')) {
                for (const u of (body as any).updates) Y.applyUpdate(doc, fromBase64(u));
                seq += 1;
                return { seq };
            }
            return { ok: true };
        },
    };
    return { doc, calls, http, overrides, setSeq: (n: number) => { seq = n; } };
}

export type Server = ReturnType<typeof makeServer>;

export const frame = (fn: () => void) => { const t = setTimeout(fn, 16); return () => clearTimeout(t); };

export function makeProvider(server: Server, extra: Partial<ConstructorParameters<typeof CollabProvider>[0]> = {}) {
    return new CollabProvider({
        projectId: 'p1', kind: 'notebook', resourceId: 'n1', userId: 'u1', http: server.http, scheduleFrame: frame, ...extra,
    });
}

export const typeText = (p: CollabProvider, text: string) => {
    p.ydoc.transact(() => {
        const t = p.fragment.length ? (p.fragment.get(0) as Y.XmlText) : (() => { const x = new Y.XmlText(); p.fragment.insert(0, [x]); return x; })();
        t.insert(t.length, text);
    }, 'local-edit');
};

export const updateCalls = (s: Server) => s.calls.filter((c) => c.path.endsWith('/updates'));


export const serverText = (s: Server) => {
    const first = s.doc.getXmlFragment('content').get(0) as Y.XmlText | undefined;
    return first ? first.toString() : '';
};
export const syncCount = (s: Server) => s.calls.filter((c) => c.path.endsWith('/sync')).length;
export const queryCount = (s: Server) => s.calls.filter((c) => c.path.endsWith('/awareness') && c.body.query === true).length;

/** Hold the first /updates request until `release()`; later ones go straight through. */
export function holdFirstUpdate(server: Server) {
    const held = { release: () => {} };
    let first = true;
    server.overrides.set('/updates', (body) => {
        const apply = () => { for (const u of body.updates) Y.applyUpdate(server.doc, fromBase64(u)); return { seq: 9 }; };
        if (!first) return Promise.resolve(apply());
        first = false;
        return new Promise((r) => { held.release = () => r(apply()); });
    });
    return held;
}
