// Learning path preference (v2) — the role/goal picked on the Learning Center
// home. Mirrors the learningProgress.js persistence pattern: scopedStorage for
// instant same-browser reads, POST /ai/user-settings { learningPath } for the
// cross-device truth (validated server-side against the known choices).
//
// Values: 'everyday' | 'builder' | 'admin' | 'skipped' | '' — 'skipped' means
// "asked, declined" (never re-prompt); '' means never asked.

import scopedStorage from '../../utils/scopedStorage';
import { API_BASE, authFetch } from '../../utils/helpers';

export const LEARNING_PATH_KEY = 'learningPath';
export const PATH_VALUES = new Set(['everyday', 'builder', 'admin', 'skipped', '']);

function withUser(user) {
    try { if (user?.id) scopedStorage.setCurrentUser(user.id); } catch (_) { /* ignore */ }
}

export function readLearningPath(user) {
    try {
        withUser(user);
        const v = scopedStorage.getItem(LEARNING_PATH_KEY) || '';
        return PATH_VALUES.has(v) ? v : '';
    } catch (_) {
        return '';
    }
}

// Mirror a server-fetched value locally (the section already fetches
// /ai/user-settings — no extra request needed).
export function mirrorLearningPath(user, value) {
    if (!PATH_VALUES.has(value)) return;
    try {
        withUser(user);
        scopedStorage.setItem(LEARNING_PATH_KEY, value);
    } catch (_) { /* preference only */ }
}

export async function saveLearningPath(user, value) {
    if (!PATH_VALUES.has(value)) return;
    mirrorLearningPath(user, value);
    try {
        await authFetch(`${API_BASE}/ai/user-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ learningPath: value }),
        });
    } catch (_) { /* local mirror already written */ }
}
