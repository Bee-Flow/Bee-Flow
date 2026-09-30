/**
 * The XHR uploads carry the same credentials as every other request.
 *
 * They are the one path that cannot use `request()` (only XHR reports upload
 * progress), and they used to set `Accept` and `X-Beeflow-Client` by hand and
 * nothing else. An SSO user has no cookie — the Custom Tab keeps its own jar —
 * so recording uploads, knowledge-base and notebook ingest and template
 * uploads all answered 401 for exactly the people who signed in the way the
 * organisation asked them to.
 *
 * The last block drives the two real call sites through a fake
 * XMLHttpRequest, because a helper nobody calls fixes nothing.
 */

import { uploadFillFile } from '@/features/forms/api/fillUpload';
import { uploadFile, kbIngestTarget } from '@/features/knowledge/api/upload';
import { uploadRecording } from '@/features/recording/api/upload';

import { ApiError, setSessionToken, setUnauthorizedHandler } from './client';
import { setServerUrl } from './server';
import { setAuthHeaders, uploadError } from './xhrUpload';

/** Just enough of XMLHttpRequest to record what a caller does with it. */
class FakeXhr {
    static last: FakeXhr | null = null;
    headers: Record<string, string> = {};
    url = '';
    status = 0;
    responseText = '';
    responseType = '';
    withCredentials = false;
    timeout = 0;
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;

    constructor() {
        FakeXhr.last = this;
    }
    open(_method: string, url: string) {
        this.url = url;
    }
    setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
    }
    body: unknown = null;
    send(body: unknown) {
        this.body = body;
    }
    abort() {}
    /** Answer the request the way the server would. */
    respond(status: number, body: unknown) {
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
    }
}

const realXhr = global.XMLHttpRequest;

beforeAll(async () => {
    await setServerUrl('https://bee.example');
});

beforeEach(() => {
    FakeXhr.last = null;
    global.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
    setSessionToken(null);
    setUnauthorizedHandler(null);
});

afterAll(() => {
    global.XMLHttpRequest = realXhr;
});

describe('setAuthHeaders', () => {
    it('sends the SSO session token when there is one', () => {
        setSessionToken('sso-token');
        const xhr = new FakeXhr();
        setAuthHeaders(xhr as unknown as XMLHttpRequest);

        expect(xhr.headers).toEqual({
            Accept: 'application/json',
            'X-Beeflow-Client': 'android',
            'X-Session-Token': 'sso-token',
        });
    });

    it('sends no token header for a cookie session', () => {
        const xhr = new FakeXhr();
        setAuthHeaders(xhr as unknown as XMLHttpRequest);

        expect(xhr.headers).not.toHaveProperty('X-Session-Token');
        expect(xhr.headers['X-Beeflow-Client']).toBe('android');
    });
});

describe('uploadError', () => {
    it('sends a 401 to the lock screen', () => {
        const handler = jest.fn();
        setUnauthorizedHandler(handler);

        const failure = uploadError('/api/transcriptions', 401, { error: 'Not authenticated' });
        expect(failure).toBeInstanceOf(ApiError);
        expect(failure.status).toBe(401);
        expect(handler).toHaveBeenCalledWith('/api/transcriptions');
    });

    it('reads the sentence, not the code, from a training gate', () => {
        // meeting_notes gates the upload itself (server/learning/requireTraining.js).
        const failure = uploadError('/api/transcriptions', 403, {
            error: 'training_required',
            message: 'Finish the course "Meeting notes" before using this.',
        });
        expect(failure.message).toBe('Finish the course "Meeting notes" before using this.');
        expect(failure.code).toBe('training_required');
    });

    it('calls a load with no status an interrupted upload', () => {
        expect(uploadError('/api/transcriptions', 0, null).message).toBe('The upload was interrupted.');
        expect(uploadError('/api/transcriptions', 502, null).message).toBe('HTTP 502');
    });
});

describe('the upload call sites', () => {
    it('sends the SSO token with a library upload', async () => {
        setSessionToken('sso-token');
        const done = uploadFile(kbIngestTarget('kb1'), {
            uri: 'file:///doc.pdf',
            name: 'doc.pdf',
            mimeType: 'application/pdf',
            size: 10,
        });
        const xhr = FakeXhr.last as FakeXhr;
        expect(xhr.headers['X-Session-Token']).toBe('sso-token');

        xhr.respond(200, { ok: true });
        await expect(done).resolves.toEqual({ ok: true });
    });

    it('sends the SSO token with a recording upload, and a 401 reaches the lock screen', async () => {
        setSessionToken('sso-token');
        const handler = jest.fn();
        setUnauthorizedHandler(handler);
        const done = uploadRecording({
            uri: 'file:///meeting.m4a',
            fileName: 'meeting.m4a',
            mimeType: 'audio/mp4',
            captureMode: 'recording',
            settings: { title: 'Standup', language: 'nl', attendees: '', contextTerms: '', numSpeakers: '' },
        });
        const xhr = FakeXhr.last as FakeXhr;
        expect(xhr.headers['X-Session-Token']).toBe('sso-token');

        xhr.respond(401, { error: 'Not authenticated' });
        await expect(done).rejects.toMatchObject({ status: 401 });
        expect(handler).toHaveBeenCalledWith('/api/transcriptions');
    });

    it('sends a form’s file with its text parts, and reads the descriptor back', async () => {
        setSessionToken('sso-token');
        const progress = jest.fn();
        const done = uploadFillFile(
            { token: 't 1', field: 'cv', csrf: 'c1', sessionId: 's1', maxSizeMb: 5 },
            { uri: 'file:///cv.pdf', name: 'cv.pdf', mimeType: 'application/pdf', size: 10 },
            progress,
        );
        const xhr = FakeXhr.last as FakeXhr;
        expect(xhr.url).toBe('https://bee.example/api/automation/form/t%201/upload');
        expect(xhr.headers['X-Session-Token']).toBe('sso-token');
        const form = xhr.body as FormData;
        expect([...form.keys()]).toEqual(['file', 'field', 'csrf', 'sessionId']);
        expect([form.get('field'), form.get('csrf'), form.get('sessionId')]).toEqual(['cv', 'c1', 's1']);
        xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
        expect(progress).toHaveBeenCalledWith(0.5);

        xhr.respond(200, { fileId: 'f1', filename: 'cv.pdf', size: 10, mimeType: 'application/pdf' });
        await expect(done).resolves.toEqual({ fileId: 'f1', filename: 'cv.pdf', size: 10, mimeType: 'application/pdf' });
    });

    it('refuses a form file over the question’s limit before sending a byte', async () => {
        const done = uploadFillFile(
            { token: 't1', field: 'cv', csrf: 'c1', sessionId: null, maxSizeMb: 1 },
            { uri: 'file:///big.pdf', name: 'big.pdf', mimeType: 'application/pdf', size: 2 * 1024 * 1024 },
        );
        await expect(done).rejects.toMatchObject({ name: 'FillFileTooLargeError', message: 'That file is larger than 1 MB.' });
        expect(FakeXhr.last).toBeNull();
    });

    it('says a dropped connection leaves the file on the device', async () => {
        const done = uploadFile(kbIngestTarget('kb1'), { uri: 'file:///doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf', size: 10 });
        (FakeXhr.last as FakeXhr).onerror?.();
        await expect(done).rejects.toThrow('The connection dropped during the upload. The file is still on this device.');
    });
});
