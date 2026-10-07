import {
  Rational, ZERO, HUNDRED,
  add, sub, mul, div, neg, isZero,
  parseDecimal, significantDigits, digitCount,
  formatDisplay, toStringExact,
} from "./rational";

export type Op = "+" | "-" | "*" | "/";
export type Key =
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "." | "+" | "-" | "*" | "/" | "=" | "±" | "%" | "CE" | "C";

export const VALID_KEYS: readonly string[] = [
  "0","1","2","3","4","5","6","7","8","9",".","+","-","*","/","=","±","%","CE","C",
];

/** 精度预算 */
export const MAX_INPUT_SIG_DIGITS = 30;   // 输入有效数字上限
export const MAX_COMPONENT_DIGITS = 60;   // 分子/分母十进制位数上限

export interface RepeatRecord {
  op: Op;
  rhs: Rational;
}

export interface EngineState {
  /** 累计值 / 当前结果 */
  acc: Rational;
  /** 待执行运算符 */
  pendingOp: Op | null;
  /** 正在输入的原始缓冲（保留小数点与尾零） */
  input: string;
  /** 是否处于数字输入中 */
  entering: boolean;
  /** 由百分号产生的精确输入值（优先于 input 文本解析） */
  entryOverride: Rational | null;
  /** 上一次完成的按键是否为等号 */
  justEquals: boolean;
  /** 最近一次等号记住的 运算符+实际右操作数 */
  lastEquals: RepeatRecord | null;
  /** 错误码；非空时仅 C 可恢复 */
  error: string | null;
}

export function initialState(): EngineState {
  return {
    acc: ZERO,
    pendingOp: null,
    input: "0",
    entering: false,
    entryOverride: null,
    justEquals: false,
    lastEquals: null,
    error: null,
  };
}

export interface PressResult {
  ok: boolean;
  /** 按键被忽略（非致命，状态未变） */
  ignored: boolean;
  /** 业务错误码（如 DIV_BY_ZERO / PRECISION_BUDGET / KEY_INVALID / ERROR_STATE） */
  code: string | null;
  /** 本次按键的逐步解释 */
  explanation: string[];
  state: EngineState;
  display: string;
  exact: string;
  displayRounded: boolean;
}

function clone(s: EngineState): EngineState {
  return {
    ...s,
    lastEquals: s.lastEquals ? { op: s.lastEquals.op, rhs: { ...s.lastEquals.rhs } } : null,
  };
}

function applyOp(a: Rational, op: Op, b: Rational): Rational {
  switch (op) {
    case "+": return add(a, b);
    case "-": return sub(a, b);
    case "*": return mul(a, b);
    case "/": return div(a, b);
  }
}

function checkBudget(r: Rational): void {
  if (digitCount(r.num) > MAX_COMPONENT_DIGITS || digitCount(r.den) > MAX_COMPONENT_DIGITS) {
    throw new Error("PRECISION_BUDGET");
  }
}

function displayOf(s: EngineState): { display: string; exact: string; rounded: boolean } {
  if (s.entering) {
    // 输入中：原样显示缓冲（保留小数点与尾零）
    if (s.entryOverride !== null) {
      const f = formatDisplay(s.entryOverride);
      return { display: f.text, exact: toStringExact(s.entryOverride), rounded: f.rounded };
    }
    const r = parseDecimal(s.input);
    return { display: s.input, exact: toStringExact(r), rounded: false };
  }
  const f = formatDisplay(s.acc);
  return { display: f.text, exact: toStringExact(s.acc), rounded: f.rounded };
}

function result(
  state: EngineState,
  explanation: string[],
  opts: { ok?: boolean; ignored?: boolean; code?: string | null } = {},
): PressResult {
  const d = displayOf(state);
  return {
    ok: opts.ok ?? state.error === null,
    ignored: opts.ignored ?? false,
    code: opts.code ?? state.error,
    explanation,
    state,
    display: d.display,
    exact: d.exact,
    displayRounded: d.rounded,
  };
}

function fail(state: EngineState, code: string, explanation: string[]): PressResult {
  state.error = code;
  state.entering = false;
  explanation.push(`进入错误状态：${code}，此后仅 C 键可恢复`);
  return result(state, explanation, { ok: false, code });
}

function currentOperand(s: EngineState): Rational {
  if (!s.entering) return s.acc;
  return s.entryOverride !== null ? s.entryOverride : parseDecimal(s.input);
}

/** 执行一次待运算（若有右操作数），结果写入 acc。 */
function executePending(s: EngineState, explanation: string[]): boolean {
  if (s.pendingOp === null) return true;
  const rhs = currentOperand(s);
  explanation.push(
    `执行待运算：${toStringExact(s.acc)} ${s.pendingOp} ${toStringExact(rhs)}`,
  );
  let r: Rational;
  try {
    r = applyOp(s.acc, s.pendingOp, rhs);
    checkBudget(r);
  } catch (e) {
    fail(s, (e as Error).message, explanation);
    return false;
  }
  s.acc = r;
  explanation.push(`累计值更新为 ${toStringExact(r)}`);
  return true;
}

export function press(prev: EngineState, key: string): PressResult {
  const s = clone(prev);
  const explanation: string[] = [`按键 '${key}'`];

  if (!VALID_KEYS.includes(key)) {
    explanation.push(`非法按键，已忽略（状态未变）`);
    return result(s, explanation, { ok: false, ignored: true, code: "KEY_INVALID" });
  }

  // 错误状态：仅 C 可恢复，其余按键返回错误状态且状态不变
  if (s.error !== null && key !== "C") {
    explanation.push(`处于错误状态 ${s.error}，按键 '${key}' 被拒绝（仅 C 可恢复）`);
    return result(s, explanation, { ok: false, code: "ERROR_STATE" });
  }

  if (/^[0-9]$/.test(key)) return pressDigit(s, key, explanation);
  switch (key) {
    case ".": return pressDot(s, explanation);
    case "+": case "-": case "*": case "/": return pressOp(s, key, explanation);
    case "=": return pressEquals(s, explanation);
    case "±": return pressNegate(s, explanation);
    case "%": return pressPercent(s, explanation);
    case "CE": return pressCE(s, explanation);
    case "C": return pressC(s, explanation);
  }
  // 不可达
  return result(s, explanation);
}

function pressDigit(s: EngineState, d: string, ex: string[]): PressResult {
  if (s.justEquals) {
    // 等号后直接按数字：开始全新计算，清除重复等号记录
    s.acc = ZERO;
    s.pendingOp = null;
    s.lastEquals = null;
    s.justEquals = false;
    s.input = d;
    s.entering = true;
    s.entryOverride = null;
    ex.push("等号后输入数字：开始新计算，清除重复等号记录");
    return result(s, ex);
  }
  if (!s.entering) {
    s.input = d;
    s.entering = true;
    s.entryOverride = null;
    ex.push(`开始输入新操作数：${d}`);
    return result(s, ex);
  }
  s.entryOverride = null;
  const candidate = s.input === "0" ? d : s.input === "-0" ? "-" + d : s.input + d;
  if (significantDigits(candidate) > MAX_INPUT_SIG_DIGITS) {
    ex.push(`输入有效数字超过 ${MAX_INPUT_SIG_DIGITS} 位上限`);
    return fail(s, "PRECISION_BUDGET", ex);
  }
  s.input = candidate;
  ex.push(`追加数字，当前输入缓冲 '${s.input}'`);
  return result(s, ex);
}

function pressDot(s: EngineState, ex: string[]): PressResult {
  if (s.justEquals) {
    s.acc = ZERO;
    s.pendingOp = null;
    s.lastEquals = null;
    s.justEquals = false;
    s.input = "0.";
    s.entering = true;
    s.entryOverride = null;
    ex.push("等号后输入小数点：开始新计算，视为 '0.'");
    return result(s, ex);
  }
  if (!s.entering) {
    s.input = "0.";
    s.entering = true;
    s.entryOverride = null;
    ex.push("前导小数点视为零点，输入缓冲 '0.'");
    return result(s, ex);
  }
  if (s.input.includes(".")) {
    ex.push("重复小数点被忽略（非致命，状态未变）");
    return result(s, ex, { ignored: true });
  }
  s.input += ".";
  ex.push(`追加小数点，当前输入缓冲 '${s.input}'`);
  return result(s, ex);
}

function pressOp(s: EngineState, op: Op, ex: string[]): PressResult {
  s.justEquals = false;
  s.lastEquals = null; // 用运算符继续时不能误用上一次右操作数
  if (s.pendingOp !== null && s.entering) {
    // 已输入右操作数：先执行此前待运算（即时执行，无优先级）
    if (!executePending(s, ex)) return result(s, ex, { ok: false });
    s.pendingOp = op;
    s.entering = false;
    ex.push(`设置待执行运算符 '${op}'`);
    return result(s, ex);
  }
  // 连续按运算符且未输入右操作数：替换运算符
  if (s.pendingOp !== null) {
    ex.push(`未输入右操作数，运算符 '${s.pendingOp}' 替换为 '${op}'`);
  } else {
    if (s.entering) {
      // 第一个操作数落账为累计值
      s.acc = currentOperand(s);
      s.entryOverride = null;
      ex.push(`第一个操作数 ${toStringExact(s.acc)} 作为累计值`);
    }
    ex.push(`设置待执行运算符 '${op}'，累计值 ${toStringExact(s.acc)}`);
  }
  s.pendingOp = op;
  s.entering = false;
  return result(s, ex);
}

function pressEquals(s: EngineState, ex: string[]): PressResult {
  s.justEquals = true;
  if (s.pendingOp !== null) {
    // 没有新右操作数时，采用当前累计值作为右操作数（如 5+=）
    const rhs = currentOperand(s);
    const op = s.pendingOp;
    if (!s.entering) ex.push(`未输入右操作数，采用累计值 ${toStringExact(s.acc)} 作为右操作数`);
    ex.push(`执行：${toStringExact(s.acc)} ${op} ${toStringExact(rhs)}`);
    let r: Rational;
    try {
      r = applyOp(s.acc, op, rhs);
      checkBudget(r);
    } catch (e) {
      return fail(s, (e as Error).message, ex);
    }
    s.acc = r;
    s.pendingOp = null;
    s.entering = false;
    s.lastEquals = { op, rhs };
    ex.push(`结果 ${toStringExact(r)}；记住本次 '${op} ${toStringExact(rhs)}' 供重复等号`);
    return result(s, ex);
  }
  if (s.lastEquals !== null) {
    const { op, rhs } = s.lastEquals;
    ex.push(`重复等号：${toStringExact(s.acc)} ${op} ${toStringExact(rhs)}`);
    let r: Rational;
    try {
      r = applyOp(s.acc, op, rhs);
      checkBudget(r);
    } catch (e) {
      return fail(s, (e as Error).message, ex);
    }
    s.acc = r;
    s.entering = false;
    ex.push(`结果 ${toStringExact(r)}`);
    return result(s, ex);
  }
  if (s.entering) {
    // 独立输入数没有待运算：等号把输入落账为结果，值不变
    s.acc = currentOperand(s);
    s.entryOverride = null;
    ex.push(`无待运算，等号将输入 ${toStringExact(s.acc)} 落账，值不变`);
  } else {
    ex.push("无待运算且无重复记录，等号保持值不变");
  }
  s.entering = false;
  return result(s, ex);
}

function pressNegate(s: EngineState, ex: string[]): PressResult {
  if (s.entering) {
    if (s.entryOverride !== null) {
      s.entryOverride = neg(s.entryOverride);
      ex.push(`切换输入符号，当前输入值 ${toStringExact(s.entryOverride)}`);
      return result(s, ex);
    }
    if (isZero(parseDecimal(s.input))) {
      ex.push("输入为零，符号切换后仍显示 0（不输出负零）");
      return result(s, ex);
    }
    s.input = s.input.startsWith("-") ? s.input.slice(1) : "-" + s.input;
    ex.push(`切换输入符号，当前输入缓冲 '${s.input}'`);
    return result(s, ex);
  }
  if (isZero(s.acc)) {
    ex.push("结果为零，符号切换后仍为 0（不输出负零）");
    return result(s, ex);
  }
  s.acc = neg(s.acc);
  ex.push(`切换结果符号，累计值 ${toStringExact(s.acc)}`);
  return result(s, ex);
}

function pressPercent(s: EngineState, ex: string[]): PressResult {
  s.justEquals = false;
  const operand = currentOperand(s);
  let converted: Rational;
  if (s.pendingOp === "+" || s.pendingOp === "-") {
    // 待加减：当前操作数解释为累计值的百分之几
    converted = mul(mul(s.acc, operand), div({ num: 1n, den: 1n }, HUNDRED));
    ex.push(
      `待运算为 '${s.pendingOp}'：${toStringExact(operand)}% 解释为累计值 ${toStringExact(s.acc)} 的百分之几 = ${toStringExact(converted)}`,
    );
  } else {
    // 无待运算或待乘除：当前操作数除以一百
    converted = div(operand, HUNDRED);
    ex.push(`当前操作数除以一百：${toStringExact(operand)}% = ${toStringExact(converted)}`);
  }
  try {
    checkBudget(converted);
  } catch (e) {
    return fail(s, (e as Error).message, ex);
  }
  if (s.pendingOp !== null || s.entering) {
    // 换算值视为已输入的右操作数（精确保存，显示走统一格式化）
    s.entryOverride = converted;
    s.input = formatDisplay(converted).text;
    s.entering = true;
    ex.push(`换算值作为已输入的右操作数（精确值 ${toStringExact(converted)}）`);
  } else {
    s.acc = converted;
    ex.push(`无待运算，累计值更新为 ${toStringExact(converted)}`);
  }
  return result(s, ex);
}

function pressCE(s: EngineState, ex: string[]): PressResult {
  s.input = "0";
  s.entering = false;
  s.entryOverride = null;
  s.lastEquals = null;
  ex.push("CE：清空当前输入为 0，保留累计值与待运算，清除重复等号记录");
  return result(s, ex);
}

function pressC(s: EngineState, ex: string[]): PressResult {
  const fresh = initialState();
  Object.assign(s, fresh);
  ex.push("C：清空全部状态为初始零");
  return result(s, ex);
}
