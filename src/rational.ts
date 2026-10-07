// 精确有理数：BigInt 分子分母，始终约分，分母恒正。
export interface Rat {
  n: bigint;
  d: bigint;
}

export class DivZeroError extends Error {
  constructor() {
    super('DIV_BY_ZERO');
    this.name = 'DivZeroError';
  }
}

export class LimitExceededError extends Error {
  constructor() {
    super('LIMIT_EXCEEDED');
    this.name = 'LimitExceededError';
  }
}

// 分子/分母十进制位数预算，超出即进入错误状态
export const MAX_RATIONAL_DIGITS = 100;
// 显示保留的最大小数位数
export const MAX_DISPLAY_DECIMALS = 12;

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

function digitsOf(x: bigint): number {
  return (x < 0n ? -x : x).toString().length;
}

function checkBudget(r: Rat): Rat {
  if (digitsOf(r.n) > MAX_RATIONAL_DIGITS || digitsOf(r.d) > MAX_RATIONAL_DIGITS) {
    throw new LimitExceededError();
  }
  return r;
}

export function make(n: bigint, d: bigint): Rat {
  if (d === 0n) throw new DivZeroError();
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) return { n: 0n, d: 1n };
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const zero: Rat = { n: 0n, d: 1n };

export function add(a: Rat, b: Rat): Rat {
  return checkBudget(make(a.n * b.d + b.n * a.d, a.d * b.d));
}

export function sub(a: Rat, b: Rat): Rat {
  return checkBudget(make(a.n * b.d - b.n * a.d, a.d * b.d));
}

export function mul(a: Rat, b: Rat): Rat {
  return checkBudget(make(a.n * b.n, a.d * b.d));
}

export function div(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new DivZeroError();
  return checkBudget(make(a.n * b.d, a.d * b.n));
}

export function neg(a: Rat): Rat {
  return { n: -a.n, d: a.d };
}

export function isZero(a: Rat): boolean {
  return a.n === 0n;
}

// 解析十进制字符串（允许前导 '-'、前导 '.'、尾零），得到约分有理数
export function parseDecimal(s: string): Rat {
  let negFlag = false;
  let t = s;
  if (t.startsWith('-')) {
    negFlag = true;
    t = t.slice(1);
  }
  const dot = t.indexOf('.');
  let intPart: string;
  let fracPart: string;
  if (dot < 0) {
    intPart = t;
    fracPart = '';
  } else {
    intPart = t.slice(0, dot);
    fracPart = t.slice(dot + 1);
  }
  if (intPart === '') intPart = '0';
  const digits = intPart + fracPart;
  let n = BigInt(digits === '' ? '0' : digits);
  const d = 10n ** BigInt(fracPart.length);
  if (negFlag) n = -n;
  return make(n, d);
}

// 精确分数形式，如 "3/10"；整数为 "5"
export function toExactString(r: Rat): string {
  return r.d === 1n ? r.n.toString() : `${r.n}/${r.d}`;
}

// 显示：最多 12 位小数，绝对值四舍五入（负数对称），去掉末尾无意义零。
// 返回文本与是否发生了显示舍入。
export function toDisplay(r: Rat): { text: string; rounded: boolean } {
  const scale = 10n ** BigInt(MAX_DISPLAY_DECIMALS);
  const negFlag = r.n < 0n;
  const absN = negFlag ? -r.n : r.n;
  const scaled = absN * scale;
  const q = scaled / r.d;
  const rem = scaled % r.d;
  // 绝对值四舍五入：余数*2 >= 分母 则进一
  const roundedUp = rem * 2n >= r.d;
  const qFinal = roundedUp ? q + 1n : q;
  const didRound = rem !== 0n;

  const intPart = qFinal / scale;
  let frac = (qFinal % scale).toString().padStart(MAX_DISPLAY_DECIMALS, '0');
  frac = frac.replace(/0+$/, '');
  let text = intPart.toString();
  if (frac !== '') text += '.' + frac;
  if (negFlag && qFinal !== 0n) text = '-' + text;
  return { text, rounded: didRound };
}
