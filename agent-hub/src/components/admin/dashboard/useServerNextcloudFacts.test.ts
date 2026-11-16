import { describe, expect, it } from 'vitest';
import { hasNextcloudInstancesIn } from './useServerNextcloudFacts';

describe('hasNextcloudInstancesIn: does the server have a Nextcloud to look after', () => {
    it('is yes for an organisation bound to a Nextcloud or registered by the connector', () => {
        expect(hasNextcloudInstancesIn([{ id: 'a' }, { id: 'b', nc_instance_id: 'nc-1' }])).toBe(true);
        expect(hasNextcloudInstancesIn([{ id: 'a', registrationSource: 'nextcloud_connector' }])).toBe(true);
        expect(hasNextcloudInstancesIn({ organizations: [{ id: 'b', nc_instance_id: 'nc-1' }] })).toBe(true);
    });

    it('is no for organisations without one, and for an answer without a list', () => {
        expect(hasNextcloudInstancesIn([{ id: 'a', nc_instance_id: '' }, { id: 'b', registrationSource: 'signup' }, null])).toBe(false);
        expect(hasNextcloudInstancesIn({})).toBe(false);
        expect(hasNextcloudInstancesIn(null)).toBe(false);
    });
});
