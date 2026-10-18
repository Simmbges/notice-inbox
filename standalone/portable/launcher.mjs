import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createControlServer, createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = realpathSync(dirname(fileURLToPath(import.meta.url)));
const dataDirectory = join(root, 'data');
const settingsFile = join(dataDirectory, 'launcher.json');
const instance = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24);
const controlPath = `\\\\.\\pipe\\zhihui-${instance}`;

function openBrowser(url) {
  if (process.argv.includes('--no-browser')) return;
  const browser = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [url], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log('浏览器未能自动打开，请复制上方地址访问。'));
  browser.unref();
}

function contactRunning(action) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlPath);
    let reply = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy(new Error('正在运行的知会未响应，请查看启动窗口。')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(action));
    socket.on('data', chunk => { reply += chunk; });
    socket.on('end', () => {
      try { resolve(JSON.parse(reply)); }
      catch { reject(new Error('无法读取运行状态，请查看启动窗口。')); }
    });
  });
}

function listen(server, ...address) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...address, () => { server.removeListener('error', reject); resolve(); });
  });
}

async function start() {
  let site, server, url, stopping = false;
  let ready;
  const whenReady = new Promise(resolve => { ready = resolve; });
  const control = createControlServer(socket => {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10000, () => socket.destroy());
    socket.once('data', async command => {
      await whenReady;
      socket.end(JSON.stringify({ url }));
      if (command.toString() === 'stop') await shutdown();
    });
  });
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    site?.database.close();
    control.close();
    console.log('知会已停止，账号和通知已保留在 data 文件夹。');
  }

  try { await listen(control, controlPath); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const running = await contactRunning('open');
    console.log(`知会已经运行，无需重复启动。\n访问地址：${running.url}`);
    openBrowser(running.url);
    return;
  }

  try {
    mkdirSync(dataDirectory, { recursive: true });
    const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
    const preferred = Number.isInteger(settings.port) && settings.port >= 1024 && settings.port <= 65515 ? settings.port : 4173;
    const { createApplication } = await import('./app/standalone/server.mjs');
    for (let port = preferred; port < preferred + 20; port++) {
      url = `http://127.0.0.1:${port}`;
      site = createApplication({ databaseFile: join(dataDirectory, 'notice-inbox.sqlite'), origin: url, cookieSuffix: `_${instance}` });
      server = createHttpServer(site.handler);
      server.requestTimeout = 20000;
      server.headersTimeout = 10000;
      try { await listen(server, port, '127.0.0.1'); break; }
      catch (error) { site.database.close(); site = null; if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; }
    }
    if (!server?.listening) throw new Error('端口被占用或受系统限制，请关闭其他知会副本后重试。');
    writeFileSync(settingsFile, JSON.stringify({ port: server.address().port }, null, 2));
    ready();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    console.log(`知会本地版已启动\n访问地址：${url}\n数据目录：${dataDirectory}\n请保留此窗口。停止时双击“停止知会.cmd”，或在此窗口按 Ctrl+C。`);
    openBrowser(url);
  } catch (error) {
    ready();
    await shutdown();
    throw error;
  }
}

try {
  if (process.argv.includes('--stop')) {
    try { await contactRunning('stop'); console.log('已发送停止请求，账号和通知会保留在 data 文件夹。'); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; console.log('这个启动包当前没有运行。'); }
  } else await start();
} catch (error) {
  console.error(`操作失败：${error.message}\n请确认已经完整解压，且当前文件夹可以写入。`);
  process.exitCode = 1;
}
