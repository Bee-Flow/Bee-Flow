// Save/disconnect boilerplate for integration cards — replaces the recurring
//   const [saving, setSaving] = useState(false);
//   const [disconnecting, setDisconnecting] = useState(false);
//   const [error, setError] = useState(null);
//   const save = async () => {
//       setSaving(true); ...
//       const res = await authFetch(`${API_BASE}/ai/user-settings`, { … });
//       if (res.ok) { onSaved(); … }
//       else { const err = await res.json().catch(() => ({})); setError(err.error…) }
//       setSaving(false);
//   };
//   const handleDisconnect = async () => { … };
// pattern that ~9 integration sub-components in
// src/pages/settings/IntegrationsSection.jsx each hand-rolled (Fireflies,
// Gamma, YouTrack, SignRequest, AFAS, NMBRS, Nextcloud, GitHub, …).
//
// The copies had drifted: some only `console.error`d, some `alert()`d, some
// set a visible `error`. This centralises the safest variant — a guarded JSON
// parse of the error body plus a visible `error` string.
//
// Usage:
//   const { saving, disconnecting, error, setError, save, disconnect } =
//       useUserSettingSave(onSaved);
//   // single key:  save({ firefliesApiKey: key }, { onSuccess: () => setKey('') })
//   // clear:       disconnect({ firefliesApiKey: '' })
//   // custom flow: save(body, { endpoint, method, fallback, onSuccess })
//
// `save`/`disconnect` never throw — failures land in `error`. Both default to
// POST `${API_BASE}/ai/user-settings`; pass `endpoint`/`method` to reuse the
// same state machine for other endpoints (GitHub connect, Nextcloud app
// password, …). A `null`/`undefined` body sends no request body (for DELETE or
// no-payload calls).

import { useState } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';

const USER_SETTINGS_URL = `${API_BASE}/ai/user-settings`;

/** The parsed response body; `{}` when the response carried no JSON. */
export type UserSettingResponse = Record<string, unknown> & { error?: string };

export interface UserSettingSaveOptions {
    onSuccess?: (data: UserSettingResponse) => void;
    endpoint?: string;
    method?: string;
    fallback?: string;
}

export type UserSettingSaveResult =
    | { ok: true; data: UserSettingResponse }
    | { ok: false; data: UserSettingResponse; error?: undefined }
    | { ok: false; error: unknown; data?: undefined };

export interface UseUserSettingSaveReturn {
    saving: boolean;
    disconnecting: boolean;
    error: string | null;
    setError: (message: string | null) => void;
    save: (body?: unknown, opts?: UserSettingSaveOptions) => Promise<UserSettingSaveResult>;
    disconnect: (body?: unknown, opts?: UserSettingSaveOptions) => Promise<UserSettingSaveResult>;
}

export default function useUserSettingSave(onSaved?: () => void): UseUserSettingSaveReturn {
    const [saving, setSaving] = useState(false);
    const [disconnecting, setDisconnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async (
        setBusy: (busy: boolean) => void,
        body: unknown,
        { onSuccess, endpoint = USER_SETTINGS_URL, method = 'POST', fallback = 'Failed to save' }: UserSettingSaveOptions = {},
    ): Promise<UserSettingSaveResult> => {
        setBusy(true);
        setError(null);
        try {
            const opts: RequestInit = { method };
            if (body != null) {
                opts.headers = { 'Content-Type': 'application/json' };
                opts.body = JSON.stringify(body);
            }
            const res = await authFetch(endpoint, opts);
            // Guarded parse: tolerate empty / non-JSON responses (e.g. 204 on delete).
            const data: UserSettingResponse = await res.json().catch(() => ({}));
            if (res.ok) {
                onSaved?.();
                onSuccess?.(data);
                return { ok: true, data };
            }
            setError(data.error || fallback);
            return { ok: false, data };
        } catch (e) {
            console.error(e);
            setError(e instanceof Error ? e.message : String(e));
            return { ok: false, error: e };
        } finally {
            setBusy(false);
        }
    };

    const save = (body?: unknown, opts?: UserSettingSaveOptions) => run(setSaving, body, opts);
    const disconnect = (body?: unknown, opts?: UserSettingSaveOptions) => run(setDisconnecting, body, opts);

    return { saving, disconnecting, error, setError, save, disconnect };
}
