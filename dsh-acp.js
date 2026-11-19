'use strict';

/**
 * ACP engine entry for Cindy (`harnesses[].entry`).
 *
 * Cindy starts this file in raw-stdio mode, one process per task. It starts the
 * locally installed `dsh --profile acp` and relays bytes unchanged:
 *   stdin  -> dsh stdin    (ACP JSON-RPC from Cindy)
 *   dsh stdout -> stdout   (ACP JSON-RPC to Cindy; this file never writes stdout itself)
 *   dsh stderr -> stderr   (diagnostics, ends up in the plugin log)
 * When Cindy closes stdin, dsh's stdin is closed and dsh exits on its own; when dsh
 * exits, this process exits with the same code. When this process is asked to stop,
 * dsh (and on Windows its whole process tree) is stopped first so nothing is orphaned.
 */

const os = require('node:os');
const { resolveDsh, spawnDsh, killTree } = require('./resolve-dsh.js');

/** dsh normally exits right after stdin closes; force it if it lingers. */
const STDIN_END_GRACE_MS = 5_000;
/** Cindy escalates to a hard kill 2 s after asking us to stop; stay inside that. */
const SIGNAL_GRACE_MS = 1_500;
const FLUSH_TIMEOUT_MS = 2_000;
const NOT_FOUND_EXIT_CODE = 127;

function exitAfterStderr(line, code) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    process.exit(code);
  };
  try {
    process.stderr.write(line + '\n', finish);
  } catch {
    finish();
  }
  setTimeout(finish, 1_000);
}

function describe(error) {
  if (!error) return 'unknown error';
  return error.code ? `${error.code}: ${error.message}` : String(error.message || error);
}

function exitCodeFor(code, signal) {
  if (typeof code === 'number') return code;
  if (signal && os.constants.signals[signal]) return 128 + os.constants.signals[signal];
  return 1;
}

function run(dshPath) {
  let child;
  try {
    child = spawnDsh(dshPath, ['--profile', 'acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    exitAfterStderr(`[dsh-acp] Could not start DeepSeek Harness at ${dshPath} (${describe(error)}).`, NOT_FOUND_EXIT_CODE);
    return;
  }

  let childExited = false;
  let finished = false;
  let stopCode = null;
  let forceTimer = null;

  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(forceTimer);
    process.stdin.unpipe(child.stdin);
    const done = () => process.exit(code);
    if (process.stdout.writableLength > 0) {
      process.stdout.once('drain', done);
      setTimeout(done, FLUSH_TIMEOUT_MS);
    } else {
      done();
    }
  };

  const terminate = () => {
    if (childExited) return;
    if (process.platform === 'win32') {
      killTree(child);
      return;
    }
    killTree(child, 'SIGTERM');
    setTimeout(() => {
      if (!childExited) killTree(child, 'SIGKILL');
    }, SIGNAL_GRACE_MS).unref();
  };

  const stop = (signal) => {
    if (stopCode !== null) return;
    stopCode = 128 + (os.constants.signals[signal] || os.constants.signals.SIGTERM);
    terminate();
    setTimeout(() => finish(stopCode), SIGNAL_GRACE_MS + 300).unref();
  };

  child.on('error', (error) => {
    if (child.pid === undefined) {
      // Never started (missing file, permission denied): there will be no exit event.
      childExited = true;
      finished = true;
      exitAfterStderr(`[dsh-acp] Could not start DeepSeek Harness at ${dshPath} (${describe(error)}).`, NOT_FOUND_EXIT_CODE);
      return;
    }
    process.stderr.write(`[dsh-acp] DeepSeek Harness process error: ${describe(error)}\n`);
  });

  child.on('exit', (code, signal) => {
    childExited = true;
    const status = stopCode !== null ? stopCode : exitCodeFor(code, signal);
    // Let the remaining stdout bytes reach Cindy, but don't wait forever for pipes
    // that a grandchild may still hold open.
    const closeTimer = setTimeout(() => finish(status), FLUSH_TIMEOUT_MS);
    child.once('close', () => {
      clearTimeout(closeTimer);
      finish(status);
    });
  });

  // Byte-for-byte relay. No encoding is set anywhere, so chunks stay Buffers.
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {
    // EPIPE after dsh exited; the exit handler takes care of shutting down.
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  process.stdin.on('end', () => {
    // pipe() has already ended dsh's stdin; dsh treats that as disconnect.
    if (childExited || forceTimer) return;
    forceTimer = setTimeout(terminate, STDIN_END_GRACE_MS);
    forceTimer.unref();
  });
  process.stdout.on('error', () => {
    // Cindy stopped reading: nobody can receive ACP output any more.
    stop('SIGTERM');
  });

  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  for (const signal of signals) process.on(signal, () => stop(signal));
  process.on('disconnect', () => stop('SIGTERM'));
  process.on('uncaughtException', (error) => {
    try {
      process.stderr.write(`[dsh-acp] internal error: ${describe(error)}\n`);
    } catch {
      // ignore
    }
    stop('SIGTERM');
  });
  // Last line of defence for any exit path: never leave dsh running.
  process.on('exit', () => {
    if (!childExited) killTree(child, 'SIGKILL');
  });
}

const dshPath = resolveDsh();
if (dshPath) {
  run(dshPath);
} else {
  exitAfterStderr(
    '[dsh-acp] DeepSeek Harness (dsh) was not found on this computer. Install it with "npm i -g @deepseek-ai/dsh" (requires Node.js 24.9 or later), then start the task again.',
    NOT_FOUND_EXIT_CODE,
  );
}
