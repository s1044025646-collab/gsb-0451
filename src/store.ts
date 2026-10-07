// SQLite 持久化：会话、按键记录与状态原子保存，重启后可继续输入。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  CalcState, SerializedState, serialize, deserialize, initialState, press, isValidKey,
  KeyResult, Key,
} from './engine.js';
import { toDisplay, toExactString, parseDecimal } from './rational.js';

export type ErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'INVALID_KEY'
  | 'SEQ_CONFLICT'
  | 'SEQ_GAP'
  | 'INVALID_REQUEST';

export class ApiError extends Error {
  constructor(public code: ErrorCode, message: string, public httpStatus = 400) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface KeyRequest {
  seq: number;
  requestId: string;
  key: string;
}

export interface KeyOutcome extends KeyResult {
  seq: number;
  requestId: string;
  duplicate: boolean; // 重复请求，返回原结果
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS keys (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        key TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (session_id, seq),
        UNIQUE (session_id, request_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createSession(): { sessionId: string; state: SerializedState } {
    const id = randomUUID();
    const st = initialState();
    this.db.prepare('INSERT INTO sessions (id, state, last_seq, created_at) VALUES (?, ?, 0, ?)')
      .run(id, JSON.stringify(serialize(st)), new Date().toISOString());
    return { sessionId: id, state: serialize(st) };
  }

  private load(id: string): { state: CalcState; lastSeq: number } {
    const row = this.db.prepare('SELECT state, last_seq FROM sessions WHERE id = ?').get(id) as
      | { state: string; last_seq: number }
      | undefined;
    if (!row) throw new ApiError('SESSION_NOT_FOUND', `会话不存在: ${id}`, 404);
    return { state: deserialize(JSON.parse(row.state) as SerializedState), lastSeq: row.last_seq };
  }

  getState(id: string): { sessionId: string; lastSeq: number; state: SerializedState; view: KeyResult } {
    const { state, lastSeq } = this.load(id);
    return { sessionId: id, lastSeq, state: serialize(state), view: viewSnapshot(state) };
  }

  // 批量提交按键；每个按键独立幂等。整批在单事务中原子落盘。
  submitKeys(id: string, requests: KeyRequest[]): KeyOutcome[] {
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new ApiError('INVALID_REQUEST', 'keys 必须是非空数组');
    }
    for (const r of requests) {
      if (!Number.isInteger(r.seq) || r.seq < 1) {
        throw new ApiError('INVALID_REQUEST', `非法序号: ${String(r.seq)}`);
      }
      if (typeof r.requestId !== 'string' || r.requestId === '') {
        throw new ApiError('INVALID_REQUEST', 'requestId 必须是非空字符串');
      }
      if (!isValidKey(r.key)) {
        throw new ApiError('INVALID_KEY', `非法按键: ${String(r.key)}，合法值: 0-9 . + - * / = % CE C ±`);
      }
    }

    const { state, lastSeq } = this.load(id);
    const results: KeyOutcome[] = [];
    let expected = lastSeq;

    this.db.exec('BEGIN');
    try {
      for (const r of requests) {
        // 幂等：requestId 已存在则返回原结果
        const dup = this.db.prepare('SELECT seq, result FROM keys WHERE session_id = ? AND request_id = ?')
          .get(id, r.requestId) as { seq: number; result: string } | undefined;
        if (dup) {
          if (dup.seq !== r.seq) {
            throw new ApiError('SEQ_CONFLICT',
              `requestId ${r.requestId} 已绑定序号 ${dup.seq}，与本次 ${r.seq} 冲突`, 409);
          }
          const stored = JSON.parse(dup.result) as KeyOutcome;
          results.push({ ...stored, duplicate: true });
          expected = Math.max(expected, dup.seq);
          continue;
        }
        // 序号必须严格递增（= 上次 + 1）
        if (r.seq <= expected) {
          const existing = this.db.prepare('SELECT request_id FROM keys WHERE session_id = ? AND seq = ?')
            .get(id, r.seq) as { request_id: string } | undefined;
          if (existing) {
            throw new ApiError('SEQ_CONFLICT',
              `序号 ${r.seq} 已被 requestId ${existing.request_id} 占用，拒绝重放`, 409);
          }
          throw new ApiError('SEQ_CONFLICT', `序号 ${r.seq} 不大于已处理序号 ${expected}`, 409);
        }
        if (r.seq !== expected + 1) {
          throw new ApiError('SEQ_GAP', `序号跳变：期望 ${expected + 1}，收到 ${r.seq}`, 409);
        }
        const res = press(state, r.key as Key);
        const outcome: KeyOutcome = { ...res, seq: r.seq, requestId: r.requestId, duplicate: false };
        this.db.prepare('INSERT INTO keys (session_id, seq, request_id, key, result) VALUES (?, ?, ?, ?, ?)')
          .run(id, r.seq, r.requestId, r.key, JSON.stringify(outcome));
        results.push(outcome);
        expected = r.seq;
      }
      this.db.prepare('UPDATE sessions SET state = ?, last_seq = ? WHERE id = ?')
        .run(JSON.stringify(serialize(state)), expected, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return results;
  }

  // 完整回放导出：全部按键与每键结果
  exportSession(id: string): {
    sessionId: string;
    state: SerializedState;
    keys: Array<{ seq: number; requestId: string; key: string; result: KeyOutcome }>;
  } {
    const { state } = this.load(id);
    const rows = this.db.prepare('SELECT seq, request_id, key, result FROM keys WHERE session_id = ? ORDER BY seq')
      .all(id) as Array<{ seq: number; request_id: string; key: string; result: string }>;
    return {
      sessionId: id,
      state: serialize(state),
      keys: rows.map((r) => ({
        seq: r.seq,
        requestId: r.request_id,
        key: r.key,
        result: JSON.parse(r.result) as KeyOutcome,
      })),
    };
  }
}

// 构造当前状态视图（不改变状态）
function viewSnapshot(s: CalcState): KeyResult {
  const cur = s.error ? s.acc : (s.entryActive
    ? (s.entryValue !== null ? s.entryValue : s.entry === null ? { n: 0n, d: 1n } : parseDecimal(s.entry))
    : s.acc);
  let display: string;
  let rounded = false;
  if (!s.error && s.entryActive && s.entry !== null) {
    display = s.entry;
    if (display === '' || display === '-') display = display + '0';
    if (display.startsWith('.')) display = '0' + display;
    if (display.startsWith('-.')) display = '-0' + display.slice(1);
    if (parseDecimal(display).n === 0n && display.startsWith('-')) display = display.slice(1);
  } else {
    const d = toDisplay(cur);
    display = d.text;
    rounded = d.rounded;
  }
  return {
    key: '',
    accepted: true,
    ignored: false,
    ignoreReason: null,
    error: s.error,
    display,
    exact: toExactString(cur),
    displayRounded: rounded,
    state: {
      acc: toExactString(s.acc),
      entry: s.entry,
      pendingOp: s.pendingOp,
      lastEq: s.lastEq ? { op: s.lastEq.op, rhs: toExactString(s.lastEq.rhs) } : null,
    },
    explanation: '',
  };
}
