// 演示：通过内存引擎直接展示 键 / 显示值 / 精确值 / 待操作。
import { initialState, press, Key } from './engine.js';

const demos: Array<{ title: string; keys: Key[] }> = [
  { title: '即时执行无优先级: 2+3*4=', keys: ['2', '+', '3', '*', '4', '='] },
  { title: '0.1+0.2= 精确 3/10', keys: ['0', '.', '1', '+', '0', '.', '2', '='] },
  { title: '1/3*3= 内部精确回到 1', keys: ['1', '/', '3', '*', '3', '='] },
  { title: '连续运算符替换: 7+*2=', keys: ['7', '+', '*', '2', '='] },
  { title: '5+= 得 10', keys: ['5', '+', '='] },
  { title: '重复等号: 2+3==', keys: ['2', '+', '3', '=', '='] },
  { title: '百分号(加减): 200+10%=', keys: ['2', '0', '0', '+', '1', '0', '%', '='] },
  { title: '百分号(乘除): 200*10%=', keys: ['2', '0', '0', '*', '1', '0', '%', '='] },
  { title: '200+10%== 得 240', keys: ['2', '0', '0', '+', '1', '0', '%', '=', '='] },
  { title: '等号后按数字开始新计算: 2+3= 9+1=', keys: ['2', '+', '3', '=', '9', '+', '1', '='] },
  { title: 'CE 保留运算: 5+3 CE 2 =', keys: ['5', '+', '3', 'CE', '2', '='] },
  { title: '连续正负号: 5 ±± ±', keys: ['5', '±', '±', '±'] },
  { title: '除零与恢复: 1/0= 然后 5 被忽略, C 恢复', keys: ['1', '/', '0', '=', '5', 'C', '7'] },
];

for (const demo of demos) {
  console.log(`\n== ${demo.title} ==`);
  const s = initialState();
  for (const k of demo.keys) {
    const r = press(s, k);
    console.log(
      `键[${k}] 显示=${r.display} 精确=${r.exact} 待运算=${r.state.pendingOp ?? '-'}` +
      ` 累计=${r.state.acc}` +
      (r.ignored ? ` [被忽略:${r.ignoreReason}]` : '') +
      (r.error ? ` [错误:${r.error}]` : ''),
    );
  }
}
