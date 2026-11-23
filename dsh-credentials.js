'use strict';

/**
 * DeepSeek API key through DSH's own credential store.
 *
 * DSH reads `DEEPSEEK_API_KEY` from its credential file (`$DSH_HOME/.credentials.yaml`, by default
 * `~/.dsh`), then the launch environment, then `.env` files. The plugin never edits that file by
 * hand: it loads the `@deepseek-ai/dsh-credentials-local` provider from the dsh installation it
 * found and calls describe / set / unset — the same path DSH's own settings use (cross-process
 * writer lock, owner-only file, comments and other entries kept). A saved key applies to the next
 * request of every dsh process, including the one Cindy runs, without a restart.
 *
 * Every operation takes an optional `{ dshHome }`: the DSH home of an account Cindy added (its
 * account directory, see account-dir.js). Without it the store is the user's own DSH home, exactly
 * as before. On an account only the key saved in that home's credential file counts: a key from
 * the environment belongs to the user's own login, and dsh never sees it on an account either.
 *
 * Values never leave this module: results carry only { configured, source, writable }, and an
 * account's status only a masked hint (`API Key ····abcd`) and a one-way fingerprint.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { pathToFileURL } = require('node:url');
const { resolveDsh } = require('./resolve-dsh.js');

const KEY_REF = 'DEEPSEEK_API_KEY';
const BASE_URL_REF = 'DEEPSEEK_BASE_URL';
const DSH_PACKAGE = '@deepseek-ai/dsh';
const READY_TIMEOUT_MS = 5000;
const MAX_KEY_LENGTH = 512;
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const OFFICIAL_ORIGIN = 'https://api.deepseek.com';

function packageName(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
  } catch {
    return null;
  }
}

/** The installed `@deepseek-ai/dsh` package behind a dsh executable or shim, or null. */
function findDshPackageDir(dshPath) {
  const binDir = path.dirname(dshPath);
  const candidates = [];
  // POSIX global installs link the bin straight to `<pkg>/lib/bin.js`.
  try {
    candidates.push(path.resolve(path.dirname(fs.realpathSync(dshPath)), '..'));
  } catch { /* unreadable path: try the shims below */ }
  // npm on Windows: `<prefix>/dsh.cmd` next to `<prefix>/node_modules`.
  candidates.push(path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh'));
  // npm prefix on POSIX: `<prefix>/bin` next to `<prefix>/lib/node_modules`.
  candidates.push(path.join(binDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  // npm / pnpm shims name the script they run; follow it.
  try {
    const text = fs.readFileSync(dshPath, 'utf8').slice(0, 8192);
    const match = text.match(/[^"'\s]*@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/);
    if (match) {
      const target = match[0]
        .replace(/^%~?dp0%?[\\/]?/i, binDir + path.sep)
        .replace(/^\$basedir[\\/]/, binDir + path.sep);
      candidates.push(path.resolve(binDir, path.dirname(path.dirname(target))));
    }
  } catch { /* binary or unreadable: no shim to follow */ }
  for (const dir of candidates) {
    if (packageName(dir) === DSH_PACKAGE) return path.resolve(dir);
  }
  return null;
}

/** `@deepseek-ai/<name>` as resolved from the dsh package (nested first, then hoisted). */
function findModule(pkgDir, name) {
  let dir = pkgDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function sourceOf(info) {
  if (!info || info.configured !== true) return undefined;
  if (info.source === 'file') return 'file';
  if (info.source === 'env') return 'env';
  return 'dotenv';
}

function statusOf(info) {
  const source = sourceOf(info);
  return {
    supported: true,
    configured: info && info.configured === true,
    ...(source ? { source } : {}),
    writable: info ? info.writable !== false : false,
  };
}

async function waitForStore(ctx, fiber) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (fiber && fiber.inertia) await fiber.inertia.catch(() => {});
    const store = (typeof ctx.get === 'function' ? ctx.get('credentials') : undefined) || ctx.credentials;
    if (store && typeof store.describe === 'function' && typeof store.set === 'function') return store;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Provider config for one operation: no file watcher, and the account's home when there is one. */
function providerConfig(options) {
  const dshHome = options && options.dshHome;
  return { watch: false, ...(dshHome ? { dshHome } : {}) };
}

/**
 * Opens DSH's credential store for one operation and closes it again. Returns
 * `{ supported: false, reason }` when dsh or a compatible store cannot be found.
 */
async function withStore(options, operation) {
  const dshPath = resolveDsh(options);
  if (!dshPath) return { supported: false, reason: 'not-installed' };
  const pkgDir = findDshPackageDir(dshPath);
  if (!pkgDir) return { supported: false, reason: 'unknown-layout' };
  const files = ['cordis', 'dsh-credentials', 'dsh-credentials-local'].map((name) => findModule(pkgDir, name));
  if (files.some((file) => !file)) return { supported: false, reason: 'unsupported-version' };
  const [cordis, credentials, local] = await Promise.all(files.map((file) => import(pathToFileURL(file).href)));
  if (
    typeof cordis.Context !== 'function' ||
    typeof credentials.credentialRef !== 'function' ||
    typeof local.LocalCredentialProvider !== 'function'
  ) {
    return { supported: false, reason: 'unsupported-version' };
  }
  const ctx = new cordis.Context();
  // No file watcher: this store lives for one operation; running dsh processes watch the file.
  const fiber = ctx.plugin(local.LocalCredentialProvider, providerConfig(options));
  try {
    const store = await waitForStore(ctx, fiber);
    if (!store) return { supported: false, reason: 'unsupported-version' };
    return await operation(store, credentials.credentialRef(KEY_REF), credentials.credentialRef);
  } finally {
    if (fiber && typeof fiber.dispose === 'function') await fiber.dispose().catch(() => {});
  }
}

function keyStatus(options) {
  return withStore(options, async (store, ref) => statusOf(await store.describe(ref)));
}

function isAccount(options) {
  return Boolean(options && options.dshHome);
}

/** The user's own DSH home as dsh resolves it: `DSH_HOME`, else `~/.dsh`. */
function defaultDshHome() {
  const configured = process.env.DSH_HOME;
  if (!configured) return path.join(os.homedir(), '.dsh');
  if (configured === '~' || configured.startsWith('~/') || configured.startsWith('~\\')) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}

/**
 * A value of the user's `<DSH home>/.env`, which dsh reads (with Node's `util.parseEnv`) below its
 * credential file and the environment. This plugin's one-shot store cannot see that layer; without
 * it a login that works in dsh would read as signed out.
 */
function homeDotenvValue(name) {
  if (typeof util.parseEnv !== 'function') return null;
  try {
    const file = path.join(defaultDshHome(), '.env');
    if (fs.statSync(file).size > 1024 * 1024) return null;
    const value = util.parseEnv(fs.readFileSync(file, 'utf8'))[name];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * `{ value, source }` as dsh would find it with this store: its credential file, then the
 * environment, and for the user's own login (not an `account`) also the home's `.env`.
 */
async function resolveSetting(store, ref, name, account) {
  const hit = await store.resolve(ref);
  if (hit && typeof hit.value === 'string' && hit.value) return hit;
  const value = account ? null : homeDotenvValue(name);
  return value ? { value, source: 'dotenv' } : null;
}

/**
 * The key dsh would use with this store, or null. On an account Cindy added (`fileOnly`) only a key
 * saved in the home's own credential file counts.
 */
async function resolveKey(store, ref, fileOnly) {
  const credential = await resolveSetting(store, ref, KEY_REF, fileOnly);
  if (!credential || (fileOnly && credential.source !== 'file')) return null;
  return credential.value;
}

/** Whether DSH talks to DeepSeek's official API with this store (no other `DEEPSEEK_BASE_URL`). */
async function usesOfficialApi(store, credentialRef, account) {
  const endpoint = await resolveSetting(store, credentialRef(BASE_URL_REF), BASE_URL_REF, account);
  if (!endpoint?.value) return true;
  try {
    return new URL(endpoint.value).origin === OFFICIAL_ORIGIN;
  } catch {
    return false;
  }
}

/** One call to DeepSeek's fixed balance endpoint: `{ status, balances? }`. */
async function requestBalance(key, request) {
  const response = await request(BALANCE_URL, {
    headers: { Authorization: 'Bearer ' + key }, redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return { status: response.status };
  const data = await response.json();
  if (!Array.isArray(data.balance_infos)) return { status: response.status };
  const balances = data.balance_infos.filter(row => row && ['CNY', 'USD'].includes(row.currency)
    && typeof row.total_balance === 'string' && /^-?\d{1,15}(?:\.\d{1,12})?$/.test(row.total_balance))
    .slice(0, 8).map(row => ({ currency: row.currency, amount: row.total_balance }));
  return { status: response.status, balances };
}

/** The credential stays inside the DSH worker and is sent only to DeepSeek's fixed balance endpoint. */
async function readUsage(options, request = fetch) {
  const result = await withStore(options, async (store, ref, credentialRef) => {
    if (!await usesOfficialApi(store, credentialRef, isAccount(options))) return null;
    const key = await resolveKey(store, ref, isAccount(options));
    if (!key) return null;
    const { balances } = await requestBalance(key, request);
    return balances && balances.length ? { updatedAt: Date.now(), balances } : null;
  });
  return result?.balances ? result : null;
}

/** A DeepSeek key is one token: no whitespace inside, bounded length. */
function normalizeKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) return null;
  return key;
}

/**
 * What Cindy may know about a signed-in key: a masked hint for the account list and a short,
 * one-way fingerprint that only recognises the same key added twice. Never the key itself.
 */
function signedInStatus(key) {
  const tail = key.slice(-4);
  const detail = key.length >= 12 && /^[\x21-\x7e]{4}$/.test(tail) ? 'API Key ····' + tail : 'API Key';
  const fingerprint = crypto.createHash('sha256').update('cindy-dsh-account\0' + key, 'utf8').digest('hex').slice(0, 16);
  return { state: 'signed-in', identity: { detail }, fingerprint };
}

/**
 * Cindy's `accountStatus`: `{ state: 'signed-in', identity, fingerprint }` when this home has a
 * DeepSeek key, `{ state: 'signed-out' }` when not, null when DSH's store cannot be used here.
 */
async function accountStatus(options) {
  const result = await withStore(options, async (store, ref) => {
    const key = await resolveKey(store, ref, isAccount(options));
    return { status: key ? signedInStatus(key) : { state: 'signed-out' } };
  });
  return result && result.status ? result.status : null;
}

/**
 * Cindy's `accountLogin` with the `api-key` method: checks the key's shape, asks DeepSeek's
 * balance endpoint whether it accepts it (only when DSH uses the official API; a network failure
 * does not block saving), then saves it as `DEEPSEEK_API_KEY` in this home's credential file.
 * Returns `{ ok: true }` or `{ ok: false, error, message? }`. The key is never logged or returned.
 */
async function loginWithKey(raw, options, request = fetch) {
  const key = normalizeKey(raw);
  // A key is sent in an HTTP header: printable ASCII only.
  if (!key || !/^[\x21-\x7e]+$/.test(key)) {
    return { ok: false, error: 'invalid-secret', message: 'A DeepSeek API key is one word without spaces, like sk-…' };
  }
  const result = await withStore(options, async (store, ref, credentialRef) => {
    if (await usesOfficialApi(store, credentialRef, isAccount(options))) {
      const check = await requestBalance(key, request).catch(() => null);
      if (check && (check.status === 401 || check.status === 403)) {
        return { ok: false, error: 'invalid-secret', message: 'DeepSeek did not accept this API key.' };
      }
    }
    await store.set(ref, key);
    const saved = await resolveKey(store, ref, true);
    return saved === key ? { ok: true } : { ok: false, error: 'failed', message: 'The key could not be saved in the DeepSeek Harness credential file.' };
  });
  if (result && result.supported === false) {
    return result.reason === 'not-installed'
      ? { ok: false, error: 'failed', message: 'DeepSeek Harness (dsh) is not installed on this computer.' }
      : { ok: false, error: 'unsupported', message: 'This DeepSeek Harness version does not let the plugin save a key.' };
  }
  return result;
}

async function setKey(rawKey, options) {
  const key = normalizeKey(rawKey);
  if (!key) return { supported: true, error: 'invalid-key' };
  return withStore(options, async (store, ref) => {
    await store.set(ref, key);
    return statusOf(await store.describe(ref));
  });
}

function clearKey(options) {
  return withStore(options, async (store, ref) => {
    await store.unset(ref);
    return statusOf(await store.describe(ref));
  });
}

module.exports = {
  KEY_REF, accountStatus, clearKey, findDshPackageDir, findModule, keyStatus, loginWithKey, normalizeKey, readUsage, setKey,
};
