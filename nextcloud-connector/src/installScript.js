'use strict';
/**
 * The install script the setup page offers to an administrator who has no
 * Bee Flow server yet.
 *
 * The page asks a few questions (where the server will be reachable, which
 * ports, which version); this module turns the answers into a shell script
 * the administrator reads and runs on their Docker host. The script does not
 * reimplement the installer: it fetches `selfhost.sh` and its compose file of
 * a Bee Flow release, writes the answers into the settings template, and lets
 * `selfhost.sh` do the work, which includes generating every secret ON THAT
 * HOST. Nothing secret exists in this module, in the page or in Nextcloud.
 *
 * Two rules keep the script safe to hand out:
 *   - every answer is validated against a small alphabet before it is used,
 *     with plain character checks (no pattern is run over request text);
 *   - an answer only ever appears as a single-quoted assignment at the top of
 *     the script. Everything below that block is the fixed text in this file.
 */

const REPOSITORY = 'Bee-Flow/Bee-Flow';
const SCRIPT_FILENAME = 'beeflow-install.sh';
const LATEST = 'latest';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const LETTERS = LOWER + LOWER.toUpperCase();
const HOST_CHARS = new Set(LETTERS + DIGITS + '.-');
const DIR_CHARS = new Set(LETTERS + DIGITS + '._-/~');
const TAG_CHARS = new Set(LETTERS + DIGITS + '._-');
const STACK_CHARS = new Set(LOWER + DIGITS + '-');
const NAME_CHARS = new Set(LETTERS + DIGITS + ' ._-&');

/**
 * @typedef {object} InstallOptions
 * @property {string} host          name or IPv4 address the server is reached at
 * @property {number} serverPort
 * @property {number} clientPort
 * @property {string} dir           directory the install lives in
 * @property {string} version       'latest' or a release tag
 * @property {boolean} sidecars     also start the PII guard and the topic classifier
 * @property {boolean} privateNextcloud  the Nextcloud is on a private address
 * @property {string} organisation  name of the organisation to make a pairing code for ('' = none)
 * @property {string} stackName     '' for the plain install
 */

/** @type {(value: unknown) => string} */
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** @type {(value: string, allowed: Set<string>) => boolean} */
function onlyChars(value, allowed) {
    for (const ch of value) if (!allowed.has(ch)) return false;
    return true;
}

/** @type {(value: unknown) => number | null} A whole port number, or null. */
function port(value) {
    const raw = typeof value === 'number' ? String(value) : text(value);
    if (!raw || raw.length > 5 || !onlyChars(raw, new Set(DIGITS))) return null;
    const n = Number(raw);
    return n >= 1 && n <= 65535 ? n : null;
}

/** @type {(host: string) => boolean} Labels of letters, digits and dashes, joined by dots. */
function validHost(host) {
    if (!host || host.length > 253 || !onlyChars(host, HOST_CHARS)) return false;
    return host.split('.').every(label => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'));
}

/** @type {(dir: string) => boolean} */
function validDir(dir) {
    if (!dir || dir.length > 200 || !onlyChars(dir, DIR_CHARS)) return false;
    if (dir.includes('~') && !dir.startsWith('~/')) return false;
    return !dir.split('/').includes('..');
}

/**
 * @param {Record<string, unknown> | null | undefined} input
 * @returns {{ ok: true, options: InstallOptions } | { ok: false, errors: Record<string, string> }}
 */
function validateInstallOptions(input) {
    const raw = input && typeof input === 'object' ? input : {};
    /** @type {Record<string, string>} */
    const errors = {};

    const host = text(raw.host).toLowerCase();
    if (!validHost(host)) errors.host = 'Enter the name or IPv4 address of the Docker host, for example 192.168.1.20 or beeflow.example.com (no http://, no port).';
    else if (host === 'localhost' || host.startsWith('127.')) errors.host = 'Use an address Nextcloud can reach: localhost points at the Nextcloud container itself.';

    const serverPort = raw.serverPort === undefined || raw.serverPort === '' ? 3001 : port(raw.serverPort);
    const clientPort = raw.clientPort === undefined || raw.clientPort === '' ? 5176 : port(raw.clientPort);
    if (serverPort === null) errors.serverPort = 'A port is a number from 1 to 65535.';
    if (clientPort === null) errors.clientPort = 'A port is a number from 1 to 65535.';
    if (serverPort !== null && serverPort === clientPort) errors.clientPort = 'The server and the web app need two different ports.';

    const dir = text(raw.dir) || 'beeflow';
    if (!validDir(dir)) errors.dir = 'Use letters, digits, dots, dashes and slashes, for example beeflow or /opt/beeflow.';

    const version = text(raw.version) || LATEST;
    if (version !== LATEST && !(version.startsWith('v') && version.length <= 40 && onlyChars(version, TAG_CHARS))) {
        errors.version = 'Leave empty for the newest release, or enter a release tag such as v2026.11.10.3.';
    }

    const organisation = text(raw.organisation);
    if (organisation.length > 80 || !onlyChars(organisation, NAME_CHARS)) errors.organisation = 'Use up to 80 letters, digits and spaces.';

    const stackName = text(raw.stackName);
    if (stackName && (stackName.length > 30 || !onlyChars(stackName, STACK_CHARS) || stackName.startsWith('-') || stackName === 'beeflow')) {
        errors.stackName = 'Lowercase letters, digits and dashes, not starting with a dash (leave empty for a single install).';
    }

    if (Object.keys(errors).length) return { ok: false, errors };
    return {
        ok: true,
        options: {
            host,
            serverPort: /** @type {number} */ (serverPort),
            clientPort: /** @type {number} */ (clientPort),
            dir,
            version,
            sidecars: raw.sidecars !== false,
            privateNextcloud: raw.privateNextcloud !== false,
            organisation,
            stackName,
        },
    };
}

/** @type {(value: string | number) => string} A value as one single-quoted shell word. */
function shellWord(value) {
    return `'${String(value).split("'").join(`'\\''`)}'`;
}

/** The fixed part of the script: nothing in it depends on an answer. */
const SCRIPT_BODY = String.raw`
REPOSITORY='${REPOSITORY}'

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31mStopped:\033[0m %s\n' "$*" >&2; exit 1; }

# ── What this machine needs ─────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "Docker is installed but this user cannot use it. Run this script as a user in the docker group, or with sudo."
if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    die "Docker Compose is missing. See https://docs.docker.com/compose/install/"
fi
command -v curl >/dev/null 2>&1 || die "curl is not installed."

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$SERVER_PORT" "$CLIENT_PORT"; do
    if port_in_use "$p"; then die "Port $p is already in use on this machine. Choose another port in the block at the top of this script."; fi
done

# ── Which release ───────────────────────────────────────────────────────
if [ "$VERSION" = "latest" ]; then
    say "Looking up the newest Bee Flow release"
    TAG="$(curl -fsSL "https://api.github.com/repos/$REPOSITORY/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
    [ -n "$TAG" ] || die "Could not read the newest release from GitHub. Set VERSION at the top of this script to a release tag (https://github.com/$REPOSITORY/releases) and run it again."
else
    TAG="$VERSION"
fi
note "Release: $TAG"

# ── The installer of that release ───────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
ENV_FILE=".env${'$'}{STACK_NAME:+.$STACK_NAME}"
if [ -f "$ENV_FILE" ]; then
    die "$(pwd)/$ENV_FILE exists: Bee Flow is already installed here. Upgrade it with ./selfhost.sh --upgrade, or choose another directory."
fi
say "Downloading the installer of $TAG into $(pwd)"
for f in selfhost.sh docker-compose.from-registry.yml .env.selfhost.example; do
    curl -fsSL "https://raw.githubusercontent.com/$REPOSITORY/$TAG/$f" -o "$f" || die "Could not download $f of release $TAG."
done
chmod +x selfhost.sh

# ── Your choices, into the settings template ────────────────────────────
# selfhost.sh copies this template to the settings file and generates every
# secret itself, on this machine.
setting() { # key value
    grep -v "^$1=" .env.selfhost.example > .env.selfhost.example.tmp || true
    mv .env.selfhost.example.tmp .env.selfhost.example
    printf '%s=%s\n' "$1" "$2" >> .env.selfhost.example
}
setting TAG "$TAG"
setting SERVER_PORT "$SERVER_PORT"
setting CLIENT_PORT "$CLIENT_PORT"
setting SERVER_PROTOCOL http
setting CLIENT_PROTOCOL http
setting SERVER_PUBLIC_HOST "$HOST:$SERVER_PORT"
setting CLIENT_PUBLIC_HOST "$HOST:$CLIENT_PORT"
# Published on every interface, so Nextcloud's connector can reach them.
setting SERVER_BIND_HOST 0.0.0.0
setting CLIENT_BIND_HOST 0.0.0.0
if [ "$PRIVATE_NEXTCLOUD" = "1" ]; then setting NEXTCLOUD_ALLOW_PRIVATE_HOSTS 1; fi

# ── Install and start ───────────────────────────────────────────────────
export PROFILES
if [ -n "$STACK_NAME" ]; then export STACK_NAME; fi
say "Starting Bee Flow ($PROFILES). The first start downloads the images; with the PII guard that is several gigabytes."
./selfhost.sh
# A named stack stops once after writing its settings; the second run starts it.
if [ -n "$STACK_NAME" ]; then ./selfhost.sh; fi

value() { (grep -E "^$1=" "$ENV_FILE" || true) | tail -n1 | cut -d= -f2-; }
SERVER_CONTAINER="${'$'}{STACK_NAME:-beeflow}-server"
SERVER_URL="http://$HOST:$SERVER_PORT"
WEB_URL="http://$HOST:$CLIENT_PORT"

say "Waiting for the server to answer"
for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$SERVER_PORT/api/health" >/dev/null 2>&1; then break; fi
    sleep 2
done
curl -fsS "http://127.0.0.1:$SERVER_PORT/api/health" >/dev/null 2>&1 || die "The server does not answer on port $SERVER_PORT yet. Look at: ./selfhost.sh --logs"

# ── A pairing code for Nextcloud ────────────────────────────────────────
PAIRING_CODE=""
if [ -n "$ORGANISATION" ]; then
    say "Creating the organisation \"$ORGANISATION\" and a pairing code"
    PAIRING_CODE="$(docker exec -i \
        -e BF_PASSWORD="$(value INIT_ADMIN_PASSWORD)" -e BF_ORGANISATION="$ORGANISATION" \
        -e BF_BASE="http://localhost:$SERVER_PORT" -e BF_ORIGIN="$WEB_URL" \
        "$SERVER_CONTAINER" node - <<'EOJS' || true
const { BF_PASSWORD, BF_ORGANISATION, BF_BASE, BF_ORIGIN } = process.env;
const fail = (what) => { console.error(what); process.exit(1); };
(async () => {
    const login = await fetch(BF_BASE + '/auth/admin-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BF_ORIGIN },
        body: JSON.stringify({ username: 'admin', password: BF_PASSWORD }),
    });
    if (!login.ok) fail('sign-in as admin answered ' + login.status);
    const cookie = (login.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
    const call = async (method, path, body) => {
        const r = await fetch(BF_BASE + path, {
            method,
            headers: { 'content-type': 'application/json', origin: BF_ORIGIN, cookie },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    let org = (await call('POST', '/auth/organizations', { name: BF_ORGANISATION })).json.organization;
    if (!org) {
        const list = (await call('GET', '/auth/organizations')).json;
        org = (Array.isArray(list) ? list : (list.organizations || [])).find(o => o.name === BF_ORGANISATION);
    }
    if (!org) fail('the organisation could not be created');
    const code = await call('POST', '/auth/admin/nc-bindings/generate-pairing-code', { organizationId: org.id });
    if (code.status !== 200 || !code.json.code) fail('the pairing code request answered ' + code.status);
    console.log(code.json.code);
})().catch(e => fail(String(e && e.message || e)));
EOJS
    )"
fi

# ── What you need next ──────────────────────────────────────────────────
say "Bee Flow $TAG is running"
note "Web app:   $WEB_URL"
note "Sign in:   admin / $(value INIT_ADMIN_PASSWORD)   (change it after the first sign-in)"

say "In Nextcloud: open Bee Flow, choose \"Self-hosted server\" and enter"
note "Server URL:    $SERVER_URL"
note "Web app URL:   $WEB_URL"
if [ -n "$PAIRING_CODE" ]; then
    note "Pairing code:  $PAIRING_CODE   (valid for 15 minutes, works once)"
else
    note "Pairing code:  sign in to the web app, create your organisation, then"
    note "               Settings -> Organisation -> Pair a new Nextcloud"
fi

say "The secrets this install generated"
note "They are in $(pwd)/$ENV_FILE (readable by you only). Keep a copy somewhere safe:"
note "without MASTER_ENCRYPTION_KEY the stored data cannot be read again."
for key in INIT_ADMIN_PASSWORD MASTER_ENCRYPTION_KEY SESSION_SECRET DB_PASSWORD RUSTFS_SECRET_KEY SERVICES_API_KEY; do
    printf '  %-22s %s\n' "$key" "$(value "$key")"
done

say "Later"
note "Upgrade:  cd $(pwd) && ./selfhost.sh --upgrade   (set TAG in $ENV_FILE first)"
note "Logs:     ./selfhost.sh --logs      Stop: ./selfhost.sh --stop"
note "Ports $SERVER_PORT and $CLIENT_PORT are open on this machine's network interfaces, over plain http."
note "For use outside your own network, put a reverse proxy with HTTPS in front."
`;

/**
 * @param {InstallOptions} options  validated options (see validateInstallOptions)
 * @returns {string}
 */
function buildInstallScript(options) {
    const head = [
        '#!/usr/bin/env bash',
        '# Bee Flow: install with Docker.',
        '#',
        '# Made by the Bee Flow app in Nextcloud from your answers. Read it before you',
        '# run it: it downloads the installer of a Bee Flow release from GitHub, writes',
        '# the choices below into its settings, and starts the containers. Every secret',
        '# is generated on this machine and shown at the end.',
        '#',
        `# Run it on the Docker host:   bash ${SCRIPT_FILENAME}`,
        'set -euo pipefail',
        '',
        '# ── Your choices (change them here if you like) ────────────────────────',
        `INSTALL_DIR=${shellWord(options.dir)}`,
        `HOST=${shellWord(options.host)}                 # how Nextcloud reaches this machine`,
        `SERVER_PORT=${shellWord(options.serverPort)}`,
        `CLIENT_PORT=${shellWord(options.clientPort)}`,
        `VERSION=${shellWord(options.version)}           # "latest" = the newest production release, looked up now and pinned`,
        `PROFILES=${shellWord(options.sidecars ? 'core guard classify' : 'core')}`,
        `PRIVATE_NEXTCLOUD=${shellWord(options.privateNextcloud ? '1' : '0')}        # 1 = the Nextcloud is on a private address (same machine or LAN)`,
        `ORGANISATION=${shellWord(options.organisation)}       # a pairing code is made for it; empty = none`,
        `STACK_NAME=${shellWord(options.stackName)}            # empty = the single install on this machine`,
    ].join('\n');
    return head + '\n' + SCRIPT_BODY;
}

/** @type {(options: InstallOptions) => { serverUrl: string, webAppUrl: string }} What to enter in the setup page afterwards. */
function addressesFor(options) {
    return { serverUrl: `http://${options.host}:${options.serverPort}`, webAppUrl: `http://${options.host}:${options.clientPort}` };
}

module.exports = { validateInstallOptions, buildInstallScript, addressesFor, shellWord, SCRIPT_FILENAME, REPOSITORY };
