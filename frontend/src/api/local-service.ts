import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 终态锁定：落到这些状态记录就封档，后续动作一律拒绝。
// 取消与完成并发时以先落库的状态为准，后到的那个动作直接判失败，只生效一次。
const TERMINAL_STATUSES: Record<string, string[]> = {
  campaign: ['已完成', '已取消'],
}

// 取消防火宣传活动的级联口径：活动指标清零的字段、值勤协办台账的联动规则。
const CAMPAIGN_KEY = 'campaign'
const CAMPAIGN_CANCEL_ACTION = '取消活动'
const CAMPAIGN_CANCELLED_STATUS = '已取消'
const CAMPAIGN_ZERO_FIELDS = ['覆盖村组', '受众人数']
const DUTY_KEY = 'duty'
const DUTY_REVOKABLE_STATUSES = ['待确认', '已确认', '值勤中']
const DUTY_REVOKED_STATUS = '已调班'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const terminal = TERMINAL_STATUSES[key]
  if (terminal?.includes(current)) {
    return { ok: false, message: `${meta.entity}已按「${current}」落库封档，「${action}」不再生效` }
  }
  if (key === CAMPAIGN_KEY && action === CAMPAIGN_CANCEL_ACTION) {
    return cancelCampaign(meta, id)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const closed = terminal ? terminal.includes(target) : target === lastStatus
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !closed,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 取消防火宣传活动的级联事务，顺着 runAction 的取消调用链走：
// 1. 活动记录保留（活动编号留档可查），覆盖村组、受众人数一起清零，状态封档为「已取消」并标异常；
// 2. 值勤排班里按活动日期协办的台账跟着撤销一份，置为「已调班」并标异常；
// 3. 两个模块的新状态先全部算好，再经 saveAll 一次落库，任何一步失败都整条回退。
function cancelCampaign(meta: ModuleMeta, id: number): ActionResult {
  const snapshot = allRows()
  const campaignRows = [...(snapshot[CAMPAIGN_KEY] ?? [])]
  const index = campaignRows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const cancelled: EntryRow = {
    ...campaignRows[index],
    status: CAMPAIGN_CANCELLED_STATUS,
    pending: false,
    abnormal: true,
  }
  for (const field of CAMPAIGN_ZERO_FIELDS) {
    cancelled[field] = '0'
  }
  campaignRows[index] = cancelled

  const dutyRows = [...(snapshot[DUTY_KEY] ?? [])]
  const dutyIndex = dutyRows.findIndex(
    (row) =>
      String(row['值勤日期'] ?? '') === String(cancelled['活动日期'] ?? '') &&
      DUTY_REVOKABLE_STATUSES.includes(String(row.status)),
  )
  const revoked = dutyIndex >= 0
  if (revoked) {
    dutyRows[dutyIndex] = {
      ...dutyRows[dutyIndex],
      status: DUTY_REVOKED_STATUS,
      pending: false,
      abnormal: true,
    }
  }

  try {
    saveAll({ ...snapshot, [CAMPAIGN_KEY]: campaignRows, [DUTY_KEY]: dutyRows })
  } catch (error) {
    return {
      ok: false,
      message: `${meta.entity}取消失败，已整条回退：${error instanceof Error ? error.message : '本地存储写入异常'}`,
    }
  }
  const dutyNote = revoked ? '，值勤协办台账已同步撤销 1 份' : '，没有需要撤销的值勤协办台账'
  return {
    ok: true,
    message: `${meta.entity}已取消，覆盖村组与受众人数已清零${dutyNote}，当前状态「${CAMPAIGN_CANCELLED_STATUS}」`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
