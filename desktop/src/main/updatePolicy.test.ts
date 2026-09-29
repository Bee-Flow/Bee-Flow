import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildInfoFrom, channelFor, detectPackaging, feedFromEnv, updateCapability, type PackagingSignals } from './updatePolicy.ts';

function signals(overrides: Partial<PackagingSignals> = {}): PackagingSignals {
    return { platform: 'linux', execPath: '/opt/Bee Flow/beeflow', env: {}, packaged: true, ...overrides };
}

describe('detectPackaging', () => {
    it('knows an AppImage by the variable its runtime exports', () => {
        assert.equal(detectPackaging(signals({ env: { APPIMAGE: '/home/tom/Apps/BeeFlow.AppImage' } })), 'appimage');
    });

    it('knows a Flatpak two ways', () => {
        assert.equal(detectPackaging(signals({ env: { FLATPAK_ID: 'nl.beeflow.desktop' } })), 'flatpak');
        assert.equal(detectPackaging(signals({ execPath: '/app/bin/beeflow' })), 'flatpak');
    });

    it('knows a Snap two ways', () => {
        assert.equal(detectPackaging(signals({ env: { SNAP: '/snap/bee-flow/12' } })), 'snap');
        assert.equal(detectPackaging(signals({ execPath: '/snap/bee-flow/current/beeflow' })), 'snap');
    });

    it('reads a package-manager install from where the binary sits', () => {
        assert.equal(detectPackaging(signals({ execPath: '/opt/Bee Flow/beeflow' })), 'deb');
        assert.equal(detectPackaging(signals({ execPath: '/usr/lib/beeflow/beeflow' })), 'deb');
    });

    it('tells the Windows shapes apart', () => {
        assert.equal(detectPackaging(signals({ platform: 'win32', execPath: 'C:\\Program Files\\Bee Flow\\Bee Flow.exe' })), 'nsis');
        assert.equal(
            detectPackaging(signals({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'D:\\tools' }, execPath: 'D:\\tools\\Bee Flow.exe' })),
            'portable',
        );
        assert.equal(detectPackaging(signals({ platform: 'win32', windowsStore: true, execPath: 'C:\\x' })), 'msi');
    });

    it('reports macOS as a dmg install', () => {
        assert.equal(detectPackaging(signals({ platform: 'darwin', execPath: '/Applications/Bee Flow.app/Contents/MacOS/Bee Flow' })), 'dmg');
    });

    it('says dev when running from source, whatever else is set', () => {
        assert.equal(detectPackaging(signals({ packaged: false, env: { APPIMAGE: '/x' } })), 'dev');
    });
});

describe('updateCapability', () => {
    it('updates the packagings that have nothing else to update them', () => {
        for (const packaging of ['appimage', 'nsis', 'dmg'] as const) {
            assert.equal(updateCapability(packaging).canSelfUpdate, true, packaging);
        }
    });

    it('stands aside for a package manager, and says which one', () => {
        assert.match(updateCapability('deb').reason, /package manager/);
        assert.match(updateCapability('flatpak').reason, /flatpak update/);
        assert.match(updateCapability('snap').reason, /snap refresh/);
        for (const packaging of ['deb', 'rpm', 'pacman', 'flatpak', 'snap', 'msi'] as const) {
            assert.equal(updateCapability(packaging).canSelfUpdate, false, packaging);
        }
    });

    it('always gives a reason when it will not update', () => {
        for (const packaging of ['deb', 'rpm', 'pacman', 'flatpak', 'snap', 'msi', 'portable', 'dev', 'unknown'] as const) {
            assert.notEqual(updateCapability(packaging).reason, '', packaging);
        }
    });
});

describe('channelFor', () => {
    it('maps the setting onto electron-updater channel names', () => {
        assert.equal(channelFor('stable'), 'latest');
        assert.equal(channelFor('beta'), 'beta');
    });
});

describe('feedFromEnv', () => {
    it('lets a self-hoster point updates at their own host', () => {
        assert.deepEqual(feedFromEnv({ BEEFLOW_UPDATE_FEED_URL: 'https://updates.example.com/beeflow/' }), {
            provider: 'generic',
            url: 'https://updates.example.com/beeflow',
        });
    });

    it('ignores an unset or unusable value rather than failing to start', () => {
        assert.equal(feedFromEnv({}), null);
        assert.equal(feedFromEnv({ BEEFLOW_UPDATE_FEED_URL: '   ' }), null);
        assert.equal(feedFromEnv({ BEEFLOW_UPDATE_FEED_URL: 'not a url' }), null);
        assert.equal(feedFromEnv({ BEEFLOW_UPDATE_FEED_URL: 'file:///tmp/evil' }), null);
    });
});

describe('updateCapability — unsigned macOS builds', () => {
    it('does not offer an update macOS will refuse to apply', () => {
        const unsigned = updateCapability('dmg', { unsignedMac: true });
        assert.equal(unsigned.canSelfUpdate, false);
        assert.match(unsigned.reason, /unsigned build/);
        assert.equal(updateCapability('dmg', {}).canSelfUpdate, true);
    });

    it('reads the flag the release workflow stamps, as a boolean or a string', () => {
        assert.deepEqual(buildInfoFrom({ beeflowUnsignedMac: true }), { unsignedMac: true });
        assert.deepEqual(buildInfoFrom({ beeflowUnsignedMac: 'true' }), { unsignedMac: true });
        assert.deepEqual(buildInfoFrom({ name: '@beeflow/desktop' }), { unsignedMac: false });
        assert.deepEqual(buildInfoFrom(null), { unsignedMac: false });
    });
});
