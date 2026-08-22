// 临时脚本：向 miniflare 本地 KV 写入 provider 与转发 Key
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const kvDir = path.join('.wrangler', 'state', 'v3', 'kv', 'miniflare-KVNamespaceObject')
const blobDir = path.join('.wrangler', 'state', 'v3', 'kv', 'KV', 'blobs')
const dbFile = fs.readdirSync(kvDir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
if (!dbFile) { console.error('no kv sqlite found'); process.exit(1) }
const db = new DatabaseSync(path.join(kvDir, dbFile))

function putBlob(content) {
  const buf = Buffer.from(content, 'utf8')
  const id = crypto.createHash('sha256').update(buf).digest('hex') +
    Date.now().toString(16).padStart(16, '0').slice(0, 16)
  fs.writeFileSync(path.join(blobDir, id), buf)
  return id
}

const upsert = db.prepare('INSERT OR REPLACE INTO _mf_entries (key, blob_id, expiration, metadata) VALUES (?, ?, ?, ?)')

// 1) providers：保留默认 + 追加 mockanthropic（apiType=anthropic）
const providers = JSON.parse(fs.readFileSync(path.join(blobDir, '7b0bd045eb3f1aaf5337e9d968089826ef22ae9ace929e79d4033e0165a17861000001a0295da49a'), 'utf8'))
const mock = {
  id: 'mockanthropic', name: 'MockAnthropic',
  baseUrl: 'http://127.0.0.1:8788', apiType: 'anthropic', authType: 'api-key',
  apiKeys: [{ key: 'test-anthropic-key-123', enabled: true }],
  models: [{ id: 'claude-mock', enabled: true }],
  enabled: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}
providers.push(mock)
const providersBlob = putBlob(JSON.stringify(providers))
upsert.run('providers', providersBlob, null, null)
console.log('providers updated, now', providers.map((p) => `${p.id}(${p.apiType})`).join(', '))

// 2) proxy:keys：追加本地测试 Key
let keys = []
try {
  keys = JSON.parse(fs.readFileSync(path.join(blobDir, '0dcdfd6a0431945bebf1dd383e7b1e8b840728beab375809b37d25043045bf8e000001a0295da4ba'), 'utf8'))
} catch {}
if (!keys.find((k) => k.key === 'sk_cf_test_local_key_001')) {
  keys.push({ id: 'test-key-1', key: 'sk_cf_test_local_key_001', name: 'local-test', enabled: true, createdAt: new Date().toISOString(), expiresAt: null })
}
const keysBlob = putBlob(JSON.stringify(keys))
upsert.run('proxy:keys', keysBlob, null, null)
console.log('proxy keys now', keys.map((k) => k.key).join(', '))

db.close()
console.log('DONE')
