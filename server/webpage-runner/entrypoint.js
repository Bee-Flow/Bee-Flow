/**
 * Webpage full-tier runner entrypoint (runs INSIDE the per-project container).
 *
 * 1. Install the project's npm deps (if it ships a package.json).
 * 2. Start an optional custom Node backend (server.js) alongside the dev server.
 * 3. Serve the project with the project's own `dev` script, else our Vite.
 *
 * The container is disposable; /project is a bind-mount hydrated from RustFS by
 * the runtime manager. Resource/security limits are enforced by the daemon
 * (Memory/CPU/PID caps, no-new-privileges, cap-drop, isolated network).
 */

const fs = require('fs');
const { spawn } = require('child_process');

const PROJECT = '/project';
const RUNNER = '/runner';
const PORT = process.env.PORT || '5173';
// Bounds a hanging `npm install` (broken registry, slow network, a package
// stuck in an install-script loop) explicitly rather than relying only on the
// runtime manager's outer READY_TIMEOUT_MS — that timeout covers the WHOLE
// startup sequence (install + dev-server boot), so a slow install could eat
// the entire budget and get the container killed right as Vite was about to
// come up. Overridable per-image build via INSTALL_TIMEOUT_MS.
const INSTALL_TIMEOUT_MS = parseInt(process.env.INSTALL_TIMEOUT_MS, 10) || 120_000;

function run(cmd, args, { timeoutMs } = {}) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: 'inherit', cwd: PROJECT });
        let timedOut = false;
        const timer = timeoutMs ? setTimeout(() => {
            timedOut = true;
            console.error(`[runner] ${cmd} ${args.join(' ')} exceeded ${timeoutMs}ms — killing`);
            p.kill('SIGKILL');
        }, timeoutMs) : null;
        p.on('exit', (code) => { if (timer) clearTimeout(timer); resolve(timedOut ? 124 : (code ?? 0)); });
        p.on('error', (e) => { if (timer) clearTimeout(timer); console.error(`[runner] spawn error: ${cmd}: ${e.message}`); resolve(1); });
    });
}

function readPkg() {
    try { return JSON.parse(fs.readFileSync(`${PROJECT}/package.json`, 'utf8')); }
    catch { return null; }
}

(async () => {
    const pkg = readPkg();

    // 1. Install deps (best-effort — a failed/timed-out install falls through
    // to the dev-server step, which will fail loudly and diagnosably if deps
    // are actually missing). --ignore-scripts skips pre/post-install hooks:
    // arbitrary npm packages can run any script here, and this container has
    // no reason to execute one (native rebuilds aside — projects needing those
    // aren't the light-editor use case this tier targets).
    if (pkg) {
        console.log('[runner] installing project dependencies…');
        const code = await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { timeoutMs: INSTALL_TIMEOUT_MS });
        if (code !== 0) console.error(`[runner] npm install exited ${code} — continuing best-effort`);
    }

    // 2. Optional custom backend.
    if (fs.existsSync(`${PROJECT}/server.js`)) {
        console.log('[runner] starting project server.js');
        const srv = spawn('node', ['server.js'], { stdio: 'inherit', cwd: PROJECT });
        srv.on('error', (e) => console.error('[runner] server.js error:', e.message));
    }

    // 3. Dev server — prefer the project's own `dev` script.
    const hasDevScript = !!(pkg?.scripts?.dev);
    if (hasDevScript) {
        console.log('[runner] npm run dev');
        await run('npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', PORT]);
    } else {
        const hasOwnConfig = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts']
            .some((f) => fs.existsSync(`${PROJECT}/${f}`));
        const cfgArgs = hasOwnConfig ? [] : ['--config', `${RUNNER}/vite.config.js`];
        console.log('[runner] starting Vite dev server');
        await run('node', [`${RUNNER}/node_modules/vite/bin/vite.js`, '--host', '0.0.0.0', '--port', PORT, ...cfgArgs]);
    }

    console.log('[runner] dev server exited');
    process.exit(0);
})();
