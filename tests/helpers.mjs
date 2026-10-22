/**
 * 单测用的假对象。
 *
 * 宿主半侧的外呼全部走注入的 fetch，HTTP 侧只需要一个最小的 ServerResponse 替身，
 * 这样「参数校验 / 白名单 / 206 透传 / 错误映射」都能完全不联网地验证。
 */

/** 大小写不敏感的 Headers 替身：只实现 handler 用到的 get()。 */
export function fakeHeaders(source = {}) {
  const map = new Map()
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue
    map.set(key.toLowerCase(), String(value))
  }
  return {
    get(name) {
      const key = String(name).toLowerCase()
      return map.has(key) ? map.get(key) : null
    },
    has(name) {
      return map.has(String(name).toLowerCase())
    },
  }
}

/** 极简 ServerResponse：记录状态、响应头、写出的字节，并支持 close 事件。 */
export function mockRes() {
  const state = {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    destroyed: false,
    headersSent: false,
  }
  const listeners = new Map()

  const add = (event, handler) => {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
  }
  const remove = (event, handler) => {
    const list = listeners.get(event)
    if (list === undefined) return
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  const res = {
    get headersSent() {
      return state.headersSent
    },
    get destroyed() {
      return state.destroyed
    },
    writeHead(status, headers) {
      state.status = status
      state.headers = { ...(headers ?? {}) }
      state.headersSent = true
      return res
    },
    write(chunk) {
      // 真实 ServerResponse 返回 false 表示要等 drain；这里始终返回 true，
      // 需要测背压时单独传 overrideWrite
      state.chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) state.chunks.push(Buffer.from(chunk))
      state.ended = true
    },
    on(event, handler) {
      add(event, handler)
      return res
    },
    once(event, handler) {
      const wrapper = (...args) => {
        remove(event, wrapper)
        handler(...args)
      }
      add(event, wrapper)
      return res
    },
    off(event, handler) {
      remove(event, handler)
      return res
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
    },
    setHeader(name, value) {
      state.headers[name] = value
    },
    destroy() {
      state.destroyed = true
    },
  }

  const text = () => Buffer.concat(state.chunks).toString('utf8')
  const json = () => JSON.parse(text())

  return {
    res,
    state,
    text,
    json,
  }
}

/** 假 fetch 的 JSON 响应。 */
export function jsonResult(body, options = {}) {
  const status = options.status ?? 200
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    url: options.url ?? 'https://api.bilibili.com/x/web-interface/view',
    headers: fakeHeaders({ 'content-type': 'application/json; charset=utf-8', ...(options.headers ?? {}) }),
    body: options.body ?? null,
    async json() {
      return JSON.parse(text)
    },
    async text() {
      return text
    },
  }
}

/** 把一段字节包装成 fetch 的 ReadableStream 替身（按 chunkSize 切片吐）。 */
export function webStream(buffer, chunkSize = 8) {
  const bytes = Buffer.from(buffer)
  let offset = 0
  return {
    getReader() {
      return {
        async read() {
          if (offset >= bytes.length) return { done: true, value: undefined }
          const value = new Uint8Array(bytes.subarray(offset, offset + chunkSize))
          offset += chunkSize
          return { done: false, value }
        },
        releaseLock() {},
      }
    },
    async cancel() {},
  }
}

/** 假 fetch 的音频字节响应，默认模拟 CDN 的 206 + Octet-Stream。 */
export function audioResult(buffer, options = {}) {
  return {
    ok: true,
    status: options.status ?? 206,
    url: options.url ?? 'https://cn-xj-ct-01-05.bilivideo.com/audio.m4s',
    headers: fakeHeaders({
      'content-type': 'application/octet-stream',
      'content-length': String(buffer.length),
      'content-range': 'bytes 0-' + (buffer.length - 1) + '/' + (buffer.length * 10),
      ...(options.headers ?? {}),
    }),
    body: webStream(buffer, options.chunkSize ?? 8),
  }
}

/** 组装一个 GET 请求。 */
export function getRequest(pathname, params = {}, headers = {}) {
  const search = new URLSearchParams(params)
  const query = search.toString()
  return {
    method: 'GET',
    url: pathname + (query === '' ? '' : '?' + query),
    headers,
  }
}
