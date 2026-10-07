// CLI：直接操作 SQLite 存储，无需启动 HTTP 服务。
// 用法:
//   node dist/src/cli.js new
//   node dist/src/cli.js key <sessionId> <key...>     （逐个按键，自动分配序号）
//   node dist/src/cli.js state <sessionId>
//   node dist/src/cli.js export <sessionId>
import { randomUUID } from 'node:crypto';
import { Store, KeyOutcome } from './store.js';

const dbPath = process.env.CALC_DB ?? 'data/calc.db';
const store = new Store(dbPath);

function printOutcome(o: KeyOutcome): void {
  const flags = [
    o.duplicate ? '重复请求' : null,
    o.ignored ? `被忽略(${o.ignoreReason})` : null,
    o.error ? `错误:${o.error}` : null,
    o.displayRounded ? '显示已舍入' : null,
  ].filter(Boolean).join(' ');
  console.log(
    `#${String(o.seq).padStart(3)} 键[${o.key}] 显示=${o.display} 精确=${o.exact} ` +
    `待运算=${o.state.pendingOp ?? '-'} 累计=${o.state.acc}` +
    (o.state.lastEq ? ` 重复等号=${o.state.lastEq.op}${o.state.lastEq.rhs}` : '') +
    (flags ? `  [${flags}]` : ''),
  );
  if (o.explanation) console.log(`      ${o.explanation}`);
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'new': {
      const { sessionId } = store.createSession();
      console.log(`新会话: ${sessionId}`);
      break;
    }
    case 'key': {
      const [sessionId, ...keys] = args;
      if (!sessionId || keys.length === 0) {
        console.error('用法: cli.js key <sessionId> <key...>');
        process.exitCode = 1;
        return;
      }
      const { lastSeq } = store.getState(sessionId);
      const requests = keys.map((key, i) => ({
        seq: lastSeq + i + 1,
        requestId: randomUUID(),
        key,
      }));
      const results = store.submitKeys(sessionId, requests);
      for (const r of results) printOutcome(r);
      break;
    }
    case 'state': {
      const [sessionId] = args;
      const st = store.getState(sessionId);
      console.log(JSON.stringify(st, null, 2));
      break;
    }
    case 'export': {
      const [sessionId] = args;
      console.log(JSON.stringify(store.exportSession(sessionId), null, 2));
      break;
    }
    default:
      console.error('用法: cli.js new | key <sessionId> <key...> | state <sessionId> | export <sessionId>');
      process.exitCode = 1;
  }
}

main();
store.close();
