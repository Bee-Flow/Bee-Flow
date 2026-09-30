/**
 * The logo upload: a multipart POST under the multer field `logo`, carrying
 * the session headers, whose answer is read through its contract — and a
 * refusal that becomes the server's own error.
 */

import { uploadOrgLogo } from './profile';

jest.mock('@/core/api/server', () => ({ apiUrl: (path: string) => `https://bee.test${path}` }));
jest.mock('@/core/api/xhrUpload', () => ({
    setAuthHeaders: (xhr: { setRequestHeader: (k: string, v: string) => void }) => xhr.setRequestHeader('X-Session-Token', 'tok'),
    uploadError: (_path: string, status: number, body: unknown) => Object.assign(new Error(`HTTP ${status}`), { body }),
}));

class FakeXhr {
    static last: FakeXhr;
    method = '';
    url = '';
    headers: Record<string, string> = {};
    sent: FormData | null = null;
    status = 0;
    responseText = '';
    responseType = '';
    withCredentials = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
        FakeXhr.last = this;
    }
    open(method: string, url: string) {
        this.method = method;
        this.url = url;
    }
    setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
    }
    send(form: FormData) {
        this.sent = form;
    }
    answer(status: number, body: string) {
        this.status = status;
        this.responseText = body;
        this.onload?.();
    }
}

const FILE = { uri: 'file:///logo.png', name: 'logo.png', mimeType: 'image/png' };

beforeEach(() => {
    (global as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
});

describe('uploadOrgLogo', () => {
    it('posts the file as `logo` with the session headers and reads the new path', async () => {
        const pending = uploadOrgLogo('o 1', FILE);
        const xhr = FakeXhr.last;
        expect(xhr.method).toBe('POST');
        expect(xhr.url).toBe('https://bee.test/auth/organizations/o%201/logo');
        expect(xhr.headers['X-Session-Token']).toBe('tok');
        expect(xhr.withCredentials).toBe(true);
        expect(xhr.sent?.get('logo')).toBeTruthy();
        xhr.answer(200, JSON.stringify({ success: true, logo: '/uploads/org-logo-o1.png' }));
        await expect(pending).resolves.toEqual({ logo: '/uploads/org-logo-o1.png' });
    });

    it('rejects with the server refusal, and on a dropped connection', async () => {
        const refused = uploadOrgLogo('o1', FILE);
        FakeXhr.last.answer(400, 'not json');
        await expect(refused).rejects.toThrow('HTTP 400');
        const dropped = uploadOrgLogo('o1', FILE);
        FakeXhr.last.onerror?.();
        await expect(dropped).rejects.toThrow('HTTP 0');
    });
});
