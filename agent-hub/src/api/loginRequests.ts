import { API_BASE, authFetch } from '../utils/helpers';

// The read requests the login hooks make from their effects. They live here,
// apart from the hooks, so that the request and the effect stay separate things.

export const getSetupStatus = () => authFetch(`${API_BASE}/auth/setup-status`);

export const getPublicOrganizations = () => authFetch(`${API_BASE}/auth/organizations/public`);

export const getPublicPlans = (signal: AbortSignal) => authFetch(`${API_BASE}/billing/public-plans`, { signal });

export const getPendingInvite = () => authFetch(`${API_BASE}/auth/pending-invite`);

export const getInviteByToken = (token: string) => authFetch(`${API_BASE}/auth/invite/${token}`);

export const getAuthUser = () => authFetch(`${API_BASE}/auth/user`);

// The write requests of the login screen. The bodies carry secrets (password,
// MFA code, reset token); they are built here from the arguments and go nowhere else.

export const postSetup = (password: string) => authFetch(`${API_BASE}/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });

export const postAdminLogin = (username: string, password: string) => authFetch(`${API_BASE}/auth/admin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });

export const postMfaVerifyLogin = (code: string) => authFetch(`${API_BASE}/auth/mfa/verify-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
    });

export const postForgotPassword = (email: string) => authFetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
    });

export const postResetPassword = (token: string | null, newPassword: string) => authFetch(`${API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword })
    });

export const postSignup = (body: Record<string, unknown>) => authFetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

export const postResendVerification = (email: string) => authFetch(`${API_BASE}/auth/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
});
