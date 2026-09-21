// 旧版 scene_actions 迁移：旧表只有 device_key（设备名称），重建为 device_id 稳定关联。
// 安全原则：仅名称唯一匹配才自动绑定；重名（≥2 台同名）绝不猜测，一律置 NULL 并保留
// device_key 快照，待用户人工确认——宁可失效，不可误绑导致误控。
// 返回 { bound, dup, lost } 统计；已是新结构时返回 null（无需迁移）。
export function migrateSceneActions(db) {
  const cols = db.prepare('PRAGMA table_info(scene_actions)').all().map((c) => c.name)
  if (cols.includes('device_id')) return null
  const rows = db.prepare('SELECT * FROM scene_actions').all()
  const findByName = db.prepare('SELECT id FROM devices WHERE name=? ORDER BY id')
  const stat = { bound: 0, dup: 0, lost: 0 }
  db.exec('BEGIN')
  try {
    db.exec(`CREATE TABLE scene_actions_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id INTEGER NOT NULL,
      device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
      device_key TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      order_no INTEGER NOT NULL DEFAULT 0
    )`)
    const ins = db.prepare('INSERT INTO scene_actions_migrated (id,scene_id,device_id,device_key,action,order_no) VALUES (?,?,?,?,?,?)')
    for (const r of rows) {
      const m = findByName.all(r.device_key)
      // 唯一匹配才绑定；重名/找不到都置 NULL（失效引用，由用户处理）
      const deviceId = m.length === 1 ? m[0].id : null
      if (m.length > 1) stat.dup++
      else if (!m.length) stat.lost++
      else stat.bound++
      ins.run(r.id, r.scene_id, deviceId, r.device_key, r.action, r.order_no)
    }
    db.exec('DROP TABLE scene_actions')
    db.exec('ALTER TABLE scene_actions_migrated RENAME TO scene_actions')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return stat
}
