// 即时执行计算器按键状态机。
// 状态分离保存：当前输入(entry)、累计值(acc)、待执行运算符(pendingOp)、
// 最近一次等号操作(lastEq)。不使用任何表达式求值。
import {
  Rat, zero, add, sub, mul, div, neg, parseDecimal, toDisplay, toExactString,
  DivZeroError, LimitExceededError,
} from './rational.js';

export type Op = '+' | '-' | '*' | '/';

export interface CalcState {
  acc: Rat;                 // 累计值 / 左操作数 / 最近一次结果
  pendingOp: Op | null;     // 待执行运算符
  entry: string | null;     // 正在输入的原始按键串（保留小数点与尾零）
  entryActive: boolean;     // 是否处于输入状态
  entryValue: Rat | null;   // 百分号换算产生的精确输入值（优先于 entry 字符串）
  lastEq: { op: Op; rhs: Rat } | null; // 最近一次等号记录（用于重复等号）
  error: string | null;     // 错误码；非空时仅 C 可恢复
}

export function initialState(): CalcState {
  return { acc: zero, pendingOp: null, entry: null, entryActive: false, entryValue: null, lastEq: null, error: null };
}

// 输入有效数字上限（不含符号与小数点）
export const MAX_INPUT_DIGITS = 15;

export const KEYS = ['0','1','2','3','4','5','6','7','8','9','.','+','-','*','/','=','%','CE','C','±'] as const;
export type Key = (typeof KEYS)[number];

export function isValidKey(k: string): k is Key {
  return (KEYS as readonly string[]).includes(k);
}

export interface KeyResult {
  key: string;
  accepted: boolean;        // 按键是否改变了状态
  ignored: boolean;         // 按键被忽略（如重复小数点、超出输入位数、错误状态下非 C 键）
  ignoreReason: string | null;
  error: string | null;     // 当前错误码
  display: string;          // 显示值
  exact: string;            // 精确分数
  displayRounded: boolean;  // 显示是否发生舍入
  state: {
    acc: string;
    entry: string | null;
    pendingOp: Op | null;
    lastEq: { op: Op; rhs: string } | null;
  };
  explanation: string;      // 逐键解释
}

function applyOp(a: Rat, op: Op, b: Rat): Rat {
  switch (op) {
    case '+': return add(a, b);
    case '-': return sub(a, b);
    case '*': return mul(a, b);
    case '/': return div(a, b);
  }
}

function entryRat(s: CalcState): Rat {
  if (s.entryValue !== null) return s.entryValue;
  return s.entry === null ? zero : parseDecimal(s.entry);
}

function currentRat(s: CalcState): Rat {
  return s.entryActive ? entryRat(s) : s.acc;
}

function snapshot(s: CalcState, key: string, accepted: boolean, ignored: boolean,
  ignoreReason: string | null, explanation: string): KeyResult {
  const cur = s.error ? s.acc : currentRat(s);
  // 输入状态下原样显示输入串（保留小数点与尾零）
  let display: string;
  let rounded = false;
  if (!s.error && s.entryActive && s.entry !== null) {
    display = s.entry;
    if (display === '' || display === '-') display = display + '0';
    if (display.startsWith('.')) display = '0' + display;
    if (display.startsWith('-.')) display = '-0' + display.slice(1);
    // 负零不显示负号
    if (parseDecimal(display).n === 0n && display.startsWith('-')) display = display.slice(1);
  } else {
    const d = toDisplay(cur);
    display = d.text;
    rounded = d.rounded;
  }
  return {
    key,
    accepted,
    ignored,
    ignoreReason,
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
    explanation,
  };
}

function countInputDigits(entry: string): number {
  return entry.replace(/[-.]/g, '').length;
}

function fail(s: CalcState, code: string): void {
  s.error = code;
  s.entry = null;
  s.entryActive = false;
  s.pendingOp = null;
  s.lastEq = null;
}

// 执行一次按键，返回结果与解释。状态原地更新。
export function press(s: CalcState, key: Key): KeyResult {
  // 错误状态：仅 C 可恢复，其余按键被忽略且状态不变
  if (s.error !== null && key !== 'C') {
    return snapshot(s, key, false, true, 'ERROR_STATE_LOCKED',
      `错误状态 ${s.error} 中，按键 ${key} 被忽略（仅 C 可恢复），状态未改变`);
  }

  if (/^[0-9]$/.test(key)) return pressDigit(s, key);
  switch (key) {
    case '.': return pressDot(s);
    case '+': case '-': case '*': case '/': return pressOp(s, key);
    case '=': return pressEquals(s);
    case '%': return pressPercent(s);
    case '±': return pressNegate(s);
    case 'CE': return pressCE(s);
    case 'C': {
      const fresh = initialState();
      Object.assign(s, fresh);
      return snapshot(s, key, true, false, null, 'C：清空全部状态，回到初始零');
    }
    default:
      throw new Error(`未知按键: ${String(key)}`);
  }
}

function startEntry(s: CalcState, first: string): void {
  if (!s.entryActive) {
    if (s.pendingOp === null) {
      // 等号结束后或初始状态直接按数字：开始全新计算，清除重复等号记录
      s.acc = zero;
      s.lastEq = null;
    }
    s.entry = first;
    s.entryActive = true;
    s.entryValue = null;
  }
}

function pressDigit(s: CalcState, d: string): KeyResult {
  startEntry(s, '');
  if (s.entry === '0') s.entry = ''; // 前导零替换
  if (s.entry === '-0') s.entry = '-';
  if (countInputDigits(s.entry ?? '') >= MAX_INPUT_DIGITS) {
    return snapshot(s, d, false, true, 'INPUT_DIGIT_LIMIT',
      `数字 ${d} 被忽略：输入有效数字已达上限 ${MAX_INPUT_DIGITS} 位（非致命，可继续其他按键）`);
  }
  s.entry = (s.entry ?? '') + d;
  if (s.entry === '') s.entry = d;
  return snapshot(s, d, true, false, null, `输入数字 ${d}，当前输入 "${s.entry}"`);
}

function pressDot(s: CalcState): KeyResult {
  startEntry(s, '0');
  const e = s.entry ?? '0';
  if (e.includes('.')) {
    return snapshot(s, '.', false, true, 'DUPLICATE_DOT',
      '重复小数点被忽略（非致命错误），当前输入不变');
  }
  s.entry = e + '.';
  return snapshot(s, '.', true, false, null, `输入小数点，当前输入 "${s.entry}"`);
}

function commitEntry(s: CalcState): Rat | null {
  if (!s.entryActive) return null;
  const rhs = entryRat(s);
  s.entry = null;
  s.entryActive = false;
  s.entryValue = null;
  return rhs;
}

function pressOp(s: CalcState, op: Op): KeyResult {
  let explanation: string;
  if (s.entryActive) {
    const rhs = commitEntry(s)!;
    if (s.pendingOp !== null) {
      // 已有右操作数：先执行此前待运算（即时执行，无优先级）
      const prevOp = s.pendingOp;
      const lhs = s.acc;
      try {
        s.acc = applyOp(lhs, prevOp, rhs);
      } catch (e) {
        return opError(s, key2op(prevOp), e);
      }
      explanation = `先执行待运算 ${fmt(lhs)} ${prevOp} ${fmt(rhs)} = ${fmt(s.acc)}，再记录新运算符 ${op}`;
    } else {
      s.acc = rhs;
      explanation = `提交输入 ${fmt(rhs)} 作为累计值，记录运算符 ${op}`;
    }
  } else if (s.pendingOp !== null) {
    // 连续按运算符且未输入右操作数：替换运算符
    explanation = `未输入右操作数，运算符 ${s.pendingOp} 被替换为 ${op}`;
  } else {
    explanation = `以当前结果 ${fmt(s.acc)} 继续，记录运算符 ${op}`;
  }
  s.pendingOp = op;
  return snapshot(s, op, true, false, null, explanation);
}

function key2op(op: Op): string { return op; }

function opError(s: CalcState, key: string, e: unknown): KeyResult {
  if (e instanceof DivZeroError) {
    fail(s, 'DIV_BY_ZERO');
    return snapshot(s, key, false, false, null, '除零错误：进入错误状态，仅 C 可恢复');
  }
  if (e instanceof LimitExceededError) {
    fail(s, 'LIMIT_EXCEEDED');
    return snapshot(s, key, false, false, null, '分子/分母位数超出精度预算：进入错误状态，仅 C 可恢复');
  }
  throw e;
}

function pressEquals(s: CalcState): KeyResult {
  if (s.pendingOp !== null) {
    // 无新右操作数时采用当前累计值作为右操作数（如 5+= 得 10）
    const rhs = s.entryActive ? commitEntry(s)! : s.acc;
    const op = s.pendingOp;
    const lhs = s.acc;
    try {
      s.acc = applyOp(lhs, op, rhs);
    } catch (e) {
      return opError(s, '=', e);
    }
    s.pendingOp = null;
    s.lastEq = { op, rhs };
    return snapshot(s, '=', true, false, null,
      `执行 ${fmt(lhs)} ${op} ${fmt(rhs)} = ${fmt(s.acc)}，记录本次等号操作供重复`);
  }
  if (s.entryActive) {
    // 独立输入数：等号仅提交，值不变
    const v = commitEntry(s)!;
    s.acc = v;
    return snapshot(s, '=', true, false, null, `无待运算，提交输入值 ${fmt(v)}，结果不变`);
  }
  if (s.lastEq !== null) {
    // 重复等号：重复最近一次等号的运算符与实际右操作数
    const { op, rhs } = s.lastEq;
    const lhs = s.acc;
    try {
      s.acc = applyOp(lhs, op, rhs);
    } catch (e) {
      return opError(s, '=', e);
    }
    return snapshot(s, '=', true, false, null,
      `重复等号：${fmt(lhs)} ${op} ${fmt(rhs)} = ${fmt(s.acc)}`);
  }
  return snapshot(s, '=', true, false, null, '无待运算且无重复记录，等号保持值不变');
}

function pressPercent(s: CalcState): KeyResult {
  const cur = currentRat(s);
  let converted: Rat;
  let explanation: string;
  try {
    if (s.pendingOp === '+' || s.pendingOp === '-') {
      // 待加减：当前操作数解释为累计值的百分之几
      converted = div(mul(s.acc, cur), { n: 100n, d: 1n });
      explanation = `待运算为 ${s.pendingOp}：${fmt(cur)}% 换算为累计值 ${fmt(s.acc)} 的百分之几，即 ${fmt(converted)}`;
    } else {
      // 无待运算或待乘除：除以一百
      converted = div(cur, { n: 100n, d: 1n });
      explanation = `无待运算或待乘除：${fmt(cur)}% 换算为 ${fmt(converted)}`;
    }
  } catch (e) {
    return opError(s, '%', e);
  }
  // 换算值视为已输入的右操作数，下一次等号据此记忆
  s.entry = displayOf(converted);
  s.entryValue = converted; // 保留精确值，避免显示舍入污染内部状态
  s.entryActive = true;
  return snapshot(s, '%', true, false, null, explanation);
}

function displayOf(r: Rat): string {
  return toDisplay(r).text;
}

function pressNegate(s: CalcState): KeyResult {
  if (s.entryActive && s.entry !== null) {
    if (s.entryValue !== null) {
      s.entryValue = neg(s.entryValue);
    }
    if (s.entry.startsWith('-')) {
      s.entry = s.entry.slice(1);
    } else {
      s.entry = '-' + s.entry;
    }
    return snapshot(s, '±', true, false, null, `切换输入符号，当前输入 "${s.entry}"`);
  }
  s.acc = neg(s.acc);
  return snapshot(s, '±', true, false, null, `切换结果符号，当前值 ${fmt(s.acc)}（零不显示负零）`);
}

function pressCE(s: CalcState): KeyResult {
  // 只清空当前输入为零，保留累计值与待运算，清除重复等号记录
  s.entry = '0';
  s.entryActive = true;
  s.entryValue = null;
  s.lastEq = null;
  return snapshot(s, 'CE', true, false, null,
    'CE：当前输入清零，累计值与待运算保留，重复等号记录已清除');
}

function fmt(r: Rat): string {
  return toExactString(r);
}

// ---- 序列化（BigInt -> string）----
export interface SerializedState {
  acc: { n: string; d: string };
  pendingOp: Op | null;
  entry: string | null;
  entryActive: boolean;
  entryValue: { n: string; d: string } | null;
  lastEq: { op: Op; rhs: { n: string; d: string } } | null;
  error: string | null;
}

export function serialize(s: CalcState): SerializedState {
  return {
    acc: { n: s.acc.n.toString(), d: s.acc.d.toString() },
    pendingOp: s.pendingOp,
    entry: s.entry,
    entryActive: s.entryActive,
    entryValue: s.entryValue ? { n: s.entryValue.n.toString(), d: s.entryValue.d.toString() } : null,
    lastEq: s.lastEq
      ? { op: s.lastEq.op, rhs: { n: s.lastEq.rhs.n.toString(), d: s.lastEq.rhs.d.toString() } }
      : null,
    error: s.error,
  };
}

export function deserialize(j: SerializedState): CalcState {
  return {
    acc: { n: BigInt(j.acc.n), d: BigInt(j.acc.d) },
    pendingOp: j.pendingOp,
    entry: j.entry,
    entryActive: j.entryActive,
    entryValue: j.entryValue ? { n: BigInt(j.entryValue.n), d: BigInt(j.entryValue.d) } : null,
    lastEq: j.lastEq
      ? { op: j.lastEq.op, rhs: { n: BigInt(j.lastEq.rhs.n), d: BigInt(j.lastEq.rhs.d) } }
      : null,
    error: j.error,
  };
}
