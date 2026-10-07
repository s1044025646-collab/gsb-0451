// 手写状态转换核验 + 独立有理运算核验，不使用 eval 或表达式库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initialState, press, Key, KeyResult } from '../src/engine.js';
import { make, add, sub, mul, div, parseDecimal, toDisplay, toExactString } from '../src/rational.js';
import { Store } from '../src/store.js';

function run(keys: Key[]): KeyResult {
  const s = initialState();
  let r!: KeyResult;
  for (const k of keys) r = press(s, k);
  return r;
}

function runAll(keys: Key[]): KeyResult[] {
  const s = initialState();
  return keys.map((k) => press(s, k));
}

test('即时执行无优先级: 2+3*4= 得 20', () => {
  const r = run(['2', '+', '3', '*', '4', '=']);
  assert.equal(r.display, '20');
  assert.equal(r.exact, '20');
});

test('0.1+0.2= 精确为 3/10，显示 0.3 不舍入', () => {
  const r = run(['0', '.', '1', '+', '0', '.', '2', '=']);
  assert.equal(r.exact, '3/10');
  assert.equal(r.display, '0.3');
  assert.equal(r.displayRounded, false);
});

test('1/3*3= 内部精确回到 1', () => {
  const r = run(['1', '/', '3', '*', '3', '=']);
  assert.equal(r.exact, '1');
  assert.equal(r.display, '1');
});

test('1/3= 显示舍入并标记', () => {
  const r = run(['1', '/', '3', '=']);
  assert.equal(r.exact, '1/3');
  assert.equal(r.display, '0.333333333333');
  assert.equal(r.displayRounded, true);
});

test('7+*2= 连续运算符替换，得 14', () => {
  const r = run(['7', '+', '*', '2', '=']);
  assert.equal(r.display, '14');
});

test('5+= 无右操作数时用累计值，得 10', () => {
  const r = run(['5', '+', '=']);
  assert.equal(r.display, '10');
});

test('2+3== 重复等号得 8', () => {
  const results = runAll(['2', '+', '3', '=', '=']);
  assert.equal(results[3].display, '5');
  assert.equal(results[4].display, '8');
});

test('200+10%= 得 220（加减语义）', () => {
  const r = run(['2', '0', '0', '+', '1', '0', '%', '=']);
  assert.equal(r.display, '220');
});

test('200*10%= 得 20（乘除语义）', () => {
  const r = run(['2', '0', '0', '*', '1', '0', '%', '=']);
  assert.equal(r.display, '20');
});

test('200+10%== 得 240', () => {
  const results = runAll(['2', '0', '0', '+', '1', '0', '%', '=', '=']);
  assert.equal(results[7].display, '220');
  assert.equal(results[8].display, '240');
});

test('等号后按数字开始新计算并清除重复记录', () => {
  const results = runAll(['2', '+', '3', '=', '9', '=']);
  assert.equal(results[4].display, '9'); // 不是 14
  assert.equal(results[5].display, '9'); // 无重复记录，等号不变
});

test('等号后按运算符用结果继续，不误用旧右操作数', () => {
  const results = runAll(['2', '+', '3', '=', '+', '4', '=']);
  assert.equal(results[6].display, '9'); // 5+4
});

test('独立输入数等号保持值不变', () => {
  const r = run(['4', '2', '=']);
  assert.equal(r.display, '42');
});

test('CE 只清当前输入，保留累计与待运算', () => {
  const results = runAll(['5', '+', '3', 'CE', '2', '=']);
  assert.equal(results[3].display, '0');
  assert.equal(results[3].state.pendingOp, '+');
  assert.equal(results[3].state.acc, '5');
  assert.equal(results[5].display, '7'); // 5+2
});

test('CE 清除重复等号记录', () => {
  const results = runAll(['2', '+', '3', '=', 'CE', '=']);
  assert.equal(results[5].display, '0'); // CE 后输入 0，等号提交 0
});

test('C 清空全部状态', () => {
  const results = runAll(['5', '+', '3', 'C']);
  assert.equal(results[3].display, '0');
  assert.equal(results[3].state.pendingOp, null);
  assert.equal(results[3].state.acc, '0');
});

test('连续正负号切换，零不输出负零', () => {
  const results = runAll(['5', '±', '±', '±']);
  assert.equal(results[1].display, '-5');
  assert.equal(results[2].display, '5');
  assert.equal(results[3].display, '-5');
  const zero = runAll(['0', '±']);
  assert.equal(zero[1].display, '0');
});

test('正负号切换结果符号', () => {
  const results = runAll(['2', '+', '3', '=', '±']);
  assert.equal(results[4].display, '-5');
});

test('重复小数点被忽略但不致命，前导小数点视为零点', () => {
  const results = runAll(['.', '.', '5']);
  assert.equal(results[1].ignored, true);
  assert.equal(results[1].ignoreReason, 'DUPLICATE_DOT');
  assert.equal(results[2].display, '0.5');
});

test('输入时保留小数点与尾零', () => {
  const results = runAll(['1', '.', '0', '0']);
  assert.equal(results[3].display, '1.00');
});

test('除零进入错误状态，仅 C 可恢复', () => {
  const results = runAll(['1', '/', '0', '=', '5', 'C', '7']);
  assert.equal(results[3].error, 'DIV_BY_ZERO');
  assert.equal(results[4].ignored, true);
  assert.equal(results[4].ignoreReason, 'ERROR_STATE_LOCKED');
  assert.equal(results[4].error, 'DIV_BY_ZERO'); // 状态未变
  assert.equal(results[5].error, null); // C 恢复
  assert.equal(results[6].display, '7');
});

test('输入位数超限被忽略（非致命）', () => {
  const keys: Key[] = Array(16).fill('9') as Key[];
  const results = runAll(keys);
  assert.equal(results[14].accepted, true);
  assert.equal(results[15].ignored, true);
  assert.equal(results[15].ignoreReason, 'INPUT_DIGIT_LIMIT');
  assert.equal(results[15].error, null);
});

test('显示舍入：绝对值四舍五入且负数对称', () => {
  // 2/3 -> 0.666666666667；-2/3 -> -0.666666666667
  const pos = toDisplay(make(2n, 3n));
  const neg = toDisplay(make(-2n, 3n));
  assert.equal(pos.text, '0.666666666667');
  assert.equal(neg.text, '-0.666666666667');
  // 尾零去除
  assert.equal(toDisplay(make(1n, 2n)).text, '0.5');
  // 0.5 单位进位（half away from zero）
  assert.equal(toDisplay(make(5n, 10n ** 13n)).text, '0.000000000001');
});

test('独立有理运算核验（与引擎分离的手工计算）', () => {
  // 0.1 + 0.2
  const a = parseDecimal('0.1');
  const b = parseDecimal('0.2');
  assert.equal(toExactString(add(a, b)), '3/10');
  // (1/3)*3
  assert.equal(toExactString(mul(div(make(1n, 1n), make(3n, 1n)), make(3n, 1n))), '1');
  // 200 + 200*10/100
  const pct = div(mul(make(200n, 1n), make(10n, 1n)), make(100n, 1n));
  assert.equal(toExactString(add(make(200n, 1n), pct)), '220');
  // 减法与除法
  assert.equal(toExactString(sub(make(5n, 1n), make(8n, 1n))), '-3');
  assert.equal(toExactString(div(make(7n, 1n), make(2n, 1n))), '7/2');
});

// ---- 持久化与 API 层 ----
const TEST_DB = path.join('data', 'test-store.db');

function freshStore(): Store {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + suffix); } catch { /* 忽略 */ }
  }
  return new Store(TEST_DB);
}

test('Store: 幂等请求与序号冲突', () => {
  const store = freshStore();
  const { sessionId } = store.createSession();
  const r1 = store.submitKeys(sessionId, [{ seq: 1, requestId: 'req-1', key: '5' }]);
  assert.equal(r1[0].display, '5');
  // 重复请求返回原结果
  const r2 = store.submitKeys(sessionId, [{ seq: 1, requestId: 'req-1', key: '5' }]);
  assert.equal(r2[0].duplicate, true);
  assert.equal(r2[0].display, '5');
  // 序号冲突：同序号不同 requestId
  assert.throws(
    () => store.submitKeys(sessionId, [{ seq: 1, requestId: 'req-x', key: '6' }]),
    /SEQ_CONFLICT|序号/,
  );
  // 序号跳变
  assert.throws(
    () => store.submitKeys(sessionId, [{ seq: 5, requestId: 'req-5', key: '6' }]),
    /SEQ_GAP|跳变/,
  );
  // 正常继续
  const r3 = store.submitKeys(sessionId, [{ seq: 2, requestId: 'req-2', key: '+' }]);
  assert.equal(r3[0].state.pendingOp, '+');
  store.close();
});

test('Store: 中途重启后可继续输入', () => {
  const store1 = freshStore();
  const { sessionId } = store1.createSession();
  store1.submitKeys(sessionId, [
    { seq: 1, requestId: 'a', key: '2' },
    { seq: 2, requestId: 'b', key: '+' },
    { seq: 3, requestId: 'c', key: '3' },
  ]);
  store1.close();
  // 模拟重启：重新打开同一个数据库
  const store2 = new Store(TEST_DB);
  const r = store2.submitKeys(sessionId, [{ seq: 4, requestId: 'd', key: '=' }]);
  assert.equal(r[0].display, '5');
  const exp = store2.exportSession(sessionId);
  assert.equal(exp.keys.length, 4);
  assert.equal(exp.keys[3].result.display, '5');
  store2.close();
});

test('Store: 非法按键与未知会话', () => {
  const store = freshStore();
  const { sessionId } = store.createSession();
  assert.throws(() => store.submitKeys(sessionId, [{ seq: 1, requestId: 'x', key: 'sin' }]), /非法按键/);
  assert.throws(() => store.submitKeys('no-such', [{ seq: 1, requestId: 'x', key: '5' }]), /会话不存在/);
  store.close();
});
