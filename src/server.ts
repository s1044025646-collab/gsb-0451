import * as http from "node:http";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { Store } from "./store";
import { press, initialState, EngineState, PressResult, VALID_KEYS } from "./engine";
import { formatDisplay, toStringExact, parseDecimal } from "./rational";

const DATA_DIR = process.env.CALC_DATA_DIR || path.join(process.cwd(), "data");
const store = new Store(DATA_DIR);

function stateView(state: EngineState) {
  let display: string;
  let exact: string;
  let displayRounded = false;
  if (state.entering && state.entryOverride === null) {
    display = state.input;
    exact = toStringExact(parseDecimal(state.input));
  } else if (state.entering && state.entryOverride !== null) {
    const f = formatDisplay(state.entryOverride);
    display = f.text;
    exact = toStringExact(state.entryOverride);
    displayRounded = f.rounded;
  } else {
    const f = formatDisplay(state.acc);
    display = f.text;
    exact = toStringExact(state.acc);
    displayRounded = f.rounded;
  }
  return {
    display,
    exact,
    displayRounded,
    acc: toStringExact(state.acc),
    pendingOp: state.pendingOp,
    input: state.input,
    entering: state.entering,
    lastEquals: state.lastEquals
      ? { op: state.lastEquals.op, rhs: toStringExact(state.lastEquals.rhs) }
      : null,
    error: state.error,
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

interface KeySubmission {
  requestId?: unknown;
  seq?: unknown;
  key?: unknown;
}

function validateSubmission(s: KeySubmission): { requestId: string; seq: number; key: string } | string {
  if (typeof s.requestId !== "string" || s.requestId.length === 0 || s.requestId.length > 128)
    return "requestId 必须是非空字符串（≤128 字符）";
  if (typeof s.seq !== "number" || !Number.isInteger(s.seq) || s.seq < 1)
    return "seq 必须是 ≥1 的整数";
  if (typeof s.key !== "string" || !VALID_KEYS.includes(s.key))
    return `key 必须是合法按键之一：${VALID_KEYS.join(" ")}`;
  return { requestId: s.requestId, seq: s.seq, key: s.key };
}

function handleKey(sessionId: string, sub: { requestId: string; seq: number; key: string }) {
  const sess = store.getSession(sessionId);
  if (!sess) return { status: 404, body: { error: "SESSION_NOT_FOUND", sessionId } };

  const dup = store.findByRequestId(sessionId, sub.requestId);
  if (dup) {
    return {
      status: 200,
      body: { duplicated: true, seq: dup.seq, key: dup.key, result: JSON.parse(dup.resultJson, reviverSafe) },
    };
  }
  if (sub.seq !== sess.nextSeq) {
    return {
      status: 409,
      body: { error: "SEQ_CONFLICT", expectedSeq: sess.nextSeq, gotSeq: sub.seq },
    };
  }
  const result: PressResult = press(sess.state, sub.key);
  store.commitKey(sessionId, sub.requestId, sub.seq, sub.key, result);
  return { status: 200, body: { duplicated: false, seq: sub.seq, key: sub.key, result } };
}

// 反序列化存储的结果（含 BigInt 标记）
function reviverSafe(_k: string, v: unknown): unknown {
  if (v !== null && typeof v === "object" && "$bigint" in (v as Record<string, unknown>)) {
    return (v as { $bigint: string }).$bigint; // 导出时以字符串呈现，避免恢复 BigInt 再序列化
  }
  return v;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "POST" && url.pathname === "/sessions") {
      const id = crypto.randomUUID();
      const state = initialState();
      store.createSession(id, state);
      return send(res, 201, { sessionId: id, nextSeq: 1, state: stateView(state) });
    }

    if (parts[0] === "sessions" && parts.length >= 2) {
      const sessionId = parts[1];

      if (req.method === "GET" && parts.length === 3 && parts[2] === "state") {
        const sess = store.getSession(sessionId);
        if (!sess) return send(res, 404, { error: "SESSION_NOT_FOUND" });
        return send(res, 200, { sessionId, nextSeq: sess.nextSeq, state: stateView(sess.state) });
      }

      if (req.method === "POST" && parts.length === 3 && parts[2] === "keys") {
        const body = JSON.parse(await readBody(req));
        const v = validateSubmission(body);
        if (typeof v === "string") return send(res, 400, { error: "VALIDATION_ERROR", message: v });
        const r = handleKey(sessionId, v);
        return send(res, r.status, r.body);
      }

      if (req.method === "POST" && parts.length === 4 && parts[2] === "keys" && parts[3] === "batch") {
        const body = JSON.parse(await readBody(req));
        if (!Array.isArray(body.keys)) {
          return send(res, 400, { error: "VALIDATION_ERROR", message: "keys 必须是数组" });
        }
        const outcomes = [];
        for (const item of body.keys) {
          const v = validateSubmission(item);
          if (typeof v === "string") {
            outcomes.push({ status: 400, body: { error: "VALIDATION_ERROR", message: v } });
            continue;
          }
          outcomes.push(handleKey(sessionId, v));
        }
        return send(res, 200, { sessionId, outcomes });
      }

      if (req.method === "GET" && parts.length === 3 && parts[2] === "export") {
        const sess = store.getSession(sessionId);
        if (!sess) return send(res, 404, { error: "SESSION_NOT_FOUND" });
        const keys = store.listKeys(sessionId).map((k) => ({
          seq: k.seq,
          requestId: k.requestId,
          key: k.key,
          createdAt: k.createdAt,
          result: JSON.parse(k.resultJson, reviverSafe),
        }));
        return send(res, 200, {
          sessionId,
          nextSeq: sess.nextSeq,
          state: stateView(sess.state),
          replay: keys,
        });
      }
    }

    return send(res, 404, { error: "NOT_FOUND" });
  } catch (e) {
    return send(res, 500, { error: "INTERNAL", message: String((e as Error).message) });
  }
});

const portEnv = process.env.PORT;
const port = portEnv ? Number(portEnv) : 0; // 默认选择空闲端口
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`计算器后端已启动: http://127.0.0.1:${actual}  数据目录: ${DATA_DIR}`);
});

process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});
