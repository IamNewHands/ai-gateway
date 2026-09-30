/**
 * probe/call-probe.mjs — 用本机 .secrets 里的浏览器 token 调边缘探针 Worker。
 *
 *   node probe/call-probe.mjs https://deepseek-probe.<account>.workers.dev
 *
 * 为什么不在 DSH 里用 curl：沙箱里 curl 走 Schannel，被 Kaspersky MITM 拦成
 * SEC_E_NO_CREDENTIALS；Node 自带 OpenSSL 与 CA 才能发出 HTTPS。token 只进请求体，
 * 不打印，避免落进会话记录。
 */

import { readFileSync } from 'node:fs'

const url = process.argv[2]
if (!url) {
  console.error('usage: node probe/call-probe.mjs <worker-url>')
  process.exit(1)
}

const sessionPath = new URL('../.secrets/deepseek-web-session.json', import.meta.url)
let session
try {
  session = JSON.parse(readFileSync(sessionPath, 'utf8'))
} catch (err) {
  console.error(`cannot read ${sessionPath.pathname}: ${err.message}`)
  process.exit(1)
}

const body = {
  token: session.token,
  headerDeviceId: session.headerDeviceId,
  userAgent: session.userAgent,
}

const endpoint = `${url.replace(/\/+$/, '')}/probe`
console.log(`POST ${endpoint}`)

let resp
try {
  resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
} catch (err) {
  console.error(`fetch failed: ${err.message}`)
  if (err.cause) console.error(`cause: ${err.cause.message ?? err.cause}`)
  process.exit(1)
}

console.log(`HTTP ${resp.status} ${resp.headers.get('content-type') ?? ''}`)
console.log(await resp.text())
