import * as path from "node:path";
import * as crypto from "node:crypto";
import { Store } from "./store";
import { press, initialState } from "./engine";
import { formatDisplay, toStringExact, parseDecimal } from "./rational";

const DATA_DIR = process.env.CALC_DATA_DIR || path.join(process.cwd(), "data");
const store = new Store(DATA_DIR);

function printState(sessionId: string): void {
  const sess = store.getSession(sessionId);
  if (!sess) {
    console.error("会话不存在: " + sessionId);
    process.exitCode = 1;
    return;
  }
  const s = sess.state;
  const disp = s.entering
    ? s.entryOverride
      ? formatDisplay(s.entryOverride).text
      : s.input
    : formatDisplay(s.acc).text;
  const exact = s.entering
    ? s.entryOverride
      ? toStringExact(s.entryOverride)
      : toStringExact(parseDecimal(s.input))
    : toStringExact(s.acc);
  console.log(`会话: ${sessionId}  nextSeq: ${sess.nextSeq}`);
  console.log(`显示: ${disp}   精确值: ${exact}`);
  console.log(`累计值: ${toStringExact(s.acc)}  待运算: ${s.pendingOp ?? "无"}  输入缓冲: '${s.input}'  entering=${s.entering}`);
  console.log(
    `重复等号记录: ${s.lastEquals ? `${s.lastEquals.op} ${toStringExact(s.lastEquals.rhs)}` : "无"}  错误: ${s.error ?? "无"}`,
  );
}

const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case "new": {
    const id = crypto.randomUUID();
    store.createSession(id, initialState());
    console.log(id);
    break;
  }
  case "key": {
    const [sessionId, ...keys] = args;
    if (!sessionId || keys.length === 0) {
      console.error("用法: cli key <sessionId> <按键...>");
      process.exitCode = 1;
      break;
    }
    for (const key of keys) {
      const sess = store.getSession(sessionId);
      if (!sess) {
        console.error("会话不存在: " + sessionId);
        process.exitCode = 1;
        break;
      }
      const result = press(sess.state, key);
      const seq = sess.nextSeq;
      store.commitKey(sessionId, crypto.randomUUID(), seq, key, result);
      console.log(
        `#${seq} '${key}' -> 显示 ${result.display}  精确 ${result.exact}  待运算 ${result.state.pendingOp ?? "无"}${result.ignored ? "  [已忽略]" : ""}${result.code ? "  [" + result.code + "]" : ""}`,
      );
    }
    break;
  }
  case "state": {
    printState(args[0]);
    break;
  }
  case "export": {
    const sessionId = args[0];
    const keys = store.listKeys(sessionId);
    const sess = store.getSession(sessionId);
    console.log(JSON.stringify({ sessionId, nextSeq: sess?.nextSeq, replay: keys.map((k) => ({ seq: k.seq, requestId: k.requestId, key: k.key, result: JSON.parse(k.resultJson) })) }, null, 2));
    break;
  }
  default:
    console.log(`用法:
  node dist/cli.js new                      新建会话
  node dist/cli.js key <sessionId> <键...>  提交按键（如 2 + 3 =）
  node dist/cli.js state <sessionId>        查看状态
  node dist/cli.js export <sessionId>       导出完整回放`);
}

store.close();
