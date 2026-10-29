// 直接问一次宿主模型（不进会话）：给表情起备注、心情判断、记忆提炼等后台小任务用。

import { randomUUID } from 'node:crypto'
const noTemperatureModels = new Set()

export function defaultModel(dsh, cfg) {
  if (cfg?.model?.provider && cfg?.model?.model) return { provider: cfg.model.provider, model: cfg.model.model }
  try {
    const svc = dsh.get('agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch (error) {}
  return null
}

/**
 * @param {object} dsh 宿主 ctx
 * @param {{system:string, text:string, images?:Array<{data:string, mediaType:string}>, maxTokens?:number, temperature?:number, cfg?:object}} o
 * @returns {Promise<string>}
 */
export async function askModel(dsh, o) {
  const llm = dsh.llm || dsh.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  const t = defaultModel(dsh, o.cfg)
  if (!t) throw new Error('拿不到默认模型')
  let content = [{ type: 'text', text: o.text }]
  for (const img of o.images || []) content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'aurabot-image' })
  // 图片要先交给 DSH 的附件服务登记成附件块，模型适配层只认附件
  if (content.length > 1) {
    const att = dsh.attachments || dsh.get('attachments')
    if (!att || typeof att.admitPromptContent !== 'function') throw new Error('宿主没有附件服务，看不了图')
    content = await att.admitPromptContent(content)
  }
  const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'plugin', plugin: 'aurabot' } }]
  const route = `${t.provider}/${t.model}`
  for (let attempt = 0; attempt < 2; attempt++) {
    let out = ''
    try {
      for await (const chunk of llm.stream({
        provider: t.provider,
        model: t.model,
        system: o.system || '',
        messages,
        maxTokens: o.maxTokens || 600,
        ...(!noTemperatureModels.has(route) && o.temperature !== undefined ? { temperature: o.temperature } : {}),
        ...(o.cfg?.model?.reasoningEffort ? { reasoningEffort: o.cfg.model.reasoningEffort } : {}),
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          const f = chunk.reason.failure || {}
          throw new Error('模型报错：' + (f.message || f.code || '未知'))
        }
      }
      return out.trim()
    } catch (error) {
      // Retry only an explicitly rejected temperature, before any output.
      if (attempt === 0 && !out && /does not support non-default temperature|temperature.*not supported|unsupported.*temperature/i.test(error.message)) {
        noTemperatureModels.add(route)
        continue
      }
      throw error
    }
  }
}
