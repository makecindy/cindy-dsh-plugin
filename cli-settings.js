/* CLI maintenance controls shared by the plugin's local settings pages. */
window.createCliMaintenance = function (channel, refresh) {
  const root = document.getElementById('cli-maintenance');
  const action = document.getElementById('cli-action');
  const status = document.getElementById('cli-status');
  const strings = {
    'zh-CN': {
      install: '从官方安装', check: '检查 CLI 更新', update: '更新到 {version}', installing: '正在安装…',
      updating: '正在更新…', checking: '正在检查更新…', installed: '已安装 {version}',
      current: '已是最新版本（{version}）', newer: '官方版本 {version} 可用', unknown: '官方版本 {version}，无法比较本机版本。',
      missing: '本机尚未安装。', source: '无法连接官方发布源，请稍后重试。',
      integrity: '下载文件校验失败，请重试。', unsupported: '官方源不提供适用于这台电脑的安装包。',
      busy: '操作正在另一处进行，请稍后重试。', verify: '安装后仍未检测到目标版本，请重新检测。',
      operation: '安装或更新未完成，请重试。', 'node-required': '请先安装 Node.js 24.9 或更高版本（含 npm），再重试。',
      timeout: '未收到操作结果，请先重新检测。',
    },
    en: {
      install: 'Install from official source', check: 'Check for CLI updates', update: 'Update to {version}', installing: 'Installing…',
      updating: 'Updating…', checking: 'Checking for updates…', installed: 'Installed {version}',
      current: 'Up to date ({version})', newer: 'Official version {version} is available', unknown: 'Official version: {version}. Could not compare the installed version.',
      missing: 'Not installed on this computer.', source: 'Could not reach the official release source. Try again.',
      integrity: 'The download failed verification. Try again.', unsupported: 'The official source has no installer for this computer.',
      busy: 'An operation is already running. Try again later.', verify: 'The expected version was not detected after installation. Check again.',
      operation: 'Installation or update did not finish. Try again.', 'node-required': 'Install Node.js 24.9 or later with npm, then try again.',
      timeout: 'No result was received. Check the local CLI again.',
    },
  };
  let local = null;
  let locale = 'en';
  let result;
  let pending;
  let retry;
  let timer;

  function render() {
    const text = strings[locale];
    const missing = !['installed', 'current'].includes(result?.state) && (local?.reason === 'not-installed' || result?.state === 'missing');
    const next = missing ? 'install' : ['newer', 'unknown'].includes(result?.state) ? 'update' : 'check';
    const key = pending ? { install: 'installing', check: 'checking', update: 'updating' }[pending.action] :
      result?.error || result?.state;
    root.hidden = !local && !pending;
    action.dataset.action = next;
    action.textContent = text[next].replace('{version}', result?.version || '');
    action.disabled = !!pending || !channel;
    status.textContent = (text[key] || '').replace('{version}', result?.version || '');
  }

  function finish(value) {
    const shouldRefresh = value.state === 'installed' || (pending?.action !== 'check' && value.state === 'current');
    clearInterval(retry);
    clearTimeout(timer);
    pending = undefined;
    result = value;
    render();
    if (shouldRefresh) refresh();
  }

  channel?.addEventListener('message', ({ data }) => {
    if (!pending || data?.reqId !== pending.reqId) return;
    if (data.type === 'cli-ack') clearInterval(retry);
    if (data.type === 'cli-result') finish(data.result || { error: 'operation' });
  });
  action.addEventListener('click', () => {
    if (pending || !channel) return;
    const operation = action.dataset.action;
    pending = { type: 'cli-maintenance', reqId: crypto.randomUUID(), action: operation, version: result?.version };
    const send = () => channel.postMessage(pending);
    void fetch('/wake').catch(() => {});
    render();
    send();
    retry = setInterval(send, 650);
    timer = setTimeout(() => finish({ error: 'timeout' }), operation === 'check' ? 55000 : 855000);
  });

  return function renderMaintenance(status, language) {
    if (status && local && (status.version !== local.version || status.reason !== local.reason) && result?.state !== 'installed') {
      result = undefined;
    }
    if (status) local = status;
    locale = /^zh\b/i.test(language) ? 'zh-CN' : 'en';
    render();
  };
};
