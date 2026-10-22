/**
 * dsh-bili-audio —— 客户端半侧
 *
 * 在 DSH Web 界面的右下角挂一条悬浮播放条：粘贴 BV 号 / 链接 → 解析 → 用原生
 * <audio> 播放。音频字节由宿主半侧的 /bili-audio/api/stream 反向代理，因为 B 站
 * CDN 校验 Referer，浏览器直连会 403。
 *
 * 骨架遵循 DSH 客户端 bundle 约定（手写，无构建工具）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *   factory 里 require('react')，导出 { name, inject, apply }
 *
 * UI 挂载点用 `shell.overlay`：它覆盖整个窗口框架、不占布局，正是 whale-pet 等
 * 插件放悬浮物的位置（props 是空对象，自己用 position:fixed 定位）。
 *
 * 设计取舍（v0.1 故意做小）：
 *   · 队列只存在内存里（刷新页面就没了），只把「展开状态 / 音量 / 倍速」记到
 *     localStorage —— 那是真正会重复设置的偏好；
 *   · 不做字幕 / 登录 / 下载：那些需要 Cookie 与额外接口，留到后续版本；
 *   · 播放失败时依次尝试 backupUrl → 重新解析一次（B 站音频地址带 deadline）→
 *     探测具体原因并给可见提示。
 */

window.__ModuleLoader__.load({
  id: 'dsh-bili-audio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const { useCallback, useEffect, useRef, useState } = react

    const PLUGIN_ID = 'dsh-bili-audio'
    const API = '/bili-audio/api'
    const STYLE_TAG_ID = 'dsh-bili-audio/style'
    const PREFS_KEY = 'dsh-bili-audio:prefs'

    /* ---------------------------------------------------------------- *
     * 文案：跟随 <html lang>，不依赖 locale 服务
     * ---------------------------------------------------------------- */

    function isZh() {
      const lang =
        (document.documentElement && document.documentElement.lang) ||
        (typeof navigator !== 'undefined' ? navigator.language : '') ||
        ''
      return String(lang).toLowerCase().startsWith('zh')
    }

    const TEXT = {
      zh: {
        title: 'B站音频',
        expand: '展开播放条',
        minimize: '收起',
        placeholder: '粘贴 B 站链接或 BV 号，多个用空格/换行分开',
        resolveAndPlay: '解析并播放',
        addOnly: '只入队',
        needInput: '请先粘贴 B 站链接或 BV 号',
        emptyQueue: '队列是空的：贴一个链接开始听。',
        queue: '队列',
        countSuffix: ' 条',
        clear: '清空',
        sort: '按标题排序',
        prev: '上一条',
        next: '下一条',
        play: '播放',
        pause: '暂停',
        volume: '音量',
        rate: '倍速',
        retry: '重试',
        remove: '移除',
        pending: '待解析',
        resolving: '解析中…',
        failed: '失败',
        playing: '正在播放',
        paused: '已暂停',
        buffering: '缓冲中…',
        ready: '就绪',
        noAudio: '该视频没有可用的音频流（可能是充电专属 / 付费 / 地区限制）',
        cdn403: 'CDN 拒绝播放（403）：地址可能已过期，点「重试」重新解析',
        cdnGone: '音频已从 CDN 移除，点「重试」重新解析',
        videoNotFound: '视频不存在或不可见（可能已删除 / 私密）',
        badHost: '只支持 bilibili.com / b23.tv / bilibili.tv 的链接',
        timeout: '请求超时，请检查网络后重试',
        networkError: '网络错误，请检查网络后重试',
        playbackFailed: '播放失败：音频地址可能已失效，点「重试」',
        resolveFailed: '解析失败',
        hostOffline: '宿主插件没有响应（/bili-audio/api/health 不通）',
      },
      en: {
        title: 'Bilibili Audio',
        expand: 'Expand player',
        minimize: 'Minimize',
        placeholder: 'Paste a Bilibili link or BV id (space/newline separated)',
        resolveAndPlay: 'Resolve & play',
        addOnly: 'Queue only',
        needInput: 'Paste a Bilibili link or BV id first',
        emptyQueue: 'Queue is empty — paste a link to start listening.',
        queue: 'Queue',
        countSuffix: ' items',
        clear: 'Clear',
        sort: 'Sort by title',
        prev: 'Previous',
        next: 'Next',
        play: 'Play',
        pause: 'Pause',
        volume: 'Volume',
        rate: 'Speed',
        retry: 'Retry',
        remove: 'Remove',
        pending: 'Pending',
        resolving: 'Resolving…',
        failed: 'Failed',
        playing: 'Now playing',
        paused: 'Paused',
        buffering: 'Buffering…',
        ready: 'Ready',
        noAudio: 'This video has no playable audio stream (paid / region-locked content)',
        cdn403: 'CDN said 403: the audio URL probably expired — press Retry',
        cdnGone: 'Audio was removed from the CDN — press Retry',
        videoNotFound: 'Video not found or not visible (deleted / private)',
        badHost: 'Only bilibili.com / b23.tv / bilibili.tv links are supported',
        timeout: 'Request timed out, please retry',
        networkError: 'Network error, please retry',
        playbackFailed: 'Playback failed: the audio URL may be stale — press Retry',
        resolveFailed: 'Failed to resolve',
        hostOffline: 'The host plugin is not responding (/bili-audio/api/health)',
      },
    }

    /** 订阅 <html lang> 的变化：用户切界面语言时文案立刻跟着换。 */
    function useLabels() {
      const [zh, setZh] = useState(isZh)
      useEffect(() => {
        const root = document.documentElement
        if (!root || typeof MutationObserver !== 'function') return undefined
        const observer = new MutationObserver(() => setZh(isZh()))
        observer.observe(root, { attributes: true, attributeFilter: ['lang'] })
        return () => observer.disconnect()
      }, [])
      return zh ? TEXT.zh : TEXT.en
    }

    /* ---------------------------------------------------------------- *
     * 样式：注入一个 <style>，颜色全部走 CSS 变量
     * ---------------------------------------------------------------- *
     * 优先用 DSH 自己的设计令牌（--dsw-alias-*），拿不到时用 light-dark() 兜底，
     * 这样深浅色都跟着宿主走，插件里没有一个写死的固定配色。
     */

    const CSS = `
.ba-root{
  position:fixed;right:16px;bottom:16px;z-index:60;pointer-events:auto;
  color-scheme:inherit;font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:1.5;
  --ba-fg:var(--dsw-alias-label-primary,light-dark(#101114,#f4f5f7));
  --ba-fg2:var(--dsw-alias-label-secondary,light-dark(#5b6068,#b8bcc4));
  --ba-fg3:var(--dsw-alias-label-tertiary,light-dark(#8a8f98,#8f949c));
  --ba-bg:var(--dsw-alias-bg-layer-1,light-dark(#fffffff2,#242529f2));
  --ba-bg2:var(--dsw-alias-bg-layer-2,light-dark(#f1f2f4,#2e3035));
  --ba-line:var(--dsw-alias-border-l1,light-dark(#00000014,#ffffff1f));
  --ba-line2:var(--dsw-alias-border-l2,light-dark(#00000024,#ffffff33));
  --ba-accent:var(--dsw-alias-brand-primary,light-dark(#0b6cff,#6aa6ff));
  --ba-danger:var(--dsw-alias-state-error-primary,light-dark(#c62828,#ff8a8a));
  --ba-warn:var(--dsw-alias-state-warn-primary,light-dark(#9a6200,#ffc46b));
  color:var(--ba-fg);
}
.ba-panel{
  width:360px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;gap:8px;
  padding:12px;border-radius:14px;border:.5px solid var(--ba-line2);background:var(--ba-bg);
  box-shadow:0 12px 32px #0000002e;backdrop-filter:blur(12px);
}
.ba-head{display:flex;align-items:center;gap:8px}
.ba-title{font-weight:600;font-size:13px;white-space:nowrap}
.ba-count{font-size:11px;color:var(--ba-fg3);white-space:nowrap}
.ba-spacer{flex:1}
.ba-iconbtn{
  display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  border:.5px solid var(--ba-line);border-radius:7px;background:transparent;color:var(--ba-fg2);
  cursor:pointer;font-size:13px;line-height:1;padding:0;
}
.ba-iconbtn:hover{color:var(--ba-accent);border-color:var(--ba-accent)}
.ba-form{display:flex;gap:6px;align-items:center}
.ba-input{
  flex:1;min-width:0;border:.5px solid var(--ba-line);border-radius:8px;background:var(--ba-bg2);
  color:var(--ba-fg);padding:6px 8px;font-size:12px;outline:none;
}
.ba-input:focus{border-color:var(--ba-accent)}
.ba-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:4px;border:.5px solid var(--ba-line);
  border-radius:8px;background:var(--ba-bg2);color:var(--ba-fg);padding:5px 9px;font-size:11.5px;
  cursor:pointer;white-space:nowrap;line-height:1.5;
}
.ba-btn:hover{border-color:var(--ba-accent);color:var(--ba-accent)}
.ba-btn:disabled{opacity:.45;cursor:default;border-color:var(--ba-line);color:var(--ba-fg2)}
.ba-btn-primary{background:var(--ba-accent);border-color:var(--ba-accent);color:#fff}
.ba-btn-primary:hover{color:#fff;filter:brightness(1.06)}
.ba-btn-ghost{background:transparent}
.ba-now{display:flex;flex-direction:column;gap:2px;min-width:0}
.ba-now-title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ba-now-sub{font-size:11px;color:var(--ba-fg2);display:flex;align-items:center;gap:6px}
.ba-live{color:var(--ba-accent)}
.ba-progress{width:100%;height:4px;accent-color:var(--ba-accent);cursor:pointer;margin:0}
.ba-rowtime{display:flex;justify-content:space-between;font-size:10.5px;color:var(--ba-fg3);font-variant-numeric:tabular-nums}
.ba-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ba-control{
  display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 6px;
  border:.5px solid var(--ba-line);border-radius:8px;background:var(--ba-bg2);color:var(--ba-fg);
  cursor:pointer;font-size:12px;
}
.ba-control:hover:not(:disabled){border-color:var(--ba-accent);color:var(--ba-accent)}
.ba-control:disabled{opacity:.4;cursor:default}
.ba-control-main{background:var(--ba-accent);border-color:var(--ba-accent);color:#fff;min-width:34px}
.ba-control-main:hover:not(:disabled){color:#fff;filter:brightness(1.06)}
.ba-slider{width:64px;height:4px;accent-color:var(--ba-accent);cursor:pointer;margin:0}
.ba-group{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--ba-fg2)}
.ba-select{
  border:.5px solid var(--ba-line);border-radius:7px;background:var(--ba-bg2);color:var(--ba-fg);
  font-size:11px;padding:2px 4px;outline:none;
}
.ba-queue{display:flex;flex-direction:column;gap:5px;border-top:.5px solid var(--ba-line);padding-top:8px}
.ba-queue-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ba-fg3)}
.ba-queue-list{display:flex;flex-direction:column;gap:4px;max-height:170px;overflow:auto}
.ba-item{
  display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:8px;
  border:.5px solid transparent;background:var(--ba-bg2);cursor:pointer;
}
.ba-item:hover{border-color:var(--ba-line2)}
.ba-item-current{border-color:var(--ba-accent)}
.ba-item-index{font-size:10px;color:var(--ba-fg3);font-variant-numeric:tabular-nums;min-width:14px;text-align:right}
.ba-item-body{flex:1;min-width:0;display:flex;flex-direction:column}
.ba-item-title{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ba-item-meta{font-size:10px;color:var(--ba-fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ba-item-status{font-size:10px;color:var(--ba-fg3);white-space:nowrap}
.ba-item-status-error{color:var(--ba-danger)}
.ba-item-status-ready{color:var(--ba-accent)}
.ba-item-x{
  border:0;background:transparent;color:var(--ba-fg3);cursor:pointer;font-size:13px;line-height:1;
  padding:2px 3px;border-radius:5px;
}
.ba-item-x:hover{color:var(--ba-danger)}
.ba-empty{font-size:11px;color:var(--ba-fg3);padding:6px 2px}
.ba-error{
  font-size:11px;color:var(--ba-danger);border:.5px solid var(--ba-line);border-radius:8px;
  padding:6px 8px;background:var(--ba-bg2);
}
.ba-pill{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;width:52px;height:52px;
  border-radius:50%;border:.5px solid var(--ba-line2);background:var(--ba-bg);color:var(--ba-fg);
  box-shadow:0 8px 22px #00000033;backdrop-filter:blur(12px);cursor:pointer;font-size:20px;
}
.ba-pill:hover{border-color:var(--ba-accent);color:var(--ba-accent)}
.ba-pill-icon{line-height:1}
.ba-pill-icon-live{color:var(--ba-accent);animation:ba-breathe 2.4s ease-in-out infinite}
.ba-pill-dot{width:6px;height:6px;border-radius:50%;background:var(--ba-accent)}
@keyframes ba-breathe{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.ba-pill-icon-live{animation:none}}
`

    function ensureStyles() {
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') !== null) {
        return
      }
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', STYLE_TAG_ID)
      tag.textContent = CSS
      ;(document.head || document.documentElement).append(tag)
    }

    /* ---------------------------------------------------------------- *
     * 小工具
     * ---------------------------------------------------------------- */

    /** 偏好持久化：只存展开状态 / 音量 / 倍速，队列不进 localStorage。 */
    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (raw === null || raw === '') return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    function writePrefs(patch) {
      try {
        const next = Object.assign({}, readPrefs(), patch)
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch (error) {
        /* 隐私模式 / 存储满：偏好存不下不影响播放 */
      }
    }

    function clamp(value, min, max) {
      const number = Number(value)
      if (!Number.isFinite(number)) return min
      return Math.min(max, Math.max(min, number))
    }

    /** 秒 → m:ss / h:mm:ss。 */
    function formatTime(seconds) {
      const value = Number(seconds)
      if (!Number.isFinite(value) || value <= 0) return '0:00'
      const total = Math.floor(value)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const rest = total % 60
      if (hours > 0) {
        return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(rest).padStart(2, '0')
      }
      return minutes + ':' + String(rest).padStart(2, '0')
    }

    /**
     * 把输入框里的内容拆成「链接 / BV 号」列表。
     * 允许一次贴多条（空格、换行、中英文逗号分号都算分隔），也允许一条分享文案里
     * 夹着链接 —— 只保留看起来像链接或 BV/av 号的 token。
     */
    function splitLinks(text) {
      const tokens = String(text || '')
        .split(/[\s,，;；]+/)
        .map((token) => token.trim())
        .filter((token) => token !== '')
      const picked = []
      for (const token of tokens) {
        const cleaned = token.replace(/[)\]}>。！!？?]+$/, '')
        if (/^https?:\/\//i.test(cleaned)) {
          picked.push(cleaned)
          continue
        }
        if (/^BV[0-9A-Za-z]{10}$/.test(cleaned) || /^av\d{1,12}$/i.test(cleaned)) {
          picked.push(cleaned)
          continue
        }
        // 分享文案里的链接可能没有 http 前缀之外的问题，这里再兜一次「文本里含 BV」
        const inline = /BV[0-9A-Za-z]{10}/.exec(cleaned)
        if (inline !== null) picked.push(inline[0])
      }
      // 同一次粘贴里的重复链接只留一份
      return [...new Set(picked)]
    }

    function streamUrl(audioUrl) {
      return API + '/stream?u=' + encodeURIComponent(audioUrl)
    }

    let itemSeq = 0
    function nextItemId() {
      itemSeq += 1
      return 'ba-' + Date.now().toString(36) + '-' + itemSeq
    }

    /** 把宿主返回的错误码翻成当前语言的可见文案。 */
    function describeError(labels, failure) {
      const code = failure && failure.code ? String(failure.code) : ''
      const message = failure && failure.message ? String(failure.message) : labels.resolveFailed
      // fetch 本身抛出来的 TypeError（断网 / 宿主没起）没有业务 code
      if (code === '' && failure && failure.name === 'TypeError') return labels.networkError
      if (code === 'no_audio_stream') return labels.noAudio
      if (code === 'cdn_forbidden') return labels.cdn403
      if (code === 'cdn_gone') return labels.cdnGone
      if (code === 'video_not_found') return labels.videoNotFound
      if (code === 'host_not_allowed' || code === 'short_link_foreign') return labels.badHost
      if (code === 'missing_url' || code === 'no_video_id' || code === 'invalid_url') return labels.needInput
      if (code === 'upstream_timeout' || code === 'short_link_timeout') return labels.timeout
      if (code === 'fetch_unavailable') return labels.hostOffline
      return message
    }

    /** 从 fetch 响应里取出 {code, message}；不是 JSON 就用 HTTP 状态兜底。 */
    async function errorFromResponse(response) {
      const body = await response.json().catch(() => undefined)
      if (body !== null && typeof body === 'object' && body.error !== undefined && body.error !== null) {
        const failure = new Error(String(body.error.message || 'HTTP ' + response.status))
        failure.code = String(body.error.code || 'http_' + response.status)
        return failure
      }
      const failure = new Error('HTTP ' + response.status)
      failure.code = 'http_' + response.status
      return failure
    }

    /* ---------------------------------------------------------------- *
     * 播放条
     * ---------------------------------------------------------------- */

    function BiliAudioBar() {
      const labels = useLabels()
      const audioRef = useRef(null)
      // 首帧读一次偏好即可；useRef 的参数每次渲染都会求值，所以这里手动做惰性读取，
      // 避免 timeupdate（每秒约 4 次）带着 localStorage 一起跑
      const prefsRef = useRef(null)
      if (prefsRef.current === null) prefsRef.current = readPrefs()

      const [open, setOpen] = useState(() => prefsRef.current.open !== false)
      const [input, setInput] = useState('')
      const [items, setItems] = useState([])
      const [currentId, setCurrentId] = useState('')
      const [error, setError] = useState('')
      const [volume, setVolume] = useState(() => clamp(prefsRef.current.volume ?? 0.9, 0, 1))
      const [rate, setRate] = useState(() => clamp(prefsRef.current.rate ?? 1, 0.5, 2))
      const [playing, setPlaying] = useState(false)
      const [buffering, setBuffering] = useState(false)
      const [time, setTime] = useState(0)
      const [duration, setDuration] = useState(0)

      // 用 ref 持有最新列表/当前项，异步流程（解析、失败回退）里避免拿到旧闭包
      const itemsRef = useRef(items)
      const currentIdRef = useRef(currentId)
      // 是否「希望自动播放」：只入队时不抢当前播放
      const wantPlayRef = useRef(false)

      useEffect(() => {
        itemsRef.current = items
      }, [items])
      useEffect(() => {
        currentIdRef.current = currentId
      }, [currentId])

      /* ---------------- 队列增删改 ---------------- */

      const patchItem = useCallback((id, patch) => {
        setItems((previous) =>
          previous.map((item) => (item.id === id ? Object.assign({}, item, patch) : item)),
        )
      }, [])

      /**
       * 解析一个已入队的条目。
       * item 直接传对象而不是 id：调用方可能在 setItems 之后立刻开始解析，
       * 此时 itemsRef 还没被下一次渲染同步。
       */
      const resolveItem = useCallback(
        async (item, options) => {
          patchItem(item.id, { status: 'resolving', error: '' })
          try {
            const response = await fetch(
              API + '/resolve?url=' + encodeURIComponent(item.link),
              { cache: 'no-store' },
            )
            if (!response.ok) throw await errorFromResponse(response)
            const body = await response.json().catch(() => undefined)
            if (body === null || typeof body !== 'object' || body.ok !== true) {
              const failure = new Error(labels.resolveFailed)
              failure.code = 'bad_payload'
              throw failure
            }
            patchItem(item.id, {
              status: 'ready',
              title: String(body.title || item.title || item.link),
              bvid: String(body.bvid || ''),
              cid: String(body.cid || ''),
              duration: Number(body.duration) || 0,
              audioUrl: String(body.audioUrl || ''),
              backups: Array.isArray(body.backups) ? body.backups.slice() : [],
              backupIndex: -1,
              error: '',
              // 只有「用户主动重试」才清掉 refreshed 标记，正常换地址不会重置
              ...(options !== undefined && options.resetFlags === true ? { refreshed: false } : {}),
            })
            return body
          } catch (failure) {
            patchItem(item.id, { status: 'error', error: describeError(labels, failure) })
            return undefined
          }
        },
        [labels, patchItem],
      )

      const retryItem = useCallback(
        async (id) => {
          const item = itemsRef.current.find((entry) => entry.id === id)
          if (item === undefined) return
          patchItem(id, { status: 'pending', error: '', refreshed: false, backupIndex: -1 })
          await resolveItem(item, { resetFlags: true })
        },
        [patchItem, resolveItem],
      )

      const playItem = useCallback(
        (id) => {
          const item = itemsRef.current.find((entry) => entry.id === id)
          if (item === undefined) return
          wantPlayRef.current = true
          setError('')
          currentIdRef.current = id
          setCurrentId(id)
          if (item.status === 'error' || item.status === 'pending') {
            void resolveItem(item, { resetFlags: item.status === 'error' })
          } else if (item.status === 'ready') {
            const audio = audioRef.current
            if (audio !== null && audio.getAttribute('src') === streamUrl(item.audioUrl)) {
              // 点的是当前这条：直接恢复播放（用户手势，绕开自动播放限制）
              audio.play().catch(() => setPlaying(false))
            }
          }
        },
        [resolveItem],
      )

      const step = useCallback(
        (delta) => {
          const list = itemsRef.current
          if (list.length === 0) return
          const index = list.findIndex((item) => item.id === currentIdRef.current)
          const target = list[index + delta]
          if (target === undefined) {
            if (delta > 0) setPlaying(false)
            return
          }
          playItem(target.id)
        },
        [playItem],
      )

      const removeItem = useCallback((id) => {
        const list = itemsRef.current
        const index = list.findIndex((item) => item.id === id)
        const next = list.filter((item) => item.id !== id)
        itemsRef.current = next
        setItems(next)
        if (currentIdRef.current !== id) return
        const replacement = next[index] || next[index - 1]
        const nextId = replacement === undefined ? '' : replacement.id
        wantPlayRef.current = false
        currentIdRef.current = nextId
        setCurrentId(nextId)
        if (replacement === undefined) {
          setPlaying(false)
          setTime(0)
          setDuration(0)
        }
      }, [])

      const clearQueue = useCallback(() => {
        itemsRef.current = []
        setItems([])
        wantPlayRef.current = false
        currentIdRef.current = ''
        setCurrentId('')
        setPlaying(false)
        setTime(0)
        setDuration(0)
        setError('')
      }, [])

      const sortQueue = useCallback(() => {
        const locale = isZh() ? 'zh' : 'en'
        const sorted = itemsRef.current.slice().sort((left, right) =>
          String(left.title || left.link).localeCompare(String(right.title || right.link), locale),
        )
        itemsRef.current = sorted
        setItems(sorted)
      }, [])

      /**
       * 把输入框里的链接加进队列并解析。
       * playFirst=true 时切到第一个新条目并播放；false 时只是入队/后台解析。
       */
      const addLinks = useCallback(
        (playFirst) => {
          const links = splitLinks(input)
          if (links.length === 0) {
            setError(labels.needInput)
            return
          }
          setError('')
          const known = new Map(itemsRef.current.map((item) => [item.link, item]))
          const fresh = []
          for (const link of links) {
            if (known.has(link)) continue
            fresh.push({
              id: nextItemId(),
              link,
              title: '',
              status: 'pending',
              error: '',
              bvid: '',
              cid: '',
              duration: 0,
              audioUrl: '',
              backups: [],
              backupIndex: -1,
              refreshed: false,
            })
          }
          setInput('')
          if (fresh.length > 0) {
            const merged = itemsRef.current.concat(fresh)
            itemsRef.current = merged
            setItems(merged)
          }
          const duplicates = links
            .map((link) => known.get(link))
            .filter((item) => item !== undefined)
          const firstNew = fresh[0]

          if (playFirst) {
            if (firstNew !== undefined) {
              // 新条目要等解析完才有 src；先切过去并标记「希望播放」，
              // resolveItem 把它变成 ready 后，一个 effect 会装载并播放
              wantPlayRef.current = true
              currentIdRef.current = firstNew.id
              setCurrentId(firstNew.id)
            } else if (duplicates[0] !== undefined) {
              // 键入的都是已在队列里的链接：等价于点了那一条
              playItem(duplicates[0].id)
            }
          } else if (currentIdRef.current === '' && firstNew !== undefined) {
            // 队列本来是空的：顺手把它设成当前项，用户点播放就能听
            wantPlayRef.current = false
            currentIdRef.current = firstNew.id
            setCurrentId(firstNew.id)
          }

          // 已存在但失败的条目，除目标条目（playItem 会自己重试）之外都顺手重试
          for (const item of duplicates) {
            if (item.status !== 'error') continue
            if (playFirst && firstNew === undefined && item === duplicates[0]) continue
            void retryItem(item.id)
          }
          if (fresh.length > 0) {
            void (async () => {
              for (const item of fresh) {
                await resolveItem(item)
              }
            })()
          }
        },
        [input, labels, playItem, resolveItem, retryItem],
      )

      /* ---------------- 音频元素 ---------------- */

      /**
       * 当前条目变成 ready 时装载 src；只在这里调用 play()，且仅在「希望播放」
       * 时调用 —— 浏览器要求自动播放来自用户手势，解析是 click 的异步延续，
       * Chromium 一般仍把它算在手势窗口内，失败就退回让用户点播放。
       */
      useEffect(() => {
        const audio = audioRef.current
        if (audio === null) return
        const item = items.find((entry) => entry.id === currentId)
        if (item === undefined || item.status !== 'ready' || item.audioUrl === '') {
          if (audio.getAttribute('src') !== null) {
            try {
              audio.pause()
            } catch (error) {
              /* ignore */
            }
            audio.removeAttribute('src')
            audio.load()
          }
          return
        }
        const source = streamUrl(item.audioUrl)
        if (audio.getAttribute('src') === source) return
        audio.src = source
        audio.load()
        if (wantPlayRef.current) {
          audio.play().catch(() => {
            // 自动播放被拦：保持暂停，用户点播放即可
            setPlaying(false)
          })
        }
      }, [currentId, items])

      // 音量 / 倍速：同步到 <audio> 并记住
      useEffect(() => {
        const audio = audioRef.current
        if (audio !== null) audio.volume = volume
        writePrefs({ volume })
      }, [volume])
      useEffect(() => {
        const audio = audioRef.current
        if (audio !== null) audio.playbackRate = rate
        writePrefs({ rate })
      }, [rate])
      useEffect(() => {
        writePrefs({ open })
      }, [open])

      /**
       * 播放失败时的回退链：
       *   1. 换下一个 backupUrl（主 CDN 403 时备用域名常常还能用）；
       *   2. 重新解析一次（B 站音频地址带 deadline，过期只能重新要）；
       *   3. 探测一次 stream 接口拿到具体原因（403 / 410），给可见提示。
       */
      const probeAudio = useCallback(
        async (audioUrl) => {
          try {
            const response = await fetch(streamUrl(audioUrl), {
              headers: { Range: 'bytes=0-0' },
              cache: 'no-store',
            })
            if (response.ok) return ''
            const failure = await errorFromResponse(response)
            if (failure.code === 'cdn_forbidden') return labels.cdn403
            if (failure.code === 'cdn_gone') return labels.cdnGone
            return describeError(labels, failure)
          } catch (error) {
            return labels.networkError
          }
        },
        [labels],
      )

      const handleAudioError = useCallback(async () => {
        const id = currentIdRef.current
        const item = itemsRef.current.find((entry) => entry.id === id)
        // 只有「已经就绪」的条目才谈得上播放失败；切歌瞬间的 load() 也会触发 error
        if (item === undefined || item.status !== 'ready') return
        const backups = Array.isArray(item.backups) ? item.backups : []
        const nextIndex = (typeof item.backupIndex === 'number' ? item.backupIndex : -1) + 1
        if (nextIndex < backups.length) {
          patchItem(id, { backupIndex: nextIndex, audioUrl: backups[nextIndex] })
          return
        }
        if (item.refreshed !== true) {
          patchItem(id, { refreshed: true, status: 'pending' })
          await resolveItem(Object.assign({}, item, { status: 'pending' }))
          return
        }
        const reason = await probeAudio(item.audioUrl)
        patchItem(id, { status: 'error', error: reason || labels.playbackFailed })
      }, [labels, patchItem, probeAudio, resolveItem])

      const handleEnded = useCallback(() => {
        const list = itemsRef.current
        const index = list.findIndex((item) => item.id === currentIdRef.current)
        const target = list[index + 1]
        if (target === undefined) {
          setPlaying(false)
          setTime(0)
          return
        }
        playItem(target.id)
      }, [playItem])

      /* ---------------- 派生值 ---------------- */

      const currentItem = items.find((item) => item.id === currentId)
      const currentError =
        currentItem !== undefined && currentItem.status === 'error' ? currentItem.error : ''
      const maxDuration =
        Number.isFinite(duration) && duration > 0
          ? duration
          : (currentItem !== undefined ? Number(currentItem.duration) || 0 : 0)
      const shownTime = maxDuration > 0 ? Math.min(time, maxDuration) : time
      const readyCount = items.filter((item) => item.status === 'ready').length
      const hasCurrent = currentItem !== undefined
      const currentReady = hasCurrent && currentItem.status === 'ready'
      const canPrev = items.findIndex((item) => item.id === currentId) > 0
      const canNext = (() => {
        const index = items.findIndex((item) => item.id === currentId)
        return index >= 0 && index < items.length - 1
      })()

      const togglePlay = useCallback(() => {
        const audio = audioRef.current
        if (audio === null) return
        const item = items.find((entry) => entry.id === currentId)
        if (item === undefined) return
        if (item.status !== 'ready' || item.audioUrl === '') {
          playItem(item.id)
          return
        }
        if (audio.paused) {
          wantPlayRef.current = true
          audio.play().catch(() => setPlaying(false))
        } else {
          wantPlayRef.current = false
          audio.pause()
        }
      }, [currentId, items, playItem])

      const onSeek = useCallback(
        (event) => {
          const audio = audioRef.current
          if (audio === null) return
          const value = Number(event.target.value)
          if (!Number.isFinite(value)) return
          const limit = maxDuration > 0 ? Math.min(value, maxDuration) : value
          try {
            audio.currentTime = limit
            setTime(limit)
          } catch (error) {
            /* 还没 metadata 时设置 currentTime 会抛，忽略即可 */
          }
        },
        [maxDuration],
      )

      /* ---------------- 渲染 ---------------- */

      const audio = h('audio', {
        ref: audioRef,
        preload: 'metadata',
        // 不显示原生控件：进度/音量/倍速都做成紧凑的自定义控件
        style: { display: 'none' },
        onPlay: () => {
          setPlaying(true)
          setBuffering(false)
        },
        onPause: () => setPlaying(false),
        onWaiting: () => setBuffering(true),
        onPlaying: () => setBuffering(false),
        onCanPlay: () => setBuffering(false),
        onLoadedMetadata: (event) => {
          const value = Number(event.target.duration)
          setDuration(Number.isFinite(value) && value > 0 ? value : 0)
        },
        onTimeUpdate: (event) => setTime(Number(event.target.currentTime) || 0),
        onEnded: handleEnded,
        onError: handleAudioError,
      })

      // 最小化时只留一个圆形入口；<audio> 必须一直挂在 DOM 里，否则播放会中断
      if (!open) {
        return h(
          'div',
          { className: 'ba-root', 'data-bili-audio': 'minimized' },
          audio,
          h(
            'button',
            {
              type: 'button',
              className: 'ba-pill',
              title: labels.expand,
              'aria-label': labels.expand,
              onClick: () => setOpen(true),
            },
            h('span', { className: 'ba-pill-icon' + (playing ? ' ba-pill-icon-live' : '') }, '♪'),
            playing ? h('span', { className: 'ba-pill-dot' }) : null,
          ),
        )
      }

      const head = h(
        'div',
        { className: 'ba-head' },
        h('span', { className: 'ba-title' }, labels.title),
        h(
          'span',
          { className: 'ba-count' },
          items.length > 0 ? items.length + labels.countSuffix : '',
        ),
        h('span', { className: 'ba-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'ba-iconbtn',
            title: labels.minimize,
            'aria-label': labels.minimize,
            onClick: () => setOpen(false),
          },
          '—',
        ),
      )

      const form = h(
        'div',
        { className: 'ba-form' },
        h('input', {
          className: 'ba-input',
          placeholder: labels.placeholder,
          value: input,
          spellCheck: false,
          onChange: (event) => setInput(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') addLinks(true)
          },
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'ba-btn ba-btn-primary',
            onClick: () => addLinks(true),
          },
          labels.resolveAndPlay,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ba-btn ba-btn-ghost',
            onClick: () => addLinks(false),
          },
          labels.addOnly,
        ),
      )

      const now = h(
        'div',
        { className: 'ba-now' },
        h(
          'div',
          { className: 'ba-now-title' },
          hasCurrent ? currentItem.title || currentItem.link : labels.emptyQueue,
        ),
        h(
          'div',
          { className: 'ba-now-sub' },
          hasCurrent
            ? h(
                'span',
                { className: playing ? 'ba-live' : '' },
                buffering
                  ? labels.buffering
                  : playing
                    ? labels.playing
                    : currentReady
                      ? labels.paused
                      : currentItem.status === 'error'
                        ? labels.failed
                        : labels.resolving,
              )
            : null,
          hasCurrent && currentItem.bvid !== '' ? h('span', null, currentItem.bvid) : null,
          hasCurrent && currentItem.cid !== '' ? h('span', null, 'cid ' + currentItem.cid) : null,
        ),
      )

      const progress = h(
        'div',
        null,
        h('input', {
          className: 'ba-progress',
          type: 'range',
          min: 0,
          max: maxDuration > 0 ? maxDuration : 0,
          step: maxDuration > 0 ? Math.max(0.1, maxDuration / 1000) : 0.1,
          value: shownTime,
          disabled: maxDuration <= 0,
          'aria-label': labels.play,
          onChange: onSeek,
        }),
        h(
          'div',
          { className: 'ba-rowtime' },
          h('span', null, formatTime(shownTime)),
          h('span', null, formatTime(maxDuration)),
        ),
      )

      const controls = h(
        'div',
        { className: 'ba-controls' },
        h(
          'button',
          {
            type: 'button',
            className: 'ba-control',
            title: labels.prev,
            'aria-label': labels.prev,
            disabled: !canPrev,
            onClick: () => step(-1),
          },
          '⏮',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ba-control ba-control-main',
            title: playing ? labels.pause : labels.play,
            'aria-label': playing ? labels.pause : labels.play,
            onClick: togglePlay,
          },
          playing ? '⏸' : '▶',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ba-control',
            title: labels.next,
            'aria-label': labels.next,
            disabled: !canNext,
            onClick: () => step(1),
          },
          '⏭',
        ),
        h(
          'span',
          { className: 'ba-group', title: labels.volume },
          '🔊',
          h('input', {
            className: 'ba-slider',
            type: 'range',
            min: 0,
            max: 1,
            step: 0.01,
            value: volume,
            'aria-label': labels.volume,
            onChange: (event) => setVolume(clamp(Number(event.target.value), 0, 1)),
          }),
        ),
        h(
          'span',
          { className: 'ba-group', title: labels.rate },
          labels.rate,
          h(
            'select',
            {
              className: 'ba-select',
              value: String(rate),
              'aria-label': labels.rate,
              onChange: (event) => setRate(clamp(Number(event.target.value), 0.5, 2)),
            },
            [0.75, 1, 1.25, 1.5, 2].map((value) =>
              h('option', { key: value, value: String(value) }, value + 'x'),
            ),
          ),
        ),
      )

      const queueRows =
        items.length === 0
          ? [h('div', { className: 'ba-empty', key: 'empty' }, labels.emptyQueue)]
          : items.map((item, index) => {
              const isCurrent = item.id === currentId
              const statusText =
                item.status === 'ready'
                  ? labels.ready
                  : item.status === 'resolving'
                    ? labels.resolving
                    : item.status === 'error'
                      ? labels.failed
                      : labels.pending
              return h(
                'div',
                {
                  key: item.id,
                  className: 'ba-item' + (isCurrent ? ' ba-item-current' : ''),
                  role: 'button',
                  tabIndex: 0,
                  title: item.title || item.link,
                  onClick: () => playItem(item.id),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      playItem(item.id)
                    }
                  },
                },
                h('span', { className: 'ba-item-index' }, String(index + 1)),
                h(
                  'span',
                  { className: 'ba-item-body' },
                  h('span', { className: 'ba-item-title' }, item.title || item.link),
                  h(
                    'span',
                    { className: 'ba-item-meta' },
                    item.status === 'error'
                      ? item.error
                      : item.status === 'ready'
                        ? formatTime(item.duration) + ' · ' + item.link
                        : item.link,
                  ),
                ),
                h(
                  'span',
                  {
                    className:
                      'ba-item-status' +
                      (item.status === 'error'
                        ? ' ba-item-status-error'
                        : item.status === 'ready'
                          ? ' ba-item-status-ready'
                          : ''),
                  },
                  statusText,
                ),
                item.status === 'error'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'ba-btn ba-btn-ghost',
                        onClick: (event) => {
                          event.stopPropagation()
                          void retryItem(item.id)
                        },
                      },
                      labels.retry,
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ba-item-x',
                    title: labels.remove,
                    'aria-label': labels.remove,
                    onClick: (event) => {
                      event.stopPropagation()
                      removeItem(item.id)
                    },
                  },
                  '×',
                ),
              )
            })

      const queue = h(
        'div',
        { className: 'ba-queue' },
        h(
          'div',
          { className: 'ba-queue-head' },
          h('span', null, labels.queue + ' · ' + readyCount + '/' + items.length),
          h('span', { className: 'ba-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'ba-btn ba-btn-ghost',
              onClick: sortQueue,
              disabled: items.length < 2,
            },
            labels.sort,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ba-btn ba-btn-ghost',
              onClick: clearQueue,
              disabled: items.length === 0,
            },
            labels.clear,
          ),
        ),
        h('div', { className: 'ba-queue-list' }, ...queueRows),
      )

      const banner = error !== '' ? h('div', { className: 'ba-error' }, error) : null
      const playbackError =
        currentError !== '' && currentError !== error ? h('div', { className: 'ba-error' }, currentError) : null

      return h(
        'div',
        { className: 'ba-root', 'data-bili-audio': 'expanded' },
        audio,
        h(
          'div',
          { className: 'ba-panel', role: 'region', 'aria-label': labels.title },
          head,
          form,
          now,
          progress,
          controls,
          banner,
          playbackError,
          queue,
        ),
      )
    }

    /* ---------------------------------------------------------------- *
     * 注册
     * ---------------------------------------------------------------- */

    const inject = ['slots']

    function apply(ctx) {
      try {
        ensureStyles()
      } catch (error) {
        // 样式注入失败不该拦住注册（没有样式也还能用，只是丑）
      }
      // shell.overlay：覆盖整个窗口框架、不占布局的悬浮层，适合全局播放条
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: PLUGIN_ID,
            order: 80,
          },
          BiliAudioBar,
        ),
      )
    }

    exports.name = PLUGIN_ID
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
