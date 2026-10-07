/**
 * The chat-signals contract, pinned against the server's own source (read as
 * TEXT: the route files import the database pool). A red line means the
 * server moved: follow it in api/chatSignals.ts and its readers.
 */
import fs from 'node:fs';
import path from 'node:path';

import { CHAT_SIGNALS_ACTIVITY_ID } from './chatSignalsReaders';

const SERVER = path.resolve(__dirname, '../../../../../server');
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

function expectAll(src: string, needles: string[]) {
    for (const needle of needles) expect({ needle, found: src.includes(needle) }).toEqual({ needle, found: true });
}

describe('chat-signals server contract', () => {
    it('serves the four chat-monitoring routes, the 403 and the 422 missing list', () => {
        expectAll(read('routes/compliance/chatMonitoring.js'), [
            "router.get('/chat-monitoring'",
            "router.put('/chat-monitoring'",
            "router.get('/chat-monitoring/summary'",
            "router.delete('/chat-monitoring/counts'",
            'chat_monitoring_widen_forbidden',
            "{ missing }",
            'details.missing',
            'res.json({ deleted })',
            'can_widen',
            'install_has_organisations',
            'privacy_notice_url_set',
            'dpo_contact',
            'dsr_url',
            'shield_log_retention_days',
        ]);
    });

    it('records the DPIA under chat_monitoring through the DPIA route and its hook', () => {
        expectAll(read('routes/compliance/dpia.js'), ["router.post('/dpia/:agentId'", 'chatMonitoringDpiaHook', "'chat_monitoring'", 'attestation']);
    });

    it('registers the chat-signals activity with the fields the preview reads', () => {
        expectAll(read('compliance/ropa/chatMonitoringActivity.js'), [
            `activity_id: '${CHAT_SIGNALS_ACTIVITY_ID}'`,
            'purpose:', 'processing:', 'data_categories', 'data_subjects', 'retention:', 'legal_basis:', 'security_measures:',
        ]);
    });
});
