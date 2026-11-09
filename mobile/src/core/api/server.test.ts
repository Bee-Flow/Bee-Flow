/**
 * Which addresses count as the user's own network, where plain http is a
 * self-hoster and not a mistake.
 */

import { isPrivateHost } from './server';

describe('isPrivateHost', () => {
    it('accepts loopback, .local and RFC1918 literals', () => {
        for (const url of [
            'http://localhost:5176',
            'http://nas.local',
            'http://10.0.0.5',
            'http://192.168.1.40:5176',
            'http://172.16.0.9',
            'http://172.31.255.1',
            'http://127.0.0.1:3101',
        ]) {
            expect([url, isPrivateHost(url)]).toEqual([url, true]);
        }
    });

    it('does not take a public NAME that starts like a private address for one', () => {
        for (const url of [
            'http://10.example.com',
            'http://192.168.evil.org',
            'http://172.16.example.net',
            'http://127.attacker.io',
            'http://172.32.0.1',
            'http://8.8.8.8',
        ]) {
            expect([url, isPrivateHost(url)]).toEqual([url, false]);
        }
    });
});
