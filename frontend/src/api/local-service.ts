import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 值勤协办台账撤销后的落库状态；只有还在生效的排班才算可撤销的协办台账。
const DUTY_REVOKED_STATUS = '已撤销'
const DUTY_ACTIVE_STATUSES = ['待确认', '已确认', '值勤中']

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
  if (meta.terminalStatuses?.includes(current)) {
    return {
      ok: false,
      message: `${meta.entity}已落库为「${current}」，以先落库状态为准，「${action}」不再生效`,
    }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (meta.key === 'campaign' && action === '取消活动') {
    return cancelCampaign(meta, rows, index, action, target)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 「取消活动」是一条跨模块事务，三步要么一起落库、要么整条回退：
// 1. 活动落库为「已取消」，覆盖村组、受众人数一起清零——历史已完成活动保留受众原值，这里不碰；
// 2. 值勤排班里按活动日期找到一份还在生效的协办台账，跟着撤销一份；
// 3. 找不到可撤销的台账、或落库失败，都算整条失败，活动状态不留半截。
function cancelCampaign(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  action: string,
  target: string,
): ActionResult {
  const campaign = rows[index]
  const dutyRows = listRows('duty')
  const dutyIndex = dutyRows.findIndex(
    (row) =>
      String(row['值勤日期']) === String(campaign['活动日期']) &&
      DUTY_ACTIVE_STATUSES.includes(String(row.status)),
  )
  if (dutyIndex < 0) {
    return {
      ok: false,
      message: `没有找到与「${campaign['活动编号']}」同日的值勤协办台账，取消活动已整条回退`,
    }
  }
  const canceled: EntryRow = {
    ...campaign,
    status: target,
    pending: false,
    abnormal: false,
    覆盖村组: 0,
    受众人数: 0,
  }
  const revoked: EntryRow = {
    ...dutyRows[dutyIndex],
    status: DUTY_REVOKED_STATUS,
    pending: false,
    abnormal: true,
    交接记录: `协办「${campaign['活动编号']}」已取消，台账撤销`,
  }
  const nextCampaign = [...rows]
  nextCampaign[index] = canceled
  const nextDuty = [...dutyRows]
  nextDuty[dutyIndex] = revoked
  try {
    saveAll({ ...allRows(), campaign: nextCampaign, duty: nextDuty })
  } catch {
    return { ok: false, message: `${meta.entity}取消落库失败，已整条回退` }
  }
  return {
    ok: true,
    message: `${meta.entity}已${action}，覆盖村组与受众人数已清零，值勤协办台账「${revoked['排班编号']}」同步撤销`,
  }
}

// 防火宣传统计卡：覆盖人次只累计未取消的活动——取消的受众已清零，
// 历史已完成活动按受众原值计入；老数据里取消时没清零的，也按状态排除在外。
export function campaignStats(): { label: string; value: number }[] {
  const rows = listRows('campaign')
  const now = new Date()
  const inThisMonth = rows.filter((row) => {
    const date = new Date(String(row['活动日期']))
    return (
      !Number.isNaN(date.getTime()) &&
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth()
    )
  })
  const audience = rows
    .filter((row) => String(row.status) !== '已取消')
    .reduce((sum, row) => sum + toCount(row['受众人数']), 0)
  return [
    { label: '本月活动数', value: inThisMonth.length },
    { label: '已完成数', value: rows.filter((row) => String(row.status) === '已完成').length },
    { label: '覆盖人次', value: audience },
  ]
}

function toCount(value: unknown): number {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? parsed : 0
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
