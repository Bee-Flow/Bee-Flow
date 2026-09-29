import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountsFrom, configCandidates, normaliseRemotePath, parseIni, trimTrailingSeparator, unescapeIniValue } from './clientConfig.ts';

/** A config as a current Nextcloud desktop client writes it. */
const MODERN = `[General]
optionalServerNotifications=true
showInExplorerNavigationPane=true

[Accounts]
0\\Folders\\1\\ignoreHiddenFiles=true
0\\Folders\\1\\journalPath=._sync_2f1a0c.db
0\\Folders\\1\\localPath=/home/tom/Nextcloud/
0\\Folders\\1\\paused=false
0\\Folders\\1\\targetPath=/
0\\Folders\\1\\version=2
0\\Folders\\1\\virtualFilesMode=off
0\\Folders\\2\\localPath=/home/tom/Werk/
0\\Folders\\2\\targetPath=/Projecten/Bee Flow
0\\Folders\\2\\virtualFilesMode=wincfapi
0\\dav_user=tom
0\\displayName=Tom Kooy
0\\url=https://cloud.example.com
0\\user=tom
0\\version=1
1\\Folders\\5\\localPath=/home/tom/Klant/
1\\Folders\\5\\targetPath=/
1\\dav_user=t.kooy
1\\url=https://klant.example.org/nextcloud
1\\user=t.kooy
version=2
`;

/** The older layout, with folders in their own section. */
const LEGACY = `[Accounts]
0\\url=https://cloud.example.com
0\\user=tom

[Folders]
Nextcloud\\localPath=/home/tom/Nextcloud/
Nextcloud\\targetPath=/
Nextcloud\\backend=owncloud
`;

describe('parseIni', () => {
    it('splits sections and keeps the nested keys intact', () => {
        const ini = parseIni(MODERN);
        assert.equal(ini.get('Accounts')?.get('0\\url'), 'https://cloud.example.com');
        assert.equal(ini.get('General')?.get('optionalServerNotifications'), 'true');
    });

    it('ignores comments, blank lines and anything without an =', () => {
        const ini = parseIni('; a comment\n# another\n\n[Accounts]\nnot-a-pair\n0\\url=https://x.example\n');
        assert.equal(ini.get('Accounts')?.size, 1);
    });

    it('keeps an = inside a value', () => {
        const ini = parseIni('[Accounts]\n0\\url=https://x.example/?a=b\n');
        assert.equal(ini.get('Accounts')?.get('0\\url'), 'https://x.example/?a=b');
    });
});

describe('unescapeIniValue', () => {
    it('decodes the \\xNNNN Qt writes for non-ASCII folder names', () => {
        assert.equal(unescapeIniValue('/home/tom/Bel\\xe4gg'), '/home/tom/Belägg');
        assert.equal(unescapeIniValue('\\x041f\\x0440\\x043e\\x0435\\x043a\\x0442'), 'Проект');
    });

    it('unquotes a quoted value and keeps its commas', () => {
        assert.equal(unescapeIniValue('"/home/tom/A, B"'), '/home/tom/A, B');
    });

    it('leaves an ordinary value alone', () => {
        assert.equal(unescapeIniValue('  /home/tom/Nextcloud  '), '/home/tom/Nextcloud');
    });
});

describe('accountsFrom — modern layout', () => {
    const accounts = accountsFrom(parseIni(MODERN));

    it('finds every account with a URL', () => {
        assert.equal(accounts.length, 2);
        assert.equal(accounts[0]?.url, 'https://cloud.example.com');
        assert.equal(accounts[0]?.user, 'tom');
        assert.equal(accounts[0]?.davUser, 'tom');
        assert.equal(accounts[0]?.displayName, 'Tom Kooy');
        assert.equal(accounts[1]?.url, 'https://klant.example.org/nextcloud', 'a subpath install keeps its path');
        assert.equal(accounts[1]?.davUser, 't.kooy', 'the DAV user can differ from the login name');
    });

    it('attaches folders to the account that owns them', () => {
        assert.equal(accounts[0]?.folders.length, 2);
        assert.equal(accounts[1]?.folders.length, 1);
        assert.equal(accounts[1]?.folders[0]?.accountId, '1');
    });

    it('normalises the paths on both sides', () => {
        const work = accounts[0]?.folders.find((f) => f.localPath.endsWith('Werk'));
        assert.equal(work?.localPath, '/home/tom/Werk', 'no trailing separator');
        assert.equal(work?.targetPath, '/Projecten/Bee Flow');

        const root = accounts[0]?.folders.find((f) => f.localPath.endsWith('Nextcloud'));
        assert.equal(root?.targetPath, '/');
    });

    it('reads virtual-files mode as a flag, not a string', () => {
        const work = accounts[0]?.folders.find((f) => f.localPath.endsWith('Werk'));
        const root = accounts[0]?.folders.find((f) => f.localPath.endsWith('Nextcloud'));
        assert.equal(work?.virtualFiles, true, 'wincfapi means placeholders');
        assert.equal(root?.virtualFiles, false, 'off means fully downloaded');
    });

    it('orders folders longest-path-first so a nested pair wins', () => {
        const nested = accountsFrom(
            parseIni(`[Accounts]
0\\url=https://cloud.example.com
0\\Folders\\1\\localPath=/home/tom/Nextcloud
0\\Folders\\1\\targetPath=/
0\\Folders\\2\\localPath=/home/tom/Nextcloud/Projects
0\\Folders\\2\\targetPath=/Shared/Projects
`),
        );
        assert.equal(nested[0]?.folders[0]?.localPath, '/home/tom/Nextcloud/Projects');
    });
});

describe('accountsFrom — legacy layout', () => {
    it('reads folders from their own section', () => {
        const accounts = accountsFrom(parseIni(LEGACY));
        assert.equal(accounts.length, 1);
        assert.equal(accounts[0]?.folders.length, 1);
        assert.equal(accounts[0]?.folders[0]?.localPath, '/home/tom/Nextcloud');
    });
});

describe('accountsFrom — malformed input', () => {
    it('returns nothing rather than throwing', () => {
        assert.deepEqual(accountsFrom(parseIni('')), []);
        assert.deepEqual(accountsFrom(parseIni('total garbage\nnot ini at all')), []);
    });

    it('drops an account entry that has no URL', () => {
        assert.deepEqual(accountsFrom(parseIni('[Accounts]\n0\\user=tom\n0\\Folders\\1\\localPath=/home/tom/x\n')), []);
    });

    it('drops a folder entry that has no local path', () => {
        const accounts = accountsFrom(parseIni('[Accounts]\n0\\url=https://x.example\n0\\Folders\\1\\targetPath=/\n'));
        assert.deepEqual(accounts[0]?.folders, []);
    });
});

describe('configCandidates', () => {
    it('covers the three ways Linux ships this client', () => {
        const paths = configCandidates({}, 'linux', '/home/tom');
        assert.ok(paths.includes('/home/tom/.config/Nextcloud/nextcloud.cfg'), 'distro package');
        assert.ok(paths.some((p) => p.includes('.var/app/com.nextcloud.desktopclient.nextcloud')), 'flatpak');
        assert.ok(paths.some((p) => p.includes('snap/nextcloud-desktop-client')), 'snap');
    });

    it('honours XDG_CONFIG_HOME', () => {
        const paths = configCandidates({ XDG_CONFIG_HOME: '/home/tom/.cfg' }, 'linux', '/home/tom');
        assert.equal(paths[0], '/home/tom/.cfg/Nextcloud/nextcloud.cfg');
    });

    it('uses APPDATA on Windows and normalises its separators', () => {
        const paths = configCandidates({ APPDATA: 'C:\\Users\\tom\\AppData\\Roaming' }, 'win32', 'C:\\Users\\tom');
        assert.equal(paths[0], 'C:/Users/tom/AppData/Roaming/Nextcloud/nextcloud.cfg');
    });

    it('looks in Preferences on macOS', () => {
        const paths = configCandidates({}, 'darwin', '/Users/tom');
        assert.equal(paths[0], '/Users/tom/Library/Preferences/Nextcloud/nextcloud.cfg');
    });

    it('lists every candidate once', () => {
        const paths = configCandidates({ XDG_CONFIG_HOME: '/home/tom/.config' }, 'linux', '/home/tom');
        assert.equal(new Set(paths).size, paths.length);
    });
});

describe('path normalisation', () => {
    it('trims a trailing separator but keeps a root', () => {
        assert.equal(trimTrailingSeparator('/home/tom/Nextcloud/'), '/home/tom/Nextcloud');
        assert.equal(trimTrailingSeparator('C:\\Users\\tom\\Nextcloud\\'), 'C:\\Users\\tom\\Nextcloud');
        assert.equal(trimTrailingSeparator('/'), '/');
        assert.equal(trimTrailingSeparator('C:/'), 'C:/');
    });

    it('makes a remote path absolute, POSIX and un-doubled', () => {
        assert.equal(normaliseRemotePath('Projecten/Bee Flow/'), '/Projecten/Bee Flow');
        assert.equal(normaliseRemotePath('\\Projecten\\Bee Flow'), '/Projecten/Bee Flow');
        assert.equal(normaliseRemotePath('//a//b//'), '/a/b');
        assert.equal(normaliseRemotePath('/'), '/');
        assert.equal(normaliseRemotePath(''), '/');
    });
});
