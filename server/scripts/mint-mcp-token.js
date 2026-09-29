#!/usr/bin/env node
/**
 * Mint (or revoke) a Bee Flow MCP bearer token from the command line.
 *
 * The self-service HTTP route (routes/mcpServerTokens.js) needs a browser
 * session, and no UI calls it yet — which is fine for the Nextcloud assistant,
 * where an admin sets it up once, and useless for the App Studio MCP endpoint,
 * whose whole point is being wired into an editor on a developer box. This is
 * that path: same token, same secret key, same revoke semantics, no browser.
 *
 * The token is shown ONCE. Only its random half is stored, so a lost token is
 * replaced by minting again — which also invalidates the previous one, since a
 * user has exactly one.
 *
 * USAGE
 *   node scripts/mint-mcp-token.js --email you@example.com
 *   node scripts/mint-mcp-token.js --user <userId>
 *   node scripts/mint-mcp-token.js --email you@example.com --revoke
 *
 * Run it where the server's env is (same CORE_DATABASE_URL and
 * MASTER_ENCRYPTION_KEY — the secret store is encrypted). In the container:
 *   docker compose exec server node scripts/mint-mcp-token.js --email you@…
 */

'use strict';

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { mintToken, SECRET_KEY } = require('../auth/mcpToken');
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 ? process.argv[i + 1] : null;
}

async function main() {
    const email = arg('email');
    const userIdArg = arg('user');
    const revoke = process.argv.includes('--revoke');

    if (!email && !userIdArg) {
        console.error('Usage: node scripts/mint-mcp-token.js --email <email> | --user <userId> [--revoke]');
        process.exit(2);
    }

    let userId = userIdArg;
    if (!userId) {
        const user = await userStore.getUserByEmail(email);
        if (!user) {
            console.error(`No user with email ${email}.`);
            process.exit(1);
        }
        userId = user.id;
    } else {
        const user = await userStore.getUser(userId);
        if (!user) {
            console.error(`No user with id ${userId}.`);
            process.exit(1);
        }
    }

    // Revoking overwrites the stored half with a value nobody holds — the store
    // is write-once by design and has no delete. Mirrors the DELETE route.
    const { token, random } = mintToken(userId);
    await configStore.setSecret(SECRET_KEY(userId), random);
    await configStore.setSecret(`${SECRET_KEY(userId)}_revoked`, revoke ? '1' : '0');

    if (revoke) {
        console.log(`Revoked the MCP token for user ${userId}.`);
        return;
    }

    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
        || `http://localhost:${process.env.PORT || 3101}`;

    console.log(`\nMCP token for user ${userId} (shown once — minting again revokes this one):\n`);
    console.log(`  ${token}\n`);
    console.log('Wire App Studio into Claude Code:\n');
    console.log(`  claude mcp add --transport http beeflow-studio ${base}/mcp/studio \\`);
    console.log(`    --header "Authorization: Bearer ${token}"\n`);
    console.log('That endpoint needs STUDIO_MCP_ENABLED=1 on the server. The same token also');
    console.log(`works against ${base}/mcp (integration tools), which is always mounted.\n`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error('Failed:', e.message);
        process.exit(1);
    });
