/**
 * Get Organization Component
 * Reads organization data from the SQLite database.
 *
 * Input JSON (stdin):
 * { "organizationId": "acme-corp" }
 * OR
 * { "name": "Acme" }
 *
 * Output JSON:
 * { "found": true, "organization": { id, name, description, ... } }
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function safeJsonStdin() {
    const raw = fs.readFileSync(0, 'utf-8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
}

function main() {
    const inputs = safeJsonStdin();
    const dbPath = path.resolve(__dirname, '../../server/data/beeflow.db');

    if (!fs.existsSync(dbPath)) {
        console.log(JSON.stringify({ found: false, error: 'Database not found' }));
        process.exit(1);
    }

    const db = new Database(dbPath, { readonly: true });

    try {
        let org = null;

        if (inputs.organizationId) {
            org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(inputs.organizationId);
        } else if (inputs.name) {
            org = db.prepare('SELECT * FROM organizations WHERE LOWER(name) LIKE ?').get(`%${inputs.name.toLowerCase()}%`);
        } else {
            // Return all organizations
            const orgs = db.prepare('SELECT * FROM organizations').all();
            console.log(JSON.stringify({ found: orgs.length > 0, organizations: orgs, count: orgs.length }));
            db.close();
            return;
        }

        if (org) {
            console.log(JSON.stringify({ found: true, organization: org }));
        } else {
            console.log(JSON.stringify({ found: false, organization: null }));
        }
    } catch (e) {
        console.log(JSON.stringify({ found: false, error: e.message }));
        process.exit(1);
    } finally {
        db.close();
    }
}

main();
