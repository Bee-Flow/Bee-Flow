/**
 * Environment for the suite: where the app lives and who we log in as.
 *
 * Values come from real environment variables, then from playwright-tests/.env
 * (see .env.example), then from the local-stack defaults below.
 */
import * as fs from 'fs';
import * as path from 'path';

const ENV_FILE = path.join(__dirname, '..', '.env');

// Dependency-free .env loader — deliberately no dotenv dependency.
try {
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
} catch {
  // Missing/unreadable .env is fine — defaults below apply.
}

export const BASE_URL = process.env.BASE_URL || 'http://localhost:5176';
export const TEST_USER = process.env.TEST_USER || 'testuser';
export const TEST_PASSWORD = process.env.TEST_PASSWORD || 'test123';

/** Saved session (cookies + storage) produced once by global-setup.ts. */
export const AUTH_FILE = path.join(__dirname, '..', '.auth', 'user.json');

/**
 * Desktop viewport is mandatory: below 768px the Agent Hub switches to mobile
 * mode and redirects most routes back to /app.
 */
export const VIEWPORT = { width: 1440, height: 900 };
