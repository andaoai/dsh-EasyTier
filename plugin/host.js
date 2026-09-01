// dsh-EasyTier · Host 半部分（Cordis 动态插件函数体）
// 独立管理 easytier-core：二进制引导（官方发行包）、TUN 组网实例生命周期、
// easytier-cli 状态查询、对等节点管理，并向 Agent 注册动态 Tools。
//
// 说明：本文件内容即 cordis_define 的 code.host「函数体」，不是可独立 require 的模块。

const DEFAULT_CONFIG = {
  networkName: '',
  networkSecret: '',
  peers: ['tcp://39.108.52.138:11010'],
  dhcp: true,
  ipv4: '',
  devName: 'dshet0',
  rpcPort: 15898,
  mtu: 1380,
}

return {
  name: 'dsh-easytier-host',
  inject: ['tools'],
  apply(ctx) {
    const shell = ctx.get('shell')
    const subprocess = ctx.get('subprocess')
    if (!shell || !subprocess) {
      console.error('[dsh-easytier] shell/subprocess 服务不可用，插件不启动')
      return
    }

    const state = {
      ready: false,
      env: null,
      dataDir: null,
      hostname: '',
      arch: '',
      corePath: null,
      cliPath: null,
      coreVersion: null,
      config: { ...DEFAULT_CONFIG, peers: [...DEFAULT_CONFIG.peers] },
      proc: null,
      startedAt: null,
      lastExit: null,
      lastError: null,
      logBuf: '',
      logOffset: { out: 0, err: 0 },
    }

    // ---------- 基础工具 ----------

    async function sh(command, opts = {}) {
      const spec = shell.resolve({
        command,
        timeoutMs: opts.timeoutMs ?? 20000,
        stdoutMaxBytes: opts.stdoutMaxBytes ?? 512 * 1024,
        stdin: opts.stdin,
        // 动态插件的 shell 默认套会话沙箱（workspace 外只读），而插件数据目录在
        // ~/.local/share；本会话已是 danger-full-access，显式声明确保写盘/下载不被拦。
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: state.dataDir || '/' },
      })
      const r = await shell.run(spec)
      // shell.run 的 stdout/stderr 是 CollectedOutput 对象（{text,truncated,spillPath}），
      // 规范化成字符串，方便下游按字符串使用。
      const asText = (v) => (typeof v === 'string' ? v : (v && typeof v.text === 'string' ? v.text : ''))
      return {
        exitCode: r.exitCode,
        signal: r.signal,
        timedOut: r.timedOut,
        stdout: asText(r.stdout),
        stderr: asText(r.stderr),
      }
    }

    function q(s) {
      return `'${String(s).replace(/'/g, `'\\''`)}'`
    }

    // host 沙箱不保证有 Date，用系统 date 取毫秒时间戳
    async function nowMs() {
      try {
        const r = await sh(`date +%s%3N`, { timeoutMs: 5000 })
        const n = Number((r.stdout || '').trim())
        if (Number.isFinite(n) && n > 0) return n
      } catch (e) {}
      return 0
    }

    async function writeFile(path, content, mode) {
      const r = await sh(`cat > ${q(path)}`, { stdin: content, timeoutMs: 10000 })
      if (r.exitCode !== 0) return false
      if (mode) await sh(`chmod ${mode} ${q(path)}`, { timeoutMs: 5000 })
      return true
    }

    async function readFileText(path) {
      const r = await sh(`test -f ${q(path)} && cat ${q(path)} || true`, { timeoutMs: 5000 })
      return r.exitCode === 0 ? r.stdout.trim() : ''
    }

    // ---------- 环境与二进制 ----------

    async function detectEnvironment() {
      const r = await sh(`printf 'HOME=%s\\nUSER=%s\\nLANG=%s\\nHOST=%s\\nARCH=%s\\n' "$HOME" "$USER" "$LANG" "$(hostname)" "$(uname -m)"`, { timeoutMs: 8000 })
      const env = {}
      for (const line of r.stdout.split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
      }
      state.env = { HOME: env.HOME, USER: env.USER, LANG: env.LANG || 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' }
      state.hostname = env.HOST || ''
      state.arch = env.ARCH || ''
      state.dataDir = `${env.HOME}/.local/share/dsh-easytier`
      await sh(`mkdir -p ${q(state.dataDir)}/bin ${q(state.dataDir)}/cache`, { timeoutMs: 5000 })
    }

    async function detectBinaries() {
      const candidates = [
        '/opt/easytier/easytier-core',
        '/usr/local/bin/easytier-core',
        `${state.dataDir}/bin/easytier-core`,
      ]
      for (const p of candidates) {
        const r = await sh(`test -x ${q(p)} && echo yes || true`, { timeoutMs: 5000 })
        if (r.stdout.trim() === 'yes') { state.corePath = p; break }
      }
      if (!state.corePath) {
        const r = await sh(`command -v easytier-core || true`, { timeoutMs: 5000 })
        const p = r.stdout.trim()
        if (p) state.corePath = p
      }
      const cliCandidates = [
        '/opt/easytier/easytier-cli',
        '/usr/local/bin/easytier-cli',
        `${state.dataDir}/bin/easytier-cli`,
      ]
      for (const p of cliCandidates) {
        const r = await sh(`test -x ${q(p)} && echo yes || true`, { timeoutMs: 5000 })
        if (r.stdout.trim() === 'yes') { state.cliPath = p; break }
      }
      if (!state.cliPath) {
        const r = await sh(`command -v easytier-cli || true`, { timeoutMs: 5000 })
        const p = r.stdout.trim()
        if (p) state.cliPath = p
      }
      if (state.corePath) {
        const v = await sh(`${q(state.corePath)} --version`, { timeoutMs: 8000 })
        const m = (v.stdout || '').match(/(\d+\.\d+\.\d+)/)
        if (m) state.coreVersion = m[1]
      }
    }

    // 下载官方发行包，补齐 core / cli 到 dataDir/bin
    async function ensureBinaries(force) {
      if (!force && state.corePath && state.cliPath) {
        return { ok: true, corePath: state.corePath, cliPath: state.cliPath, coreVersion: state.coreVersion }
      }
      const archMap = { x86_64: 'x86_64', aarch64: 'aarch64' }
      const arch = archMap[state.arch]
      if (!arch) return { ok: false, error: `暂不支持架构 ${state.arch}（支持 x86_64/aarch64），请手动安装 easytier-core/easytier-cli` }
      let ver = state.coreVersion
      if (!ver) {
        const v = await sh(`curl -fsSL --connect-timeout 15 --max-time 30 https://api.github.com/repos/EasyTier/EasyTier/releases/latest`, { timeoutMs: 40000 })
        const m = (v.stdout || '').match(/"tag_name":\s*"v?(\d+\.\d+\.\d+)"/)
        if (!m) return { ok: false, error: '无法获取 EasyTier 最新版本号（网络不通？）' }
        ver = m[1]
      }
      const url = `https://github.com/EasyTier/EasyTier/releases/download/v${ver}/easytier-linux-${arch}-v${ver}.zip`
      const dl = await sh(`curl -fSL --retry 2 --connect-timeout 15 --max-time 240 -o ${q(state.dataDir)}/cache/et.zip ${q(url)}`, { timeoutMs: 260000, stdoutMaxBytes: 4096 })
      if (dl.exitCode !== 0) return { ok: false, error: '下载 easytier 发行包失败：' + (dl.stderr || '').slice(-300) }
      const uz = await sh(
        `rm -rf ${q(state.dataDir)}/cache/extract && mkdir -p ${q(state.dataDir)}/cache/extract && cd ${q(state.dataDir)}/cache/extract && unzip -o -q ../et.zip && cp easytier-linux-*/easytier-core easytier-linux-*/easytier-cli ${q(state.dataDir)}/bin/ && chmod +x ${q(state.dataDir)}/bin/easytier-core ${q(state.dataDir)}/bin/easytier-cli`,
        { timeoutMs: 60000 },
      )
      if (uz.exitCode !== 0) return { ok: false, error: '解压发行包失败：' + (uz.stderr || '').slice(-300) }
      state.corePath = `${state.dataDir}/bin/easytier-core`
      state.cliPath = `${state.dataDir}/bin/easytier-cli`
      state.coreVersion = ver
      return { ok: true, corePath: state.corePath, cliPath: state.cliPath, coreVersion: ver }
    }

    async function capsInfo() {
      if (!state.corePath) return { supported: false, getcapMissing: true, netAdmin: false, netRaw: false, setcapCmd: null }
      const r = await sh(`if command -v getcap >/dev/null 2>&1; then getcap ${q(state.corePath)}; else echo __NO_GETCAP__; fi`, { timeoutMs: 5000 })
      const out = r.stdout || ''
      if (out.includes('__NO_GETCAP__')) {
        return { supported: false, getcapMissing: true, netAdmin: false, netRaw: false, setcapCmd: `sudo setcap 'cap_net_admin,cap_net_raw+eip' ${state.corePath}` }
      }
      const netAdmin = /cap_net_admin\b/.test(out)
      const netRaw = /cap_net_raw\b/.test(out)
      return {
        supported: true,
        getcapMissing: false,
        netAdmin,
        netRaw,
        ok: netAdmin && netRaw,
        setcapCmd: `sudo setcap 'cap_net_admin,cap_net_raw+eip' ${state.corePath}`,
        raw: out.trim(),
      }
    }

    // ---------- 配置 ----------

    function tomStr(s) {
      return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    }

    function buildToml(cfg) {
      const lines = [
        `instance_name = ${tomStr('dsh-easytier')}`,
        `hostname = ${tomStr(state.hostname)}`,
        `listeners = []`,
        `dhcp = ${cfg.dhcp ? 'true' : 'false'}`,
        `rpc_portal = ${tomStr(`127.0.0.1:${cfg.rpcPort}`)}`,
      ]
      if (!cfg.dhcp) {
        if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cfg.ipv4 || '')) throw new Error('静态 IPv4 需写成 CIDR 形式，例如 10.0.0.99/24')
        lines.push(`ipv4 = ${tomStr(cfg.ipv4)}`)
      }
      lines.push('', '[network_identity]', `network_name = ${tomStr(cfg.networkName)}`, `network_secret = ${tomStr(cfg.networkSecret)}`)
      for (const peer of cfg.peers) {
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(peer)) throw new Error(`peer 地址格式不正确：${peer}（示例 tcp://1.2.3.4:11010）`)
        lines.push('', '[[peer]]', `uri = ${tomStr(peer)}`)
      }
      lines.push(
        '', '[flags]',
        'default_protocol = "udp"',
        `dev_name = ${tomStr(cfg.devName)}`,
        'enable_encryption = true',
        'enable_ipv6 = false',
        `mtu = ${cfg.mtu}`,
        'no_tun = false',
        'use_smoltcp = false',
      )
      return lines.join('\n') + '\n'
    }

    async function loadSavedConfig() {
      const txt = await readFileText(`${state.dataDir}/config.json`)
      if (!txt) return
      try {
        const saved = JSON.parse(txt)
        state.config = { ...state.config, ...saved }
      } catch (e) {
        console.error('[dsh-easytier] 保存的配置解析失败', e)
      }
    }

    async function saveConfig() {
      const { networkName, networkSecret, peers, dhcp, ipv4, devName, rpcPort, mtu } = state.config
      await writeFile(`${state.dataDir}/config.json`, JSON.stringify({ networkName, networkSecret, peers, dhcp, ipv4, devName, rpcPort, mtu }, null, 2), '600')
    }

    function publicConfig() {
      return {
        networkName: state.config.networkName,
        peers: state.config.peers,
        dhcp: state.config.dhcp,
        ipv4: state.config.ipv4,
        devName: state.config.devName,
        rpcPort: state.config.rpcPort,
        mtu: state.config.mtu,
        hasSecret: !!state.config.networkSecret,
      }
    }

    // ---------- 日志 ----------

    function drainLogs() {
      if (!state.proc) return state.logBuf
      const cols = [['out', state.proc.collected.stdout], ['err', state.proc.collected.stderr]]
      for (const [name, reader] of cols) {
        if (!reader) continue
        const r = reader.readFrom(state.logOffset[name] || 0)
        state.logOffset[name] = r.nextOffset
        if (r.text) state.logBuf = (state.logBuf + r.text).slice(-24000)
      }
      return state.logBuf
    }

    // ---------- core 生命周期 ----------

    async function startCore(patch) {
      if (state.proc) return { ok: false, error: 'easytier-core 已在运行中' }
      state.lastError = null
      state.lastExit = null

      if (patch && typeof patch === 'object') {
        const next = { ...state.config, ...patch }
        if (patch.peers !== undefined) next.peers = patch.peers
        if (patch.networkSecret === undefined || patch.networkSecret === '') {
          // 留空表示沿用已保存密钥
          next.networkSecret = state.config.networkSecret
        }
        state.config = next
      }
      const cfg = state.config
      if (!cfg.networkName) return { ok: false, error: '缺少 networkName（网络名）' }
      if (!cfg.networkSecret) return { ok: false, error: '缺少 networkSecret（网络密钥；首次启动必须提供）' }
      if (!cfg.peers || cfg.peers.length === 0) return { ok: false, error: '至少需要一个 peer 引导节点地址' }
      if (!cfg.devName || cfg.devName.length > 15) return { ok: false, error: 'TUN 网卡名不能为空且长度 ≤ 15' }
      cfg.rpcPort = Number(cfg.rpcPort) || DEFAULT_CONFIG.rpcPort

      let toml
      try {
        toml = buildToml(cfg)
      } catch (e) {
        return { ok: false, error: String(e.message || e) }
      }
      await saveConfig()
      const tomlPath = `${state.dataDir}/core.toml`
      const written = await writeFile(tomlPath, toml, '600')
      if (!written) return { ok: false, error: '写 core.toml 失败' }

      const caps = await capsInfo()
      if (caps.supported && !caps.ok) {
        return { ok: false, error: `easytier-core 缺少建 TUN 网卡的权限（CAP_NET_ADMIN/CAP_NET_RAW）。请在终端执行一次：\n${caps.setcapCmd}`, needSetcap: true, setcapCmd: caps.setcapCmd }
      }

      let proc
      try {
        proc = subprocess.spawn({
          argv: [state.corePath, '-c', tomlPath, '--console-log-level', 'info'],
          cwd: state.dataDir,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 256 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
            stderr: { maxBytes: 256 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
          },
          graceMs: 3000,
          env: state.env || undefined,
        })
      } catch (e) {
        return { ok: false, error: '启动 easytier-core 失败：' + String(e.message || e) }
      }
      state.proc = proc
      state.startedAt = await nowMs()
      state.logBuf = ''
      state.logOffset = { out: 0, err: 0 }

      proc.done.then((outcome) => {
        if (state.proc !== proc) return
        drainLogs()
        state.proc = null
        state.lastExit = outcome
        state.lastError = outcome.signal
          ? `easytier-core 被信号 ${outcome.signal} 终止`
          : `easytier-core 已退出（exit=${outcome.exitCode}）`
      }).catch(() => {})

      // 等待就绪：进程存活 + RPC 可查
      let node = null
      for (let i = 0; i < 15; i++) {
        await sh('sleep 1', { timeoutMs: 5000 })
        drainLogs()
        if (state.proc !== proc) break
        const info = await cliJson(['node', 'info'])
        if (info.ok) { node = info.data; break }
      }
      drainLogs()

      if (state.proc !== proc) {
        const tail = state.logBuf.split('\n').filter(Boolean).slice(-12).join('\n')
        return { ok: false, error: `easytier-core 启动后很快退出。${state.lastError || ''}\n${tail}` }
      }
      if (!node) {
        const tail = state.logBuf.split('\n').filter(Boolean).slice(-12).join('\n')
        if (/permission denied|Operation not permitted|TUN|tun/i.test(tail)) {
          return { ok: false, error: `TUN 网卡创建失败，通常是权限不足。请执行：\n${caps.setcapCmd}\n日志：\n${tail}`, needSetcap: true, setcapCmd: caps.setcapCmd }
        }
        return { ok: true, warning: '进程已启动但 RPC 暂未就绪（可能还在组网）', partial: true }
      }
      return { ok: true, node: pickNode(node) }
    }

    async function stopCore() {
      const proc = state.proc
      if (!proc) return { ok: true, alreadyStopped: true }
      state.proc = null
      try { proc.terminate() } catch (e) { console.error('[dsh-easytier] terminate 失败', e) }
      try {
        await Promise.race([proc.done, sh('sleep 6', { timeoutMs: 8000 })])
      } catch (e) {}
      drainLogs()
      state.startedAt = null
      return { ok: true }
    }

    // ---------- cli 查询 ----------

    async function cliJson(args) {
      if (!state.cliPath) return { ok: false, error: 'easytier-cli 未安装' }
      const portal = `127.0.0.1:${state.config.rpcPort || DEFAULT_CONFIG.rpcPort}`
      const r = await sh(`${q(state.cliPath)} -p ${q(portal)} -o json ${args.map(a => q(a)).join(' ')} 2>&1`, { timeoutMs: 9000, stdoutMaxBytes: 256 * 1024 })
      if (r.exitCode !== 0) return { ok: false, error: (r.stdout || r.stderr || '').trim().slice(-300) }
      try {
        return { ok: true, data: JSON.parse(r.stdout) }
      } catch (e) {
        return { ok: false, error: 'cli 输出不是 JSON：' + (r.stdout || '').slice(-200) }
      }
    }

    function pickNode(n) {
      return {
        peerId: String(n.peer_id ?? ''),
        ipv4: n.ipv4_addr || '',
        hostname: n.hostname || '',
        version: n.version || '',
        listeners: Array.isArray(n.listeners) ? n.listeners : [],
        natType: n.stun_info?.udp_nat_type ?? null,
        publicIps: Array.isArray(n.stun_info?.public_ip) ? n.stun_info.public_ip.slice(0, 4) : [],
      }
    }

    function pickPeers(list) {
      if (!Array.isArray(list)) return []
      return list.map((p) => ({
        id: String(p.id ?? ''),
        hostname: p.hostname || '',
        ipv4: p.ipv4 || p.cidr || '',
        cost: p.cost || '',
        latency: p.lat_ms || '-',
        loss: p.loss_rate || '-',
        rx: p.rx_bytes || '-',
        tx: p.tx_bytes || '-',
        proto: p.tunnel_proto || '-',
        nat: p.nat_type || '-',
        version: p.version || '',
      }))
    }

    async function foreignInstances() {
      const ownPid = state.proc?.pid
      const r = await sh(`pgrep -af easytier-core || true`, { timeoutMs: 5000 })
      const out = []
      for (const line of (r.stdout || '').split('\n')) {
        const m = line.match(/^(\d+)\s+(.*)$/)
        if (!m) continue
        const pid = Number(m[1])
        if (pid === ownPid) continue
        out.push({ pid, cmd: m[2].slice(0, 180) })
        if (out.length >= 5) break
      }
      return out
    }

    async function status() {
      const caps = await capsInfo()
      let fsWritable = null
      if (state.dataDir) {
        const probe = await sh(`mkdir -p ${q(state.dataDir)}/bin && touch ${q(state.dataDir)}/.probe && echo ok`, { timeoutMs: 6000 })
        fsWritable = probe.stdout.trim() === 'ok'
      }
      const running = !!state.proc
      let node = null
      let peers = null
      let cliError = null
      if (running) {
        drainLogs()
        if (state.cliPath) {
          const [n, p] = await Promise.all([cliJson(['node', 'info']), cliJson(['peer', 'list'])])
          if (n.ok) node = pickNode(n.data)
          else cliError = n.error
          if (p.ok) peers = pickPeers(p.data)
        } else {
          cliError = 'easytier-cli 未安装，无法查询节点详情'
        }
      }
      return {
        ok: true,
        host: { hostname: state.hostname, arch: state.arch },
        ready: state.ready,
        binaries: {
          corePath: state.corePath,
          cliPath: state.cliPath,
          coreVersion: state.coreVersion,
          coreMissing: !state.corePath,
          cliMissing: !state.cliPath,
        },
        caps,
        fsWritable,
        dataDir: state.dataDir,
        running,
        pid: state.proc?.pid ?? null,
        startedAt: state.startedAt,
        uptimeSec: state.startedAt ? Math.max(0, Math.floor(((await nowMs()) - state.startedAt) / 1000)) : null,
        config: publicConfig(),
        node,
        peers,
        cliError,
        foreign: running ? await foreignInstances() : [],
        error: running ? null : state.lastError,
        logTail: running ? state.logBuf.split('\n').filter(Boolean).slice(-15).join('\n') : '',
      }
    }

    async function peerAction(action, url) {
      if (!state.proc) return { ok: false, error: 'easytier-core 未运行' }
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url || '')) return { ok: false, error: 'URL 格式不正确，示例 tcp://1.2.3.4:11010' }
      const args = action === 'remove' ? ['connector', 'remove', url] : ['connector', 'add', url]
      const r = await cliJson(args)
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true }
    }

    // ---------- 初始化 ----------

    async function diag(msg) {
      try {
        const safe = String(msg).replace(/\n/g, ' | ').slice(0, 500)
        await sh(`echo ${q(safe)} >> /tmp/dsh-easytier-diag.log`, { timeoutMs: 8000 })
      } catch (e) {}
    }

    async function init() {
      try {
        await diag('init start; shell=' + (shell ? 'yes' : 'no') + ' subprocess=' + (subprocess ? 'yes' : 'no'))
        await detectEnvironment()
        await diag('detectEnvironment done: dataDir=' + state.dataDir + ' arch=' + state.arch + ' host=' + state.hostname)
        await detectBinaries()
        await diag('detectBinaries done: core=' + state.corePath + ' cli=' + state.cliPath + ' ver=' + state.coreVersion)
        await loadSavedConfig()
        state.ready = true
        if (!state.corePath || !state.cliPath) {
          await diag('开始后台引导二进制...')
          ensureBinaries(false).then(async (r) => {
            await diag('ensureBinaries 结果: ' + JSON.stringify(r).slice(0, 600))
            if (!r.ok) console.error('[dsh-easytier] 二进制引导失败：' + r.error)
          }).catch(async (e) => { await diag('ensureBinaries 异常: ' + (e && e.stack || e)); console.error('[dsh-easytier] 二进制引导异常', e) })
        } else {
          await diag('二进制齐备，无需下载')
        }
      } catch (e) {
        await diag('初始化失败: ' + (e && e.stack || e))
        console.error('[dsh-easytier] 初始化失败', e)
      }
    }

    // ---------- RPC（Client → Host）----------

    ctx.effect(() => {
      const disposers = []
      disposers.push(harness.handle('et/status', async () => status()))
      disposers.push(harness.handle('et/bootstrap', async () => ensureBinaries(true)))
      disposers.push(harness.handle('et/start', async (args) => startCore(args && args.config)))
      disposers.push(harness.handle('et/stop', async () => stopCore()))
      disposers.push(harness.handle('et/restart', async () => {
        await stopCore()
        await sh('sleep 1', { timeoutMs: 3000 })
        return startCore()
      }))
      disposers.push(harness.handle('et/peer', async (args) => peerAction(args && args.action, args && args.url)))

      // ---------- Agent 可见的动态 Tools ----------

      disposers.push(harness.registerTool(ctx, harness.defineTool({
        name: 'easytier_status',
        description: '查看本机 EasyTier 内网组网状态：easytier-core 进程、TUN 虚拟网卡、本机节点信息、对等节点（主机名/虚拟IP/延迟/丢包/协议/NAT）、权能与冲突检测。无论组网是否在运行都可调用。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_args, value) {
            const lines = []
            if (!value.running) {
              lines.push(`EasyTier 未运行${value.error ? '：' + value.error : '。'}`)
            } else {
              const n = value.node
              lines.push(`EasyTier 运行中：pid=${value.pid}，版本=${value.binaries.coreVersion || '?'}，TUN=${value.config.devName}`)
              if (n) lines.push(`本机节点：${n.hostname}，虚拟IP=${n.ipv4 || '(DHCP)'}，peer_id=${n.peerId}，NAT=${n.natType ?? '?'}`)
              if (Array.isArray(value.peers)) {
                lines.push(`对等节点 ${value.peers.length} 个：`)
                for (const p of value.peers) {
                  lines.push(`- ${p.hostname || p.id} ${p.ipv4} | 延迟=${p.latency} 丢包=${p.loss} 协议=${p.proto} NAT=${p.nat}${p.cost === 'Local' ? '（本机）' : ''}`)
                }
              }
            }
            if (value.caps && value.caps.supported && !value.caps.ok) lines.push(`\n[权限] TUN 不可用，需执行：${value.caps.setcapCmd}`)
            if (Array.isArray(value.foreign) && value.foreign.length) lines.push(`\n[注意] 检测到其他 easytier-core 实例：${value.foreign.map(f => `pid=${f.pid}`).join(', ')}（如 wfmon 组网），同机多 TUN 请避免网络名/IP 冲突`)
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute() {
          return status()
        },
      })))

      disposers.push(harness.registerTool(ctx, harness.defineTool({
        name: 'easytier_start',
        description: '启动并接入 EasyTier 个人内网（TUN 虚拟网卡模式）：由插件拉起独立的 easytier-core 实例。首次启动需提供网络名与网络密钥；已保存密钥时 network_secret 可留空。需要 easytier-core 具备 CAP_NET_ADMIN/CAP_NET_RAW（失败信息会给出 setcap 命令）。',
        parameters: {
          network_name: { type: 'string', required: true, description: 'EasyTier 网络名（同一虚拟网内所有节点一致）' },
          network_secret: { type: 'string', description: '网络密钥；已保存过可留空' },
          peers: { type: 'array', items: { type: 'string' }, description: '引导节点地址列表，如 ["tcp://1.2.3.4:11010"]' },
          dhcp: { type: 'boolean', description: '是否自动分配虚拟 IP，默认 true' },
          ipv4: { type: 'string', description: '静态虚拟 IP（CIDR），如 10.0.0.99/24；dhcp=false 时必填' },
          dev_name: { type: 'string', description: 'TUN 网卡名，默认 dshet0' },
          rpc_port: { type: 'number', description: '本机 RPC 管理端口，默认 15898' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_args, value) {
            return [{ type: 'text', text: value.ok ? `EasyTier 已启动${value.node ? `：${value.node.hostname} 虚拟IP=${value.node.ipv4 || '(DHCP)'}` : '（进程已启动，正在组网）'}` : `启动失败：${value.error || '未知错误'}` }]
          },
        },
        async execute(args) {
          const patch = {
            networkName: args.network_name,
            peers: args.peers,
            dhcp: args.dhcp !== false,
            ipv4: args.ipv4 || '',
            devName: args.dev_name || undefined,
            rpcPort: args.rpc_port || undefined,
          }
          if (args.network_secret) patch.networkSecret = args.network_secret
          return startCore(patch)
        },
      })))

      disposers.push(harness.registerTool(ctx, harness.defineTool({
        name: 'easytier_stop',
        description: '停止由本插件管理的 easytier-core 实例（断开 EasyTier 内网，移除 TUN 网卡）。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_args, value) {
            return [{ type: 'text', text: value.ok ? 'EasyTier 已停止。' : `停止失败：${value.error || '未知错误'}` }]
          },
        },
        async execute() {
          return stopCore()
        },
      })))

      disposers.push(harness.registerTool(ctx, harness.defineTool({
        name: 'easytier_peer',
        description: '向正在运行的 EasyTier 实例添加或移除一个对等引导节点（connector），例如加入新的公网节点 tcp://host:11010。',
        parameters: {
          action: { type: 'string', enum: ['add', 'remove'], required: true, description: 'add=添加节点，remove=移除节点' },
          url: { type: 'string', required: true, description: '节点 URL，如 tcp://1.2.3.4:11010、udp://host:port、ws://host:port' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_args, value) {
            return [{ type: 'text', text: value.ok ? '节点操作成功。' : `节点操作失败：${value.error || '未知错误'}` }]
          },
        },
        async execute(args) {
          return peerAction(args.action, args.url)
        },
      })))

      // 插件卸载/更新时停掉 core，避免孤儿进程占用网卡与端口
      return () => {
        for (const d of disposers) { try { d() } catch (e) {} }
        try { if (state.proc) state.proc.terminate() } catch (e) {}
        state.proc = null
      }
    })

    init()
  },
}
