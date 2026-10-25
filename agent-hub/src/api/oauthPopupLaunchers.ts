// The Google / Microsoft consent popups bound to the app's authenticated
// fetch and API base, so a panel that only wants to (re-)consent does not
// have to thread `authFetch` and `API_BASE` through itself.

import { openGoogleOAuthPopup } from '../lib/googleOAuthPopup';
import { API_BASE, authFetch } from '../utils/helpers';
import { openMicrosoftOAuthPopup } from './microsoftOAuthPopup';

/** Open the Google consent popup; same result and rejections as `openGoogleOAuthPopup`. */
export function openGoogleConsentPopup() {
    return openGoogleOAuthPopup({ authFetch, apiBase: API_BASE });
}

/** Open the Microsoft consent popup; same result and rejections as `openMicrosoftOAuthPopup`. */
export function openMicrosoftConsentPopup() {
    return openMicrosoftOAuthPopup({ authFetch, apiBase: API_BASE });
}
