/**
 * dsh-EasyTier · Client bundle entry.
 *
 * 由 DSH web 的 ModuleLoader 加载（id 与包名一致）。内部通过 require 获取
 * react；注册设置页「EasyTier 组网」面板，通过同源 HTTP 路由 /dsh-easytier/*
 * 与 host 半通信。纯 React.createElement，无需 JSX 构建。
 */
window.__ModuleLoader__.load({
  id: 'dsh-easytier',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    const css = `
.etx-wrap{display:flex;flex-direction:column;gap:14px;padding:8px 4px 24px;max-width:760px}
.etx-hd{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:650}
.etx-dot{width:10px;height:10px;border-radius:50%;flex:none;background:#9aa0a6}
.etx-dot.run{background:#34a853;box-shadow:0 0 7px rgba(52,168,83,.6)}
.etx-dot.err{background:#ea4335}
.etx-badge{font-size:11px;font-weight:500;padding:2px 8px;border-radius:99px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);opacity:.75}
.etx-card{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;padding:12px 14px}
.etx-warn{background:rgba(234,67,53,.08);border:1px solid rgba(234,67,53,.4);border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.6}
.etx-info{background:rgba(26,115,232,.08);border:1px solid rgba(26,115,232,.35);border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.6}
.etx-note{font-size:12px;padding:6px 10px;border-radius:8px}
.etx-note.ok{background:rgba(52,168,83,.1)}
.etx-note.err{background:rgba(234,67,53,.1)}
.etx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.etx-kv{display:flex;flex-direction:column;gap:2px;min-width:0}
.etx-kv b{font-size:11px;font-weight:500;opacity:.55}
.etx-kv span{font-size:13px;word-break:break-all}
.etx-table{width:100%;border-collapse:collapse;font-size:12.5px}
.etx-table th{font-weight:600;text-align:left;padding:5px 8px;opacity:.6;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent)}
.etx-table td{padding:5px 8px;border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent);word-break:break-all}
.etx-lbl{display:block;font-size:12px;opacity:.7;margin:10px 0 4px}
.etx-input,.etx-ta{width:100%;box-sizing:border-box;background:color-mix(in srgb,currentColor 6%,transparent);border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;padding:6px 10px;color:inherit;font-size:13px;outline:none}
.etx-input:focus,.etx-ta:focus{border-color:rgba(26,115,232,.6)}
.etx-input:disabled,.etx-ta:disabled{opacity:.45}
.etx-ta{min-height:64px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.etx-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:color-mix(in srgb,currentColor 7%,transparent);border-radius:6px;padding:8px 10px;margin:8px 0 2px;word-break:break-all;white-space:pre-wrap;line-height:1.5}
.etx-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.etx-btn{padding:6px 16px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;font-size:13px;cursor:pointer}
.etx-btn:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
.etx-btn.primary{background:#1a73e8;border-color:transparent;color:#fff}
.etx-btn.primary:hover{background:#1765cc}
.etx-btn.danger{color:#ea4335;border-color:rgba(234,67,53,.5)}
.etx-btn:disabled{opacity:.45;cursor:default}
.etx-chk{display:flex;align-items:center;gap:6px;font-size:13px;margin:10px 0 2px;cursor:pointer}
.etx-sub{font-size:12px;opacity:.6;margin-top:2px}
.etx-foot{font-size:12px;opacity:.55;line-height:1.6}
`

    const name = 'dsh-easytier'
    const inject = ['slots', 'timer']

    function apply(ctx) {
      const h = React.createElement

      async function call(method, args) {
        try {
          const path = '/dsh-easytier/' + method.replace(/^et\//, '')
          const isGet = method === 'et/status'
          const res = await fetch(path, isGet ? undefined : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args || {}),
          })
          if (!res.ok) {
            const txt = await res.text().catch(() => '')
            return { ok: false, error: 'HTTP ' + res.status + ' ' + txt.slice(0, 200) }
          }
          return await res.json()
        } catch (e) {
          return { ok: false, error: 'Host 调用失败：' + String((e && e.message) || e) }
        }
      }

      function Section() {
        const [st, setSt] = React.useState(null)
        const [cfg, setCfg] = React.useState(null)
        const [busy, setBusy] = React.useState('')
        const [note, setNote] = React.useState(null)
        const [peerUrl, setPeerUrl] = React.useState('')

        async function refresh() {
          const s = await call('et/status')
          setSt(s)
          setCfg((prev) => {
            if (prev || !s || !s.config) return prev
            const c = s.config
            return {
              networkName: c.networkName || '',
              secret: '',
              peersText: (c.peers || []).join('\n'),
              dhcp: c.dhcp !== false,
              ipv4: c.ipv4 || '',
              devName: c.devName || 'dshet0',
              rpcPort: String(c.rpcPort || 15898),
            }
          })
        }

        React.useEffect(() => {
          refresh()
          const stop = ctx.timer.interval(() => { void refresh() }, 4000)
          return stop
        }, [])

        function flash(kind, text) { setNote({ kind, text }) }
        async function withBusy(key, fn) {
          setBusy(key)
          try { await fn() } finally { setBusy(''); await refresh() }
        }
        async function doBootstrap() {
          await withBusy('boot', async () => {
            const r = await call('et/bootstrap')
            if (!r.ok) flash('err', r.error || '二进制安装失败')
            else flash('ok', `已安装 easytier-core/easytier-cli ${r.coreVersion || ''}（${r.cliPath}）`)
          })
        }
        async function doStart() {
          if (!cfg) return
          const config = {
            networkName: (cfg.networkName || '').trim(),
            networkSecret: cfg.secret || '',
            peers: (cfg.peersText || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
            dhcp: !!cfg.dhcp,
            ipv4: (cfg.ipv4 || '').trim(),
            devName: (cfg.devName || '').trim(),
            rpcPort: Number(cfg.rpcPort) || 15898,
          }
          await withBusy('start', async () => {
            const r = await call('et/start', { config })
            if (r.ok) flash('ok', r.warning || '组网实例已启动，正在连接对等节点…')
            else flash('err', r.error || '启动失败')
          })
        }
        async function doStop() {
          await withBusy('stop', async () => {
            const r = await call('et/stop')
            flash(r.ok ? 'ok' : 'err', r.ok ? '实例已停止。' : (r.error || '停止失败'))
          })
        }
        async function doRestart() {
          await withBusy('restart', async () => {
            const r = await call('et/restart')
            if (r.ok) flash('ok', '已重启。')
            else flash('err', r.error || '重启失败')
          })
        }
        async function doPeer(action) {
          const url = (peerUrl || '').trim()
          if (!url) return
          await withBusy('peer', async () => {
            const r = await call('et/peer', { action, url })
            if (r.ok) { flash('ok', action === 'remove' ? '节点已移除。' : '节点已添加。'); setPeerUrl('') }
            else flash('err', r.error || '操作失败')
          })
        }
        function fmtUptime(sec) {
          if (sec === null || sec === undefined) return '-'
          if (sec < 60) return sec + ' 秒'
          const m = Math.floor(sec / 60)
          if (m < 60) return m + ' 分钟'
          return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
        }

        const running = !!(st && st.running)
        const caps = st && st.caps
        const capsBad = !!(caps && caps.supported && !caps.ok)
        const field = (label, node) => h('div', null, h('label', { className: 'etx-lbl' }, label), node)
        const kids = [h('style', null, css)]

        kids.push(h('div', { className: 'etx-hd' },
          h('span', { className: 'etx-dot ' + (running ? 'run' : (st && st.error ? 'err' : '')) }),
          h('span', null, 'EasyTier 组网'),
          st && st.binaries && st.binaries.coreVersion ? h('span', { className: 'etx-badge' }, 'core v' + st.binaries.coreVersion) : null,
          h('span', { className: 'etx-badge' }, running ? '运行中' : '已停止'),
        ))

        if (st && st.fsWritable === false) {
          kids.push(h('div', { className: 'etx-warn' }, '⚠️ 插件数据目录不可写（' + (st.dataDir || '') + '），二进制安装与配置保存会失败。'))
        }
        if (capsBad) {
          kids.push(h('div', { className: 'etx-warn' },
            h('div', null, '⚠️ easytier-core 缺少创建 TUN 虚拟网卡的权限（CAP_NET_ADMIN / CAP_NET_RAW）。请在本机终端执行一次（只需一次）：'),
            h('pre', { className: 'etx-pre' }, caps.setcapCmd),
            h('div', { style: { opacity: 0.75 } }, '执行后回到本页点击「启动」即可。wfmon 采用的是同样的 capabilities 机制。'),
          ))
        }
        if (st && st.binaries && (st.binaries.coreMissing || st.binaries.cliMissing)) {
          kids.push(h('div', { className: 'etx-info' },
            h('div', null, '未检测到 easytier-core / easytier-cli，可直接下载官方发行包（GitHub Release，约 25MB）安装到本插件数据目录：'),
            h('div', { className: 'etx-row', style: { marginTop: '8px' } },
              h('button', { className: 'etx-btn primary', disabled: !!busy, onClick: doBootstrap }, busy === 'boot' ? '安装中…' : '一键安装 easytier'),
            ),
          ))
        }
        if (st && Array.isArray(st.foreign) && st.foreign.length) {
          kids.push(h('div', { className: 'etx-warn', style: { background: 'rgba(234,167,53,.08)', borderColor: 'rgba(234,167,53,.4)' } },
            h('div', null, `⚠️ 检测到本机还有 ${st.foreign.length} 个 easytier-core 实例（如 wfmon 组网）。同机再建 TUN 网卡时，请使用不同的网络名或虚拟 IP 段，避免路由冲突。`),
          ))
        }
        if (note) kids.push(h('div', { className: 'etx-note ' + note.kind }, note.text))

        if (running && st) {
          const n = st.node
          const kv = (k, v) => h('div', { className: 'etx-kv' }, h('b', null, k), h('span', null, v || '-'))
          kids.push(h('div', { className: 'etx-card' },
            h('div', { className: 'etx-grid' },
              kv('虚拟 IP', n ? (n.ipv4 || 'DHCP 分配中') : '…'),
              kv('主机名', n ? n.hostname : st.host.hostname),
              kv('TUN 网卡', st.config.devName),
              kv('已运行', fmtUptime(st.uptimeSec)),
              kv('NAT 类型', n ? String(n.natType === null || n.natType === undefined ? '-' : n.natType) : '-'),
              kv('peer_id', n ? n.peerId : '-'),
              kv('监听', n ? n.listeners.length + ' 个' : '-'),
              kv('RPC 端口', String(st.config.rpcPort)),
            ),
          ))
          const peers = Array.isArray(st.peers) ? st.peers : []
          kids.push(h('div', { className: 'etx-card' },
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, `对等节点（${peers.length}）`),
            st.cliError ? h('div', { className: 'etx-sub', style: { color: '#ea4335' } }, st.cliError)
              : h('table', { className: 'etx-table' },
                h('thead', null, h('tr', null,
                  h('th', null, '节点'), h('th', null, '虚拟IP'), h('th', null, '延迟'), h('th', null, '丢包'), h('th', null, '协议'), h('th', null, 'NAT'), h('th', null, '收/发'),
                )),
                h('tbody', null, peers.map((p) => h('tr', { key: p.id || p.hostname },
                  h('td', null, p.hostname + (p.cost === 'Local' ? '（本机）' : '')),
                  h('td', null, p.ipv4 || '-'),
                  h('td', null, p.latency),
                  h('td', null, p.loss),
                  h('td', null, p.proto),
                  h('td', null, p.nat),
                  h('td', null, p.rx + ' / ' + p.tx),
                ))),
              ),
            h('div', { className: 'etx-row', style: { marginTop: '10px' } },
              h('input', {
                className: 'etx-input', style: { flex: '1 1 260px' },
                placeholder: '添加/移除引导节点，如 tcp://1.2.3.4:11010',
                value: peerUrl, onChange: (e) => setPeerUrl(e.target.value),
              }),
              h('button', { className: 'etx-btn', disabled: !!busy, onClick: () => doPeer('add') }, '添加'),
              h('button', { className: 'etx-btn danger', disabled: !!busy, onClick: () => doPeer('remove') }, '移除'),
            ),
          ))
        } else if (st && st.error) {
          kids.push(h('div', { className: 'etx-card' },
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '上次状态'),
            h('pre', { className: 'etx-pre' }, st.error),
            st.logTail ? h('pre', { className: 'etx-pre' }, st.logTail) : null,
          ))
        }

        if (cfg) {
          const set = (k) => (e) => setCfg({ ...cfg, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
          kids.push(h('div', { className: 'etx-card' },
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '组网配置'),
            field('网络名 network-name', h('input', { className: 'etx-input', value: cfg.networkName, disabled: running, placeholder: '例如 my-mesh（同一虚拟网内所有节点一致）', onChange: set('networkName') })),
            field('网络密钥 network-secret', h('input', { className: 'etx-input', type: 'password', value: cfg.secret, disabled: running, placeholder: st && st.config && st.config.hasSecret ? '已保存（留空沿用）' : '首次启动必填', onChange: set('secret') })),
            field('引导节点 peers（每行一个）', h('textarea', { className: 'etx-ta', value: cfg.peersText, disabled: running, onChange: set('peersText') })),
            h('label', { className: 'etx-chk' },
              h('input', { type: 'checkbox', checked: cfg.dhcp, disabled: running, onChange: set('dhcp') }),
              h('span', null, 'DHCP 自动分配虚拟 IP（推荐）'),
            ),
            field('静态虚拟 IP（关闭 DHCP 时必填，CIDR 形式）', h('input', { className: 'etx-input', value: cfg.ipv4, disabled: running || cfg.dhcp, placeholder: '例如 10.0.0.99/24', onChange: set('ipv4') })),
            h('div', { className: 'etx-grid' },
              field('TUN 网卡名', h('input', { className: 'etx-input', value: cfg.devName, disabled: running, maxLength: 15, onChange: set('devName') })),
              field('RPC 管理端口', h('input', { className: 'etx-input', value: cfg.rpcPort, disabled: running, onChange: set('rpcPort') })),
            ),
            h('div', { className: 'etx-row', style: { marginTop: '14px' } },
              running
                ? h('button', { className: 'etx-btn danger', disabled: !!busy, onClick: doStop }, busy === 'stop' ? '停止中…' : '停止')
                : h('button', { className: 'etx-btn primary', disabled: !!busy || capsBad, onClick: doStart }, busy === 'start' ? '启动中…' : '启动并接入'),
              running ? h('button', { className: 'etx-btn', disabled: !!busy, onClick: doRestart }, busy === 'restart' ? '重启中…' : '重启') : null,
            ),
          ))
        }

        kids.push(h('div', { className: 'etx-foot' },
          '实例由本插件管理，DSH 进程退出或插件停用时会一并停止；需要长期常驻请用 easytier-core --daemon 或 systemd。',
        ))

        return h('div', { className: 'etx-wrap' }, kids)
      }

      ctx.effect(() => {
        const retire = ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'easytier', order: 30, label: 'EasyTier 组网' },
            () => React.createElement(Section),
          ),
        )
        return retire
      }, 'dsh-easytier: settings section')
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
