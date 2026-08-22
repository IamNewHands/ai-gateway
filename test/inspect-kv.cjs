// 探查两个可能的 KV sqlite
const { DatabaseSync } = require('node:sqlite')
for (const p of ['.wrangler/state/v3/kv/miniflare-KVNamespaceObject/4f0b3839dd15a13ff445a1aeea339588ae4ebd1083bfd1419829a182fa3baee9.sqlite']) {
  console.log('===== ' + p + ' =====')
  const db = new DatabaseSync(p)
  const objs = db.prepare("SELECT type,name FROM sqlite_master WHERE type='table' OR type='index'").all()
  console.log('OBJECTS:', JSON.stringify(objs))
  for (const t of objs) {
    if (t.name.startsWith('sqlite_')) continue
    try {
      const rows = db.prepare(`SELECT * FROM ${t.name} LIMIT 10`).all()
      console.log(`== ${t.type} ${t.name} rows:`, JSON.stringify(rows, null, 1))
    } catch (e) { console.log('read err', String(e)) }
  }
  db.close()
}
