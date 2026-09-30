import { CONNECTORS } from './catalog';
import { connectorState } from './connectorState';

const byProvider = (provider: string) => {
    const connector = CONNECTORS.find((c) => c.provider === provider);
    if (!connector) throw new Error(`no connector ${provider}`);
    return connector;
};

describe('connectorState', () => {
    it('reads nothing into a missing status', () => {
        expect(connectorState(byProvider('google'), null)).toEqual({
            identity: null,
            notConfigured: false,
            needsReauth: false,
            connected: false,
        });
    });

    it('names the account from the field that provider uses', () => {
        const google = connectorState(byProvider('google'), { connected: true, email: 'a@b.nl' });
        expect(google.identity).toBe('a@b.nl');
        expect(google.connected).toBe(true);
    });

    it('only calls a provider unconfigured when it reports that it can be', () => {
        expect(connectorState(byProvider('google'), { connected: false, configured: false }).notConfigured).toBe(
            true,
        );
        expect(connectorState(byProvider('github'), { connected: false, configured: false }).notConfigured).toBe(
            false,
        );
    });
});
