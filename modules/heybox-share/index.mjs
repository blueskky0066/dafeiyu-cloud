// 让她能分享自己从小黑盒刷到的帖子（私聊 + 群聊都能用）
// 群聊里只有只读能力，没有任何写入或电脑操作。
//
// 注意：QQ 客户端对 JSON 卡片有版本白名单，Linux 上的 QQ 发卡片会提示「版本过低」，
// 所以分享用「标题 + 一句自己的话 + 正确链接」的纯文本格式。
const RPC = 'http://127.0.0.1:63482/heybox/rpc'
const WATCHED = 'http://127.0.0.1:63482/heybox/watched'
// 正确的帖子地址；/post/{id} 那种是 404
const POST_URL = (id) => 'https://www.xiaoheihe.cn/app/bbs/link/' + id

async function rpc(path, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, params }),
    signal: AbortSignal.timeout(25000),
  })
  return r.json()
}

async function recent(n) {
  const r = await fetch(WATCHED + '?limit=' + n, { signal: AbortSignal.timeout(15000) })
  const j = await r.json()
  return (j.records || []).slice().reverse()
}

async function fetchPost(id) {
  const j = await rpc('/bbs/app/link/tree', { link_id: String(id) })
  if (!j.ok) return { ok: false, error: j.msg || j.error || '读不到' }
  const r = j.result || {}
  const link = r.link || {}
  const cmts = (r.comments || []).slice(0, 3)
    .map(c => (c.comment || [])[0]).filter(Boolean)
    .map(c => String(c.text || '').trim().slice(0, 80)).filter(Boolean)
  return {
    ok: true,
    title: String(link.title || '').trim(),
    body: String(link.description || '').trim(),
    comments: cmts,
    url: POST_URL(id),
  }
}

export default {
  id: 'heybox-share',
  name: '小黑盒分享',
  version: '0.3.0',
  api: 1,
  description: '让她把自己在小黑盒刷到的帖子讲出来并给出可点链接',

  setup(api) {
    api.tool(({ chat, level }) => {
      if (chat.kind === 'system') return []
      const full = level === 'full'

      return [
        api.defineTool({
          name: 'heybox_recent',
          description: '看看自己最近在小黑盒刷过哪些帖子。有人问「你刷到什么了」「小黑盒上有啥新鲜的」时用。',
          properties: { count: { type: 'number', description: '要几条，默认 5，最多 20' } },
          execute: async ({ count }) => {
            const n = Math.max(1, Math.min(20, Number(count) || 5))
            try {
              const recs = await recent(n)
              if (!recs.length) return { ok: true, message: '还没刷到什么帖子' }
              return {
                ok: true,
                message: '最近刷到 ' + recs.length + ' 篇：\n' + recs.map((x, i) =>
                  (i + 1) + '. 《' + x.title + '》  postId=' + x.postId).join('\n'),
              }
            } catch (e) { return { ok: false, message: '查不到：' + e.message } }
          },
        }),

        api.defineTool({
          name: 'heybox_post',
          description: '读小黑盒上一篇帖子的正文和热评，自己心里有数好跟人聊。要 postId。',
          properties: { post_id: { type: 'string', description: '帖子 postId' } },
          required: ['post_id'],
          execute: async ({ post_id }) => {
            const p = await fetchPost(post_id)
            if (!p.ok) return { ok: false, message: '读不到：' + p.error }
            return {
              ok: true,
              message: [
                '标题：' + (p.title || '(无)'),
                '正文：' + (p.body.slice(0, full ? 1500 : 500) || '(无)'),
                '链接：' + p.url,
                p.comments.length ? '热评：\n' + p.comments.map(c => '· ' + c).join('\n') : '',
              ].filter(Boolean).join('\n'),
            }
          },
        }),

        // 专门用来「分享出去」的工具：直接给好格式，她照着发就行
        api.defineTool({
          name: 'heybox_share',
          description: '把小黑盒上一篇帖子分享给对方：标题 + 一句你自己的话 + 可点开的链接。想分享某篇给谁时用这个，别自己拼链接（拼错会 404）。',
          properties: {
            post_id: { type: 'string', description: '帖子 postId（heybox_recent 里那个）' },
          },
          required: ['post_id'],
          execute: async ({ post_id }) => {
            const p = await fetchPost(post_id)
            if (!p.ok) return { ok: false, message: '读不到：' + p.error }
            // 给她素材，她自己组织一句话
            const gist = p.body.slice(0, full ? 400 : 200)
            return {
              ok: true,
              message: [
                '给你要分享的东西：',
                '标题：' + p.title,
                '内容概要：' + (gist || '(无)'),
                p.comments.length ? '热评：' + p.comments.slice(0, 2).join(' / ') : '',
                '',
                '请按这个格式发给对方（三行，别加别的）：',
                p.title,
                '（这里写你自己的一句感受，别超过 30 字）',
                p.url,
                '',
                '链接必须原样用上面那个，不要自己改，/post/ 那种是坏的。',
              ].filter(Boolean).join('\n'),
            }
          },
        }),
      ]
    })

    const rule = (kind) => () => kind === 'social'
      ? '你会刷小黑盒（游戏资讯社区）。群里有人聊游戏新闻、比赛、新游，或者问你最近看到什么，可以用 heybox_recent 看刷过什么、heybox_post 读正文，然后用你自己的话说。要分享某篇给别人时用 heybox_share，它会给你正确链接——别自己拼。链接只能用它给的那个格式，/post/ 那种会 404。'
      : '你会刷小黑盒。想分享某篇给主人时用 heybox_share，它会给你正确的链接格式。链接必须原样用，别自己拼（/post/ 那种是 404 的）。分享时是「标题 + 一句你自己的感受 + 链接」三行，别啰嗦。'

    api.rule('social', rule('social'))
    api.rule('private', rule('private'))

    api.command({
      name: 'heybox',
      desc: '看看她最近在小黑盒刷了什么',
      run: async () => {
        try {
          const recs = await recent(5)
          if (!recs.length) return '还没刷到帖子'
          return recs.map((x, i) => (i + 1) + '. ' + x.title).join('\n')
        } catch (e) { return '查不到：' + e.message }
      },
    })
  },
}
