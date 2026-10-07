// HTTP API：会话管理、按键提交（含批量与逐键解释）、状态查看、回放导出。
import * as http from 'node:http';
import * as net from 'node:net';
import { Store, ApiError, KeyRequest } from './store.js';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

// 选取空闲端口
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

export async function startServer(dbPath: string, port?: number): Promise<{ port: number; close: () => void }> {
  const store = new Store(dbPath);
  const listenPort = port ?? (await pickFreePort());

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','sessions',':id','keys']

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        return sendJson(res, 201, store.createSession());
      }
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length >= 3) {
        const id = parts[2];
        if (req.method === 'GET' && parts.length === 3) {
          return sendJson(res, 200, store.getState(id));
        }
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'keys') {
          const body = JSON.parse(await readBody(req)) as { keys?: KeyRequest[] };
          if (!body || !Array.isArray(body.keys)) {
            throw new ApiError('INVALID_REQUEST', '请求体须为 {"keys":[{seq,requestId,key},...]}');
          }
          const results = store.submitKeys(id, body.keys);
          return sendJson(res, 200, { sessionId: id, results });
        }
        if (req.method === 'GET' && parts.length === 4 && parts[3] === 'export') {
          return sendJson(res, 200, store.exportSession(id));
        }
      }
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '路由不存在' } });
    } catch (e) {
      if (e instanceof ApiError) {
        return sendJson(res, e.httpStatus, { error: { code: e.code, message: e.message } });
      }
      if (e instanceof SyntaxError) {
        return sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: '请求体不是合法 JSON' } });
      }
      return sendJson(res, 500, { error: { code: 'INTERNAL', message: String(e) } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as net.AddressInfo;
  return { port: addr.port, close: () => { server.close(); store.close(); } };
}

// 直接运行：node dist/src/server.js [port]
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const portArg = process.argv[2] ? Number(process.argv[2]) : undefined;
  const dbPath = process.env.CALC_DB ?? 'data/calc.db';
  startServer(dbPath, portArg).then(({ port }) => {
    console.log(`计算器 API 已启动: http://127.0.0.1:${port}  (数据库: ${dbPath})`);
  });
}
