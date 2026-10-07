import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { EngineState, PressResult } from "./engine";

export interface StoredKey {
  sessionId: string;
  seq: number;
  requestId: string;
  key: string;
  resultJson: string;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "calc.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        next_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS keys (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq),
        UNIQUE (session_id, request_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createSession(id: string, state: EngineState): void {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO sessions (id, state_json, next_seq, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
      .run(id, JSON.stringify(state, bigintReplacer), now, now);
  }

  getSession(id: string): { state: EngineState; nextSeq: number } | null {
    const row = this.db
      .prepare("SELECT state_json, next_seq FROM sessions WHERE id = ?")
      .get(id) as { state_json: string; next_seq: number } | undefined;
    if (!row) return null;
    return { state: JSON.parse(row.state_json, bigintReviver) as EngineState, nextSeq: row.next_seq };
  }

  findByRequestId(sessionId: string, requestId: string): StoredKey | null {
    const row = this.db
      .prepare("SELECT * FROM keys WHERE session_id = ? AND request_id = ?")
      .get(sessionId, requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id as string,
      seq: row.seq as number,
      requestId: row.request_id as string,
      key: row.key as string,
      resultJson: row.result_json as string,
      createdAt: row.created_at as string,
    };
  }

  /**
   * 原子提交一个按键：校验序号、写入按键记录、更新会话状态。
   * 返回 'ok' | 'duplicate' | 'seq_conflict'
   */
  commitKey(
    sessionId: string,
    requestId: string,
    seq: number,
    key: string,
    result: PressResult,
  ): "ok" | "duplicate" | "seq_conflict" {
    const existing = this.findByRequestId(sessionId, requestId);
    if (existing) return "duplicate";
    const sess = this.getSession(sessionId);
    if (!sess) throw new Error("SESSION_NOT_FOUND");
    if (seq !== sess.nextSeq) return "seq_conflict";
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO keys (session_id, seq, request_id, key, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionId, seq, requestId, key, JSON.stringify(result, bigintReplacer), now);
      this.db
        .prepare("UPDATE sessions SET state_json = ?, next_seq = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result.state, bigintReplacer), seq + 1, now, sessionId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return "ok";
  }

  listKeys(sessionId: string): StoredKey[] {
    const rows = this.db
      .prepare("SELECT * FROM keys WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      sessionId: row.session_id as string,
      seq: row.seq as number,
      requestId: row.request_id as string,
      key: row.key as string,
      resultJson: row.result_json as string,
      createdAt: row.created_at as string,
    }));
  }
}

export function bigintReplacer(_k: string, v: unknown): unknown {
  if (typeof v === "bigint") return { $bigint: v.toString() };
  return v;
}

export function bigintReviver(_k: string, v: unknown): unknown {
  if (v !== null && typeof v === "object" && "$bigint" in (v as Record<string, unknown>)) {
    return BigInt((v as { $bigint: string }).$bigint);
  }
  return v;
}
