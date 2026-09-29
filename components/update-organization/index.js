/**
 * Update Organization Component
 * Updates organization details in the SQLite database.
 *
 * Input JSON (stdin):
 * {
 *   "organizationId": "acme-corp",
 *   "name": "Acme Corporation",
 *   "tagline": "We build things",
 *   "email": "info@acme.com",
 *   "phone": "+1 555 1234",
 *   "website": "www.acme.com",
 *   "address": "123 Main St",
 *   "kvk": "12345678",
 *   "vat": "XX123456789"
 * }
 *
 * Output JSON:
 * { "success": true, "organization": { ... } }
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

    if (!inputs.organizationId) {
        console.log(JSON.stringify({ success: false, error: 'organizationId is required' }));
        process.exit(1);
    }

    if (!fs.existsSync(dbPath)) {
        console.log(JSON.stringify({ success: false, error: 'Database not found' }));
        process.exit(1);
    }

    const db = new Database(dbPath);

    try {
        // Check if org exists
        const existing = db.prepare('SELECT * FROM organizations WHERE id = ?').get(inputs.organizationId);
        if (!existing) {
            console.log(JSON.stringify({ success: false, error: `Organization '${inputs.organizationId}' not found` }));
            db.close();
            process.exit(1);
        }

        // Build dynamic UPDATE query with only provided fields
        const updateFields = ['name', 'description', 'tagline', 'address', 'email', 'phone', 'website', 'kvk', 'vat'];
        const setClauses = [];
        const values = [];

        for (const field of updateFields) {
            if (inputs[field] !== undefined && inputs[field] !== null) {
                setClauses.push(`${field} = ?`);
                values.push(inputs[field]);
            }
        }

        if (setClauses.length === 0) {
            // Nothing to update, return current org
            console.log(JSON.stringify({ success: true, organization: existing, message: 'No fields to update' }));
            db.close();
            return;
        }

        values.push(inputs.organizationId);
        const sql = `UPDATE organizations SET ${setClauses.join(', ')} WHERE id = ?`;
        db.prepare(sql).run(...values);

        // Return updated org
        const updated = db.prepare('SELECT * FROM organizations WHERE id = ?').get(inputs.organizationId);
        console.log(JSON.stringify({ success: true, organization: updated }));
    } catch (e) {
        console.log(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    } finally {
        db.close();
    }
}

main();
