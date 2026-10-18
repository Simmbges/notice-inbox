import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { InputError } from '../lib/notice-input.ts';

const derive = promisify(scrypt);
const day = 86400000;
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const sha256 = value => createHash('sha256').update(value).digest('hex');
let activeHashes = 0;

async function passwordHash(password, salt) {
  if (activeHashes >= 4) throw new InputError('登录服务繁忙，请稍后重试。', 429);
  activeHashes++;
  try { return await derive(password, salt, 64, scryptOptions); }
  finally { activeHashes--; }
}

export function createAuth(sqlite, secureCookies = false, cookieSuffix = '') {
  const cookieName = (secureCookies ? '__Host-zhi_session' : 'zhi_session') + cookieSuffix;
  const cookie = (token, maxAge = 7 * 86400) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const dummySalt = randomBytes(16).toString('hex');

  function limit(bucket, max, duration) {
    const now = Date.now();
    sqlite.prepare('DELETE FROM auth_limits WHERE expires_at <= ?').run(now);
    const entry = sqlite.prepare('INSERT INTO auth_limits (bucket, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END, expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING count').get(sha256(bucket), now + duration, now, now);
    if (entry.count > max) throw new InputError('尝试次数过多，请稍后再试。', 429);
  }

  function credentials(body) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new InputError('请输入有效的邮箱地址。');
    if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) throw new InputError('密码需要 12 至 128 个字符。');
    return { email, password: body.password };
  }

  function sessionToken(headers) {
    const matches = (headers.get('cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${cookieName}=`));
    return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : '';
  }

  function user(headers) {
    const token = sessionToken(headers);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new InputError('请先登录知会账号。', 401);
    const found = sqlite.prepare('SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?').get(sha256(token), Date.now());
    if (!found) throw new InputError('登录已过期，请重新登录。', 401);
    return found;
  }

  function newSession(account, previousHeaders) {
    const token = randomBytes(32).toString('base64url');
    const previous = sessionToken(previousHeaders);
    if (previous) sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(previous));
    sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(sha256(token), account.id, Date.now() + 7 * day);
    return { user: { id: account.id, email: account.email }, cookie: cookie(token) };
  }

  async function register(body, ip, headers) {
    const { email, password } = credentials(body);
    limit(`register:${ip}`, 5, 60 * 60 * 1000);
    const salt = randomBytes(16).toString('hex');
    const hash = await passwordHash(password, salt);
    const account = { id: `email:${randomUUID()}`, email };
    try { sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(account.id, email, `scrypt:32768:8:3:${salt}:${hash.toString('hex')}`, Date.now()); }
    catch (error) {
      if (error.message.includes('UNIQUE constraint')) throw new InputError('该邮箱无法注册，可尝试登录。', 409);
      throw error;
    }
    return newSession(account, headers);
  }

  async function login(body, ip, headers) {
    const { email, password } = credentials(body);
    limit(`login-ip:${ip}`, 30, 15 * 60 * 1000);
    limit(`login:${ip}:${email}`, 10, 15 * 60 * 1000);
    const account = sqlite.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
    const parts = account?.password_hash.split(':');
    const hash = await passwordHash(password, parts?.[4] || dummySalt);
    const expected = parts ? Buffer.from(parts[5], 'hex') : Buffer.alloc(64);
    if (!account || expected.length !== hash.length || !timingSafeEqual(hash, expected)) throw new InputError('邮箱或密码不正确。', 401);
    return newSession(account, headers);
  }

  function logout(headers) {
    const token = sessionToken(headers);
    if (token) sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return cookie('', 0);
  }

  function keys(owner) {
    return sqlite.prepare('SELECT id, name, prefix, created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt FROM agent_keys WHERE user_id = ? ORDER BY created_at DESC').all(owner);
  }

  function createKey(owner, name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new InputError('请输入 1 至 60 个字符的密钥名称。');
    const now = Date.now();
    if (sqlite.prepare('SELECT count(*) AS count FROM agent_keys WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?').get(owner, now).count >= 10) throw new InputError('最多保留 10 个有效密钥，请先撤销不用的密钥。');
    const token = `zhi_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID(), expiresAt = now + 90 * day;
    sqlite.prepare('INSERT INTO agent_keys (id, user_id, name, prefix, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, owner, name.trim(), token.slice(0, 12), sha256(token), now, expiresAt);
    return { id, token, expiresAt };
  }

  function revokeKey(owner, id) {
    const result = sqlite.prepare('UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(Date.now(), id, owner);
    if (!result.changes) throw new InputError('密钥不存在或已撤销。', 404);
  }

  function agent(headers) {
    const match = /^Bearer (zhi_[A-Za-z0-9_-]{43})$/.exec(headers.get('authorization') || '');
    if (!match) throw new InputError('请提供有效的 Agent 导入密钥。', 401);
    const key = sqlite.prepare('SELECT id, user_id FROM agent_keys WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?').get(sha256(match[1]), Date.now());
    if (!key) throw new InputError('Agent 导入密钥无效、已过期或已撤销。', 401);
    limit(`agent:${key.id}`, 60, 60000);
    sqlite.prepare('UPDATE agent_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), key.id);
    return key.user_id;
  }

  return { user, register, login, logout, keys, createKey, revokeKey, agent, limit };
}
