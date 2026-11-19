# DeepSeek Harness 插件（dsh-acp）

把本机已安装的 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh`）作为
Cindy 的任务执行引擎。插件通过清单的 `harnesses` 字段声明一个 ACP 引擎，Cindy 在模型选择器的
「引擎」分组里显示「DeepSeek Harness」，选中后每个任务启动一个 `dsh --profile acp` 进程，
用 [Agent Client Protocol](https://agentclientprotocol.com) v1 与它对话。

插件负责「找到 dsh、报告能不能用、列出 dsh 提供的模型与思考深度、把字节原样转发」。它不安装、
不分发 DSH；DeepSeek API Key 可以在插件设置页填写，写进 DSH 自己的凭证文件，插件与 Cindy 都不另存。

## 安装与更新

1. 从本仓库的 [Releases](https://github.com/MagicLizi/cindy-dsh-plugin/releases) 下载最新的
   `dsh-acp-<版本>.cindy`，在 Cindy 的插件页导入。安装确认会列出 Node 工作进程（本机权限）和
   「提供执行引擎 DeepSeek Harness」两项权限。
2. 之后在插件设置页的宿主区域即可检查并安装新版本：清单里的 `githubRelease` 指向本仓库，
   Cindy 读取 GitHub Release、校验附件摘要后走插件更新确认，启用状态、配置与数据保持不变。
3. 需要支持插件执行引擎的 Cindy，见下方「前提条件」。

## 账号用量

设置页按币种显示 DeepSeek 官方账户的可用余额。插件使用 DSH 已保存的 DeepSeek 凭据查询官方余额接口。没有可用余额数据时，页面会显示提示。支持插件用量的 Cindy 也会在使用此引擎的任务输入框下方显示用量，点击可看明细。旁边的圆环显示当前任务由引擎上报的上下文占用。

## 模型与思考深度

插件向 dsh 读取它提供的模型（ACP 的 `model` 配置项）以及每个模型可选的思考深度
（`thought_level` 配置项），随可用状态一起发布给 Cindy。模型选择器里按普通供应商的样式列出；
有思考深度的模型在行尾显示当前档位，配置浮层里用滑杆切换。dsh 的 `off` 在 Cindy 中没有对应
档位，不会显示。读取在插件自己的一个探测会话里进行，不发送任何消息，不会调用模型。
打开模型选择器时 Cindy 会请插件刷新一次（同一插件 10 分钟内最多一次）。

## 工作方式

```
Cindy 任务 ──ACP JSON-RPC──► dsh-acp.js（原样 stdio 入口）──spawn──► dsh --profile acp
                                     ▲
main.js（常驻逻辑页）──cindy.node.request('detect')──► worker.js ──► dsh --version
       └── PUT /harnesses：发布「可用 / 未安装 / 无法运行」与版本
settings.html ──BroadcastChannel──► main.js：打开设置页或点「重新检测」时重新检测
```

| 文件 | 作用 |
| --- | --- |
| `ghost.json` | 清单：`node` 工作进程、额外入口 `dsh-acp.js`、`harnesses` 声明、设置页、常驻逻辑页 |
| `main.js` | 逻辑页：启动时与设置页请求时检测 dsh，并 `PUT /harnesses` 发布可用状态 |
| `worker.js` | Node 工作进程（json-rpc-stdio），提供 `detect` 方法 |
| `resolve-dsh.js` | 查找与启动 dsh 的共用代码（worker 与 ACP 入口用同一套查找顺序） |
| `dsh-models.js` | 经 ACP 读取 dsh 的模型与每个模型的思考深度 |
| `dsh-credentials.js` | 经 DSH 自带的凭证存储读写 DeepSeek API Key（设置页使用） |
| `dsh-acp.js` | ACP 引擎入口：启动 `dsh --profile acp`，双向原样转发 stdio |
| `settings.html` / `settings.js` | 设置页：检测结果、版本、位置、安装提示与「重新检测」 |
| `locales/` | 清单名称与说明的英文、简体中文文案 |
| `test/bridge.test.mjs` | 用假 dsh 验证检测与转发（`node --test test/bridge.test.mjs`） |

### 检测规则

- 时机：Cindy 启动或启用插件时、打开插件设置页（以及设置页重新可见）时、点「重新检测」时。
  不做定时轮询。装好 dsh 后点「重新检测」即可恢复可用，不需要重装插件或重启 Cindy。
- 查找顺序（取第一个找到的）：`PATH` 中的 `dsh`（Windows 按 `PATHEXT` 找 `dsh.exe` / `dsh.cmd` /
  `dsh.bat`）→ `~/.npmrc` 里 `prefix=` 指定的全局目录 → 常见全局安装位置：
  - Windows：`%APPDATA%\npm`、`%LOCALAPPDATA%\Volta\bin`、`%LOCALAPPDATA%\pnpm`
  - macOS / Linux：`~/.npm-global/bin`、`~/.local/bin`、`~/.volta/bin`、`/usr/local/bin`、
    `/opt/homebrew/bin`、nvm 管理的各 Node 版本（新版本优先）、`~/Library/pnpm`、
    `~/.local/share/pnpm`、`~/.bun/bin`
- 找到后运行 `dsh --version`（10 秒超时）。能运行发布「可用」及版本；找不到发布
  `not-installed`，能找到但运行失败发布 `not-runnable`，并附安装提示（按 Cindy 界面语言选
  中文或英文）。发布给 Cindy 的只有状态、原因、提示和版本，不含路径或命令。
- 启动 dsh 时把 dsh 所在目录放到 `PATH` 最前面，让 `#!/usr/bin/env node` 和 Windows 的
  `dsh.cmd` 能找到同目录的 Node（从程序坞或开始菜单启动的 Cindy 往往只有很短的 `PATH`）。
- 参数都是常量（`--version`、`--profile acp`），不拼接任何用户输入。Windows 上 npm 生成的
  `.cmd` 只能经 `cmd.exe` 运行，路径加引号，含 `%`、`!`、`"` 的路径直接拒绝。

### ACP 入口的进程约定

- stdout 只承载 dsh 的输出，逐字节转发，入口自己从不写 stdout；dsh 的 stderr 转到入口的
  stderr（进插件日志）。
- Cindy 关闭 stdin → 入口关闭 dsh 的 stdin，dsh 自行退出；5 秒内没退出则强制结束。
- dsh 退出 → 入口用同一个退出码退出。
- 入口收到 SIGTERM / SIGINT / SIGHUP 或 stdout 断开 → 先结束 dsh 再退出（POSIX 先 SIGTERM，
  1.5 秒后 SIGKILL；Windows 用 `taskkill /pid <pid> /T /F` 结束整棵进程树）。
- 找不到 dsh → 在 stderr 写一行不含 JSON-RPC 的提示，退出码 127。

## 前提条件

1. 支持插件执行引擎（清单 `harnesses` 字段与 `PUT /harnesses`）的 Cindy。该能力仍在开发中，
   目前只有包含「ACP 插件桥接层」改动的开发版可用；正式版发布后请把 `ghost.json` 的
   `minCindyVersion` 改成第一个包含该能力的版本号（现在填的是开发版版本 `0.0.0`）。
   旧版 Cindy 会忽略 `harnesses`，插件仍可安装，设置页会提示需要更新 Cindy。
2. Node.js 24.9 或更高版本。
3. 安装 DSH：

   ```sh
   npm i -g @deepseek-ai/dsh
   dsh --version
   ```

4. 配置 DeepSeek API Key：在插件设置页的「DeepSeek API Key」里填写并保存即可。插件调用 DSH 自带的
   凭证存储（`@deepseek-ai/dsh-credentials-local`），把 Key 写进 DSH 自己的凭证文件
   `$DSH_HOME/.credentials.yaml`（未设置 `DSH_HOME` 时为 `~/.dsh`），立即生效，终端里的 dsh 也会使用；
   插件和 Cindy 都不另存这个 Key，设置页也从不回显它。也可以照旧按 DSH 自己的说明用环境变量或 `.env`
   配置，设置页会显示 Key 来自哪里；在设置页保存的 Key 优先。模型同样由 DSH 自己的配置决定。

## 本地安装

插件源码就是本目录，按 Cindy 插件工具链打包、安装（见随 Cindy 分发的
`cindy-plugin-creator` 手册 §7）：

1. 在 Cindy 的任务里让 Agent 调用 `ghost_forge_pack({ dir: "<本目录绝对路径>" })`：只校验并在本
   目录生成 `dsh-acp-<版本>.cindy`，不会安装。
2. 需要安装时，明确让 Agent 调用 `ghost_forge_install({ dir: "<本目录绝对路径>" })`，或在 Cindy
   的插件页导入上一步生成的 `.cindy`。安装确认会列出 Node 工作进程（本机权限）和
   「提供执行引擎 DeepSeek Harness」两项权限，确认后插件启用。
3. 打开插件详情的设置区查看检测结果；状态为「可以使用」后，新建任务时在模型选择器的引擎
   分组里选择 DeepSeek Harness。

本目录不在已安装插件目录里，修改源码后重复第 2 步即可原位更新（保留启用状态与配置）。

## 发布新版本

1. 修改 `ghost.json` 的 `version`（例如 `0.1.1`）。
2. 在 Cindy 里让 Agent 调用 `ghost_forge_pack` 打包，得到 `dsh-acp-<版本>.cindy`。
3. 创建 GitHub Release，标签必须是 `v<版本>`（与清单版本一致），附件为上一步的 `.cindy`：

   ```sh
   gh release create v0.1.1 dsh-acp-0.1.1.cindy --title "v0.1.1" --notes "…"
   ```

   草稿不会被检测到；预发布会在设置页标注。

## 测试

不需要真的安装 dsh：

```sh
node --test test/bridge.test.mjs
```

测试把假的 `dsh`（Node 脚本，Windows 上配 `.cmd` 包装，其他平台配 `sh` 包装）放到临时
`PATH` 上，验证：

- `detect` 能找到 dsh 并报告版本；没有 dsh 时报告 `not-installed` 和中英文安装提示；
  `--version` 失败时报告 `not-runnable`；未知方法返回 `-32601`。
- `dsh-acp.js` 把 `initialize` 的响应逐字节原样送回 stdout（响应在一个多字节字符中间被拆开
  发送）、没有多余字节；关闭 stdin 后两个进程都退出、没有残留 dsh；结束入口进程后 dsh 也被
  结束；dsh 在 stdin 关闭后赖着不走时会被强制结束（Windows 上走 `taskkill /T`）；找不到 dsh
  时退出码 127、stdout 为空、stderr 只有一行。

## 已知限制

DSH 通过 ACP 提供的能力（来自 DSH 的 ACP 说明）：

- 不支持：回放历史（重开任务时 Cindy 显示自己保存的消息）、分叉、终端（`terminal/*`）、
  计划与模式切换。
- 支持：恢复会话、会话列表与关闭、选择模型与推理强度、HTTP MCP（Cindy 工具经本机 HTTP MCP
  桥提供）。

插件自身：

- 第一期只做自动检测，不能手动指定 dsh 路径；存在多份 dsh 时用查找顺序里的第一份。
- 不校验 dsh 的最低版本：只要 `dsh --version` 能运行就视为可用。
- Cindy 给插件 Node 进程的环境变量是精简过的（`PATH`、`HOME` / `USERPROFILE`、`APPDATA`、
  `LOCALAPPDATA`、临时目录、语言等），dsh 也只拿到这些。只写在 shell 配置里的
  `DSH_HOME`、`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`、`NODE_EXTRA_CA_CERTS` 等变量不会传给
  dsh；需要时请把配置放在 DSH 的默认目录。
- 逻辑页以 `launch: "resident"` 常驻，以便 Cindy 启动时就发布可用状态；插件详情会标注
  「常驻运行」。Node 工作进程仍是按需启动，检测完 30 秒空闲后关闭。
- Windows 上 Cindy 强制结束入口进程时不会执行任何清理代码；此时 dsh 依靠 stdin 被关闭而
  自行退出（DSH 的 ACP 模式在断开后退出）。
- Cindy 窗口获得焦点时不会重新检测：宿主没有给插件提供低成本的窗口焦点事件。
