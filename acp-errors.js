'use strict';

/**
 * Tells Cindy why a DeepSeek request failed, so it can cool the account and move the task to
 * another one (Cindy's engine accounts protocol: `error.data._meta.cindy = { kind }`).
 *
 * DSH ends a failed turn by answering `session/prompt` with JSON-RPC error -32603 and the message
 * `Internal error: turn failed: <reason>` (`… prompt was not queued: <reason>` when the prompt's
 * attachments could not be uploaded). Only the reason text reaches the wire: DeepSeek's own error
 * message, or DSH's message when no usable key is configured. Checked against
 * @deepseek-ai/dsh 0.2.2-rc.1 (dsh-acp `settleAfterQuiescence`, dsh-llm-deepseek `providerError`)
 * and live answers of api.deepseek.com:
 *   no key       -> `llm-deepseek: no API key for provider route "deepseek-official"; …`
 *   HTTP 401     -> `Authentication Fails, Your api key: ****abcd is invalid (request_id: …)`
 *   HTTP 402     -> `Insufficient Balance` (DeepSeek's documented text; DSH itself classifies it
 *                   with the same "insufficient balance" wording)
 *   HTTP 429/503 -> `Rate Limit Reached` / `Server Overloaded` (documented texts)
 *   no message   -> `DeepSeek Messages request failed (<status>)`
 * Anything else, and every other message, passes through byte for byte. A reason that is not
 * recognised stays an ordinary error, which is what Cindy did before.
 */

const FAILURE_PREFIX = /^Internal error: (?:turn failed|prompt was not queued): /;
const MAX_LINE_BYTES = 1024 * 1024;

const AUTH_REQUIRED = [
  /\bllm-deepseek: no API key for provider route\b/,
  /\bllm-deepseek: the API key resolved from\b/,
  /\bauthentication[\s_-]+fail/i,
  /\binvalid[\s_-]+(?:x-)?api[\s_-]+key\b/i,
  /\bDeepSeek Messages request failed \(40[13]\)/,
];
const USAGE_LIMIT = [
  /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i,
  /\bbalance[\s_-]+(?:is[\s_-]+)?(?:insufficient|exhausted|depleted)\b/i,
  /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i,
  /\bDeepSeek Messages request failed \(402\)/,
];
const OVERLOADED = [
  /\brate[\s_-]+limit(?:ed)?\b/i,
  /\btoo[\s_-]+many[\s_-]+requests\b/i,
  /\boverloaded\b/i,
  /\b(?:server|service)[\s_-]+(?:is[\s_-]+)?busy\b/i,
  /\bDeepSeek Messages request failed \((?:429|503|529)\)/,
];

/** The Cindy error kind for one JSON-RPC error object from dsh, or null. */
function classifyDshError(error) {
  if (!error || typeof error !== 'object' || error.code !== -32603 || typeof error.message !== 'string') return null;
  if (!FAILURE_PREFIX.test(error.message)) return null;
  const reason = error.message.replace(FAILURE_PREFIX, '');
  if (AUTH_REQUIRED.some((re) => re.test(reason))) return 'auth-required';
  if (USAGE_LIMIT.some((re) => re.test(reason))) return 'usage-limit';
  if (OVERLOADED.some((re) => re.test(reason))) return 'overloaded';
  return null;
}

const ERROR_MARK = Buffer.from('"error"');
const PREFIX_MARK = Buffer.from('Internal error: ');

/**
 * One line (including its `\n`) as it should reach Cindy: the same Buffer, or a new one when it is
 * a JSON-RPC error response DSH sent for a failed turn whose reason was recognised.
 */
function classifyLine(line) {
  if (line.length > MAX_LINE_BYTES || line.indexOf(ERROR_MARK) === -1 || line.indexOf(PREFIX_MARK) === -1) return line;
  let message;
  try {
    message = JSON.parse(line.toString('utf8'));
  } catch {
    return line;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.method !== undefined
    || message.id === undefined || !message.error || typeof message.error !== 'object') return line;
  const kind = classifyDshError(message.error);
  if (!kind) return line;
  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  // Only add to what dsh sent; data or _meta of another shape stays as it is.
  if (message.error.data !== undefined && !isRecord(message.error.data)) return line;
  const data = message.error.data || {};
  if (data._meta !== undefined && !isRecord(data._meta)) return line;
  const meta = data._meta || {};
  if (meta.cindy !== undefined) return line;
  const rewritten = { ...message, error: { ...message.error, data: { ...data, _meta: { ...meta, cindy: { kind } } } } };
  return Buffer.from(JSON.stringify(rewritten) + (line[line.length - 2] === 0x0d ? '\r\n' : '\n'), 'utf8');
}

/**
 * Relays dsh's stdout one line at a time: complete lines go out as soon as they arrive (in one
 * write when none needs a change), a partial line waits for its end. A line longer than
 * MAX_LINE_BYTES (a large tool result, never an error answer) is not held: once the partial line
 * passes the limit, what was buffered goes out and the rest of that line follows as it arrives,
 * unclassified, up to its newline. Either way the bytes and their order are exactly dsh's.
 * `write(buffer)` returns false for backpressure; `flush()` sends what is left when dsh's stdout ends.
 */
function createLineRelay(write) {
  // Chunks of the current partial line (at most MAX_LINE_BYTES), joined only once its end arrives.
  let pending = [];
  let pendingBytes = 0;
  // The current line went over MAX_LINE_BYTES: it streams through until its newline.
  let streaming = false;

  const writeLines = (complete) => {
    if (complete.indexOf(ERROR_MARK) === -1) return write(complete);
    let ok = true;
    let start = 0;
    let runStart = 0;
    while (start < complete.length) {
      const end = complete.indexOf(0x0a, start) + 1;
      const line = complete.subarray(start, end);
      const out = classifyLine(line);
      if (out !== line) {
        if (runStart < start) ok = write(complete.subarray(runStart, start)) && ok;
        ok = write(out) && ok;
        runStart = end;
      }
      start = end;
    }
    if (runStart < complete.length) ok = write(complete.subarray(runStart)) && ok;
    return ok;
  };

  const writePending = () => {
    let ok = true;
    for (const piece of pending) ok = write(piece) && ok;
    pending = [];
    pendingBytes = 0;
    return ok;
  };

  return {
    push(chunk) {
      let ok = true;
      let rest = chunk;
      if (streaming) {
        const end = rest.indexOf(0x0a);
        if (end === -1) return write(rest);
        ok = write(rest.subarray(0, end + 1)) && ok;
        streaming = false;
        rest = rest.subarray(end + 1);
      }
      const last = rest.lastIndexOf(0x0a);
      if (last !== -1) {
        const head = rest.subarray(0, last + 1);
        const complete = pending.length ? Buffer.concat([...pending, head]) : head;
        pending = [];
        pendingBytes = 0;
        ok = writeLines(complete) && ok;
        rest = rest.subarray(last + 1);
      }
      if (rest.length) {
        pending.push(rest);
        pendingBytes += rest.length;
        if (pendingBytes > MAX_LINE_BYTES) {
          ok = writePending() && ok;
          streaming = true;
        }
      }
      return ok;
    },
    flush() {
      streaming = false;
      return writePending();
    },
  };
}

module.exports = { MAX_LINE_BYTES, classifyDshError, classifyLine, createLineRelay };
