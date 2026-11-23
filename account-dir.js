'use strict';

/**
 * Accounts Cindy adds to the DeepSeek Harness engine (Cindy's engine accounts protocol).
 *
 * Every account Cindy adds is one DeepSeek API key in its own directory, which Cindy creates and
 * passes to the engine entry as `--cindy-account-dir <absolute path>` and to the worker as
 * `accountDir`. DSH keeps its credentials, the settings it writes and its session history under
 * `DSH_HOME`, so that directory becomes `DSH_HOME` for the one dsh process of the task. The user's
 * own login (`~/.dsh`, the environment, `.env`) is the "default" account and never takes the
 * argument; nothing here changes the user's global configuration.
 */

const fs = require('node:fs');
const path = require('node:path');

const ACCOUNT_DIR_ARG = '--cindy-account-dir';
const KEY_ENV = 'DEEPSEEK_API_KEY';
const HOME_ENV = 'DSH_HOME';
const MAX_DIR_LENGTH = 4096;

/**
 * Reads `--cindy-account-dir <dir>` from the entry's argv (Cindy adds it after its other arguments).
 * Returns `null` without the argument, `{ dir }` with one usable value, `{ error }` otherwise.
 */
function accountDirFromArgv(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const at = [];
  args.forEach((arg, index) => {
    if (arg === ACCOUNT_DIR_ARG) at.push(index);
  });
  if (at.length === 0) return null;
  if (at.length > 1) return { error: `${ACCOUNT_DIR_ARG} was given more than once` };
  const dir = args[at[0] + 1];
  if (typeof dir !== 'string' || dir === '' || dir.startsWith('--')) return { error: `${ACCOUNT_DIR_ARG} has no directory` };
  return { dir };
}

/**
 * Why `dir` cannot be this account's DSH home, or null when it can. The directory must already
 * exist (Cindy creates it); with `writable`, a throw-away subdirectory proves DSH can write there.
 */
function accountDirProblem(dir, options) {
  if (typeof dir !== 'string' || dir === '' || dir.length > MAX_DIR_LENGTH || dir.includes('\0')) return 'the account directory is not a valid path';
  if (!path.isAbsolute(dir)) return 'the account directory is not an absolute path';
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'the account directory does not exist' : `the account directory cannot be read (${error && error.code ? error.code : 'error'})`;
  }
  if (!stat.isDirectory()) return 'the account path is not a directory';
  if (options && options.writable) {
    try {
      fs.rmdirSync(fs.mkdtempSync(path.join(dir, '.cindy-write-check-')));
    } catch (error) {
      return `the account directory is not writable (${error && error.code ? error.code : 'error'})`;
    }
  }
  return null;
}

/**
 * The environment of a dsh process that runs on the account in `dir`: `DSH_HOME` points there and
 * a `DEEPSEEK_API_KEY` inherited from the user's environment is removed, so the account's own
 * credential file is the only key dsh can find (an account never falls back to the user's login).
 * Names compare case-insensitively on Windows, where the environment does too.
 */
function accountEnv(env, dir, platform) {
  const win = (platform || process.platform) === 'win32';
  const same = (key, name) => (win ? key.toUpperCase() === name : key === name);
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || same(key, HOME_ENV) || same(key, KEY_ENV)) continue;
    out[key] = value;
  }
  out[HOME_ENV] = dir;
  return out;
}

module.exports = { ACCOUNT_DIR_ARG, accountDirFromArgv, accountDirProblem, accountEnv };
