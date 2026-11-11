/**
 * beeflow-install.sh, the installer an administrator runs on the Docker host:
 * install, update and pairing-code mode, without Docker and without the network.
 *
 * Each case gets a directory of its own with stubs first on PATH (docker,
 * curl, and the few system commands whose answer a case steers) and fixture
 * releases served from disk (BEEFLOW_API_BASE, BEEFLOW_DOWNLOAD_BASE and
 * BEEFLOW_RAW_BASE as file:// addresses). The `selfhost.sh` of a fixture
 * release is a stub too: it records how it was called and, on a first run,
 * makes the settings file from the template the way the real one does.
 *
 * Steering, through the environment of a run:
 *   STUB_UPGRADE_FAILS   1: `selfhost.sh --upgrade` fails before the server changed,
 *                        late: after it changed
 *   STUB_EXEC_STATUS     exit status of `docker exec` (the pairing code request)
 *   STUB_EXEC_NOT_READY  that many `docker exec` calls refuse the sign-in first
 *   STUB_HEALTH          health a sidecar container reports (default healthy)
 *   STUB_ARCH, STUB_UID, STUB_DF_KB   what uname -m, id -u and df answer
 *
 * Run: node --test scripts/beeflow-install.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, hasBash } from './lib/docker-stub.mjs';

const SCRIPT = path.join(REPO, 'beeflow-install.sh');
// OLD is a release from before the checksums: its files are in the repository only.
const OLD = 'v2026.11.01.1';
const NEW = 'v2026.11.10.3';
const RELEASE_FILES = ['selfhost.sh', 'docker-compose.from-registry.yml', '.env.selfhost.example'];
const opts = { skip: !hasBash && 'needs bash' };
const escaped = (text) => text.replaceAll('.', '\\.');

const STUBS = {
    // Records the call. `exec` is the pairing code request; `inspect` answers
    // the health of a sidecar or the image of the server container.
    docker: `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
case "\${1:-} $*" in
    exec*)
        cat >/dev/null
        if [ -n "\${STUB_EXEC_NOT_READY:-}" ]; then
            n=$(( $(cat "$STUB_STATE/exec-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_STATE/exec-count"
            if [ "$n" -le "$STUB_EXEC_NOT_READY" ]; then echo 'sign-in as admin answered 401' >&2; exit 3; fi
        fi
        if [ "\${STUB_EXEC_STATUS:-0}" != 0 ]; then echo 'sign-in as admin answered 401' >&2; exit "$STUB_EXEC_STATUS"; fi
        echo ABCD-1234 ;;
    inspect*Health*) echo "\${STUB_HEALTH:-healthy}" ;;
    inspect*Config.Image*) [ -f "$STUB_STATE/image" ] || exit 1; cat "$STUB_STATE/image" ;;
esac
exit 0
`,
    // file:// addresses are read from disk, the health check on 127.0.0.1
    // succeeds, and any other address fails: a test never reaches the network.
    curl: `#!/usr/bin/env bash
out=''; url=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift ;;
        -*) ;;
        *) url="$1" ;;
    esac
    shift
done
printf 'curl %s\\n' "$url" >> "$STUB_LOG"
case "$url" in
    http://127.0.0.1:*) exit 0 ;;
    file://*) file="\${url#file://}"; file="\${file%%\\?*}"; [ -f "$file" ] || exit 22
        if [ -n "$out" ]; then cat "$file" > "$out"; else cat "$file"; fi ;;
    *) exit 7 ;;
esac
`,
    uname: '#!/usr/bin/env bash\necho "${STUB_ARCH:-x86_64}"\n',
    id: '#!/usr/bin/env bash\necho "${STUB_UID:-1000}"\n',
    sleep: '#!/usr/bin/env bash\nexit 0\n',
    chown: '#!/usr/bin/env bash\nprintf \'chown %s\\n\' "$*" >> "$STUB_LOG"\n',
    df: '#!/usr/bin/env bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/x 100 1 ${STUB_DF_KB:-99999999} 1% /"\n',
};

/** The selfhost.sh of a fixture release. */
const selfhostStub = (tag) => `#!/usr/bin/env bash
# release ${tag}
set -euo pipefail
ENV_FILE=".env\${STACK_NAME:+.$STACK_NAME}"
printf 'selfhost [%s] PROFILES=%s STACK_NAME=%s\\n' "$*" "\${PROFILES:-}" "\${STACK_NAME:-}" >> "$STUB_LOG"
if [ "$#" -eq 0 ] && [ ! -f "$ENV_FILE" ]; then
    cp .env.selfhost.example "$ENV_FILE"
    echo 'INIT_ADMIN_PASSWORD=first-sign-in' >> "$ENV_FILE"
fi
running() { echo "ghcr.io/bee-flow/server:$(grep '^TAG=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)" > "$STUB_STATE/image"; }
if [ "\${1:-}" = --upgrade ]; then
    if [ "\${STUB_UPGRADE_FAILS:-}" = 1 ]; then echo 'pull failed' >&2; exit 1; fi
    running
    if [ "\${STUB_UPGRADE_FAILS:-}" = late ]; then echo 'not healthy' >&2; exit 1; fi
else
    running
fi
exit 0
`;

const release = (tag, flags = {}) => ({ url: `https://api.example/${tag}`, author: { login: 'x', site_admin: false }, tag_name: tag, name: `Bee Flow, ${tag}`, draft: false, prerelease: false, assets: [{ name: 'selfhost.sh', state: 'uploaded' }], body: 'Notes with "tag_name": "v9999.1.1", "draft": false, "prerelease": false in them', ...flags });
/** Newest first, as GitHub lists them. Only NEW and OLD are published product releases. */
const LISTING = [
    release('android-2026.11.11'),
    release('v2097.1.1', { draft: true }),
    release('v2098.1.1', { prerelease: true }),
    release(OLD),
    release(NEW),
];

function writeRelease(dir, tag) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'selfhost.sh'), selfhostStub(tag));
    fs.writeFileSync(path.join(dir, 'docker-compose.from-registry.yml'), `# compose of ${tag}\n`);
    fs.writeFileSync(path.join(dir, '.env.selfhost.example'), `# template of ${tag}\nTAG=latest\nSERVER_PORT=3001\nDB_PASSWORD=CHANGE_ME\n`);
}

/** A directory with the stubs and the fixture releases. */
function world(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-install-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'bin'));
    for (const [name, text] of Object.entries(STUBS)) fs.writeFileSync(path.join(dir, 'bin', name), text, { mode: 0o755 });

    writeRelease(path.join(dir, 'raw', 'Bee-Flow', 'Bee-Flow', OLD), OLD);
    const assets = path.join(dir, 'download', NEW);
    writeRelease(assets, NEW);
    fs.writeFileSync(path.join(assets, 'beeflow-install.sh'), '# the installer of this release\n');
    const sums = [...RELEASE_FILES, 'beeflow-install.sh'].map((file) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(assets, file))).digest('hex')}  ${file}\n`);
    fs.writeFileSync(path.join(assets, 'SHA256SUMS'), sums.join(''));

    const api = path.join(dir, 'api', 'repos', 'Bee-Flow', 'Bee-Flow');
    fs.mkdirSync(api, { recursive: true });
    fs.writeFileSync(path.join(api, 'releases'), JSON.stringify(LISTING, null, 2));
    fs.writeFileSync(path.join(dir, 'meminfo'), 'MemTotal:       64000000 kB\nMemAvailable:   48000000 kB\n');
    fs.mkdirSync(path.join(dir, 'home'));
    return dir;
}

/** Run the installer in `dir` with the stubs first on PATH; `log` is what the stubs recorded. */
function run(dir, args, env = {}) {
    const logFile = path.join(dir, 'stub.log');
    fs.rmSync(logFile, { force: true });
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BEEFLOW_') && !k.startsWith('STUB_') && k !== 'STACK_NAME' && k !== 'PROFILES'));
    const res = spawnSync('bash', [SCRIPT, ...args], {
        cwd: dir,
        encoding: 'utf8',
        // Standard input is not a terminal.
        input: '',
        env: {
            ...base,
            PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`,
            HOME: path.join(dir, 'home'),
            STUB_LOG: logFile,
            STUB_STATE: dir,
            BEEFLOW_API_BASE: `file://${path.join(dir, 'api')}`,
            BEEFLOW_DOWNLOAD_BASE: `file://${path.join(dir, 'download')}`,
            BEEFLOW_RAW_BASE: `file://${path.join(dir, 'raw')}`,
            BEEFLOW_MEMINFO: path.join(dir, 'meminfo'),
            // No terminal unless a case gives its answers file.
            BEEFLOW_TTY: path.join(dir, 'no-terminal'),
            ...env,
        },
    });
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
    return { status: res.status, out: res.stdout + res.stderr, log };
}

/** Ports nothing listens on. */
async function freePorts(count = 4) {
    const servers = Array.from({ length: count }, () => net.createServer());
    const ports = [];
    for (const server of servers) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        ports.push(String(server.address().port));
    }
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    return ports;
}

/** An unattended install with its answers in the environment. */
async function install(dir, env = {}, args = ['--yes']) {
    const [serverPort, clientPort, ...sidecarPorts] = await freePorts();
    const res = run(dir, args, {
        BEEFLOW_HOST: '192.168.1.20', BEEFLOW_SERVER_PORT: serverPort, BEEFLOW_CLIENT_PORT: clientPort,
        // The real ones (8100, 8300) may be taken on the machine the tests run on.
        BEEFLOW_SIDECAR_PORTS: sidecarPorts.join(' '),
        ...env,
    });
    return { ...res, serverPort, clientPort };
}

/** An install of `version` made by the installer. */
async function installed(t, version = OLD, env = {}) {
    const dir = world(t);
    const res = await install(dir, { BEEFLOW_VERSION: version, ...env });
    assert.strictEqual(res.status, 0, res.out);
    return dir;
}

const read = (dir, ...rel) => fs.readFileSync(path.join(dir, ...rel), 'utf8');
const exists = (dir, ...rel) => fs.existsSync(path.join(dir, ...rel));
const selfhostCalls = (log) => log.filter((line) => line.startsWith('selfhost '));
const shows = (res, ...texts) => { for (const text of texts) assert.ok(res.out.includes(text), `${text} in:\n${res.out}`); };
const stopped = (res, ...texts) => { assert.notStrictEqual(res.status, 0, res.out); shows(res, ...texts); };

// ── The script itself ────────────────────────────────────────────────────

test('the script is valid shell and --help prints the usage', opts, () => {
    const checked = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(checked.status, 0, checked.stderr);
    const help = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.strictEqual(help.status, 0);
    for (const word of ['update', 'pairing-code', '--yes', 'BEEFLOW_HOST', 'BEEFLOW_STACK_NAME']) assert.ok(help.stdout.includes(word), word);
});

test('the script never removes data, never makes a secret and looks up no address of its own', opts, () => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    for (const word of ['--uninstall', '--down', 'docker volume', 'rm -rf', 'openssl', 'urandom', 'hostname -I', 'ip addr', 'ip route', 'releases/latest', 'jq ']) {
        assert.ok(!text.includes(word), `${word} is not part of the script`);
    }
});

// ── Install ──────────────────────────────────────────────────────────────

test('an unattended install checks the files, writes the answers into the template and runs selfhost.sh', opts, async (t) => {
    const dir = world(t);
    const res = await install(dir, { BEEFLOW_ORGANISATION: 'Acme BV' });
    assert.strictEqual(res.status, 0, res.out);

    const template = read(dir, 'beeflow', '.env.selfhost.example').split('\n');
    for (const line of [
        `TAG=${NEW}`, `SERVER_PORT=${res.serverPort}`, `CLIENT_PORT=${res.clientPort}`,
        'SERVER_PROTOCOL=http', 'CLIENT_PROTOCOL=http',
        `SERVER_PUBLIC_HOST=192.168.1.20:${res.serverPort}`, `CLIENT_PUBLIC_HOST=192.168.1.20:${res.clientPort}`,
        'SERVER_BIND_HOST=0.0.0.0', 'CLIENT_BIND_HOST=0.0.0.0', 'NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1',
    ]) assert.ok(template.includes(line), `${line} in:\n${template.join('\n')}`);
    assert.ok(!template.includes('TAG=latest') && !template.includes('SERVER_PORT=3001'), 'a setting is there once');
    assert.ok(template.includes('DB_PASSWORD=CHANGE_ME'), 'the secrets are left to selfhost.sh');

    assert.deepStrictEqual(selfhostCalls(res.log), ['selfhost [] PROFILES=core guard classify STACK_NAME=']);
    assert.ok(res.log.some((line) => line.startsWith('curl ') && line.includes('/releases?per_page=30')), 'the releases are listed');
    assert.ok(res.log.includes(`curl http://127.0.0.1:${res.serverPort}/api/health`), 'it checks the server');
    for (const name of ['beeflow-guard', 'beeflow-classify']) {
        assert.ok(res.log.some((line) => line.startsWith('docker inspect') && line.endsWith(name)), `it waits for ${name}`);
    }
    assert.ok(res.log.some((line) => line.startsWith('docker exec -i') && line.includes(`BF_ORIGIN=http://192.168.1.20:${res.clientPort}`) && line.endsWith('beeflow-server node -')), 'the pairing code is made in the server container');
    assert.ok(!res.log.some((line) => line.startsWith('chown')), 'not root: nothing changes owner');
    shows(res,
        `The files match the checksums of release ${NEW}`,
        `Bee Flow ${NEW} is installed. The addresses to use from Nextcloud`,
        `Server URL:    http://192.168.1.20:${res.serverPort}`, `Web app URL:   http://192.168.1.20:${res.clientPort}`,
        'Pairing code:  ABCD-1234', 'admin / first-sign-in');
    assert.doesNotMatch(res.out, /Warning/);
    assert.ok(!exists(dir, 'beeflow', '.beeflow-download'), 'the download directory is gone');
});

test('the choices: an older release tag, no sidecars, a public Nextcloud, a named stack, no organisation', opts, async (t) => {
    const dir = world(t);
    const res = await install(dir, {}, ['--yes', '--version', OLD, '--no-sidecars', '--public-nextcloud', '--stack-name', 'internal', '--dir', 'second']);
    assert.strictEqual(res.status, 0, res.out);
    const template = read(dir, 'second', '.env.selfhost.example');
    assert.match(template, new RegExp(`^TAG=${escaped(OLD)}$`, 'm'));
    assert.doesNotMatch(template, /NEXTCLOUD_ALLOW_PRIVATE_HOSTS/);
    assert.deepStrictEqual(selfhostCalls(res.log), Array(2).fill('selfhost [] PROFILES=core STACK_NAME=internal'), 'a named stack starts on the second run');
    assert.ok(exists(dir, 'second', '.env.internal'));
    assert.ok(!res.log.some((line) => line.startsWith('docker exec')), 'no organisation, no pairing code');
    assert.ok(!res.log.some((line) => line.startsWith('docker inspect')), 'no sidecars to wait for');
    assert.ok(!res.log.some((line) => line.includes('/releases?')), 'a given tag is not looked up');
    shows(res, `Release ${OLD} carries no checksums`, 'could NOT be checked', 'STACK_NAME=internal ./selfhost.sh --logs');
});

test('questions are asked on the terminal, and asked again after an answer that cannot be used', opts, async (t) => {
    const dir = world(t);
    const [serverPort, clientPort] = await freePorts(2);
    const answers = path.join(dir, 'answers');
    // host (refused twice), server port, web app port (refused: the same), directory,
    // version, sidecars, private Nextcloud, organisation, continue.
    fs.writeFileSync(answers, ['localhost', 'http://x', 'BeeFlow.Example.com', serverPort, serverPort, clientPort, '', '', 'n', '', '', ''].join('\n') + '\n');
    const res = run(dir, [], { BEEFLOW_TTY: answers });
    assert.strictEqual(res.status, 0, res.out);
    shows(res, 'localhost points at the Nextcloud container itself', 'no http://, no port', 'two different ports', 'Install directory [./beeflow]', 'Version (a release tag) [newest production release]', 'Continue? [Y/n]');
    assert.ok(read(dir, 'beeflow', '.env.selfhost.example').includes(`SERVER_PUBLIC_HOST=beeflow.example.com:${serverPort}`), 'a host name is lower case');
    assert.deepStrictEqual(selfhostCalls(res.log), ['selfhost [] PROFILES=core STACK_NAME=']);
});

test('without a terminal and without --yes the install stops before it does anything', opts, (t) => {
    const dir = world(t);
    const res = run(dir, [], { BEEFLOW_HOST: '192.168.1.20' });
    stopped(res, 'no terminal to ask on');
    assert.deepStrictEqual(res.log, []);
    assert.ok(!exists(dir, 'beeflow'));
});

test('an answer that is not a plain value is refused', opts, (t) => {
    const dir = world(t);
    const refused = (env) => {
        const res = run(dir, ['--yes'], { BEEFLOW_HOST: '192.168.1.20', ...env });
        stopped(res, `${Object.keys(env)[0]}:`);
        assert.deepStrictEqual(res.log, [], 'nothing was run');
    };
    for (const host of ['', 'a;rm -rf /', '$(id)', '`id`', 'a b', "a'b", 'http://x', 'x:3001', '-x.example', 'x..y', 'localhost', '127.0.0.1', '::1']) refused({ BEEFLOW_HOST: host });
    for (const port of ['0', '65536', '30 01', '3001;id', '-1', 'abc']) refused({ BEEFLOW_SERVER_PORT: port });
    refused({ BEEFLOW_CLIENT_PORT: '5000', BEEFLOW_SERVER_PORT: '5000' });
    for (const d of ['../x', 'a/../b', '$(id)', 'a b', "a'b", 'a;b', 'x~y', '~/a/~b']) refused({ BEEFLOW_DIR: d });
    for (const version of ['main', 'v1;id', 'v$(id)', '1.2.3']) refused({ BEEFLOW_VERSION: version });
    for (const organisation of ["Acme'; id", 'a$b', 'a`b`', 'x'.repeat(81)]) refused({ BEEFLOW_ORGANISATION: organisation });
    for (const stack of ['Internal', '-x', 'a b', 'beeflow', 'a;b']) refused({ BEEFLOW_STACK_NAME: stack });
    for (const flag of ['maybe', '2']) refused({ BEEFLOW_SIDECARS: flag });
    assert.ok(!exists(dir, 'beeflow'));
});

test('an existing settings file stops the install and points at update, before any port is looked at', opts, async (t) => {
    const dir = world(t);
    fs.mkdirSync(path.join(dir, 'beeflow'));
    fs.writeFileSync(path.join(dir, 'beeflow', '.env'), `TAG=${OLD}\n`);
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    t.after(() => holder.close());
    const res = await install(dir, { BEEFLOW_SERVER_PORT: String(holder.address().port) });
    stopped(res, 'already installed here', 'beeflow-install.sh update');
    assert.doesNotMatch(res.out, /already in use/);
    assert.deepStrictEqual(res.log, []);
    assert.strictEqual(read(dir, 'beeflow', '.env'), `TAG=${OLD}\n`);
});

test('a taken port stops the install before anything is downloaded or started', opts, async (t) => {
    const dir = world(t);
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    t.after(() => holder.close());
    const taken = String(holder.address().port);
    const [free] = await freePorts(1);

    const sidecar = await install(dir, { BEEFLOW_SIDECAR_PORTS: `${free} ${taken}` });
    stopped(sidecar, `Port ${taken} is already in use`, 'probably another Bee Flow on this machine', '--no-sidecars', 'https://docs.beeflow.ai/self-hosting/multi-stack');
    const server = await install(dir, { BEEFLOW_SERVER_PORT: taken });
    stopped(server, `Port ${taken} is already in use`);
    for (const res of [sidecar, server]) assert.deepStrictEqual(res.log.filter((line) => !line.startsWith('docker ')), [], 'only the docker checks ran');
    assert.ok(!exists(dir, 'beeflow'));

    const without = await install(dir, { BEEFLOW_SIDECAR_PORTS: taken, BEEFLOW_SIDECARS: '0' });
    assert.strictEqual(without.status, 0, without.out);
});

test('another CPU architecture stops the install; little memory or disk is a warning', opts, async (t) => {
    const dir = world(t);
    const arm = await install(dir, { STUB_ARCH: 'aarch64' });
    stopped(arm, 'This machine is aarch64', 'x86-64 (amd64) only');
    assert.ok(!exists(dir, 'beeflow'));

    // 8 GB free is enough for the core stack, not with the guard and the classifier.
    fs.writeFileSync(path.join(dir, 'meminfo'), 'MemTotal:       16000000 kB\nMemAvailable:    8388608 kB\n');
    const small = await install(dir, { STUB_DF_KB: String(5 * 1024 * 1024) });
    assert.strictEqual(small.status, 0, small.out);
    shows(small, 'About 8 GB of memory is free; this install wants about 11 GB', 'About 5 GB of disk is free', 'at least 10 GB');
    const core = await install(dir, { BEEFLOW_SIDECARS: '0', BEEFLOW_DIR: 'core' });
    assert.strictEqual(core.status, 0, core.out);
    assert.doesNotMatch(core.out, /memory is free/);
});

test('files that do not match the checksums of their release are not used', opts, async (t) => {
    const dir = world(t);
    fs.appendFileSync(path.join(dir, 'download', NEW, 'selfhost.sh'), '# changed on the way\n');
    const res = await install(dir);
    stopped(res, `do not match its checksums`);
    assert.deepStrictEqual(selfhostCalls(res.log), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'beeflow')), [], 'nothing of the download is left');

    // Checksums that leave one of the three files out are no check.
    const sums = path.join(dir, 'download', NEW, 'SHA256SUMS');
    fs.writeFileSync(sums, read(dir, 'download', NEW, 'SHA256SUMS').split('\n').filter((line) => !line.endsWith(' selfhost.sh')).join('\n'));
    stopped(await install(dir), 'do not list selfhost.sh');
});

test('sidecars that do not become healthy are named in the summary, and the install still succeeds', opts, async (t) => {
    const dir = world(t);
    const res = await install(dir, { STUB_HEALTH: 'starting' });
    assert.strictEqual(res.status, 0, res.out);
    shows(res, 'Not ready yet: beeflow-guard beeflow-classify', `Bee Flow ${NEW} is installed`);
});

test('run as root, the components directory is handed to the user the server runs as', opts, async (t) => {
    const dir = world(t);
    const plain = await install(dir, { STUB_UID: '0' });
    assert.strictEqual(plain.status, 0, plain.out);
    assert.ok(plain.log.includes('chown -R 1000:1000 components'), plain.log.join('\n'));
    const named = await install(dir, { STUB_UID: '0', BEEFLOW_STACK_NAME: 'internal', BEEFLOW_DIR: 'second', BEEFLOW_SIDECARS: '0' });
    assert.strictEqual(named.status, 0, named.out);
    assert.ok(named.log.includes('chown -R 1000:1000 components.internal'), named.log.join('\n'));
});

// ── Pairing code ─────────────────────────────────────────────────────────

test('a pairing code that could not be made is reported by the install, with what to do', opts, async (t) => {
    const dir = world(t);
    const refused = await install(dir, { BEEFLOW_ORGANISATION: 'Acme', STUB_EXEC_STATUS: '3' });
    assert.strictEqual(refused.status, 0, refused.out);
    shows(refused, 'Pairing code:  NOT MADE', 'refused the sign-in as admin', 'Admin dashboard -> Organisation -> Nextcloud Sync -> Pair a new Nextcloud', 'beeflow-install.sh pairing-code');
    const failed = await install(dir, { BEEFLOW_ORGANISATION: 'Acme', STUB_EXEC_STATUS: '1', BEEFLOW_DIR: 'other' });
    assert.strictEqual(failed.status, 0, failed.out);
    shows(failed, 'Pairing code:  NOT MADE', 'could not be made (sign-in as admin answered 401)');
});

test('the install waits for a server that refuses the first sign-in because it is still starting', opts, async (t) => {
    const dir = world(t);
    const res = await install(dir, { BEEFLOW_ORGANISATION: 'Acme', STUB_EXEC_NOT_READY: '2' });
    assert.strictEqual(res.status, 0, res.out);
    shows(res, 'Pairing code:  ABCD-1234');
    assert.strictEqual(res.log.filter((l) => l.startsWith('docker exec')).length, 3, res.log.join('\n'));
});

test('pairing-code prints a fresh code for an organisation of an existing install', opts, async (t) => {
    const dir = await installed(t, NEW, { BEEFLOW_STACK_NAME: 'internal', BEEFLOW_SIDECARS: '0' });
    const settings = read(dir, 'beeflow', '.env.internal');
    const res = run(dir, ['pairing-code', '--yes', '--organisation', 'Acme BV', '--stack-name', 'internal']);
    assert.strictEqual(res.status, 0, res.out);
    shows(res, 'Pairing code for "Acme BV"', 'ABCD-1234');
    const exec = res.log.find((line) => line.startsWith('docker exec'));
    assert.match(exec, /BF_ORGANISATION=Acme BV/);
    assert.match(exec, /BF_PASSWORD=first-sign-in/);
    assert.match(exec, /BF_ORIGIN=http:\/\/192\.168\.1\.20:\d+ internal-server node -$/);
    assert.strictEqual(read(dir, 'beeflow', '.env.internal'), settings, 'the settings file is only read');
    assert.deepStrictEqual(selfhostCalls(res.log), []);
});

test('pairing-code says when the sign-in is refused, and needs an organisation and an install', opts, async (t) => {
    const dir = await installed(t, NEW);
    stopped(run(dir, ['pairing-code', '--yes', '--organisation', 'Acme'], { STUB_EXEC_STATUS: '3' }),
        'refused the sign-in as admin', 'a second factor', 'Make the code in the web app', 'Admin dashboard -> Organisation -> Nextcloud Sync -> Pair a new Nextcloud');
    stopped(run(dir, ['pairing-code', '--yes']), 'BEEFLOW_ORGANISATION is needed');
    stopped(run(dir, ['pairing-code', '--yes', '--organisation', 'Acme', '--dir', 'elsewhere']), 'elsewhere is not there');
});

// ── Update ───────────────────────────────────────────────────────────────

test('update to the version that already runs says so and runs nothing', opts, async (t) => {
    const dir = await installed(t);
    const before = read(dir, 'beeflow', '.env');
    const res = run(dir, ['update', '--yes', '--version', OLD]);
    assert.strictEqual(res.status, 0, res.out);
    shows(res, `already on ${OLD}`);
    assert.deepStrictEqual(selfhostCalls(res.log), []);
    assert.strictEqual(read(dir, 'beeflow', '.env'), before);
    assert.ok(!exists(dir, 'beeflow', 'selfhost.sh.previous'));
});

test('update to the newest release sets TAG, keeps the previous files and runs selfhost.sh --upgrade', opts, async (t) => {
    const dir = await installed(t);
    const envFile = path.join(dir, 'beeflow', '.env');
    fs.chmodSync(envFile, 0o600);
    const before = read(dir, 'beeflow', '.env').split('\n').filter((line) => line && !line.startsWith('TAG='));

    const res = run(dir, ['update', '--yes']);
    assert.strictEqual(res.status, 0, res.out);
    shows(res,
        `From:           ${OLD}   (server image: ghcr.io/bee-flow/server:${OLD})`, `To:             ${NEW}`,
        'https://github.com/Bee-Flow/Bee-Flow/releases', 'https://docs.beeflow.ai/self-hosting/upgrades',
        `The files match the checksums of release ${NEW}`, `Bee Flow is now on ${NEW}`, 'The Nextcloud connector needs nothing',
        `/${NEW}/beeflow-install.sh`);
    const after = read(dir, 'beeflow', '.env').split('\n').filter(Boolean);
    assert.deepStrictEqual(after, [...before, `TAG=${NEW}`], 'only the TAG line changed');
    assert.strictEqual((fs.statSync(envFile).mode & 0o777).toString(8), '600', 'the settings file keeps its mode');
    assert.ok(!exists(dir, 'beeflow', '.env.tmp') && !exists(dir, 'beeflow', '.beeflow-download'));
    for (const file of RELEASE_FILES) {
        assert.ok(read(dir, 'beeflow', file).includes(NEW), `${file} is the one of ${NEW}`);
        assert.ok(read(dir, 'beeflow', `${file}.previous`).includes(OLD), `${file}.previous is the one of ${OLD}`);
    }
    assert.ok(!exists(dir, 'beeflow', 'beeflow-install.sh'), 'the installer does not replace or fetch itself');
    assert.deepStrictEqual(selfhostCalls(res.log), ['selfhost [--upgrade] PROFILES= STACK_NAME=']);
});

test('the newest release is the highest published v tag, also in a listing on one line', opts, async (t) => {
    const dir = await installed(t);
    fs.writeFileSync(path.join(dir, 'api', 'repos', 'Bee-Flow', 'Bee-Flow', 'releases'), JSON.stringify(LISTING));
    const res = run(dir, ['update', '--yes']);
    assert.strictEqual(res.status, 0, res.out);
    shows(res, `To:             ${NEW}`);

    fs.writeFileSync(path.join(dir, 'api', 'repos', 'Bee-Flow', 'Bee-Flow', 'releases'), JSON.stringify(LISTING.filter((r) => !r.tag_name.startsWith('v2026')), null, 2));
    stopped(run(dir, ['update', '--yes']), 'Could not read the newest release');
});

test('update of a named stack reads its own settings file and exports STACK_NAME', opts, async (t) => {
    const dir = await installed(t, OLD, { BEEFLOW_STACK_NAME: 'internal' });
    const res = run(dir, ['update', '--yes', '--stack-name', 'internal']);
    assert.strictEqual(res.status, 0, res.out);
    assert.match(read(dir, 'beeflow', '.env.internal'), new RegExp(`^TAG=${escaped(NEW)}$`, 'm'));
    assert.ok(res.log.some((line) => line.startsWith('docker inspect internal-server')));
    assert.deepStrictEqual(selfhostCalls(res.log), ['selfhost [--upgrade] PROFILES= STACK_NAME=internal']);
});

test('update asks before it changes anything, and anything but yes stops', opts, async (t) => {
    const dir = await installed(t);
    const before = read(dir, 'beeflow', '.env');
    const answers = path.join(dir, 'answers');
    // directory, version, update now (Enter = no).
    fs.writeFileSync(answers, '\n\n\n');
    const res = run(dir, ['update'], { BEEFLOW_TTY: answers });
    stopped(res, `Update to ${NEW} now? [y/N]`, 'Nothing was changed');
    assert.deepStrictEqual(selfhostCalls(res.log), []);
    assert.strictEqual(read(dir, 'beeflow', '.env'), before);
    assert.ok(!exists(dir, 'beeflow', 'selfhost.sh.previous'));
});

test('update refuses a release older than the one in use', opts, async (t) => {
    const dir = await installed(t, NEW);
    const before = read(dir, 'beeflow', '.env');
    const res = run(dir, ['update', '--yes', '--version', OLD]);
    stopped(res, `This install is on ${NEW} and ${OLD} is older`, 'Rollback');
    assert.deepStrictEqual(selfhostCalls(res.log), []);
    assert.strictEqual(read(dir, 'beeflow', '.env'), before);
});

test('an install on a moving tag is told its version cannot be compared, and is pinned', opts, async (t) => {
    const dir = await installed(t);
    const envFile = path.join(dir, 'beeflow', '.env');
    fs.writeFileSync(envFile, read(dir, 'beeflow', '.env').replace(`TAG=${OLD}`, 'TAG=latest'));
    const answers = path.join(dir, 'answers');
    fs.writeFileSync(answers, '\n\nn\n');
    const declined = run(dir, ['update'], { BEEFLOW_TTY: answers });
    stopped(declined, 'From:           latest', 'follows a moving tag', `cannot be compared with ${NEW}`, `Updating pins it to ${NEW}`, 'Nothing was changed');
    assert.match(read(dir, 'beeflow', '.env'), /^TAG=latest$/m);

    const res = run(dir, ['update', '--yes']);
    assert.strictEqual(res.status, 0, res.out);
    assert.match(read(dir, 'beeflow', '.env'), new RegExp(`^TAG=${escaped(NEW)}$`, 'm'));
});

test('an upgrade that fails before the server changed is undone: TAG and the installer files are put back', opts, async (t) => {
    const dir = await installed(t);
    const before = read(dir, 'beeflow', '.env').split('\n').filter(Boolean).sort();
    const res = run(dir, ['update', '--yes'], { STUB_UPGRADE_FAILS: '1' });
    stopped(res, `the server still runs ghcr.io/bee-flow/server:${OLD}`, 'Nothing was changed');
    assert.doesNotMatch(res.out, /Bee Flow is now on|To go back/);
    assert.deepStrictEqual(read(dir, 'beeflow', '.env').split('\n').filter(Boolean).sort(), before);
    for (const file of RELEASE_FILES) {
        assert.ok(read(dir, 'beeflow', file).includes(OLD), `${file} is the one of ${OLD} again`);
        assert.ok(!exists(dir, 'beeflow', `${file}.previous`));
    }
    assert.deepStrictEqual(selfhostCalls(res.log), ['selfhost [--upgrade] PROFILES= STACK_NAME=']);
});

test('an upgrade that fails after the server changed prints the way back and exits non-zero', opts, async (t) => {
    const dir = await installed(t);
    const res = run(dir, ['update', '--yes'], { STUB_UPGRADE_FAILS: 'late' });
    stopped(res, 'To go back to the previous version', `TAG=${OLD}`, `the server image this install was on: ghcr.io/bee-flow/server:${OLD}`, '.previous', './selfhost.sh --upgrade');
    assert.doesNotMatch(res.out, /Bee Flow is now on|Nothing was changed/);
    assert.match(read(dir, 'beeflow', '.env'), new RegExp(`^TAG=${escaped(NEW)}$`, 'm'));
    assert.ok(read(dir, 'beeflow', 'selfhost.sh.previous').includes(OLD));
});

test('update stops when there is no install in the directory, or no selfhost.sh', opts, (t) => {
    const dir = world(t);
    stopped(run(dir, ['update', '--yes']), 'beeflow is not there');
    fs.mkdirSync(path.join(dir, 'beeflow'));
    stopped(run(dir, ['update', '--yes']), '.env is not there');
    fs.writeFileSync(path.join(dir, 'beeflow', '.env'), `TAG=${OLD}\n`);
    const noInstaller = run(dir, ['update', '--yes']);
    stopped(noInstaller, 'selfhost.sh is not there');
    assert.deepStrictEqual(selfhostCalls(noInstaller.log), []);
    assert.strictEqual(read(dir, 'beeflow', '.env'), `TAG=${OLD}\n`);
});

test('a release that cannot be downloaded, or does not match its checksums, changes nothing', opts, async (t) => {
    const dir = await installed(t);
    const before = fs.readdirSync(path.join(dir, 'beeflow')).sort();
    const settings = read(dir, 'beeflow', '.env');
    const unchanged = (res) => {
        assert.strictEqual(read(dir, 'beeflow', '.env'), settings);
        assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'beeflow')).sort(), before);
        assert.deepStrictEqual(selfhostCalls(res.log), []);
    };
    const missing = run(dir, ['update', '--yes', '--version', 'v2099.1.1']);
    stopped(missing, 'Could not download selfhost.sh of release v2099.1.1');
    unchanged(missing);

    fs.appendFileSync(path.join(dir, 'download', NEW, 'docker-compose.from-registry.yml'), '# changed on the way\n');
    const tampered = run(dir, ['update', '--yes']);
    stopped(tampered, 'do not match its checksums', 'Nothing was changed');
    unchanged(tampered);
});

// ── A bundle: the files of one release come with the installer ───────────

test('with a bundle the install uses the bundled files and version, and downloads nothing', opts, async (t) => {
    const dir = world(t);
    const bundle = path.join(dir, 'bundle');
    writeRelease(bundle, NEW);
    const env = { BEEFLOW_BUNDLE_DIR: bundle, BEEFLOW_BUNDLE_VERSION: NEW };
    const res = await install(dir, { ...env, BEEFLOW_VERSION: OLD, BEEFLOW_API_BASE: 'file:///nowhere', BEEFLOW_DOWNLOAD_BASE: 'file:///nowhere', BEEFLOW_RAW_BASE: 'file:///nowhere' });
    assert.strictEqual(res.status, 0, res.out);
    shows(res, `carries Bee Flow ${NEW} and installs or updates to that version only`, `the version ${OLD} that was asked for is not used`, `Bee Flow ${NEW} is installed`);
    assert.ok(read(dir, 'beeflow', '.env.selfhost.example').includes(`TAG=${NEW}`));
    assert.ok(read(dir, 'beeflow', 'selfhost.sh').includes(NEW));
    assert.deepStrictEqual(res.log.filter((line) => line.startsWith('curl ') && !line.includes('127.0.0.1')), [], 'nothing was downloaded');

    stopped(await install(dir, { BEEFLOW_BUNDLE_DIR: bundle, BEEFLOW_DIR: 'x' }), 'BEEFLOW_BUNDLE_VERSION must be the release tag');
    fs.rmSync(path.join(bundle, 'selfhost.sh'));
    stopped(await install(dir, { ...env, BEEFLOW_DIR: 'x' }), 'the bundle is not complete');
    assert.ok(!exists(dir, 'x'));
});

test('with a bundle, update goes to the bundled version and asks no version', opts, async (t) => {
    const dir = await installed(t);
    const bundle = path.join(dir, 'bundle');
    writeRelease(bundle, NEW);
    const answers = path.join(dir, 'answers');
    // directory, update now.
    fs.writeFileSync(answers, '\ny\n');
    const res = run(dir, ['update'], { BEEFLOW_TTY: answers, BEEFLOW_BUNDLE_DIR: bundle, BEEFLOW_BUNDLE_VERSION: NEW, BEEFLOW_API_BASE: 'file:///nowhere', BEEFLOW_DOWNLOAD_BASE: 'file:///nowhere' });
    assert.strictEqual(res.status, 0, res.out);
    assert.doesNotMatch(res.out, /Version \(a release tag\)/);
    shows(res, `To:             ${NEW}`, `Bee Flow is now on ${NEW}`);
    assert.ok(!res.log.some((line) => line.startsWith('curl ')), 'nothing was downloaded');
    assert.ok(read(dir, 'beeflow', 'selfhost.sh.previous').includes(OLD));
    assert.deepStrictEqual(selfhostCalls(res.log), ['selfhost [--upgrade] PROFILES= STACK_NAME=']);
});
