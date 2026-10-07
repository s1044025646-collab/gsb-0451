/** 精确有理数：BigInt 分子/分母，始终约分，分母恒正。 */

export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

export function make(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new Error("DIV_BY_ZERO");
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) return { num: 0n, den: 1n };
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

export const ZERO: Rational = { num: 0n, den: 1n };
export const ONE: Rational = { num: 1n, den: 1n };
export const HUNDRED: Rational = { num: 100n, den: 1n };

export function add(a: Rational, b: Rational): Rational {
  return make(a.num * b.den + b.num * a.den, a.den * b.den);
}
export function sub(a: Rational, b: Rational): Rational {
  return make(a.num * b.den - b.num * a.den, a.den * b.den);
}
export function mul(a: Rational, b: Rational): Rational {
  return make(a.num * b.num, a.den * b.den);
}
export function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new Error("DIV_BY_ZERO");
  return make(a.num * b.den, a.den * b.num);
}
export function neg(a: Rational): Rational {
  return { num: -a.num, den: a.den };
}
export function isZero(a: Rational): boolean {
  return a.num === 0n;
}

export function toStringExact(a: Rational): string {
  return a.den === 1n ? `${a.num}/1` : `${a.num}/${a.den}`;
}

/** 解析十进制输入串（允许 "12."、"."、".5"、"-3.40"），返回精确有理数。 */
export function parseDecimal(s: string): Rational {
  let negFlag = false;
  let t = s;
  if (t.startsWith("-")) {
    negFlag = true;
    t = t.slice(1);
  }
  const dot = t.indexOf(".");
  let intPart = dot < 0 ? t : t.slice(0, dot);
  let fracPart = dot < 0 ? "" : t.slice(dot + 1);
  if (intPart === "") intPart = "0";
  if (!/^\d+$/.test(intPart) || (fracPart !== "" && !/^\d+$/.test(fracPart))) {
    throw new Error("INVALID_NUMBER");
  }
  const scale = 10n ** BigInt(fracPart.length);
  const num = BigInt(intPart) * scale + (fracPart === "" ? 0n : BigInt(fracPart));
  const r = make(num, scale);
  return negFlag ? neg(r) : r;
}

/** 有效数字位数（去掉前导零与小数点后的十进制位数）。 */
export function significantDigits(s: string): number {
  const t = s.replace(/^-/, "").replace(".", "").replace(/^0+/, "");
  return t.length;
}

export function digitCount(v: bigint): number {
  const s = (v < 0n ? -v : v).toString();
  return s.length;
}

const DISPLAY_DECIMALS = 12;

export interface DisplayResult {
  text: string;
  rounded: boolean;
}

/**
 * 显示格式化：最多 12 位小数，绝对值四舍五入（负数对称），
 * 去掉末尾无意义零；舍入到零时不输出负零。
 */
export function formatDisplay(a: Rational): DisplayResult {
  const scale = 10n ** BigInt(DISPLAY_DECIMALS);
  const negFlag = a.num < 0n;
  const absNum = negFlag ? -a.num : a.num;
  const numScaled = absNum * scale;
  const q = numScaled / a.den;
  const rem = numScaled % a.den;
  // 绝对值四舍五入：余数*2 >= 分母 则进一
  const roundUp = rem * 2n >= a.den;
  const rounded = rem !== 0n;
  const scaled = roundUp ? q + 1n : q;
  if (scaled === 0n) return { text: "0", rounded };
  const digits = scaled.toString().padStart(DISPLAY_DECIMALS + 1, "0");
  const intPart = digits.slice(0, digits.length - DISPLAY_DECIMALS);
  let fracPart = digits.slice(digits.length - DISPLAY_DECIMALS);
  fracPart = fracPart.replace(/0+$/, "");
  const text = (negFlag ? "-" : "") + intPart + (fracPart === "" ? "" : "." + fracPart);
  return { text, rounded };
}
