/**
 * Bee Flow Docs CMS — OAuth relay (Cloudflare Worker).
 *
 * Sveltia/Decap CMS protocol for GitHub login:
 *   1. Editor's browser opens  ${base_url}/auth?provider=github&site_id=...
 *      → we redirect to GitHub's authorize page.
 *   2. GitHub redirects back to ${base_url}/callback?code=...&state=...
 *      → we POST the code to GitHub, receive an access token, and
 *        postMessage it back to the editor's browser, which then closes.
 *
 * Token never persists anywhere. No content data ever passes through
 * this worker — only the OAuth handshake.
 *
 * Inspired by https://github.com/sveltia/sveltia-cms-auth (MIT).
 */

// Origins that may initiate auth. Anything else gets a 403, so a stranger
// can't trick our worker into completing OAuth flows for their site.
const ALLOWED_HOSTS = [
  'bee-flow.github.io',
  'docs.beeflow.ai',
  'beeflow.nl',
  'localhost',
];

const OAUTH_SCOPE = 'repo,user';

export default {
  /**
   * @param {Request} request
   * @param {{ GITHUB_CLIENT_ID: string, GITHUB_CLIENT_SECRET: string }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return text('Bee Flow Docs CMS auth relay. See /auth.', 200);
    }

    if (url.pathname === '/auth') {
      return startAuth(url, env);
    }

    if (url.pathname === '/callback') {
      return finishAuth(url, env);
    }

    return text('Not found', 404);
  },
};

// -- /auth -----------------------------------------------------------------

function startAuth(url, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text(
      'Worker is missing GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET secrets.',
      500,
    );
  }

  const siteId = url.searchParams.get('site_id') || '';
  if (siteId && !hostAllowed(siteId)) {
    return text(`Forbidden site_id: ${siteId}`, 403);
  }

  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/callback`;

  const ghUrl = new URL('https://github.com/login/oauth/authorize');
  ghUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  ghUrl.searchParams.set('scope', OAUTH_SCOPE);
  ghUrl.searchParams.set('state', state);
  ghUrl.searchParams.set('redirect_uri', redirectUri);

  return Response.redirect(ghUrl.toString(), 302);
}

// -- /callback -------------------------------------------------------------

async function finishAuth(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return text('Missing code parameter', 400);

  let payload;
  let messageType;

  try {
    const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'bee-flow-cms-auth-worker',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const data = await tokenResp.json();

    if (!data.access_token) {
      messageType = 'error';
      payload = { message: data.error_description || data.error || 'oauth_failed' };
    } else {
      messageType = 'success';
      payload = { token: data.access_token, provider: 'github' };
    }
  } catch (err) {
    messageType = 'error';
    payload = { message: String(err && err.message ? err.message : err) };
  }

  const message = `authorization:github:${messageType}:${JSON.stringify(payload)}`;
  return html(callbackHtml(message));
}

// -- helpers ---------------------------------------------------------------

function hostAllowed(siteId) {
  // site_id can be a hostname or a full URL — accept both shapes.
  let host = siteId;
  try {
    host = new URL(siteId).host;
  } catch {
    /* siteId was already a bare hostname */
  }
  host = host.replace(/:\d+$/, '');
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function callbackHtml(message) {
  // The CMS uses one of two postMessage handshakes depending on version:
  //   (a) immediate — we post as soon as we have a token
  //   (b) handshake — the CMS posts "authorizing:github" first, we reply
  // Support both so the worker works with current and older Sveltia/Decap.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authenticating…</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:2rem;color:#34322e;">
<p>Authentication complete. You can close this window.</p>
<script>
(function () {
  var sent = false;
  var msg = ${JSON.stringify(message)};
  function send() {
    if (sent) return;
    sent = true;
    if (window.opener) window.opener.postMessage(msg, '*');
  }
  window.addEventListener('message', function (e) {
    if (typeof e.data === 'string' && e.data.indexOf('authorizing:github') === 0) send();
  });
  // Fallback for clients that don't send the "authorizing" handshake.
  setTimeout(send, 200);
  setTimeout(function () { try { window.close(); } catch (e) {} }, 1500);
})();
</script>
</body></html>`;
}
