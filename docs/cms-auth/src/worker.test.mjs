// Tests for the docs CMS OAuth relay. Run: node --test docs/cms-auth/src/worker.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker, { callbackScript, parseSite, OAUTH_SCOPE, STATE_COOKIE } from './worker.js';

const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret-for-tests' };
const BASE = 'https://cms-auth.example.workers.dev';
const realFetch = globalThis.fetch;
const realNow = Date.now.bind(Date);

afterEach(() => {
  globalThis.fetch = realFetch;
});

function cookieFrom(res) {
  const set = res.headers.get('Set-Cookie') || '';
  const m = set.match(new RegExp(`^${STATE_COOKIE}=([^;]*)`));
  return m ? m[1] : null;
}

async function startLogin(siteId = 'docs.beeflow.ai', env = ENV) {
  const res = await worker.fetch(new Request(`${BASE}/auth?provider=github&site_id=${encodeURIComponent(siteId)}`), env);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('Location'));
  return { res, location, state: location.searchParams.get('state'), cookie: cookieFrom(res) };
}

function callback(query, cookie, env = ENV) {
  const headers = cookie ? { Cookie: `other=1; ${STATE_COOKIE}=${cookie}` } : {};
  return worker.fetch(new Request(`${BASE}/callback?${query}`, { headers }), env);
}

function mockGitHub(body = { access_token: 'gho_TESTTOKEN' }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

// -- /auth -------------------------------------------------------------------

test('/auth refuses a missing site_id', async () => {
  const res = await worker.fetch(new Request(`${BASE}/auth?provider=github`), ENV);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Set-Cookie'), null);
});

test('/auth refuses a site_id that is not allow-listed, including look-alikes and subdomains', async () => {
  for (const siteId of [
    'evil.example',
    'https://evil.example',
    'docs.beeflow.ai.evil.example',
    'evil.docs.beeflow.ai',
    'x.beeflow.nl',
    'docs.beeflow.ai:8443',
    'https://evil.example/?docs.beeflow.ai',
  ]) {
    const res = await worker.fetch(new Request(`${BASE}/auth?site_id=${encodeURIComponent(siteId)}`), ENV);
    assert.equal(res.status, 403, siteId);
  }
});

test('/auth redirects to GitHub with the narrow scope, a state, and a matching HttpOnly cookie', async () => {
  const { res, location, state, cookie } = await startLogin();
  assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(location.searchParams.get('scope'), 'public_repo');
  assert.equal(OAUTH_SCOPE, 'public_repo');
  assert.equal(location.searchParams.get('redirect_uri'), `${BASE}/callback`);
  assert.match(state, /^[0-9a-f-]{36}$/);
  assert.ok(cookie);
  const set = res.headers.get('Set-Cookie');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) {
    assert.ok(set.includes(attr), `${attr} in ${set}`);
  }
});

test('STATE_TTL_SECONDS sets the cookie lifetime; 0 means no time limit', async () => {
  const a = await startLogin('docs.beeflow.ai', { ...ENV, STATE_TTL_SECONDS: '120' });
  assert.ok(a.res.headers.get('Set-Cookie').includes('Max-Age=120'));
  const b = await startLogin('docs.beeflow.ai', { ...ENV, STATE_TTL_SECONDS: '0' });
  assert.ok(!b.res.headers.get('Set-Cookie').includes('Max-Age'));
  mockGitHub();
  const res = await callback(`code=c&state=${b.state}`, b.cookie, { ...ENV, STATE_TTL_SECONDS: '0' });
  assert.equal(res.status, 200);
});

test('parseSite accepts the shapes Sveltia and Decap send', () => {
  assert.deepEqual(parseSite('docs.beeflow.ai'), { host: 'docs.beeflow.ai', port: '' });
  assert.deepEqual(parseSite('https://bee-flow.github.io/docs/'), { host: 'bee-flow.github.io', port: '' });
  assert.deepEqual(parseSite('localhost:3000'), { host: 'localhost', port: '3000' });
  assert.deepEqual(parseSite('localhost'), { host: 'localhost', port: '' });
  assert.equal(parseSite(''), null);
  assert.equal(parseSite(null), null);
});

// -- /callback ---------------------------------------------------------------

test('/callback without the state cookie is refused before any code exchange', async () => {
  const calls = mockGitHub();
  const { state } = await startLogin();
  const res = await callback(`code=c&state=${state}`, null);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('/callback with a state that does not match the cookie is refused', async () => {
  const calls = mockGitHub();
  const { cookie } = await startLogin();
  const other = await startLogin();
  const res = await callback(`code=c&state=${other.state}`, cookie);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('/callback with a tampered or foreign-signed cookie is refused', async () => {
  const calls = mockGitHub();
  const { state, cookie } = await startLogin();
  const [body, sig] = cookie.split('.');
  const tampered = `${body.slice(0, -2)}AA.${sig}`;
  assert.equal((await callback(`code=c&state=${state}`, tampered)).status, 400);
  const foreign = await startLogin('docs.beeflow.ai', { ...ENV, GITHUB_CLIENT_SECRET: 'another-secret' });
  assert.equal((await callback(`code=c&state=${foreign.state}`, foreign.cookie)).status, 400);
  assert.equal(calls.length, 0);
});

test('/callback with an expired state is refused', async (t) => {
  const calls = mockGitHub();
  const { state, cookie } = await startLogin('docs.beeflow.ai', { ...ENV, STATE_TTL_SECONDS: '60' });
  t.mock.method(Date, 'now', () => realNow() + 61_000);
  const res = await callback(`code=c&state=${state}`, cookie);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('/callback with a valid state exchanges the code once and burns the cookie', async () => {
  const calls = mockGitHub();
  const { state, cookie } = await startLogin();
  const res = await callback(`code=thecode&state=${state}`, cookie);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).code, 'thecode');
  assert.match(res.headers.get('Set-Cookie'), new RegExp(`^${STATE_COOKIE}=;.*Max-Age=0`));
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const page = await res.text();
  assert.ok(!page.includes("postMessage(msg, '*')"));
  assert.ok(!/setTimeout\(\s*send/.test(page));
});

// -- the callback page script --------------------------------------------------

function runPage(site, message = 'authorization:github:success:{"token":"gho_X","provider":"github"}') {
  const posted = [];
  const listeners = [];
  const opener = {
    postMessage(data, target) {
      posted.push({ data, target });
    },
  };
  const window = {
    opener,
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    close() {},
  };
  vm.runInNewContext(callbackScript(message, site), {
    window,
    URL,
    setTimeout: () => 0,
  });
  const dispatch = (origin, data = 'authorizing:github', source = opener) => {
    for (const fn of listeners) fn({ origin, data, source });
  };
  const tokens = () => posted.filter((p) => p.data.startsWith('authorization:'));
  return { posted, dispatch, tokens };
}

test('the page announces the handshake without the token and sends nothing unasked', () => {
  const { posted, tokens } = runPage({ host: 'docs.beeflow.ai', port: '' });
  assert.deepEqual(posted, [{ data: 'authorizing:github', target: '*' }]);
  assert.equal(tokens().length, 0);
});

test('the page posts the token only to the exact allow-listed origin', () => {
  const p = runPage({ host: 'docs.beeflow.ai', port: '' });
  for (const origin of [
    'https://evil.example',
    'http://docs.beeflow.ai',
    'https://docs.beeflow.ai:8443',
    'https://docs.beeflow.ai.evil.example',
    'https://evil.docs.beeflow.ai',
    'null',
  ]) {
    p.dispatch(origin);
  }
  p.dispatch('https://docs.beeflow.ai', 'something-else');
  p.dispatch('https://docs.beeflow.ai', 'authorizing:github', { not: 'the opener' });
  assert.equal(p.tokens().length, 0);

  p.dispatch('https://docs.beeflow.ai');
  assert.deepEqual(p.tokens().map((t) => t.target), ['https://docs.beeflow.ai']);
  p.dispatch('https://docs.beeflow.ai');
  assert.equal(p.tokens().length, 1, 'sent once');
});

test('a site bound to bee-flow.github.io does not accept docs.beeflow.ai', () => {
  const p = runPage({ host: 'bee-flow.github.io', port: '' });
  p.dispatch('https://docs.beeflow.ai');
  assert.equal(p.tokens().length, 0);
  p.dispatch('https://bee-flow.github.io');
  assert.equal(p.tokens()[0].target, 'https://bee-flow.github.io');
});

test('localhost accepts http and the bound port only', () => {
  const p = runPage({ host: 'localhost', port: '3000' });
  p.dispatch('http://localhost:4000');
  p.dispatch('http://127.0.0.1:3000');
  assert.equal(p.tokens().length, 0);
  p.dispatch('http://localhost:3000');
  assert.equal(p.tokens()[0].target, 'http://localhost:3000');
});

test('a value with </script> cannot break out of the page script', () => {
  const src = callbackScript('authorization:github:error:{"message":"</script><script>alert(1)"}', {
    host: 'docs.beeflow.ai',
    port: '',
  });
  assert.ok(!src.includes('</script>'));
});
