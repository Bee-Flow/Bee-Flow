import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RestartOffer, type RestartOfferHost } from './restartOffer.ts';

function setup(secureOrigin: string | null = null, answer = 0) {
    const asked: string[] = [];
    let relaunches = 0;
    let release: ((response: number) => void) | null = null;
    let deferred = false;
    const host: RestartOfferHost = {
        secureOrigin,
        ask: (options) => {
            asked.push(options.message);
            if (!deferred) return Promise.resolve(answer);
            return new Promise<number>((resolve) => {
                release = resolve;
            });
        },
        relaunch: () => {
            relaunches += 1;
        },
    };
    return {
        offer: new RestartOffer(host),
        asked,
        relaunches: () => relaunches,
        defer: () => {
            deferred = true;
        },
        answer: (response: number) => release?.(response),
    };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a private plain-http server asks for a restart, and Restart now relaunches', async () => {
    const t = setup(null, 0);
    t.offer.offer('http://192.168.1.20:3000');
    await flush();
    assert.equal(t.asked.length, 1);
    assert.match(t.asked[0] ?? '', /192\.168\.1\.20/);
    assert.equal(t.relaunches(), 1);
});

test('Later does not relaunch, and the question can be asked again afterwards', async () => {
    const t = setup(null, 1);
    t.offer.offer('http://192.168.1.20:3000');
    await flush();
    assert.equal(t.relaunches(), 0);
    t.offer.offer('http://192.168.1.20:3000');
    await flush();
    assert.equal(t.asked.length, 2);
});

test('only one question at a time', async () => {
    const t = setup();
    t.defer();
    t.offer.offer('http://192.168.1.20:3000');
    t.offer.offer('http://192.168.1.20:3000');
    assert.equal(t.asked.length, 1);
    t.answer(1);
    await flush();
});

test('nothing is asked for https, a public host, or the origin this run already treats as secure', async () => {
    const t = setup('http://192.168.1.20:3000');
    t.offer.offer('https://bee.example');
    t.offer.offer('http://bee.example');
    t.offer.offer('http://192.168.1.20:3000');
    await flush();
    assert.deepEqual(t.asked, []);
});
