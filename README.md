# 即时计算器按键语义与重复等号回放后端

无界面的桌面计算器按键引擎，仅提供 HTTP API 与 CLI。TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`），Windows 本地直接运行，不依赖 Docker / WSL / 外部服务。

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP API（默认自动选择空闲端口）
npm start -- 8080  # 指定端口
npm run demo       # 演示：键 / 显示值 / 精确值 / 待操作
```

CLI（直接操作 SQLite，无需启动服务）：

```powershell
node dist/src/cli.js new                          # 新建会话
node dist/src/cli.js key <sessionId> 2 0 0 + 1 0 % = =
node dist/src/cli.js state <sessionId>
node dist/src/cli.js export <sessionId>
```

数据目录为项目内 `data/`（默认 `data/calc.db`，可用环境变量 `CALC_DB` 覆盖）。重启后按键序号与状态原样恢复，可继续输入。

## 本题规则（不声称兼容任何品牌计算器）

- **即时执行**：普通计算器规则，无代数优先级，不支持括号、函数、脚本。`2+3×4=` 得 `20`。
- **精确有理数**：十进制输入转为约分有理数（BigInt 分子/分母），除法内部不提前舍入。`0.1+0.2=` 精确为 `3/10`，`1÷3×3=` 精确回到 `1`。
- **显示**：最多 12 位小数，绝对值四舍五入（负数对称），去掉末尾无意义零；同时返回 `exact`（精确分数）与 `displayRounded`（是否发生显示舍入）。输入过程中保留正在输入的小数点与尾零（如 `1.00`），执行运算后才用规范显示。
- **限制**：输入有效数字最多 15 位（超出按键被忽略，非致命）；分子/分母最多 100 位十进制（超出进入错误状态 `LIMIT_EXCEEDED`）。
- **状态分离**：当前输入、累计值、待执行运算符、最近一次等号操作分别保存。
- **运算符**：已输入右操作数时先执行此前待运算；连续按运算符且未输入右操作数则替换（`7+×2=` 得 `14`）。
- **等号**：无新右操作数时用当前累计值作右操作数（`5+=` 得 `10`）；成功后记住本次运算符与实际右操作数，连续等号重复它（`2+3==` 得 `8`）。等号后按数字开始新计算并清除重复记录；按运算符用现有结果继续。只有独立输入数且无待运算/重复记录时，等号保持值不变。
- **正负号 `±`**：切换当前输入或结果的符号；零不输出负零。
- **小数点**：重复小数点被忽略（非致命）；前导小数点视为 `0.`。
- **百分号 `%`**：无待运算或待乘除时，当前操作数除以 100；待加减时，解释为累计值的百分之几（`200+10%=` 得 `220`，`200×10%=` 得 `20`）。换算值视为已输入的右操作数，下一次等号据此记忆（`200+10%==` 得 `240`）。连续百分号按同一规则继续作用于当前操作数。
- **CE**：只清空当前输入为零，保留累计值与待运算，清除重复等号记录。**C**：清空全部状态为初始零。
- **错误**：除零（`DIV_BY_ZERO`）与精度预算超限（`LIMIT_EXCEEDED`）进入错误状态，此后只有 `C` 能恢复，其他按键返回错误状态且不被改变。
- **被忽略 vs 执行失败**：被忽略（`ignored=true`，如重复小数点、输入位数超限、错误状态下的非 C 键）不改变状态、不产生错误；执行失败（除零、精度超限）使会话进入错误状态。

## HTTP API

默认绑定 `127.0.0.1`，未指定端口时自动选择空闲端口（启动日志打印实际端口）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/sessions` | 新建会话 |
| GET | `/api/sessions/:id` | 查看状态（含显示值、精确值、内部状态） |
| POST | `/api/sessions/:id/keys` | 提交按键（支持批量），逐键返回解释 |
| GET | `/api/sessions/:id/export` | 完整回放导出（全部按键与每键结果） |

提交按键请求体：

```json
{ "keys": [ { "seq": 1, "requestId": "任意唯一串", "key": "5" } ] }
```

- 合法按键：`0-9`、`.`、`+`、`-`、`*`、`/`、`=`、`%`、`CE`、`C`、`±`。
- `seq` 必须严格递增（等于上一序号 + 1）；`requestId` 幂等：重复请求返回原结果（`duplicate=true`）；同序号不同 `requestId` 返回 `SEQ_CONFLICT`（409），跳号返回 `SEQ_GAP`（409），不偷偷重放。
- 每个键的结果包含：`display`、`exact`、`displayRounded`、`accepted`/`ignored`/`ignoreReason`、`error`、内部状态快照与中文 `explanation`。
- 错误码：`SESSION_NOT_FOUND`、`INVALID_KEY`、`INVALID_REQUEST`、`SEQ_CONFLICT`、`SEQ_GAP`，以及状态字段中的 `DIV_BY_ZERO`、`LIMIT_EXCEEDED`。
- 按键与状态在单个 SQLite 事务中原子落盘。

## 项目结构

- `src/rational.ts` — BigInt 精确有理数与显示格式化
- `src/engine.ts` — 按键状态机（核心交付，无 eval / 表达式库）
- `src/store.ts` — SQLite 持久化、幂等与序号校验
- `src/server.ts` — HTTP API
- `src/cli.ts` — 命令行
- `src/demo.ts` — 演示脚本
- `test/engine.test.ts` — 手写状态转换与独立有理运算核验（27 个用例）

## 已知限制

- 显示整数部分不限制位数（仅小数部分限 12 位）；分子/分母超 100 位即报错而非继续近似。
- 百分号换算结果在输入态以显示串呈现，但内部保存精确有理数，显示舍入不会污染计算。
- `node:sqlite` 在 Node 25 仍标记为实验特性，启动时会有 ExperimentalWarning，不影响功能。
