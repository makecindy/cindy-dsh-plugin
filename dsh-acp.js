'use strict';

/**
 * ACP engine entry for Cindy (`harnesses[].entry`).
 *
 * Cindy starts this file in raw-stdio mode, one process per task. It starts the
 * locally installed `dsh --profile acp` and relays its stdio:
 *   stdin  -> dsh stdin    (ACP JSON-RPC from Cindy, bytes unchanged)
 *   dsh stdout -> stdout   (ACP JSON-RPC to Cindy, line by line and byte for byte; only the error
 *                           answer of a turn that failed because of the DeepSeek account gains
 *                           `error.data._meta.cindy`, see acp-errors.js)
 *   dsh stderr -> stderr   (diagnostics, ends up in the plugin log)
 * When Cindy closes stdin, dsh's stdin is closed and dsh exits on its own; when dsh
 * exits, this process exits with the same code. When this process is asked to stop,
 * dsh (and on Windows its whole process tree) is stopped first so nothing is orphaned.
 *
 * Started with `--cindy-remote-workspace` (the task's files and commands are on another
 * computer), dsh runs with its own file and command tools switched off for this one
 * process; see remote-workspace.js. Nothing in the user's dsh profile is changed.
 *
 * Started with `--cindy-account-dir <dir>` (the task runs on an account Cindy added), that
 * directory is `DSH_HOME` of this one dsh process: its DeepSeek key, the settings it writes and
 * its session history live there, never in the user's own login (account-dir.js). A directory
 * that cannot be used stops the launch; it never falls back to the user's login.
 */

const os = require('node:os');
const { resolveDsh, spawnDsh, killTree } = require('./resolve-dsh.js');
const remoteWorkspace = require('./remote-workspace.js');
const { accountDirFromArgv, accountDirProblem, accountEnv } = require('./account-dir.js');
const { createLineRelay } = require('./acp-errors.js');

/** dsh normally exits right after stdin closes; force it if it lingers. */
const STDIN_END_GRACE_MS = 5_000;
/** Cindy escalates to a hard kill 2 s after asking us to stop; stay inside that. */
const SIGNAL_GRACE_MS = 1_500;
const FLUSH_TIMEOUT_MS = 2_000;
const NOT_FOUND_EXIT_CODE = 127;
/** Remote-workspace mode could not be established; dsh was not started. */
const REMOTE_WORKSPACE_EXIT_CODE = 78;
/** The account directory Cindy passed cannot be used; dsh was not started. */
const ACCOUNT_DIR_EXIT_CODE = 77;
const LOCAL_ARGS = Object.freeze(['--profile', 'acp']);

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

function run(dshPath, args, cwd, options) {
  const guest = Boolean(options && options.guest);
  const env = options && options.env;
  let child;
  try {
    child = spawnDsh(dshPath, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) });
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
    if (!guest) process.stdin.unpipe(child.stdin);
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

  // Byte-for-byte relay for local and same-account launches; in guest-workspace mode,
  // block `session/list` so an invited user can never enumerate the sharer's local sessions.
  if (guest) {
    let pending = [];
    process.stdin.on('data', (chunk) => {
      if (finished || childExited) return;
      let start = 0;
      let index;
      while ((index = chunk.indexOf(0x0a, start)) !== -1) {
        const piece = chunk.subarray(start, index + 1);
        const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
        pending = [];
        start = index + 1;
        let parsed = null;
        try { parsed = JSON.parse(line.toString('utf8')); } catch { parsed = null; }
        if (parsed && typeof parsed === 'object' && parsed.method === 'session/list') {
          if (parsed.id !== undefined) {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              error: { code: -32601, message: 'session/list is not available for shared sessions' },
            }) + '\n');
          }
          continue;
        }
        if (!child.stdin.write(line)) {
          process.stdin.pause();
          child.stdin.once('drain', () => process.stdin.resume());
        }
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    });
    process.stdin.on('end', () => {
      try { child.stdin.end(); } catch { /* ignore */ }
    });
  } else {
    process.stdin.pipe(child.stdin);
  }
  child.stdin.on('error', () => {
    // EPIPE after dsh exited; the exit handler takes care of shutting down.
  });
  // Every byte dsh writes is handed to stdout before dsh's stdout ends (so before 'close'), like
  // the pipe it replaces; a line is only held back until its newline arrives.
  const relay = createLineRelay((bytes) => process.stdout.write(bytes));
  child.stdout.on('data', (chunk) => {
    if (!relay.push(chunk)) {
      child.stdout.pause();
      process.stdout.once('drain', () => child.stdout.resume());
    }
  });
  child.stdout.on('end', () => relay.flush());
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

/**
 * The project is on another computer: start dsh only once its own file and command tools are
 * confirmed off for this launch. Any doubt ends here, before dsh sees a single message.
 */
function runRemoteWorkspace(dshPath, guest, env) {
  let dir;
  try {
    dir = remoteWorkspace.prepareLaunchDir(undefined, { guest });
  } catch (error) {
    exitAfterStderr(`[dsh-acp] Could not prepare the remote-workspace launch (${describe(error)}). DeepSeek Harness was not started.`, REMOTE_WORKSPACE_EXIT_CODE);
    return;
  }
  process.on('exit', () => remoteWorkspace.removeLaunchDir(dir));
  // On an account Cindy added, the check reads the configuration of that account's DSH home: the
  // one the real launch below will use.
  remoteWorkspace.verifyRemoteWorkspace(spawnDsh, dshPath, dir, undefined, { guest, ...(env ? { env } : {}) }).then((check) => {
    if (!check.ok) {
      exitAfterStderr(`[dsh-acp] DeepSeek Harness cannot run a task whose files are on another computer: ${check.detail}. It was not started.`, REMOTE_WORKSPACE_EXIT_CODE);
      return;
    }
    run(dshPath, remoteWorkspace.launchArgsFor({ guest }), dir, { guest, env });
  });
}

function start(env) {
  const dshPath = resolveDsh();
  if (!dshPath) {
    exitAfterStderr(
      '[dsh-acp] DeepSeek Harness (dsh) was not found on this computer. Install it with "npm i -g @deepseek-ai/dsh" (requires Node.js 24.9 or later), then start the task again.',
      NOT_FOUND_EXIT_CODE,
    );
  } else if (remoteWorkspace.isRemoteWorkspaceLaunch(process.argv)) {
    runRemoteWorkspace(dshPath, remoteWorkspace.isGuestWorkspaceLaunch(process.argv), env);
  } else {
    run(dshPath, LOCAL_ARGS, undefined, { env });
  }
}

// Without `--cindy-account-dir` dsh uses the user's own login exactly as before (env undefined).
const account = accountDirFromArgv(process.argv);
const accountProblem = account && (account.error || accountDirProblem(account.dir, { writable: true }));
if (accountProblem) {
  exitAfterStderr(
    `[dsh-acp] Cannot run DeepSeek Harness on the account Cindy chose: ${accountProblem}. It was not started and does not fall back to your own DeepSeek login.`,
    ACCOUNT_DIR_EXIT_CODE,
  );
} else {
  start(account ? accountEnv(process.env, account.dir) : undefined);
}
