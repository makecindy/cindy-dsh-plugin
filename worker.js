'use strict';

/**
 * Node worker (json-rpc-stdio). One JSON-RPC 2.0 object per line in each direction;
 * stdout carries protocol messages only.
 *
 * Methods:
 *   detect({ locale? }) -> { available, path?, version?, reason?, message?, messages?, detail? }
 *     Finds the local dsh executable and checks that `dsh --version` runs. `message`
 *     is in the requested locale ('zh-CN' or English); `messages` carries both.
 *   keyStatus() / setKey({ key }) / clearKey()
 *     -> { supported: true, configured, source?: 'file' | 'env' | 'dotenv', writable }
 *      | { supported: false, reason } | { supported: true, error, detail? }
 *     DeepSeek API key in DSH's own credential store (see dsh-credentials.js). The key
 *     value is never returned or logged.
 *   listModels({ sessionId? })
 *     -> { supported: true, models: [{ id, name, description?, group? }], sessionId? }
 *      | { supported: false, reason } | { supported: true, error, detail? }
 *     Asks dsh for its models over ACP in the plugin's one dedicated session (see dsh-models.js).
 *   cliMaintenance({ action, version?, op? }) -> { state, version } | { error }
 *     Checks, installs or updates dsh from npm (see cli-installer.cjs). While installing it sends
 *     `progress` keep-alives and `cli-progress` { op, events } notifications for the settings page.
 *   usage({ harnessId?, accountDir? }) -> { updatedAt, balances } | null
 *     DeepSeek balance of the user's own login, or of the account Cindy added in `accountDir`.
 *
 * Engine accounts (Cindy calls these for harness `dsh`; see account-dir.js). No `accountDir` means
 * the user's own DSH login, which is also what the settings page edits:
 *   accountStatus({ harnessId, accountDir? })
 *     -> null | { state: 'signed-in' | 'signed-out', identity?: { detail }, fingerprint? }
 *   accountLogin({ harnessId, accountDir?, methodId: 'api-key', secret })
 *     -> { ok: true } | { ok: false, error, message? }   (saves the key in that home's DSH store)
 *   accountLoginCancel({ harnessId, accountDir? }) -> { ok: true }   (a key has nothing to wait for)
 */

const readline = require('node:readline');
const maintain = require('./cli-installer.cjs');
const { detectDsh } = require('./resolve-dsh.js');
const { accountDirProblem } = require('./account-dir.js');
const { accountStatus, clearKey, keyStatus, loginWithKey, readUsage, setKey } = require('./dsh-credentials.js');
const { listModels } = require('./dsh-models.js');

const HARNESS_ID = 'dsh';
const ACCOUNT_METHOD_ID = 'api-key';
const LOGIN_MESSAGE_MAX = 200;

/** Store failures (unreadable file, lock timeout) as data; DSH diagnostics never quote values. */
function storeFailure(error) {
  const detail = error && error.message ? String(error.message).slice(0, 300) : undefined;
  return { supported: true, error: 'store-failed', ...(detail ? { detail } : {}) };
}

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function replyError(id, code, message) {
  reply({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * The DSH home a call is about: `{}` for the user's own login (no `accountDir`), `{ dshHome }` for
 * an account Cindy added, or null when the call is not for this engine or names an unusable
 * directory (Cindy creates it before any call).
 */
function homeOf(params, harnessRequired) {
  const harnessId = params && params.harnessId;
  if (harnessRequired ? harnessId !== HARNESS_ID : harnessId !== undefined && harnessId !== HARNESS_ID) return null;
  const accountDir = params && params.accountDir;
  if (accountDir === undefined) return {};
  return accountDirProblem(accountDir) ? null : { dshHome: accountDir };
}

/** A login message as plain text, never carrying the key that was typed. */
function loginMessage(text, secret) {
  let message = String(text || '');
  if (typeof secret === 'string' && secret.trim()) message = message.split(secret.trim()).join('[key]');
  // eslint-disable-next-line no-control-regex
  message = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return message.length > LOGIN_MESSAGE_MAX ? message.slice(0, LOGIN_MESSAGE_MAX - 1) + '…' : message;
}

/** One balance read per DSH home at a time (`''` = the user's own login). */
const usageReads = new Map();
function forgetUsage(home) {
  usageReads.delete((home && home.dshHome) || '');
}

const handlers = {
  cliMaintenance(params) {
    return maintain(params, (method, data) => reply({ jsonrpc: '2.0', method, ...(data ? { params: data } : {}) }));
  },
  usage(params) {
    const home = homeOf(params, false);
    if (!home) return null;
    const slot = home.dshHome || '';
    if (!usageReads.has(slot)) {
      const read = readUsage(home.dshHome ? home : undefined).catch(() => null).finally(() => {
        if (usageReads.get(slot) === read) usageReads.delete(slot);
      });
      usageReads.set(slot, read);
    }
    return usageReads.get(slot);
  },
  async accountStatus(params) {
    const home = homeOf(params, true);
    if (!home) return null;
    return accountStatus(home.dshHome ? home : undefined).catch((error) => {
      // DSH's store errors name the file, never a value.
      process.stderr.write(`[dsh-acp worker] accountStatus could not read the DeepSeek key: ${loginMessage(error && error.message)}\n`);
      return null;
    });
  },
  async accountLogin(params) {
    const secret = params && params.secret;
    if (!params || params.harnessId !== HARNESS_ID || params.methodId !== ACCOUNT_METHOD_ID) return { ok: false, error: 'unsupported' };
    const home = homeOf(params, true);
    if (!home) return { ok: false, error: 'failed', message: 'The account folder Cindy prepared cannot be used.' };
    forgetUsage(home);
    try {
      const result = await loginWithKey(secret, home.dshHome ? home : undefined);
      if (result.ok) return { ok: true };
      return { ok: false, error: result.error, ...(result.message ? { message: loginMessage(result.message, secret) } : {}) };
    } catch (error) {
      process.stderr.write(`[dsh-acp worker] accountLogin could not save the DeepSeek key: ${loginMessage(error && error.message, secret)}\n`);
      return { ok: false, error: 'failed', message: loginMessage(error && error.message, secret) || 'The key could not be saved.' };
    } finally {
      forgetUsage(home);
    }
  },
  async accountLoginCancel() {
    // A key is saved at once; there is no sign-in waiting to be cancelled.
    return { ok: true };
  },
  async detect(params) {
    const locale = params && typeof params.locale === 'string' ? params.locale : undefined;
    return detectDsh({ locale });
  },
  async keyStatus() {
    return keyStatus().catch(storeFailure);
  },
  async setKey(params) {
    forgetUsage();
    return setKey(params && params.key).catch(storeFailure);
  },
  async clearKey() {
    forgetUsage();
    return clearKey().catch(storeFailure);
  },
  async listModels(params) {
    return listModels(params).catch((error) => ({
      supported: true,
      error: 'list-failed',
      detail: String((error && error.message) || error).slice(0, 300),
    }));
  },
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    replyError(null, -32700, 'Parse error');
    return;
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    replyError(null, -32600, 'Invalid request');
    return;
  }
  const hasId = Object.prototype.hasOwnProperty.call(request, 'id') && request.id !== null;
  if (typeof request.method !== 'string') {
    if (hasId) replyError(request.id, -32600, 'Invalid request');
    return;
  }
  const handler = Object.prototype.hasOwnProperty.call(handlers, request.method) ? handlers[request.method] : null;
  if (!handler) {
    if (hasId) replyError(request.id, -32601, 'Method not found');
    return;
  }
  Promise.resolve()
    .then(() => handler(request.params))
    .then(
      (result) => {
        if (hasId) reply({ jsonrpc: '2.0', id: request.id, result });
      },
      (error) => {
        process.stderr.write(`[dsh-acp worker] ${request.method} failed: ${error && error.message ? error.message : error}\n`);
        if (hasId) replyError(request.id, -32603, `DeepSeek Harness ${request.method} failed`);
      },
    );
});

input.on('close', () => {
  process.exit(0);
});
