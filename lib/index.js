/**
 * dsh-EasyTier · Host bundle entry (ESM).
 *
 * 在 DeepSeek Harness 中独立管理 EasyTier 个人内网组网（TUN 模式）：
 *  - 引导 easytier-core / easytier-cli（GitHub Release 下载到用户数据目录）
 *  - 拉起/停止 easytier-core 实例、查询节点与对等节点状态
 *  - 注册 Agent 工具 easytier_status/start/stop/peer
 *  - 挂同源 HTTP 路由 /dsh-easytier/* 供设置页（client 半）调用
 *
 * 正式 bundle 插件运行在完整 Node 环境，直接使用 node:child_process / node:fs，
 * 不经过动态沙箱 shell 服务。
 *
 * @module dsh-easytier
 */

import { spawn, exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, arch as osArch, hostname as osHostname } from 'node:os'
import {
  mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync,
} from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execP = promisify(execCb)

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

export const name = 'dsh-easytier'
export const inject = ['tools', 'webServer']

export function apply(ctx) {
  const state = {
    ready: false,
    dataDir: null,
    hostname: osHostname(),
    arch: osArch(),
    corePath: null,
    cliPath: null,
    coreVersion: null,
    config: { ...DEFAULT_CONFIG, peers: [...DEFAULT_CONFIG.peers] },
    proc: null,
    startedAt: null,
    lastError: null,
    logBuf: '',
  }

  // ---------- 基础工具 ----------

  /** 跑一条 shell 命令（/bin/sh -c），把 stdout/stderr 规范成字符串。 */
  async function sh(command, opts = {}) {
    try {
      const { stdout, stderr } = await execP(command, {
        timeout: opts.timeoutMs ?? 20000,
        maxBuffer: opts.maxBuffer ?? 2 * 1024 * 1024,
        encoding: 'utf8',
      })
      return { exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
    } catch (e) {
      return {
        exitCode: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? String(e?.message ?? e),
      }
    }
  }

  function q(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`
  }

  function writeFile(path, content, mode) {
    try {
      writeFileSync(path, content, { encoding: 'utf8' })
      if (mode) chmodSync(path, mode)
      return true
    } catch {
      return false
    }
  }

  function readFileText(path) {
    try {
      return readFileSync(path, 'utf8').trim()
    } catch {
      return ''
    }
  }

  // ---------- 环境与二进制 ----------

  function detectEnvironment() {
    const home = process.env.HOME || homedir()
    state.dataDir = join(home, '.local', 'share', 'dsh-easytier')
    try {
      mkdirSync(join(state.dataDir, 'bin'), { recursive: true })
      mkdirSync(join(state.dataDir, 'cache'), { recursive: true })
    } catch (e) {
      console.error('[dsh-easytier] 创建数据目录失败', e)
    }
  }

  async function detectBinaries() {
    const coreCandidates = [
      '/opt/easytier/easytier-core',
      '/usr/local/bin/easytier-core',
      join(state.dataDir, 'bin', 'easytier-core'),
    ]
    for (const p of coreCandidates) {
      if (existsSync(p)) { state.corePath = p; break }
    }
    if (!state.corePath) {
      const r = await sh(`command -v easytier-core || true`, { timeoutMs: 5000 })
      const p = r.stdout.trim()
      if (p) state.corePath = p
    }
    const cliCandidates = [
      '/opt/easytier/easytier-cli',
      '/usr/local/bin/easytier-cli',
      join(state.dataDir, 'bin', 'easytier-cli'),
    ]
    for (const p of cliCandidates) {
      if (existsSync(p)) { state.cliPath = p; break }
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

  async function ensureBinaries(force) {
    if (!force && state.corePath && state.cliPath) {
      return { ok: true, corePath: state.corePath, cliPath: state.cliPath, coreVersion: state.coreVersion }
    }
    const archMap = { x64: 'x86_64', x86_64: 'x86_64', arm64: 'aarch64', aarch64: 'aarch64' }
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
    const dl = await sh(`curl -fSL --retry 2 --connect-timeout 15 --max-time 240 -o ${q(join(state.dataDir, 'cache', 'et.zip'))} ${q(url)}`, { timeoutMs: 260000, maxBuffer: 64 * 1024 })
    if (dl.exitCode !== 0) return { ok: false, error: '下载 easytier 发行包失败：' + (dl.stderr || dl.stdout || '').slice(-300) }
    const binDir = join(state.dataDir, 'bin')
    const cacheDir = join(state.dataDir, 'cache')
    const uz = await sh(
      `rm -rf ${q(join(cacheDir, 'extract'))} && mkdir -p ${q(join(cacheDir, 'extract'))} && cd ${q(join(cacheDir, 'extract'))} && unzip -o -q ../et.zip && cp easytier-linux-*/easytier-core easytier-linux-*/easytier-cli ${q(binDir)}/ && chmod +x ${q(join(binDir, 'easytier-core'))} ${q(join(binDir, 'easytier-cli'))}`,
      { timeoutMs: 60000 },
    )
    if (uz.exitCode !== 0) return { ok: false, error: '解压发行包失败：' + (uz.stderr || uz.stdout || '').slice(-300) }
    state.corePath = join(binDir, 'easytier-core')
    state.cliPath = join(binDir, 'easytier-cli')
    state.coreVersion = ver
    return { ok: true, corePath: state.corePath, cliPath: state.cliPath, coreVersion: ver }
  }

  async function capsInfo() {
    if (!state.corePath) return { supported: false, getcapMissing: true, netAdmin: false, netRaw: false, ok: false, setcapCmd: null }
    const r = await sh(`if command -v getcap >/dev/null 2>&1; then getcap ${q(state.corePath)}; else echo __NO_GETCAP__; fi`, { timeoutMs: 5000 })
    const out = r.stdout || ''
    if (out.includes('__NO_GETCAP__')) {
      return { supported: false, getcapMissing: true, netAdmin: false, netRaw: false, ok: false, setcapCmd: `sudo setcap 'cap_net_admin,cap_net_raw+eip' ${state.corePath}` }
    }
    const netAdmin = /cap_net_admin\b/.test(out)
    const netRaw = /cap_net_raw\b/.test(out)
    return { supported: true, getcapMissing: false, netAdmin, netRaw, ok: netAdmin && netRaw, setcapCmd: `sudo setcap 'cap_net_admin,cap_net_raw+eip' ${state.corePath}`, raw: out.trim() }
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

  function loadSavedConfig() {
    const txt = readFileText(join(state.dataDir, 'config.json'))
    if (!txt) return
    try {
      const saved = JSON.parse(txt)
      state.config = { ...state.config, ...saved }
    } catch (e) {
      console.error('[dsh-easytier] 保存的配置解析失败', e)
    }
  }

  function saveConfig() {
    const { networkName, networkSecret, peers, dhcp, ipv4, devName, rpcPort, mtu } = state.config
    writeFile(
      join(state.dataDir, 'config.json'),
      JSON.stringify({ networkName, networkSecret, peers, dhcp, ipv4, devName, rpcPort, mtu }, null, 2),
      0o600,
    )
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

  // ---------- 进程 ----------

  function spawnCore(corePath, tomlPath) {
    const child = spawn(corePath, ['-c', tomlPath, '--console-log-level', 'info'], {
      cwd: state.dataDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const append = (chunk) => {
      state.logBuf = (state.logBuf + chunk).slice(-24000)
      out = (out + chunk).slice(-24000)
    }
    child.stdout?.on('data', (d) => append(d.toString('utf8')))
    child.stderr?.on('data', (d) => append(d.toString('utf8')))
    const done = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ exitCode: code, signal }))
      child.on('error', (err) => resolve({ exitCode: -1, signal: null, error: String(err?.message || err) }))
    })
    return {
      pid: child.pid,
      done,
      terminate() { try { child.kill('SIGTERM') } catch { /* noop */ } },
    }
  }

  async function startCore(patch) {
    if (state.proc) return { ok: false, error: 'easytier-core 已在运行中' }
    state.lastError = null

    if (patch && typeof patch === 'object') {
      const next = { ...state.config, ...patch }
      if (patch.peers !== undefined) next.peers = patch.peers
      if (patch.networkSecret === undefined || patch.networkSecret === '') next.networkSecret = state.config.networkSecret
      state.config = next
    }
    const cfg = state.config
    if (!cfg.networkName) return { ok: false, error: '缺少 networkName（网络名）' }
    if (!cfg.networkSecret) return { ok: false, error: '缺少 networkSecret（网络密钥；首次启动必须提供）' }
    if (!cfg.peers || cfg.peers.length === 0) return { ok: false, error: '至少需要一个 peer 引导节点地址' }
    if (!cfg.devName || cfg.devName.length > 15) return { ok: false, error: 'TUN 网卡名不能为空且长度 ≤ 15' }
    cfg.rpcPort = Number(cfg.rpcPort) || DEFAULT_CONFIG.rpcPort

    let toml
    try { toml = buildToml(cfg) } catch (e) { return { ok: false, error: String(e.message || e) } }
    saveConfig()
    const tomlPath = join(state.dataDir, 'core.toml')
    if (!writeFile(tomlPath, toml, 0o600)) return { ok: false, error: '写 core.toml 失败' }

    const caps = await capsInfo()
    if (caps.supported && !caps.ok) {
      return { ok: false, error: `easytier-core 缺少建 TUN 网卡的权限（CAP_NET_ADMIN/CAP_NET_RAW）。请在终端执行一次：\n${caps.setcapCmd}`, needSetcap: true, setcapCmd: caps.setcapCmd }
    }

    let proc
    try {
      proc = spawnCore(state.corePath, tomlPath)
    } catch (e) {
      return { ok: false, error: '启动 easytier-core 失败：' + String(e.message || e) }
    }
    state.proc = proc
    state.startedAt = Date.now()
    state.logBuf = ''

    proc.done.then((outcome) => {
      if (state.proc !== proc) return
      state.proc = null
      state.lastError = outcome.signal
        ? `easytier-core 被信号 ${outcome.signal} 终止`
        : outcome.error
          ? `easytier-core 启动失败：${outcome.error}`
          : `easytier-core 已退出（exit=${outcome.exitCode}）`
    }).catch(() => {})

    let node = null
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if (state.proc !== proc) break
      const info = await cliJson(['node', 'info'])
      if (info.ok) { node = info.data; break }
    }

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
    proc.terminate()
    try {
      await Promise.race([proc.done, new Promise((r) => setTimeout(r, 6000))])
    } catch { /* noop */ }
    state.startedAt = null
    return { ok: true }
  }

  async function cliJson(args) {
    if (!state.cliPath) return { ok: false, error: 'easytier-cli 未安装' }
    const portal = `127.0.0.1:${state.config.rpcPort || DEFAULT_CONFIG.rpcPort}`
    const r = await sh(`${q(state.cliPath)} -p ${q(portal)} -o json ${args.map((a) => q(a)).join(' ')} 2>&1`, { timeoutMs: 9000, maxBuffer: 512 * 1024 })
    if (r.exitCode !== 0) return { ok: false, error: (r.stdout || r.stderr || '').trim().slice(-300) }
    try { return { ok: true, data: JSON.parse(r.stdout) } } catch { return { ok: false, error: 'cli 输出不是 JSON：' + (r.stdout || '').slice(-200) } }
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
    try {
      const probe = join(state.dataDir, '.probe')
      writeFileSync(probe, 'ok', { flag: 'a' })
      fsWritable = true
    } catch {
      fsWritable = false
    }
    const running = !!state.proc
    let node = null
    let peers = null
    let cliError = null
    if (running) {
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
      binaries: { corePath: state.corePath, cliPath: state.cliPath, coreVersion: state.coreVersion, coreMissing: !state.corePath, cliMissing: !state.cliPath },
      caps,
      fsWritable,
      dataDir: state.dataDir,
      running,
      pid: state.proc?.pid ?? null,
      startedAt: state.startedAt,
      uptimeSec: state.startedAt ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)) : null,
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

  function init() {
    try {
      detectEnvironment()
    } catch (e) {
      console.error('[dsh-easytier] 环境初始化失败', e)
    }
    ;(async () => {
      try {
        await detectBinaries()
        loadSavedConfig()
        state.ready = true
        if (!state.corePath || !state.cliPath) {
          const r = await ensureBinaries(false)
          if (!r.ok) console.error('[dsh-easytier] 二进制引导失败：' + r.error)
        }
      } catch (e) {
        console.error('[dsh-easytier] 初始化失败', e)
      }
    })()
  }

  // ---------- HTTP 路由（供设置页 client 调用）----------

  function sendJson(response, httpStatus, payload) {
    const body = JSON.stringify(payload)
    response.writeHead(httpStatus, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  }

  function sameOrigin(request) {
    const origin = request.headers.origin
    const host = request.headers.host
    if (origin === undefined || host === undefined) return false
    try { return new URL(origin).host === host } catch { return false }
  }

  async function readJsonBody(request, maxBytes = 64 * 1024) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > maxBytes) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  function registerRoute(webServer, path, method, handle) {
    return webServer.register({
      kind: 'exact',
      path,
      handler: async (request, response) => {
        if (request.method !== method) {
          response.writeHead(405, { allow: method })
          response.end()
          return
        }
        if (method !== 'GET' && !sameOrigin(request)) {
          return sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        }
        try {
          const args = method === 'GET' ? {} : await readJsonBody(request)
          const result = await handle(args)
          return sendJson(response, 200, result)
        } catch (e) {
          return sendJson(response, 400, { ok: false, error: String(e?.message || e) })
        }
      },
    })
  }

  // ---------- Agent 工具 ----------

  function statusText(value) {
    const lines = []
    if (!value.running) {
      lines.push(`EasyTier 未运行${value.error ? '：' + value.error : '。'}`)
    } else {
      const n = value.node
      lines.push(`EasyTier 运行中：pid=${value.pid}，版本=${(value.binaries && value.binaries.coreVersion) || '?'}，TUN=${value.config.devName}`)
      if (n) lines.push(`本机节点：${n.hostname}，虚拟IP=${n.ipv4 || '(DHCP)'}，peer_id=${n.peerId}，NAT=${n.natType === null ? '?' : n.natType}`)
      if (Array.isArray(value.peers)) {
        lines.push(`对等节点 ${value.peers.length} 个：`)
        for (const p of value.peers) lines.push(`- ${p.hostname || p.id} ${p.ipv4} | 延迟=${p.latency} 丢包=${p.loss} 协议=${p.proto} NAT=${p.nat}${p.cost === 'Local' ? '（本机）' : ''}`)
      }
    }
    if (value.caps && value.caps.supported && !value.caps.ok) lines.push(`\n[权限] TUN 不可用，需执行：${value.caps.setcapCmd}`)
    if (Array.isArray(value.foreign) && value.foreign.length) lines.push(`\n[注意] 检测到其他 easytier-core 实例：${value.foreign.map((f) => `pid=${f.pid}`).join(', ')}（如 wfmon 组网），同机多 TUN 请避免网络名/IP 冲突`)
    return lines.join('\n')
  }

  const tools = [
    defineTool({
      name: 'easytier_status',
      description: '查看本机 EasyTier 内网组网状态：easytier-core 进程、TUN 虚拟网卡、本机节点信息、对等节点（主机名/虚拟IP/延迟/丢包/协议/NAT）、权能与冲突检测。无论组网是否在运行都可调用。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: statusText(value) }],
      },
      execute: async () => status(),
    }),
    defineTool({
      name: 'easytier_start',
      description: '启动并接入 EasyTier 个人内网（TUN 虚拟网卡模式）：拉起独立的 easytier-core 实例。首次启动需提供网络名与网络密钥；已保存密钥时 network_secret 可留空。需要 easytier-core 具备 CAP_NET_ADMIN/CAP_NET_RAW（失败信息会给出 setcap 命令）。',
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
        render: (_args, value) => [{ type: 'text', text: value.ok ? `EasyTier 已启动${value.node ? `：${value.node.hostname} 虚拟IP=${value.node.ipv4 || '(DHCP)'}` : '（进程已启动，正在组网）'}` : `启动失败：${value.error || '未知错误'}` }],
      },
      execute: async (args) => {
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
    }),
    defineTool({
      name: 'easytier_stop',
      description: '停止由本插件管理的 easytier-core 实例（断开 EasyTier 内网，移除 TUN 网卡）。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: value.ok ? 'EasyTier 已停止。' : `停止失败：${value.error || '未知错误'}` }],
      },
      execute: async () => stopCore(),
    }),
    defineTool({
      name: 'easytier_peer',
      description: '向正在运行的 EasyTier 实例添加或移除一个对等引导节点（connector），例如加入新的公网节点 tcp://host:11010。',
      parameters: {
        action: { type: 'string', enum: ['add', 'remove'], required: true, description: 'add=添加节点，remove=移除节点' },
        url: { type: 'string', required: true, description: '节点 URL，如 tcp://1.2.3.4:11010、udp://host:port、ws://host:port' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: value.ok ? '节点操作成功。' : `节点操作失败：${value.error || '未知错误'}` }],
      },
      execute: async (args) => peerAction(args.action, args.url),
    }),
  ]

  // ---------- 挂载 ----------

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = []
      disposers.push(registerRoute(host.webServer, '/dsh-easytier/status', 'GET', async () => status()))
      disposers.push(registerRoute(host.webServer, '/dsh-easytier/bootstrap', 'POST', async () => ensureBinaries(true)))
      disposers.push(registerRoute(host.webServer, '/dsh-easytier/start', 'POST', async (args) => startCore(args && args.config)))
      disposers.push(registerRoute(host.webServer, '/dsh-easytier/stop', 'POST', async () => stopCore()))
      disposers.push(registerRoute(host.webServer, '/dsh-easytier/restart', 'POST', async () => { await stopCore(); await new Promise((r) => setTimeout(r, 1000)); return startCore() }))
      disposers.push(registerRoute(host.webServer, '/dsh-easytier/peer', 'POST', async (args) => peerAction(args && args.action, args && args.url)))
      return () => { for (const d of disposers) { try { d() } catch { /* noop */ } } }
    }, 'dsh-easytier: http routes')
  })

  ctx.effect(() => {
    const disposers = tools.map((t) => ctx.tools.register(t))
    return () => { for (const d of disposers) { try { d?.() } catch { /* noop */ } } }
  }, 'dsh-easytier: tools')

  ctx.effect(() => () => {
    try { state.proc?.terminate() } catch { /* noop */ }
    state.proc = null
  }, 'dsh-easytier: core teardown')

  init()
}
