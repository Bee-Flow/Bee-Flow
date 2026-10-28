/**
 * Bee Flow Docs CMS — OAuth relay (Cloudflare Worker).
 *
 * Sveltia/Decap CMS protocol for GitHub login:
 *   1. Editor's browser opens  ${base_url}/auth?provider=github&site_id=<host>
 *      → we check site_id against ALLOWED_HOSTS, bind a random `state` and the
 *        site host in a signed HttpOnly cookie, and redirect to GitHub.
 *   2. GitHub redirects back to ${base_url}/callback?code=...&state=...
 *      → we verify `state` against the cookie and burn the cookie, POST the
 *        code to GitHub, and hand the token to the opener window, but only to
 *        the exact origin of the allow-listed site, and only after that
 *        opener answered the "authorizing:github" handshake.
 *
 * Token never persists anywhere. No content data ever passes through
 * this worker — only the OAuth handshake.
 *
 * Inspired by https://github.com/sveltia/sveltia-cms-auth (MIT).
 */

// Hosts the CMS may run on. Exact hostnames, no subdomain wildcard: a
// subdomain we do not control must not receive a token. `localhost` (any
// port, http or https) is for running the docs site locally.
export const ALLOWED_HOSTS = ['bee-flow.github.io', 'docs.beeflow.ai', 'beeflow.nl', 'localhost'];

// The docs repo (backend.repo in docs/static/cms/config.yml, Bee-Flow/docs)
// is public, so `public_repo` is enough to commit to it. The CMS reads the
// editor's login, name and avatar from GET /user, which needs no scope.
export const OAUTH_SCOPE = 'public_repo';

export const STATE_COOKIE = '__Host-cms_oauth_state';

// How long a login may take between /auth and /callback. Env
// STATE_TTL_SECONDS overrides it; 0 = no time limit (the cookie still lives
// only for the browser session and is burned on the first /callback).
const DEFAULT_STATE_TTL_SECONDS = 600;

export default {
  /**
   * @param {Request} request
   * @param {{ GITHUB_CLIENT_ID: string, GITHUB_CLIENT_SECRET: string, STATE_SECRET?: string, STATE_TTL_SECONDS?: string }} env
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
      return finishAuth(request, url, env);
    }

    return text('Not found', 404);
  },
};

// -- /auth -----------------------------------------------------------------

async function startAuth(url, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text('Worker is missing GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET secrets.', 500);
  }

  const site = parseSite(url.searchParams.get('site_id'));
  if (!site) {
    return text('Missing or forbidden site_id', 403);
  }

  const state = crypto.randomUUID();
  const ttl = stateTtlSeconds(env);
  const expires = ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0;
  const cookieValue = await signState(env, { state, host: site.host, port: site.port, expires });

  const ghUrl = new URL('https://github.com/login/oauth/authorize');
  ghUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  ghUrl.searchParams.set('scope', OAUTH_SCOPE);
  ghUrl.searchParams.set('state', state);
  ghUrl.searchParams.set('redirect_uri', `${url.origin}/callback`);

  const attrs = ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (ttl > 0) attrs.push(`Max-Age=${ttl}`);
  return new Response(null, {
    status: 302,
    headers: {
      Location: ghUrl.toString(),
      'Set-Cookie': `${STATE_COOKIE}=${cookieValue}; ${attrs.join('; ')}`,
      'Cache-Control': 'no-store',
    },
  });
}

// -- /callback -------------------------------------------------------------

async function finishAuth(request, url, env) {
  // Every answer from /callback burns the state cookie: one login, one try.
  const burn = `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

  const bound = await verifyState(env, readCookie(request, STATE_COOKIE));
  const state = url.searchParams.get('state') || '';
  if (!bound || !timingSafeEqual(bound.state, state)) {
    return text('Invalid or expired login state. Start the login again.', 400, { 'Set-Cookie': burn });
  }

  const code = url.searchParams.get('code');
  if (!code) return text('Missing code parameter', 400, { 'Set-Cookie': burn });

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
  } catch {
    messageType = 'error';
    payload = { message: 'oauth_failed' };
  }

  const message = `authorization:github:${messageType}:${JSON.stringify(payload)}`;
  return html(callbackHtml(message, { host: bound.host, port: bound.port }), 200, {
    'Set-Cookie': burn,
  });
}

// -- site allow-list -------------------------------------------------------

/**
 * site_id is a bare hostname (Sveltia), a host:port (Decap) or a full URL.
 * Returns the parsed { host, port } when the host is allow-listed, else null.
 */
export function parseSite(siteId) {
  if (!siteId || typeof siteId !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(siteId) ? siteId : `https://${siteId}`);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) return null;
  // A port only makes sense for a local dev server.
  if (parsed.port && host !== 'localhost') return null;
  return { host, port: parsed.port || '' };
}

// -- signed state cookie ---------------------------------------------------

function stateTtlSeconds(env) {
  const raw = env.STATE_TTL_SECONDS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_STATE_TTL_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_STATE_TTL_SECONDS;
}

async function hmacKey(env) {
  const secret = env.STATE_SECRET || env.GITHUB_CLIENT_SECRET;
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`cms-auth-state:v1:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function signState(env, claims) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(body)),
  );
  return `${body}.${b64url(sig)}`;
}

async function verifyState(env, cookieValue) {
  if (!cookieValue || !env.GITHUB_CLIENT_SECRET) return null;
  const [body, sig, extra] = cookieValue.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(env),
      fromB64url(sig),
      new TextEncoder().encode(body),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (typeof claims.state !== 'string' || typeof claims.host !== 'string') return null;
    if (claims.expires && claims.expires < Math.floor(Date.now() / 1000)) return null;
    // Re-check the allow-list at the moment of use, not only at /auth.
    if (!ALLOWED_HOSTS.includes(claims.host)) return null;
    return { state: claims.state, host: claims.host, port: String(claims.port || '') };
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// -- responses -------------------------------------------------------------

function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

// JSON inside a <script>: escape `<` so a value can never close the tag.
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function callbackScript(message, site) {
  // Decap/Sveltia handshake: the popup announces "authorizing:github" to its
  // opener (no secret in it), the opener answers with the same string, and
  // only then the popup posts the result — to the opener's exact origin, and
  // only when that origin parses to the allow-listed site. No fallback send:
  // a page that does not answer from the right origin gets nothing.
  return `(function () {
  var sent = false;
  var msg = ${scriptJson(message)};
  var expectedHost = ${scriptJson(site.host)};
  var expectedPort = ${scriptJson(site.port || '')};
  var isLocal = expectedHost === 'localhost';
  function originOk(origin) {
    var u;
    try { u = new URL(origin); } catch (e) { return false; }
    if (u.origin !== origin) return false;
    if (u.hostname !== expectedHost) return false;
    if (u.protocol !== 'https:' && !(isLocal && u.protocol === 'http:')) return false;
    if (isLocal) return expectedPort === '' || u.port === expectedPort;
    return u.port === '';
  }
  window.addEventListener('message', function (e) {
    if (sent || !window.opener || e.source !== window.opener) return;
    if (e.data !== 'authorizing:github') return;
    if (!originOk(e.origin)) return;
    sent = true;
    window.opener.postMessage(msg, e.origin);
    setTimeout(function () { try { window.close(); } catch (err) {} }, 500);
  });
  if (window.opener) window.opener.postMessage('authorizing:github', '*');
})();`;
}

function callbackHtml(message, site) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authenticating…</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:2rem;color:#34322e;">
<p>Authentication complete. You can close this window.</p>
<script>
${callbackScript(message, site)}
</script>
</body></html>`;
}
