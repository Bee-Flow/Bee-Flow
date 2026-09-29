/**
 * Saving the Privacy Shield must not destroy what the page cannot see.
 *
 * The PUT handler rebuilds the whole shield row from the request body, and this
 * page sent a fixed list of keys. Every key it did not send therefore came back
 * as a server default — so every admin save silently:
 *
 *   - emptied `customSensitiveTerms` (the org's own redaction patterns, which
 *     the runtime really does read),
 *   - reset `dlpScope`, `dlpFailureMode`, `dlpAllowlistedHosts` and
 *     `attachmentLargeInputPolicy`,
 *   - overwrote `scope` and `action` with hardcoded values.
 *
 * The fix keeps the loaded document and lays this page's fields over it. That
 * is invisible in the UI, so it needs a test that reads the actual PUT body —
 * including a field this code has never heard of, because the next release will
 * add one.
 *
 * Run: npx vitest run src/components/admin/guardrails/orgShield/OrgShieldEditor.save.test.jsx
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(),
}));

vi.mock('../../../../../hooks/useTranslation', () => ({
    // Mirrors the real `t(key, fallbackOrParams?, params?)`, INCLUDING `{x}`
    // interpolation. A mock that drops the params renders the raw
    // "{n} of your own words…" placeholder, so any assertion on a sentence
    // that counts something tests the mock rather than the screen.
    useTranslation: () => ({
        t: (key, fallbackOrParams, paramsArg) => {
            const hasStringFallback = typeof fallbackOrParams === 'string';
            const params = hasStringFallback ? paramsArg : fallbackOrParams;
            let out = hasStringFallback ? fallbackOrParams : key;
            if (params && typeof params === 'object') {
                for (const [k, v] of Object.entries(params)) {
                    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
                }
            }
            return out;
        },
    }),
    __esModule: true,
}));

vi.mock('../../../../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ tier: 'enterprise', hasFeature: () => true, hasTier: () => true }),
}));

import OrgShieldEditor from './OrgShieldEditor';
import { authFetch } from '../../../../../utils/helpers';

const ORG_ID = 'org-alpha';

/**
 * A stored document that exercises every field this page does NOT render,
 * plus one it cannot possibly know about.
 */
const STORED = {
    enabled: true,
    collectionIds: ['col-1'],
    scope: { userInput: false, agentOutput: true },
    action: 'redact',
    piiDetectionCategories: ['Email'],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'block',
    piiFailureMode: 'fail_closed',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
    // Not rendered by this page — all previously destroyed on save.
    customSensitiveTerms: [{ id: 't1', label: 'Codename', pattern: 'AURORA', type: 'literal', caseSensitive: false }],
    dlpScope: 'all',
    dlpFailureMode: 'fail_open',
    dlpAllowlistedHosts: ['intern.example'],
    attachmentLargeInputPolicy: 'fail_closed',
    webSearchGuardPiiCategories: ['Person'],
    // A field from a future release. It must survive too.
    somethingAddedLater: { deeply: ['nested'] },
    // Response-only keys — these must NOT be echoed back into the row.
    updatedAt: '2020-01-01T00:00:00.000Z',
    updatedBy: 'someone-else',
};

let requested = [];
let putBodies = [];
let shieldStatus = 200;

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

/**
 * The server this page talks to: `doc` is the stored shield, `put` answers a
 * save (default: the row as written).
 */
function serve({ doc = STORED, put } = {}) {
    authFetch.mockImplementation(async (url, opts) => {
        requested.push(url);
        if (url.includes('/auth/organizations')) return ok([{ id: ORG_ID, name: 'Alpha BV' }]);
        // Also answers /ai/config/chat-models-eu.
        if (url.includes('/ai/config')) return ok({});
        if (url.includes('/api/org-privacy-shield/')) {
            if (opts?.method === 'PUT') {
                const body = JSON.parse(opts.body);
                putBodies.push(body);
                // Echo the row as WRITTEN, which is what the real handler
                // returns. Replying with the pre-edit document instead would
                // leave the form legitimately dirty after a successful save —
                // the server having stored something other than what was sent
                // is exactly the state the dirty flag is supposed to report —
                // and the old UI only looked clean because it suppressed the
                // "Unsaved changes" label whenever any message was showing.
                return ok(put ? put(body) : { ok: true, config: { ...doc, ...body }, termErrors: [], typeErrors: [] });
            }
            if (shieldStatus !== 200) {
                return { ok: false, status: shieldStatus, json: async () => ({ error: 'nope' }) };
            }
            return ok(doc);
        }
        return ok({});
    });
}

beforeEach(() => {
    requested = [];
    putBodies = [];
    shieldStatus = 200;
    authFetch.mockReset();
    serve();
});

const saveButton = () => screen.getByRole('button', { name: /save/i });

async function renderLoaded() {
    render(<OrgShieldEditor orgId={ORG_ID} />);
    await waitFor(() => expect(saveButton()).toBeEnabled());
}

describe('OrgShieldEditor save payload', () => {
    it('carries every stored field the page does not render', async () => {
        const user = userEvent.setup();
        await renderLoaded();

        // Change one unrelated thing, exactly as an admin would.
        // The sensitivity cards live on the "What we look for" tab; Overview is the
        // landing tab and is deliberately read-only apart from the master
        // switch, so an edit has to start with navigation.
        await user.click(screen.getByRole('tab', { name: /What we look for/ }));
        await user.click(screen.getByRole('radio', { name: /Low sensitivity/ }));
        await user.click(saveButton());
        await waitFor(() => expect(putBodies).toHaveLength(1));

        const body = putBodies[0];
        expect(body.customSensitiveTerms).toEqual(STORED.customSensitiveTerms);
        expect(body.dlpScope).toBe('all');
        expect(body.dlpFailureMode).toBe('fail_open');
        expect(body.dlpAllowlistedHosts).toEqual(['intern.example']);
        expect(body.attachmentLargeInputPolicy).toBe('fail_closed');
        expect(body.collectionIds).toEqual(['col-1']);
        expect(body.webSearchGuardPiiCategories).toEqual(['Person']);
        // Previously overwritten with hardcoded { true, true } / 'delete'.
        expect(body.scope).toEqual({ userInput: false, agentOutput: true });
        expect(body.action).toBe('redact');
        // The unknown-field guarantee: this is what makes the merge future-proof.
        expect(body.somethingAddedLater).toEqual({ deeply: ['nested'] });
    });

    it('does not echo response-only fields back into the row', async () => {
        const user = userEvent.setup();
        await renderLoaded();
        await user.click(saveButton());
        await waitFor(() => expect(putBodies).toHaveLength(1));

        // The server owns these; sending them back would persist a stale
        // author, and a transient plan note, into the stored document.
        expect(putBodies[0]).not.toHaveProperty('updatedAt');
        expect(putBodies[0]).not.toHaveProperty('updatedBy');
        expect(putBodies[0]).not.toHaveProperty('clamped_fields');
        expect(putBodies[0]).not.toHaveProperty('stalenessWarnings');
    });

    it('never persists showRawPayload while the action is not tokenize', async () => {
        const user = userEvent.setup();
        serve({
            // Stored ON, with an action that hides the control entirely.
            doc: { ...STORED, piiDetectionAction: 'block', showRawPayload: true },
            put: () => ({ ok: true, config: STORED }),
        });
        await renderLoaded();
        await user.click(saveButton());
        await waitFor(() => expect(putBodies).toHaveLength(1));

        // The checkbox is not rendered at all under 'block', so leaving the
        // value at true kept a transparency panel switched on for every user
        // in the org with nothing on screen saying so.
        expect(putBodies[0].showRawPayload).toBe(false);
    });
});

describe('OrgShieldEditor load failure', () => {
    it('shows nothing to edit and nothing to save', async () => {
        shieldStatus = 500;
        render(<OrgShieldEditor orgId={ORG_ID} />);

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/could not load/i);

        // The whole point. The form used to render constructor defaults —
        // "shield off, no categories" — indistinguishably from a real answer,
        // with Save live. One click then wrote that blank config over the
        // org's real one. With no trustworthy document there is nothing to
        // show and nothing to save, and the page now says exactly that.
        expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
        expect(screen.queryByRole('radio', { name: /Low sensitivity/ })).toBeNull();
        expect(putBodies).toHaveLength(0);
    });

    it('names the access problem specifically on a 403', async () => {
        shieldStatus = 403;
        render(<OrgShieldEditor orgId={ORG_ID} />);
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/do not have access/i);
        expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    });
});

describe('OrgShieldEditor dirty state', () => {
    it('appears on the first edit and clears after a successful save', async () => {
        const user = userEvent.setup();
        await renderLoaded();

        expect(screen.queryByText('Unsaved changes')).toBeNull();
        // The sensitivity cards live on the "What we look for" tab; Overview is the
        // landing tab and is deliberately read-only apart from the master
        // switch, so an edit has to start with navigation.
        await user.click(screen.getByRole('tab', { name: /What we look for/ }));
        await user.click(screen.getByRole('radio', { name: /Low sensitivity/ }));
        expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

        await user.click(saveButton());
        await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    });
});

describe('OrgShieldEditor partial save', () => {
    it('says so when the server rejected some custom terms', async () => {
        const user = userEvent.setup();
        serve({
            // The server saves the valid terms and reports the rest — so this
            // is a partial success, not a clean one.
            put: () => ({ ok: true, config: STORED, termErrors: [{ id: 't9', label: 'Bad', error: 'Invalid regular expression' }] }),
        });
        await renderLoaded();
        await user.click(saveButton());

        // It has to say three things: the save happened, one term did NOT take
        // effect, and where to look. A partial save reported as a clean one is
        // how an admin ends up believing a pattern is in force that never
        // compiled.
        const note = await screen.findByText(/Saved, with notes/i);
        expect(note).toBeInTheDocument();
        expect(note.textContent).toMatch(/1 of your own words or patterns were refused/i);
        expect(note.textContent).toMatch(/NOT in force/);
    });
});

const TYPE = {
    id: 'cdt_0123456789', name: 'Codes', description: '', method: 'words', tokenKey: 'code',
    origin: 'created', words: { values: ['AURORA'], caseSensitive: false, wholeWord: true },
};
// A server that knows "Your own data": it always sends customDataTypes, and
// writes the old terms' mirror itself.
const NEW_STORED = {
    ...STORED,
    piiDetectionCategories: ['Email', TYPE.id],
    toolPiiPolicy: { external: { blockCategories: [TYPE.id] }, internal: { blockCategories: ['Person', TYPE.id] } },
    customDataTypes: [TYPE],
};
const serveOwnData = ({ doc = NEW_STORED, put } = {}) => serve({ doc, put });

describe('OrgShieldEditor save payload with "Your own data"', () => {
    it('keeps the org\'s own type ids in all three lists', async () => {
        // The page filters the lists against the 21 built-in kinds. Without
        // the org's own ids in that filter, every save deleted their switches.
        serveOwnData();
        const user = userEvent.setup();
        await renderLoaded();
        await user.click(saveButton());
        await waitFor(() => expect(putBodies).toHaveLength(1));
        const body = putBodies[0];
        expect(body.piiDetectionCategories).toEqual(['Email', TYPE.id]);
        expect(body.toolPiiPolicy.external.blockCategories).toEqual([TYPE.id]);
        expect(body.toolPiiPolicy.internal.blockCategories).toEqual(['Person', TYPE.id]);
        expect(body.customDataTypes).toEqual([TYPE]);
    });

    it('stops echoing the old terms, and leaves the tests alone when it never got them', async () => {
        serveOwnData();
        const user = userEvent.setup();
        await renderLoaded();
        await user.click(saveButton());
        await waitFor(() => expect(putBodies).toHaveLength(1));
        // The server writes the mirror itself; sending the old one back
        // beside the types would ask it to migrate the same terms twice.
        expect(putBodies[0]).not.toHaveProperty('customSensitiveTerms');
        // Absent means "unchanged": a caller who may not read the tests
        // must not overwrite them with an empty object.
        expect(putBodies[0]).not.toHaveProperty('customDataTests');
    });

    it('sends the tests back when the server sent them', async () => {
        const tests = { [TYPE.id]: { examples: ['AURORA'], sentences: [] } };
        serveOwnData({ doc: { ...NEW_STORED, customDataTests: tests } });
        const user = userEvent.setup();
        await renderLoaded();
        await user.click(saveButton());
        await waitFor(() => expect(putBodies).toHaveLength(1));
        expect(putBodies[0].customDataTests).toEqual(tests);
    });

});

describe('OrgShieldEditor after a save with "Your own data"', () => {
    it('shows the server\'s version of the types after a save, so the page is clean', async () => {
        // The server canonicalises (trims, stamps updatedAt). Without taking
        // its version the form would read as dirty right after a clean save.
        serveOwnData({
            put: (body) => ({
                ok: true,
                config: { ...NEW_STORED, ...body, customDataTypes: [{ ...TYPE, updatedAt: '2026-09-26T10:00:00.000Z' }] },
                typeErrors: [],
            }),
        });
        const user = userEvent.setup();
        await renderLoaded();
        await user.click(screen.getByRole('tab', { name: /What we look for/ }));
        await user.click(screen.getByRole('radio', { name: /Low sensitivity/ }));
        await user.click(saveButton());
        await waitFor(() => expect(putBodies).toHaveLength(1));
        await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    });

    it('says so, and points at the tab, when the server refused one of the types', async () => {
        serveOwnData({
            put: (body) => ({
                ok: true,
                config: { ...NEW_STORED, ...body },
                typeErrors: [{ id: TYPE.id, field: 'words', code: 'invalid', message: 'Too many words.' }],
            }),
        });
        const user = userEvent.setup();
        await renderLoaded();
        await user.click(saveButton());
        const note = await screen.findByText(/1 of your own types were refused/i);
        expect(note).toBeInTheDocument();
        // The banner offers the way there.
        await user.click(screen.getByRole('button', { name: /^Your own data$/ }));
        expect(screen.getByRole('tab', { name: /Your own data/ })).toHaveAttribute('aria-selected', 'true');
        // And the row that was refused says why.
        expect(screen.getByRole('alert')).toHaveTextContent('Not saved: Too many words.');
    });
});
