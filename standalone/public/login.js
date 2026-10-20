'use strict';
let mode = 'login';
const form = document.getElementById('auth-form');
const errorBox = document.getElementById('auth-error');
const submit = document.getElementById('auth-submit');
for (const next of ['login', 'register']) document.getElementById(`tab-${next}`).addEventListener('click', () => {
  mode = next;
  document.getElementById('tab-login').setAttribute('aria-selected', String(mode === 'login'));
  document.getElementById('tab-register').setAttribute('aria-selected', String(mode === 'register'));
  document.getElementById('confirm-field').hidden = mode !== 'register';
  form.elements.confirmPassword.required = mode === 'register';
  form.elements.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  document.getElementById('auth-title').textContent = mode === 'register' ? '开启你的事件库' : '欢迎回到知会';
  document.getElementById('auth-subtitle').textContent = mode === 'register' ? '创建账号，将事件集中保存在自己名下。' : '使用邮箱和密码登录你的知会账号。';
  submit.textContent = mode === 'register' ? '创建账号并进入' : '登录知会 →';
  errorBox.hidden = true;
});
form.addEventListener('submit', async event => {
  event.preventDefault(); errorBox.hidden = true;
  const email = form.elements.email.value, password = form.elements.password.value;
  if (mode === 'register' && password !== form.elements.confirmPassword.value) { errorBox.textContent = '两次输入的密码不一致。'; errorBox.hidden = false; return; }
  submit.disabled = true;
  try {
    const response = await fetch(`/api/auth/${mode}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '暂时无法登录，请重试。');
    form.reset(); location.assign('/');
  } catch (error) { errorBox.textContent = error.name === 'TimeoutError' ? '请求超时，请稍后重试。' : error.message || '网络连接失败，请重试。'; errorBox.hidden = false; }
  finally { submit.disabled = false; }
});
