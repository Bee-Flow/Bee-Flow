/**
 * The presenter flag — Shift+P on a builder canvas. One storage key for both
 * builders (routines and App Studio): a presenter who switched it on for the
 * routine film expects the app film to be in the same mode.
 */
import scopedStorage from '../../../utils/scopedStorage';

export const PRESENTER_KEY = 'routines.canvas.presenter';

export function readPresenter() {
    try {
        return scopedStorage.getItem(PRESENTER_KEY) === '1';
    } catch {
        return false;
    }
}

export function writePresenter(on) {
    try {
        scopedStorage.setItem(PRESENTER_KEY, on ? '1' : '0');
    } catch {
        // Storage refused — the toggle still holds for this session.
    }
    notifyPresenter(on);
}

// A page that HOSTS a builder (Studio Playbooks) mirrors the flag the
// builder's own Shift+P toggles, without binding the key a second time.
const PRESENTER_EVENT = 'bf:presenter';

export function subscribePresenter(cb) {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener(PRESENTER_EVENT, cb);
    return () => window.removeEventListener(PRESENTER_EVENT, cb);
}

export function notifyPresenter(on) {
    if (typeof window === 'undefined') return;
    try { window.dispatchEvent(new CustomEvent(PRESENTER_EVENT, { detail: !!on })); } catch { /* no CustomEvent — nothing listens */ }
}
