import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { press, initialState, EngineState, PressResult } from "../src/engine";
import { Store } from "../src/store";

function runKeys(keys: string[], start?: EngineState): PressResult {
  let s = start ?? initialState();
  let r: PressResult = press(s, keys[0]);
  for (const k of keys) {
    r = press(s, k);
    s = r.state;
  }
  return r;
}

test("即时执行无优先级：2+3*4= = 20", () => {
  const r = runKeys(["2", "+", "3", "*", "4", "="]);
  assert.equal(r.display, "20");
  assert.equal(r.exact, "20/1");
});

test("0.1+0.2= 精确为 3/10", () => {
  const r = runKeys(["0", ".", "1", "+", "0", ".", "2", "="]);
  assert.equal(r.exact, "3/10");
  assert.equal(r.display, "0.3");
  assert.equal(r.displayRounded, false);
});

test("1÷3×3= 内部精确回到 1", () => {
  const r = runKeys(["1", "/", "3", "*", "3", "="]);
  assert.equal(r.exact, "1/1");
  assert.equal(r.display, "1");
});

test("1÷3= 显示舍入并标记", () => {
  const r = runKeys(["1", "/", "3", "="]);
  assert.equal(r.display, "0.333333333333");
  assert.equal(r.displayRounded, true);
  assert.equal(r.exact, "1/3");
});

test("运算符替换：7+×2= = 14", () => {
  const r = runKeys(["7", "+", "*", "2", "="]);
  assert.equal(r.display, "14");
});

test("5+= = 10（无右操作数用累计值）", () => {
  const r = runKeys(["5", "+", "="]);
  assert.equal(r.display, "10");
});

test("重复等号：2+3== = 8", () => {
  const r = runKeys(["2", "+", "3", "=", "="]);
  assert.equal(r.display, "8");
});

test("百分号加减：200+10%= = 220，再 = 得 240", () => {
  const r1 = runKeys(["2", "0", "0", "+", "1", "0", "%", "="]);
  assert.equal(r1.display, "220");
  const r2 = runKeys(["2", "0", "0", "+", "1", "0", "%", "=", "="]);
  assert.equal(r2.display, "240");
});

test("百分号乘除：200×10%= = 20", () => {
  const r = runKeys(["2", "0", "0", "*", "1", "0", "%", "="]);
  assert.equal(r.display, "20");
});

test("无待运算时百分号：50% = 0.5", () => {
  const r = runKeys(["5", "0", "%"]);
  assert.equal(r.display, "0.5");
});

test("等号后按数字开始新计算并清除重复记录", () => {
  // 2+3= 得 5，按 7 开始新计算，再 = 保持 7（旧 +3 不得复用）
  const r = runKeys(["2", "+", "3", "=", "7", "="]);
  assert.equal(r.display, "7");
});

test("等号后按运算符用结果继续，不误用旧右操作数", () => {
  // 2+3= 得 5，×2= 得 10（而非用 3）
  const r = runKeys(["2", "+", "3", "=", "*", "2", "="]);
  assert.equal(r.display, "10");
});

test("独立输入无待运算时等号保持值不变", () => {
  const r = runKeys(["4", "2", "="]);
  assert.equal(r.display, "42");
});

test("CE 清空当前输入但保留累计值与待运算", () => {
  const r = runKeys(["5", "+", "3", "CE", "2", "="]);
  assert.equal(r.display, "7");
});

test("CE 清除重复等号记录", () => {
  // 2+3= 得 5，CE 后 = 不再重复 +3
  const r = runKeys(["2", "+", "3", "=", "CE", "="]);
  assert.equal(r.display, "5");
});

test("连续正负号与负零", () => {
  const r1 = runKeys(["5", "±", "±", "±"]);
  assert.equal(r1.display, "-5");
  const r2 = runKeys(["0", "±"]);
  assert.equal(r2.display, "0");
  const r3 = runKeys(["5", "-", "5", "=", "±"]);
  assert.equal(r3.display, "0");
});

test("重复小数点被忽略（非致命），前导小数点视为 0.", () => {
  const r = runKeys(["1", ".", ".", "5"]);
  assert.equal(r.display, "1.5");
  const r2 = runKeys([".", "5"]);
  assert.equal(r2.display, "0.5");
  const dup = press(press(initialState(), "1").state, ".");
  const dup2 = press(dup.state, ".");
  assert.equal(dup2.ignored, true);
  assert.equal(dup2.ok, true);
});

test("输入中保留小数点与尾零", () => {
  const r = runKeys(["1", ".", "0", "0"]);
  assert.equal(r.display, "1.00");
  assert.equal(r.exact, "1/1");
});

test("除零进入错误状态，仅 C 可恢复", () => {
  const r = runKeys(["1", "/", "0", "="]);
  assert.equal(r.code, "DIV_BY_ZERO");
  assert.equal(r.state.error, "DIV_BY_ZERO");
  // 其他按键被拒绝且状态不变
  const r2 = press(r.state, "5");
  assert.equal(r2.code, "ERROR_STATE");
  assert.equal(r2.state.error, "DIV_BY_ZERO");
  // C 恢复
  const r3 = press(r2.state, "C");
  assert.equal(r3.state.error, null);
  assert.equal(r3.display, "0");
  const r4 = press(r3.state, "9");
  assert.equal(r4.display, "9");
});

test("非法按键返回 KEY_INVALID 且状态不变", () => {
  const r = press(initialState(), "x");
  assert.equal(r.code, "KEY_INVALID");
  assert.equal(r.ignored, true);
  assert.equal(r.display, "0");
});

test("输入有效数字超限进入精度错误", () => {
  const keys = Array(31).fill("9");
  const r = runKeys(keys);
  assert.equal(r.code, "PRECISION_BUDGET");
});

test("显示舍入对称：-1÷3", () => {
  const r = runKeys(["1", "±", "/", "3", "="]);
  assert.equal(r.display, "-0.333333333333");
});

test("持久化：提交按键后重启可接着输入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calc-test-"));
  const store = new Store(dir);
  store.createSession("s1", initialState());
  let sess = store.getSession("s1")!;
  const r1 = press(sess.state, "2");
  store.commitKey("s1", "req-1", 1, "2", r1);
  const r2 = press(r1.state, "+");
  store.commitKey("s1", "req-2", 2, "+", r2);
  store.close();

  // 模拟重启
  const store2 = new Store(dir);
  sess = store2.getSession("s1")!;
  assert.equal(sess.nextSeq, 3);
  const r3 = press(sess.state, "3");
  store2.commitKey("s1", "req-3", 3, "3", r3);
  const r4 = press(r3.state, "=");
  store2.commitKey("s1", "req-4", 4, "=", r4);
  assert.equal(r4.display, "5");
  assert.equal(store2.listKeys("s1").length, 4);
  store2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("幂等：重复 requestId 返回原结果，序号冲突被拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calc-test-"));
  const store = new Store(dir);
  store.createSession("s2", initialState());
  const sess = store.getSession("s2")!;
  const r1 = press(sess.state, "5");
  assert.equal(store.commitKey("s2", "req-a", 1, "5", r1), "ok");
  // 重复 requestId
  assert.equal(store.commitKey("s2", "req-a", 1, "5", r1), "duplicate");
  const dup = store.findByRequestId("s2", "req-a")!;
  assert.equal(dup.seq, 1);
  // 序号冲突（新 requestId 但 seq 不是 2）
  const r2 = press(r1.state, "6");
  assert.equal(store.commitKey("s2", "req-b", 5, "6", r2), "seq_conflict");
  // 冲突未写入
  assert.equal(store.findByRequestId("s2", "req-b"), null);
  assert.equal(store.getSession("s2")!.nextSeq, 2);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
