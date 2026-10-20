'use strict';
const accountElement = id => document.getElementById(id);
let keyLoading = false;
let newKeyPermission = 'import';
const dayText = value => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const permissionText = value => ({ import: '仅导入', read: '仅查询', read_import: '查询＋导入', manage: '时间管理' })[value] || '仅导入';
function updatePermissionHelp() {
  accountElement('key-permission-help').textContent = {
    import: '仅导入：让 Agent 保存你发来的事件，不能读取事件库。',
    read: '仅查询：可读取事件、事件时间表、个人任务、偏好与复盘，不能写入。',
    read_import: '查询＋导入：可读取当前账号的事件和时间管理数据，也能保存新事件；不能修改课程、任务或偏好。',
    manage: '时间管理：可读取、保存和调整个人任务、一次性日程、周期课表与偏好，也可更新事件时间事项；保留事件原文。仅授予可信 Agent。',
  }[accountElement('key-permission').value];
}
function switchKeyPanel(id) {
  document.querySelectorAll('[data-key-panel]').forEach(button => {
    const active = button.dataset.keyPanel === id;
    button.setAttribute('aria-pressed', String(active));
    accountElement(button.dataset.keyPanel).hidden = !active;
  });
}

async function accountRequest(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (response.status === 401) { location.assign('/login'); throw new Error('请重新登录。'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请重试。');
  return result;
}

async function showKeys() {
  if (keyLoading) return;
  keyLoading = true;
  try {
    const { keys } = await accountRequest('/api/agent-keys');
    const list = accountElement('key-list'); list.replaceChildren();
    if (!keys.length) { const empty = document.createElement('p'); empty.textContent = '还没有密钥，创建一个就能开始连接。'; list.append(empty); }
    for (const key of keys) {
      const row = document.createElement('div'); row.className = 'key-row';
      const info = document.createElement('div'), name = document.createElement('strong'), meta = document.createElement('small');
      name.textContent = key.name;
      const expired = key.expiresAt <= Date.now();
      meta.textContent = `${permissionText(key.permission)} · ${key.prefix}… · ${key.revokedAt ? '已撤销' : expired ? '已过期' : `有效至 ${dayText(key.expiresAt)}`} · ${key.lastUsedAt ? `最近使用 ${dayText(key.lastUsedAt)}` : '尚未使用'}`;
      info.append(name, meta); row.append(info);
      if (!key.revokedAt && !expired) {
        const revoke = document.createElement('button'); revoke.className = 'text-button'; revoke.textContent = '撤销'; revoke.setAttribute('aria-label', `撤销密钥：${key.name}`);
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try { await accountRequest(`/api/agent-keys/${encodeURIComponent(key.id)}`, 'DELETE'); accountElement('key-message').textContent = '密钥已撤销，Agent 已无法使用它查询或导入。'; await showKeys(); }
          catch (error) { accountElement('key-message').textContent = error.message; revoke.disabled = false; }
        });
        row.append(revoke);
      }
      list.append(row);
    }
  } finally { keyLoading = false; }
}

accountRequest('/api/account').then(({ user }) => { accountElement('account-email').textContent = user.email; }).catch(error => { accountElement('account-email').textContent = error.message; });
accountElement('logout-account').addEventListener('click', async () => {
  try { await accountRequest('/api/auth/logout', 'POST', {}); location.assign('/login'); }
  catch (error) { accountElement('account-email').textContent = error.message; }
});
document.addEventListener('notice:connect-agent', async () => {
  accountElement('key-mcp-address').value = `${location.origin}/mcp`;
  accountElement('key-http-address').value = `${location.origin}/api/agent/notices`;
  accountElement('key-message').textContent = '';
  switchKeyPanel('key-connect-panel');
  accountElement('key-dialog').showModal();
  try { await showKeys(); } catch (error) { accountElement('key-message').textContent = error.message; }
});
accountElement('close-keys').addEventListener('click', () => accountElement('key-dialog').close());
accountElement('key-dialog').addEventListener('close', () => { accountElement('new-key-token').value = ''; accountElement('new-key').hidden = true; accountElement('key-form').reset(); newKeyPermission = 'import'; updatePermissionHelp(); });
document.querySelectorAll('[data-key-panel]').forEach(button => button.addEventListener('click', () => switchKeyPanel(button.dataset.keyPanel)));
accountElement('key-permission').addEventListener('change', updatePermissionHelp);
accountElement('key-form').addEventListener('submit', async event => {
  event.preventDefault(); accountElement('create-key').disabled = true;
  try {
    const result = await accountRequest('/api/agent-keys', 'POST', { name: accountElement('key-name').value, permission: accountElement('key-permission').value });
    newKeyPermission = result.permission;
    accountElement('new-key-token').value = result.token; accountElement('new-key').hidden = false;
    accountElement('key-message').textContent = `密钥已创建，权限：${permissionText(result.permission)}。请复制后配置到你的 Agent。`;
    accountElement('key-form').reset(); updatePermissionHelp(); await showKeys();
  } catch (error) { accountElement('key-message').textContent = error.message; }
  finally { accountElement('create-key').disabled = false; }
});
accountElement('copy-key').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(accountElement('new-key-token').value); accountElement('key-message').textContent = '密钥已复制。'; }
  catch { accountElement('new-key-token').select(); accountElement('key-message').textContent = '请复制选中的密钥。'; }
});
accountElement('copy-key-address').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(accountElement('key-mcp-address').value); accountElement('key-message').textContent = '服务地址已复制。'; }
  catch { accountElement('key-mcp-address').select(); accountElement('key-message').textContent = '请复制选中的服务地址。'; }
});
accountElement('copy-key-config').addEventListener('click', async () => {
  const token = accountElement('new-key-token').value;
  if (!token) return;
  const reads = 'list_notices、get_notice、list_events、list_tasks、get_preferences、review_period';
  const tools = newKeyPermission === 'import' ? 'import_notices' : newKeyPermission === 'read' ? reads : newKeyPermission === 'read_import' ? 'import_notices、' + reads : 'import_notices、' + reads + '、import_events、update_event、change_event_occurrence、update_notice_events、create_task、update_task、update_preferences';
  const prompt = `请把知会连接到当前 Agent，保留其他已有配置。\n服务地址：${accountElement('key-mcp-address').value}\n传输方式：Streamable HTTP\n认证方式：Bearer Token\n密钥：${token}\n权限：${permissionText(newKeyPermission)}；工具：${tools}。\n安全保存密钥，不在回答或项目文件中复述。验证初始化和工具发现，不要为了测试而写入事件，不要扩大权限。\n连接成功后使用 zhihui-notices skill；缺少 skill 时告诉我安装位置。区分配置已写入、连接成功、当前会话已加载工具。`;
  try { await navigator.clipboard.writeText(prompt); accountElement('key-message').textContent = '配置提示词已复制（包含密钥），请只发给可信的 Agent。'; }
  catch { accountElement('new-key-token').select(); accountElement('key-message').textContent = '浏览器无法复制提示词，请手动复制地址和选中的密钥。'; }
});
