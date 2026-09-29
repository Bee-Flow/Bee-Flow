// @typecheck
/**
 * commonPasswords.js — the deny-list behind the password policy.
 *
 * A pentest created a working organisation account with the password
 * `password`, then changed it to `12345678` through the authenticated API.
 * Both passed, because the only rule anywhere was a minimum length. Length
 * alone is worthless against credential stuffing: every password in this file
 * is 8+ characters and every one of them is in the first page of any breach
 * corpus.
 *
 * WHY A BUNDLED LIST AND NOT A LIBRARY
 * zxcvbn is the usual answer, but it is a ~800 KB dependency whose value here
 * is almost entirely its frequency dictionary, and this product ships to
 * air-gapped self-hosted installs where an outbound breach-API call is not
 * acceptable as a hard dependency. So: a bundled list covering the passwords
 * that actually appear in stuffing lists, checked against a CANONICALISED form
 * of the candidate (see passwordPolicy.js) so `P@ssw0rd`, `Welkom123!` and
 * `Sunshine2024` are all caught by their base word. Installs that WANT the
 * long tail can additionally turn on the k-anonymity Have I Been Pwned check
 * (PASSWORD_BREACH_CHECK=hibp) — see passwordPolicy.checkBreachedPassword.
 *
 * WHAT BELONGS IN HERE
 * Base words and literal strings that are common enough that an attacker will
 * try them in the first few thousand guesses. Deliberately Dutch-heavy: this
 * is a Dutch-market product, and English-only lists miss `welkom`, `wachtwoord`
 * and `geheim` entirely. Also brand terms — `beeflow` was one of the 40
 * passwords the pentester sprayed at the admin account.
 *
 * Entries are compared lowercase; do not add case variants.
 */

const COMMON_PASSWORDS = new Set([
    // ── The perennial top of every breach corpus ──
    'password', 'passwort', 'passwd', 'pass', 'p@ssword', 'passw0rd', 'password1',
    '123456', '1234567', '12345678', '123456789', '1234567890', '12345', '123123',
    '111111', '000000', '121212', '654321', '666666', '999999', '11111111', '00000000',
    '1q2w3e4r', '1q2w3e', 'qwerty', 'qwertyui', 'qwerty123', 'qwertyuiop', 'qwe123',
    'azerty', 'azertyuiop', 'qazwsx', 'qazwsxedc', 'zaq12wsx', '1qaz2wsx', 'q1w2e3r4',
    'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'abc123', 'abcd1234', 'abcdefg',
    'iloveyou', 'letmein', 'trustno1', 'sunshine', 'princess', 'monkey', 'dragon',
    'football', 'baseball', 'basketball', 'superman', 'batman', 'starwars', 'pokemon',
    'shadow', 'master', 'michael', 'jennifer', 'jordan', 'harley', 'ranger', 'hunter',
    'buster', 'soccer', 'hockey', 'killer', 'george', 'sexy', 'andrew', 'charlie',
    'thomas', 'robert', 'daniel', 'joshua', 'matthew', 'jessica', 'ashley', 'amanda',
    'nicole', 'chelsea', 'biteme', 'matrix', 'freedom', 'whatever', 'nothing',
    'secret', 'summer', 'winter', 'spring', 'autumn', 'orange', 'purple', 'yellow',
    'silver', 'golden', 'diamond', 'crystal', 'phoenix', 'ginger', 'peanut',
    'chocolate', 'cookie', 'flower', 'butterfly', 'rainbow', 'unicorn', 'liverpool',
    'chelsea1', 'arsenal', 'barcelona', 'juventus', 'realmadrid', 'manchester',
    'internet', 'computer', 'samsung', 'google', 'facebook', 'linkedin', 'twitter',
    'whatsapp', 'instagram', 'microsoft', 'windows', 'macintosh', 'android',
    'welcome', 'welcome1', 'welcome123', 'hello', 'hello123', 'helloworld',
    'default', 'changeme', 'change123', 'temp', 'temporary', 'temppass', 'temp123',
    'guest', 'test', 'test123', 'testing', 'testtest', 'demo', 'demo123', 'sample',
    'login', 'logmein', 'access', 'access14', 'private', 'public', 'user', 'user123',
    'system', 'service', 'support', 'helpdesk', 'operator', 'manager', 'employee',
    'company', 'business', 'office', 'work', 'workwork', 'money', 'dollar', 'cash',

    // ── Admin / infrastructure defaults ──
    'admin', 'admin1', 'admin123', 'admin1234', 'administrator', 'adminadmin',
    'admin@123', 'root', 'root123', 'toor', 'superuser', 'sysadmin', 'webadmin',
    'nimda', 'password123', 'password1234', 'password12', 'passw0rd123',
    'server', 'database', 'postgres', 'postgresql', 'mysql', 'mysqlroot', 'oracle',
    'redis', 'mongodb', 'elastic', 'jenkins', 'docker', 'kubernetes', 'grafana',
    'nextcloud', 'owncloud', 'wordpress', 'joomla', 'drupal', 'apache', 'nginx',
    'tomcat', 'openssh', 'vagrant', 'ubuntu', 'debian', 'centos', 'raspberry',
    'raspberrypi', 'firewall', 'router', 'netgear', 'linksys', 'cisco', 'ciscocisco',
    'backup', 'restore', 'monitor', 'monitoring', 'security', 'secure', 'secure123',

    // ── The "looks strong, is not" family ──
    'p@ssw0rd', 'p@ssword1', 'pa$$word', 'passw0rd!', 'password!', 'password@123',
    'welcome@123', 'welkom@123', 'qwerty!23', 'abcd@1234', 'admin@1234',
    'aa123456', 'a1b2c3d4', 'asdf1234', 'zxcv1234', 'qwer1234', '1234qwer',
    'iloveyou1', 'letmein1', 'letmein123', 'trustno1!', 'changeme1', 'changeme123',
    'secret123', 'secret1', 'summer2024', 'summer2025', 'winter2024', 'winter2025',
    'spring2024', 'spring2025', 'autumn2024', 'autumn2025', 'january', 'february',
    'december', 'september', 'november', 'october',

    // ── Dutch — the half an English-only list always misses ──
    'welkom', 'welkom01', 'welkom123', 'welkom2024', 'welkom2025', 'welkomthuis',
    'wachtwoord', 'wachtwoord1', 'wachtwoord123', 'geheim', 'geheim123', 'geheimpje',
    'nederland', 'nederland1', 'holland', 'hollands', 'amsterdam', 'rotterdam',
    'denhaag', 'utrecht', 'eindhoven', 'groningen', 'maastricht', 'nijmegen',
    'brabant', 'limburg', 'zeeland', 'friesland', 'gelderland', 'overijssel',
    'voetbal', 'voetbal1', 'oranje', 'oranje123', 'ajax', 'ajax123', 'ajaxamsterdam',
    'feyenoord', 'psveindhoven', 'azalkmaar', 'fcgroningen', 'twente', 'vitesse',
    'liefde', 'lieverd', 'schatje', 'poesje', 'kusje', 'mama', 'papa', 'oma', 'opa',
    'familie', 'kinderen', 'dochter', 'zoontje', 'vriendin', 'vriendje',
    'zonnetje', 'bloemetje', 'konijn', 'hondje', 'katje', 'paardje', 'vogeltje',
    'kaas', 'kaasje', 'stroopwafel', 'pannenkoek', 'friet', 'bitterbal', 'hagelslag',
    'fiets', 'fietsen', 'molen', 'tulpen', 'klompen', 'gezellig', 'lekkerding',
    'computer1', 'zomer', 'zomer2024', 'zomer2025', 'winter1', 'lente', 'herfst',
    'vakantie', 'weekend', 'maandag', 'vrijdag', 'zaterdag', 'zondag',
    'inloggen', 'aanmelden', 'gebruiker', 'beheerder', 'toegang', 'sleutel',
    'bedrijf', 'kantoor', 'werken', 'werk123', 'collega', 'directeur', 'baasje',
    'ikbendebeste', 'watdanook', 'niksaandehand', 'testtest1', 'proefje',

    // ── German / French / Spanish neighbours (shared border, shared lists) ──
    'passwort1', 'passwort123', 'geheimnis', 'willkommen', 'guten', 'schatzi',
    'deutschland', 'berlin', 'munchen', 'hamburg', 'arschloch', 'scheisse',
    'motdepasse', 'bonjour', 'soleil', 'chouchou', 'coucou', 'jetaime', 'france',
    'contrasena', 'hola', 'holahola', 'espana', 'barcelona1', 'madrid', 'futbol',
    'teamo', 'mivida', 'estrella',

    // ── Brand and product terms — sprayed at this very instance ──
    'beeflow', 'beeflow1', 'beeflow123', 'beeflowai', 'bee-flow', 'beeflownl',
    'beeflow2024', 'beeflow2025', 'honingbij', 'bijenkorf', 'agenthub', 'agent123',
    'flowflow', 'chatgpt', 'openai', 'anthropic', 'claude', 'copilot',

    // ── Keyboard walks and shape passwords ──
    '!qaz2wsx', 'qwertzuiop', '1234abcd', 'abcd123456', '147258369', '159753',
    '987654321', '1029384756', '123qweasd', 'qweasdzxc', 'asdzxc123', '789456123',
    'q1w2e3r4t5', '1a2b3c4d', 'aaaaaaaa', 'bbbbbbbb', 'zzzzzzzz', '11223344',
    '12341234', '11112222', '10203040', '112233', '11235813', '13579246',
    'abcabcabc', 'abcdabcd', 'asdasdasd', 'qweqweqwe', 'zxczxczxc', 'passpass',
]);

module.exports = { COMMON_PASSWORDS };
