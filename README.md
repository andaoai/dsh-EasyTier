# dsh-EasyTier

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里管理 [EasyTier](https://easytier.cn) 个人内网组网的动态 Cordis 插件。

- **独立管理 easytier-core**：插件自己拉起/停止 TUN 模式的 `easytier-core` 实例，不依赖 wfmon
- **设置页面板**：设置 →「EasyTier 组网」，一页看清节点状态、对等节点延迟/丢包/协议，一键启停
- **Agent 工具**：`easytier_status` / `easytier_start` / `easytier_stop` / `easytier_peer`，对话里直接管组网
- **自动引导二进制**：检测不到 `easytier-core`/`easytier-cli` 时，从 GitHub Release 下载官方发行包到 `~/.local/share/dsh-easytier/bin/`
- **状态查询走 easytier-cli**：core 的 RPC portal 是 protobuf 自定义协议，插件用官方 `easytier-cli -o json` 查询，不重写协议

## TUN 权限（Linux，一次性）

TUN 虚拟网卡需要 `CAP_NET_ADMIN` + `CAP_NET_RAW`。DSH 以普通用户运行，给 core 二进制授权一次即可：

```bash
sudo setcap 'cap_net_admin,cap_net_raw+eip' "$(command -v easytier-core || echo /opt/easytier/easytier-core)"
```

插件设置页检测到缺权限时会展示对应路径的完整命令。与 wfmon 的 ambient capabilities 委托是同一套机制。

## 使用

1. 在 DSH 会话中用 `cordis_define` 定义本插件（`plugin/host.js`、`plugin/client.js` 即函数体），`cordis_run` 激活
2. 打开 设置 → EasyTier 组网：
   - 缺二进制时点「一键安装 easytier」
   - 填网络名、网络密钥、引导节点（默认 `tcp://39.108.52.138:11010`），点「启动并接入」
3. 或在对话中让 Agent：「看一下 EasyTier 状态」「启动我的内网」「把 tcp://x:11010 加进组网」

## 数据目录

```
~/.local/share/dsh-easytier/
├── bin/          # easytier-core / easytier-cli（自动下载）
├── cache/        # 发行包缓存
├── config.json   # 组网配置（chmod 600，含网络密钥）
└── core.toml     # 生成的 easytier-core 配置（chmod 600）
```

默认 TUN 网卡名 `dshet0`、RPC 端口 `15898`（wfmon 的实例占用 15888/`wfmon84`，互不冲突）。

## 注意

- 动态插件随 DSH 进程退出而停止，core 实例会一并退出；需要长期常驻请用 `easytier-core --daemon` 或 systemd
- 同机已有 easytier-core（如 wfmon 组网）时，插件会提示冲突风险：同机多 TUN 请使用不同网络名或虚拟 IP 段
- 目前二进制引导支持 x86_64 / aarch64 Linux

## 实测运维要点

- **DHCP vs 静态 IP**：EasyTier 在拿到虚拟 IP 后才创建 TUN 网卡。加入已有节点的网络时 DHCP 一般能自动分到 `10.0.x.x`；若是自建/独立网络且长时间分不到 IP（`ipv4_addr` 为空、网卡不出现），取消勾选「DHCP」并填静态 CIDR（如 `10.0.0.99/24`）即可立即建卡——wfmon 用的就是静态 IP（`10.0.0.84/24`）。
- **同机双 TUN 路由冲突**：wfmon 已占用 `wfmon84 = 10.0.0.84/24` 并声明了 `10.0.0.0/24` 路由。若插件实例再加入**同一网络、同一网段**，会出现第二条 `10.0.0.0/24` 路由导致 mesh 流量走向不确定。二选一：
  - 插件实例用于**另一个网络**（不同网络名/密钥，或改用别的网段如 `10.1.0.x/24`），与 wfmon 并存；
  - 或想让插件接管 wfmon 正在用的那个网络，先在 wfmon 看板断开其组网，再用插件启动（可静态复用 wfmon 原先的虚拟 IP 或 DHCP）。
- **查询链路**：core 的 RPC portal 是 protobuf-over-TCP（非 HTTP），插件统一用 `easytier-cli -p 127.0.0.1:<rpcPort> -o json node info|peer list|connector add|remove` 查询与管理。
- **状态轮询**：设置页每 4s 调一次 `et/status`（内部跑 `getcap`/`easytier-cli` 等轻量命令）；core 未运行时只做权能与目录探测。

## 开发备忘（动态插件踩坑）

- `shell.run(spec)` 的 `stdout`/`stderr` 是 `CollectedOutput` 对象（`{text, truncated, spillPath}`），**不是字符串**，需取 `.text`；直接 `.split()` 会抛错导致整个 init 中断。
- 动态 Host 沙箱不保证有 `Date`，时间戳用系统 `date +%s%3N` 取。
- 给 shell 的命令字符串里，`find ... \( ... \)` 的反斜杠会被 JS 模板字符串吞掉，解压改用 `cp easytier-linux-*/easytier-* ...` 的 glob 形式。
- `defineTool` 输出 schema 的对象必须显式 `additionalProperties: true`；参数里不允许 `required: false`（可选参数省略 `required` 即可）。
- 动态插件的 shell 默认套会话沙箱（workspace 外只读），数据目录在 `~/.local/share` 时需在 `shell.resolve` 显式传 `sandboxPolicy: { mode: 'danger-full-access' }`。

