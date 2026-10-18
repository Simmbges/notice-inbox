'use strict';
const accountElement = id => document.getElementById(id);
let keyLoading = false;
const dayText = value => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

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
      meta.textContent = `${key.prefix}… · ${key.revokedAt ? '已撤销' : expired ? '已过期' : `有效至 ${dayText(key.expiresAt)}`} · ${key.lastUsedAt ? `最近使用 ${dayText(key.lastUsedAt)}` : '尚未使用'}`;
      info.append(name, meta); row.append(info);
      if (!key.revokedAt && !expired) {
        const revoke = document.createElement('button'); revoke.className = 'text-button'; revoke.textContent = '撤销'; revoke.setAttribute('aria-label', `撤销密钥：${key.name}`);
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try { await accountRequest(`/api/agent-keys/${encodeURIComponent(key.id)}`, 'DELETE'); accountElement('key-message').textContent = '密钥已撤销，Agent 已无法使用它导入。'; await showKeys(); }
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
  accountElement('key-dialog').showModal();
  try { await showKeys(); } catch (error) { accountElement('key-message').textContent = error.message; }
});
accountElement('close-keys').addEventListener('click', () => accountElement('key-dialog').close());
accountElement('key-dialog').addEventListener('close', () => { accountElement('new-key-token').value = ''; accountElement('new-key').hidden = true; accountElement('key-form').reset(); });
accountElement('key-form').addEventListener('submit', async event => {
  event.preventDefault(); accountElement('create-key').disabled = true;
  try {
    const result = await accountRequest('/api/agent-keys', 'POST', { name: accountElement('key-name').value });
    accountElement('new-key-token').value = result.token; accountElement('new-key').hidden = false;
    accountElement('key-message').textContent = '密钥已创建，请复制后配置到你的 Agent。';
    accountElement('key-form').reset(); await showKeys();
  } catch (error) { accountElement('key-message').textContent = error.message; }
  finally { accountElement('create-key').disabled = false; }
});
accountElement('copy-key').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(accountElement('new-key-token').value); accountElement('key-message').textContent = '密钥已复制。'; }
  catch { accountElement('new-key-token').select(); accountElement('key-message').textContent = '请复制选中的密钥。'; }
});
