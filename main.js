/*
 * DeepSeek Harness - logic page (browser sandbox, launch: resident).
 *
 * On start, and whenever the settings page asks, it runs the Node worker's `detect`
 * and publishes the result with `PUT /harnesses` so Cindy's model picker can show
 * DeepSeek Harness as available or explain how to install it. It never polls:
 * detection only runs on start, on settings-page open / visibility, and on
 * "Check again".
 *
 * Settings page protocol (BroadcastChannel 'dsh-acp'):
 *   page -> { type: 'detect-request', reqId }   (resent until acknowledged)
 *   main -> { type: 'detect-ack', reqId }
 *   main -> { type: 'detect-result', reqId, snapshot }
 *   main -> { type: 'locale-changed' }
 *   page -> { type: 'key-request', reqId, op: 'status' | 'set' | 'clear', key? }  (resent until acknowledged)
 *   main -> { type: 'key-ack', reqId }
 *   main -> { type: 'key-result', reqId, result }
 *
 * The DeepSeek API key passes through once on its way to the Node worker, which saves it in
 * DSH's own credential store. This page never keeps, logs or publishes it; results only say
 * whether a key is configured and where it comes from.
 */
(function () {
  'use strict';

  var CHANNEL_NAME = 'dsh-acp';
  var HARNESS_ID = 'dsh';
  var DETECT_TIMEOUT_MS = 30000;
  var MAX_REMEMBERED_REQUESTS = 32;
  // Listing starts dsh (about 10 s the first time); Cindy asks at most every 10 minutes per plugin.
  var MODELS_TIMEOUT_MS = 90000;
  var MODELS_MIN_INTERVAL_MS = 60000;
  var MAX_MODELS = 200;
  /** Cindy reasoning levels, low → high; the same set dsh-models.js reports. */
  var EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  var locale = 'en';
  var lastResult = null;
  var lastPublish = null;
  var lastError = null;
  var lastCheckedAt = 0;
  var inflight = null;
  var seenRequests = [];
  var channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
  // Coalesce settings checks. Drop a read
  // from the previous account if sign-in or credentials change mid-request.
  let usage = null;
  let usageWanted = false;
  let usageCheck = 0;
  let usageGeneration = 0;
  let usagePending = null;
  function announceUsage(checking = false) {
    if (channel) channel.postMessage({ type: 'harness-usage', usage, checking });
  }
  function clearUsage() {
    usageGeneration++;
    usageCheck = 0;
    usagePending = null;
    usage = null;
    announceUsage();
  }
  function refreshUsage() {
    if (!usageAvailable()) {
      usageWanted = true;
      return Promise.resolve();
    }
    usageWanted = false;
    if (usagePending) return usagePending;
    if (Date.now() - usageCheck < 60000) return Promise.resolve();
    usageCheck = Date.now();
    const generation = usageGeneration;
    usagePending = (async () => {
      let next = null;
      try {
        const response = await cindy.node.request({ method: 'usage', params: {}, timeoutMs: 26000 });
        if (response?.ok && (response.result?.windows?.length || response.result?.balances?.length)) next = response.result;
      } catch { /* Absence of billing data does not affect the engine. */ }
      if (generation !== usageGeneration || !usageAvailable()) return;
      usage = next;
      announceUsage();

    })().finally(() => { if (generation === usageGeneration) usagePending = null; });
    return usagePending;
  }
  function usageAvailable() { return !!(lastResult && lastResult.available); }

  /**
   * DSH's model list (published with the engine status, shown by Cindy like a provider's models)
   * and the plugin's one dedicated dsh session used to read it. Kept in the plugin's /kv so a
   * restart republishes the last list without starting dsh.
   */
  var models = null;
  var modelSessionId = null;
  var modelsListedAt = 0;
  var modelsInflight = null;

  function sanitizeModels(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < raw.length && out.length < MAX_MODELS; i++) {
      var item = raw[i] || {};
      var id = shortString(item.id, 256);
      var name = shortString(item.name, 200);
      if (!id || !name || seen[id]) continue;
      seen[id] = true;
      var model = { id: id, name: name };
      var description = shortString(item.description, 200);
      var group = shortString(item.group, 200);
      if (description) model.description = description;
      if (group) model.group = group;
      var efforts = Array.isArray(item.efforts)
        ? EFFORTS.filter(function (level) { return item.efforts.indexOf(level) !== -1; })
        : [];
      if (efforts.length) {
        model.efforts = efforts;
        if (efforts.indexOf(item.defaultEffort) !== -1) model.defaultEffort = item.defaultEffort;
      }
      out.push(model);
    }
    return out;
  }

  var stateLoaded = fetch('/kv')
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (saved) {
      if (!saved || typeof saved !== 'object') return;
      if (Array.isArray(saved.models)) models = sanitizeModels(saved.models);
      if (typeof saved.modelSessionId === 'string') modelSessionId = saved.modelSessionId.slice(0, 128);
      if (typeof saved.modelsListedAt === 'number') modelsListedAt = saved.modelsListedAt;
    })
    .catch(function () { /* start without a saved list */ });

  function saveState() {
    var state = { models: models || [], modelsListedAt: modelsListedAt };
    if (modelSessionId) state.modelSessionId = modelSessionId;
    return fetch('/kv', { method: 'PUT', body: JSON.stringify(state) }).catch(function () { /* best effort */ });
  }

  function pickLocale(context) {
    var value = context && (context.uiLocale || context.locale);
    return value === 'zh-CN' ? 'zh-CN' : 'en';
  }

  function refreshLocale() {
    return Promise.resolve()
      .then(function () { return cindy.request({ kind: 'app-context' }); })
      .then(function (response) {
        if (response && response.ok && response.context) locale = pickLocale(response.context);
      })
      .catch(function () { /* keep the previous language */ });
  }

  function shortString(value, max) {
    return typeof value === 'string' && value ? value.slice(0, max) : undefined;
  }

  /** Only metadata leaves the plugin: never the executable path or a command. */
  function harnessEntry(result) {
    var entry = { id: HARNESS_ID, available: result.available === true };
    if (entry.available) entry.reportsUsage = true;

    if (!entry.available) {
      entry.reason = result.reason === 'not-runnable' ? 'not-runnable' : 'not-installed';
      var messages = result.messages || {};
      var message = shortString(messages[locale], 200) || shortString(messages.en, 200) || shortString(result.message, 200);
      if (message) entry.message = message;
    }
    var version = shortString(result.version, 64);
    if (version) entry.version = version;
    if (entry.available && models && models.length) entry.models = models;
    return entry;
  }

  function publish(result) {
    return fetch('/harnesses', {
      method: 'PUT',
      body: JSON.stringify({ harnesses: [harnessEntry(result)] }),
    }).then(function (response) {
      if (response.ok) return { status: 'published' };
      // Older Cindy: no /harnesses endpoint, the request falls through to static files.
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        return { status: 'unsupported', httpStatus: response.status };
      }
      // This Cindy knows the endpoint but has not enabled the harnesses declaration
      // for this install (not approved yet, or the field is not recognized).
      if (response.status === 403) return { status: 'not-enabled', httpStatus: 403 };
      return { status: 'failed', httpStatus: response.status };
    }, function () {
      return { status: 'failed' };
    });
  }

  function sanitizeResult(raw) {
    var result = {
      available: raw.available === true,
      path: shortString(raw.path, 1024),
      version: shortString(raw.version, 64),
    };
    if (!result.available) {
      result.reason = raw.reason === 'not-runnable' ? 'not-runnable' : 'not-installed';
      result.message = shortString(raw.message, 200);
      result.messages = raw.messages && typeof raw.messages === 'object'
        ? { 'zh-CN': shortString(raw.messages['zh-CN'], 200), en: shortString(raw.messages.en, 200) }
        : undefined;
      result.detail = shortString(raw.detail, 300);
    }
    return result;
  }

  function snapshot() {
    return {
      ok: lastError === null && lastResult !== null,
      result: lastResult,
      publish: lastPublish,
      error: lastError,
      checkedAt: lastCheckedAt,
    };
  }

  function detect() {
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(function () {
        return cindy.node.request({ method: 'detect', params: { locale: locale }, timeoutMs: DETECT_TIMEOUT_MS });
      })
      .catch(function (error) {
        return { ok: false, message: String((error && error.message) || error) };
      })
      .then(function (response) {
        lastCheckedAt = Date.now();
        if (!response || response.ok !== true || !response.result || typeof response.result !== 'object') {
          // Detection itself failed (e.g. the Node runtime is unavailable). Publish
          // nothing: Cindy keeps the last state or "unknown" instead of a wrong answer.
          lastError = shortString(response && (response.message || response.errorCode), 300) || 'detect failed';
          return snapshot();
        }
        lastError = null;
        lastResult = sanitizeResult(response.result);
        if (!lastResult.available) clearUsage();
        else if (usageWanted) void refreshUsage();
        return publish(lastResult).then(function (published) {
          lastPublish = published;
          return snapshot();
        });
      })
      .then(function (value) {
        inflight = null;
        return value;
      }, function (error) {
        inflight = null;
        lastError = String((error && error.message) || error);
        return snapshot();
      });
    return inflight;
  }

  /**
   * Reads DSH's models (dsh-models.js) and republishes the engine status when the list changed.
   * mode: 'force' (settings "Check again", key saved), 'if-stale' (Cindy's picker refresh; at most
   * once a minute here, Cindy itself waits 10 minutes per plugin), 'if-missing' (start-up: only
   * when no list was saved). Only while dsh is detected as available; never blocks detection.
   */
  function refreshModels(mode) {
    if (!lastResult || !lastResult.available) return Promise.resolve();
    if (modelsInflight) return modelsInflight;
    if (mode === 'if-missing' && models && models.length) return Promise.resolve();
    if (mode === 'if-stale' && models && Date.now() - modelsListedAt < MODELS_MIN_INTERVAL_MS) return Promise.resolve();
    modelsInflight = Promise.resolve()
      .then(function () {
        return cindy.node.request({
          method: 'listModels',
          params: modelSessionId ? { sessionId: modelSessionId } : {},
          timeoutMs: MODELS_TIMEOUT_MS,
        });
      })
      .then(function (response) {
        var result = response && response.ok === true ? response.result : null;
        if (!result || result.supported !== true || !Array.isArray(result.models)) return undefined;
        var next = sanitizeModels(result.models);
        var changed = JSON.stringify(next) !== JSON.stringify(models || []);
        models = next;
        modelsListedAt = Date.now();
        if (typeof result.sessionId === 'string') modelSessionId = result.sessionId.slice(0, 128);
        saveState();
        if (!changed || !lastResult) return undefined;
        return publish(lastResult).then(function (published) { lastPublish = published; });
      })
      .catch(function () { /* keep the previous list */ })
      .then(function () { modelsInflight = null; });
    return modelsInflight;
  }

  function remember(reqId) {
    if (seenRequests.indexOf(reqId) !== -1) return false;
    seenRequests.push(reqId);
    if (seenRequests.length > MAX_REMEMBERED_REQUESTS) seenRequests.shift();
    return true;
  }

  var KEY_METHODS = { status: 'keyStatus', set: 'setKey', clear: 'clearKey' };

  /** Only these fields reach the settings page; anything else the worker returns is dropped. */
  function sanitizeKeyResult(raw) {
    if (!raw || typeof raw !== 'object') return { supported: true, error: 'store-failed' };
    if (raw.supported === false) {
      return { supported: false, reason: shortString(raw.reason, 64) || 'unsupported-version' };
    }
    if (typeof raw.error === 'string') {
      var failed = { supported: true, error: shortString(raw.error, 64) };
      var detail = shortString(raw.detail, 300);
      if (detail) failed.detail = detail;
      return failed;
    }
    var status = { supported: true, configured: raw.configured === true, writable: raw.writable !== false };
    if (raw.source === 'file' || raw.source === 'env' || raw.source === 'dotenv') status.source = raw.source;
    return status;
  }

  function runKeyRequest(op, key) {
    var params = op === 'set' ? { key: key } : {};
    return Promise.resolve()
      .then(function () {
        return cindy.node.request({ method: KEY_METHODS[op], params: params, timeoutMs: DETECT_TIMEOUT_MS });
      })
      .then(function (response) {
        if (!response || response.ok !== true) return { supported: true, error: 'worker-failed' };
        return sanitizeKeyResult(response.result);
      }, function () {
        return { supported: true, error: 'worker-failed' };
      });
  }

  const cliRequests = new Set();
  function handleCliMaintenance(data) {
    if (data?.type !== 'cli-maintenance') return false;
    if (typeof data.reqId !== 'string' || data.reqId.length > 64 ||
        !['check', 'install', 'update'].includes(data.action)) return true;
    const { reqId, action } = data;
    channel.postMessage({ type: 'cli-ack', reqId });
    if (cliRequests.has(reqId)) return true;
    cliRequests.add(reqId);
    if (cliRequests.size > 64) cliRequests.delete(cliRequests.values().next().value);
    void (async () => {
      let result;
      try {
        const response = await cindy.node.request({
          method: 'cliMaintenance', params: { action, version: typeof data.version === 'string' ? data.version.slice(0, 64) : undefined },
          timeoutMs: action === 'check' ? 50000 : 60000,
          ...(action === 'check' ? {} : { maxTotalMs: 840000 }),
        });
        if (response?.ok) {
          result = response.result;
          if (result?.state === 'installed') void detect();
        }
      } catch { /* Report a failed operation without exposing installer output. */ }
      channel.postMessage({ type: 'cli-result', reqId, result: result || { error: 'operation' } });
    })();
    return true;
  }
  if (channel) {
    channel.onmessage = function (event) {
      var data = event && event.data;
      if (handleCliMaintenance(data)) return;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'harness-usage-request') {
        announceUsage(usageAvailable() && !usage && (!usageCheck || !!usagePending));
        void refreshUsage();
        return;
      }
      if (typeof data.reqId !== 'string' || data.reqId.length > 64) return;
      if (data.type === 'detect-request') {
        channel.postMessage({ type: 'detect-ack', reqId: data.reqId });
        if (!remember(data.reqId)) return;
        detect().then(function (result) {
          channel.postMessage({ type: 'detect-result', reqId: data.reqId, snapshot: result });
          // "Check again" / settings opened: also re-read the model list (in the background),
          // at most once a minute so reopening the page does not keep starting dsh.
          refreshModels('if-stale');
        });
        return;
      }
      if (data.type === 'key-request' && Object.prototype.hasOwnProperty.call(KEY_METHODS, data.op)) {
        channel.postMessage({ type: 'key-ack', reqId: data.reqId });
        if (!remember(data.reqId)) return;
        var key = data.op === 'set' && typeof data.key === 'string' ? data.key.slice(0, 1024) : undefined;
        runKeyRequest(data.op, key).then(function (result) {
          channel.postMessage({ type: 'key-result', reqId: data.reqId, result: result });
          // The key decides which models DeepSeek offers: re-read the list after it changes.
          if (data.op !== 'status' && result && result.supported && !result.error) {
            clearUsage();
            if (lastResult) void publish(lastResult);
            void refreshUsage();
            refreshModels('force');
          }
        });
      }
    };
  }

  cindy.onHostMessage(function (message) {
    // Cindy opened a model picker (its provider-style refresh, with its own cooldown).
    if (message && message.type === 'harnesses-refresh-requested') {
      stateLoaded.then(detect).then(function () { return refreshModels('if-stale'); });
      return;
    }
    if (!message || message.type !== 'host-context-changed' || !message.context) return;
    var next = pickLocale(message.context);
    if (channel) channel.postMessage({ type: 'locale-changed' });
    if (next === locale) return;
    locale = next;
    // The stored install hint should follow Cindy's language; no new detection needed.
    if (lastResult && !lastResult.available) {
      publish(lastResult).then(function (published) { lastPublish = published; });
    }
  });

  // Start-up: republish with the saved model list; list from dsh only when none was saved yet.
  stateLoaded
    .then(refreshLocale)
    .then(detect)
    .then(function () { return refreshModels('if-missing'); });
})();
