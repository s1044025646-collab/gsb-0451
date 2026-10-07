import { press, initialState, EngineState } from "./engine";

function run(title: string, keys: string[]): void {
  console.log(`\n=== ${title} ===`);
  console.log("按键".padEnd(6) + "显示".padEnd(18) + "精确值".padEnd(24) + "待运算  说明");
  let s: EngineState = initialState();
  for (const k of keys) {
    const r = press(s, k);
    s = r.state;
    const note = r.ignored ? "已忽略" : r.code ? `错误 ${r.code}` : r.explanation[r.explanation.length - 1];
    console.log(
      `'${k}'`.padEnd(7) +
        r.display.padEnd(18) +
        r.exact.padEnd(24) +
        (r.state.pendingOp ?? "-").padEnd(8) +
        note,
    );
  }
}

run("即时执行：2+3×4= 得 20（非 14）", ["2", "+", "3", "*", "4", "="]);
run("重复等号：2+3== 得 8", ["2", "+", "3", "=", "="]);
run("无右操作数：5+= 得 10", ["5", "+", "="]);
run("百分号（加减）：200+10%== 得 240", ["2", "0", "0", "+", "1", "0", "%", "=", "="]);
run("百分号（乘除）：200×10%= 得 20", ["2", "0", "0", "*", "1", "0", "%", "="]);
run("精确小数：0.1+0.2= 精确 3/10", ["0", ".", "1", "+", "0", ".", "2", "="]);
run("除法不舍入：1÷3×3= 精确回到 1", ["1", "/", "3", "*", "3", "="]);
run("运算符替换：7+×2= 得 14", ["7", "+", "*", "2", "="]);
run("CE 保留运算：5+3 CE 2 = 得 7", ["5", "+", "3", "CE", "2", "="]);
run("除零与恢复：1÷0= 报错，C 恢复", ["1", "/", "0", "=", "+", "C", "9"]);
run("连续正负号：5 ± ± ± 得 -5", ["5", "±", "±", "±"]);
run("等号后按数字开始新计算：2+3= 7 = 保持 7", ["2", "+", "3", "=", "7", "="]);
