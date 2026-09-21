import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateSceneActions } from './migrate.js'

// 极简内存 fake：仅实现迁移用到的 prepare/exec 接口，用 JS 数组模拟两张表
function fakeDb({ devices = [], actions = [], migrated = false } = {}) {
  const db = {
    data: { devices, scene_actions: actions },
    exec(sql) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return
      if (sql.startsWith('CREATE TABLE scene_actions_migrated')) { db.data.scene_actions_migrated = []; return }
      if (sql === 'DROP TABLE scene_actions') { delete db.data.scene_actions; return }
      if (sql.startsWith('ALTER TABLE scene_actions_migrated RENAME TO scene_actions')) {
        db.data.scene_actions = db.data.scene_actions_migrated
        delete db.data.scene_actions_migrated
        return
      }
      throw new Error('unexpected exec: ' + sql)
    },
    prepare(sql) {
      if (sql === 'PRAGMA table_info(scene_actions)') {
        const cols = migrated
          ? ['id', 'scene_id', 'device_id', 'device_key', 'action', 'order_no']
          : ['id', 'scene_id', 'device_key', 'action', 'order_no']
        return { all: () => cols.map((name) => ({ name })) }
      }
      if (sql === 'SELECT * FROM scene_actions') return { all: () => db.data.scene_actions }
      if (sql === 'SELECT id FROM devices WHERE name=? ORDER BY id') {
        return { all: (name) => db.data.devices.filter((d) => d.name === name).map((d) => ({ id: d.id })) }
      }
      if (sql.startsWith('INSERT INTO scene_actions_migrated')) {
        return {
          run: (id, scene_id, device_id, device_key, action, order_no) =>
            db.data.scene_actions_migrated.push({ id, scene_id, device_id, device_key, action, order_no })
        }
      }
      throw new Error('unexpected prepare: ' + sql)
    }
  }
  return db
}

test('唯一匹配自动绑定；重名置 NULL 不擅自绑定；找不到置 NULL', () => {
  const db = fakeDb({
    devices: [
      { id: 1, name: '客厅主灯' },   // 唯一
      { id: 2, name: '智能灯' },     // 重名（与 5 同名）
      { id: 5, name: '智能灯' },
      { id: 3, name: '卧室空调' }    // 唯一
    ],
    actions: [
      { id: 1, scene_id: 1, device_key: '客厅主灯', action: '开启', order_no: 0 },
      { id: 2, scene_id: 1, device_key: '智能灯', action: '关闭', order_no: 1 },   // 重名 → 不得绑定
      { id: 3, scene_id: 1, device_key: '已删除的设备', action: '开启', order_no: 2 }, // 找不到 → NULL
      { id: 4, scene_id: 2, device_key: '卧室空调', action: '制冷26°C', order_no: 0 }
    ]
  })
  const stat = migrateSceneActions(db)
  assert.deepEqual(stat, { bound: 2, dup: 1, lost: 1 })
  const rows = db.data.scene_actions
  assert.equal(rows.find((r) => r.id === 1).device_id, 1)   // 唯一匹配 → 绑定
  assert.equal(rows.find((r) => r.id === 2).device_id, null) // 重名 → NULL，绝不猜最小 id(2)
  assert.equal(rows.find((r) => r.id === 3).device_id, null) // 已删除 → NULL
  assert.equal(rows.find((r) => r.id === 4).device_id, 3)
  // device_key 快照全部保留，供人工确认时展示
  assert.equal(rows.find((r) => r.id === 2).device_key, '智能灯')
})

test('同一重名名称出现多条动作，全部置 NULL', () => {
  const db = fakeDb({
    devices: [{ id: 1, name: '灯' }, { id: 2, name: '灯' }],
    actions: [
      { id: 1, scene_id: 1, device_key: '灯', action: '开启', order_no: 0 },
      { id: 2, scene_id: 2, device_key: '灯', action: '关闭', order_no: 0 }
    ]
  })
  const stat = migrateSceneActions(db)
  assert.deepEqual(stat, { bound: 0, dup: 2, lost: 0 })
  assert.ok(db.data.scene_actions.every((r) => r.device_id === null))
})

test('已是新结构（含 device_id 列）时不迁移、不改数据', () => {
  const actions = [{ id: 1, scene_id: 1, device_id: 7, device_key: '灯', action: '开启', order_no: 0 }]
  const db = fakeDb({ actions, migrated: true })
  assert.equal(migrateSceneActions(db), null)
  assert.deepEqual(db.data.scene_actions, actions)
})
