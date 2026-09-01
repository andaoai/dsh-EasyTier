# dsh-EasyTier

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里管理 [EasyTier](https://easytier.cn) 个人内网组网的插件（TUN 模式，独立管理 `easytier-core`，不依赖 wfmon）。

- **设置页面板**：设置 →「EasyTier 组网」，一页看清节点状态、对等节点延迟/丢包/协议，一键启停、加/删引导节点
- **Agent 工具**：`easytier_status` / `easytier_start` / `easytier_stop` / `easytier_peer`，对话里直接管组网
- **自动引导二进制**：检测不到 `easytier-core`/`easytier-cli` 时，从 GitHub Release 下载官方发行包到 `~/.local/share/dsh-easytier/bin/`
- **状态查询走 easytier-cli**：core 的 RPC portal 是 protobuf-over-TCP（非 HTTP），统一用官方 `easytier-cli -o json` 查询

## 安装（正式插件，推荐）

本仓库是一个标准 DSH bundle 插件，可直接安装（host 半在完整 Node 环境运行，client 半加载进设置页）：

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-easytier

# 或从 GitHub 安装
dsh plugin --profile web add github:andaoai/dsh-EasyTier

# 或从本地源码安装（开发/自测）
dsh plugin --profile web add /path/to/dsh-EasyTier
```

安装后**重启 `dsh web`**（host 半在启动时组合加载；client 半页面刷新即生效）。插件通过包内 `cordis.patch.yml` 自动挂载，无需手写 profile patch。

## TUN 权限（Linux，一次性）

TUN 虚拟网卡需要 `CAP_NET_ADMIN` + `CAP_NET_RAW`。DSH 以普通用户运行，给 core 二进制授权一次即可：

```bash
sudo setcap 'cap_net_admin,cap_net_raw+eip' "$(command -v easytier-core || echo /opt/easytier/easytier-core)"
```

设置页检测到缺权限时会展示对应路径的完整命令。与 wfmon 的 ambient capabilities 委托是同一套机制。

## 使用

打开 设置 → EasyTier 组网：

- 缺二进制时点「一键安装 easytier」
- 填网络名、网络密钥、引导节点（默认 `tcp://39.108.52.138:11010`），点「启动并接入」
- 或在对话中让 Agent：「看一下 EasyTier 状态」「启动我的内网」「把 tcp://x:11010 加进组网」

## 数据目录

```
~/.local/share/dsh-easytier/
├── bin/          # easytier-core / easytier-cli（自动下载）
├── cache/        # 发行包缓存
├── config.json   # 组网配置（chmod 600，含网络密钥）
└── core.toml     # 生成的 easytier-core 配置（chmod 600）
```

默认 TUN 网卡名 `dshet0`、RPC 端口 `15898`（wfmon 的实例占用 15888/`wfmon84`，互不冲突）。

## 实测运维要点

- **DHCP vs 静态 IP**：EasyTier 在拿到虚拟 IP 后才创建 TUN 网卡。加入已有节点的网络时 DHCP 一般能自动分到 `10.0.x.x`；若是自建/独立网络且长时间分不到 IP（`ipv4_addr` 为空、网卡不出现），取消勾选「DHCP」并填静态 CIDR（如 `10.0.0.99/24`）即可立即建卡——wfmon 用的就是静态 IP（`10.0.0.84/24`）。
- **同机双 TUN 路由冲突**：wfmon 已占用 `wfmon84 = 10.0.0.84/24` 并声明了 `10.0.0.0/24` 路由。若插件实例再加入**同一网络、同一网段**，会出现第二条 `10.0.0.0/24` 路由导致 mesh 流量走向不确定。二选一：
  - 插件实例用于**另一个网络**（不同网络名/密钥，或改用别的网段如 `10.1.0.x/24`），与 wfmon 并存；
  - 或想让插件接管 wfmon 在用的网络，先在 wfmon 看板断开其组网，再用插件启动。
- **查询链路**：`easytier-cli -p 127.0.0.1:<rpcPort> -o json node info|peer list|connector add|remove`。
- **生命周期**：插件停用或 dsh 进程退出时，由它拉起的 easytier-core 会一并终止；需要长期常驻请用 `easytier-core --daemon` 或 systemd。

## 仓库结构

```
dsh-EasyTier/
├── package.json         # bundle 清单：exports、dsh.bundle.patch、dsh.client、peerDependencies
├── cordis.patch.yml     # loader 组合时自动插入插件层
├── lib/index.js         # host 半（ESM）：Node 原生 child_process/fs + defineTool + webServer 路由
├── client/client.js     # client 半：ModuleLoader bundle，注册设置页面板，fetch 调同源路由
└── plugin/              # 动态插件函数体（host.js / client.js），用于会话内临时试用
```

`lib/` + `client/` 是**正式 bundle**（持久、可发布、随 dsh 加载）；`plugin/` 是**动态 Cordis 插件**函数体，可在会话里用 `cordis_define`/`cordis_run` 临时加载（进程内有效，重启失效），便于不改环境先试用或调试。两者功能一致。

## 发布到插件市场

1. `npm publish`（包名需在 npm 未被占用），或提供 GitHub Release tarball；
2. 到策展目录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提一个 PR（列表加一条），站点与插件市场通常一天内自动收录；
3. 收录后别人即可在 设置 → 插件市场 一键安装。

市场只安装策展目录里的插件；未收录前也可直接用上面的 `dsh plugin add` 从 npm/GitHub/本地安装。

## 开发备忘

**bundle（正式）与动态插件的差异**：

- bundle host 是完整 Node ESM 环境：直接 `import { spawn } from 'node:child_process'`、`node:fs`、`node:os`；工具用 `import { defineTool } from '@deepseek-ai/dsh-tools'` + `ctx.tools.register(defineTool({...}))`；client↔host 通信用 `ctx.webServer.register({kind:'exact', path, handler})` 挂同源 HTTP 路由 + client `fetch`（POST 校验 `Origin === Host`）。
- bundle client 由 `window.__ModuleLoader__.load({id, factory:(require)=>{...}})` 包裹，`require('react')` 取 React；服务经 `inject: ['slots','timer']` 后用 `ctx.slots`/`ctx.timer`；本仓库为免构建用 `React.createElement`（也可用 `react/jsx-runtime` 写 JSX 后打包）。
- `@deepseek-ai/*` 与 `react` 是宿主提供的 peer 依赖，不要打进 bundle。
- 自测 host：在能解析 `@deepseek-ai/dsh-tools` 的环境（dsh 全局包的 node_modules）用最小 mock ctx 调 `apply()`，断言工具/路由注册数；`dsh plugin --profile <tmp> add ./` 可验证包能被 loader 安装解析。

**动态插件沙箱踩过的坑**（`plugin/` 版；bundle 用 Node 原生 API 已规避大部分）：

- `shell.run()` 的 `stdout`/`stderr` 是 `CollectedOutput` 对象（`{text,truncated,spillPath}`）不是字符串，需取 `.text`。
- 动态 Host 沙箱不保证有 `Date`；bundle 是完整 Node，可直接 `Date.now()`。
- shell 命令里 `find ... \( ... \)` 的反斜杠会被 JS 模板字符串吞掉，解压改用 `cp easytier-linux-*/easytier-* ...` glob。
- `defineTool` 输出 schema 对象需显式 `additionalProperties: true`；参数不允许 `required: false`（可选参数省略 `required`）。
- 仅 x86_64 / aarch64 Linux 支持二进制自动引导。
