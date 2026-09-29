---
id: login-navigation
title: Login works and the core pages open without errors
mode: generated
tags: [smoke, auth, navigation]
requires: []
timeout: 90000
auth: none
cleanup: ""
---

## Steps

1. Open `/app` in a clean (logged-out) context. The login form must appear
   (`username`, `password`, `login-submit-button`).
2. Log in with the credentials from `process.env.ADMIN_USER` /
   `process.env.ADMIN_PASSWORD`.
3. Wait for the app shell: the sidebar (`sidebar`) becomes visible and the URL
   is under `/app`.
4. Navigate to the Studio agents page (`/app/studio/agents`) and assert its
   landmark: the create button with title "Create empty agent" is visible.
5. Navigate to the knowledge studio (`/app/studio/knowledge`) and assert its
   landmark: the create button with title "New knowledge base" is visible.
6. Navigate to the routines page (`/app/routines`) and assert the app shell
   survives: the sidebar is still visible and no login form is shown.
7. Open the profile menu (`sidebar-profile`) and sign out (`sidebar-signout`).

## Expected

- After step 3 the sidebar is visible — login succeeded without an MFA or
  encryption gate.
- The landmarks in steps 4–6 are visible on each page.
- After step 7 the login form is visible again (session ended).

## Notes for generation

- This scenario runs with `auth: none`: do NOT use the storageState fixture;
  perform the UI login inline.
- First-login gates are handled by the environment; if a modal blocks the
  shell, fail with a clear assertion message rather than trying to dismiss it.
