import { createClient } from 'npm:@supabase/supabase-js@2.56.0'

// PPC alarms from Brain to Slack, through Feed Hub's Slack bot (the bot token stays here).
// Auth: x-api-key checked against external_api_keys (scope slack:notify). Only the channels in ALLOWED.
// Actions: whoami | ensure_channel { name } | post { channel, text, mention_channel? }

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const TOKEN = Deno.env.get('SLACK_BOT_TOKEN') ?? ''
const SCOPE = 'slack:notify'
const ALLOWED = new Set(['ppc-alarm'])
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// deno-lint-ignore no-explicit-any
async function slack(method: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })
  return r.json()
}

// The channel's id: first among the channels the bot is a member of (public or private, it was invited), then among
// the workspace's public channels (joined if needed), and created as a public channel only if it does not exist.
async function ensureChannel(name: string) {
  let cursor = ''
  const memberOf: string[] = []
  let memberError = ''
  for (let i = 0; i < 20; i++) {
    const r = await slack('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, ...(cursor ? { cursor } : {}) })
    if (!r.ok) { memberError = `users.conversations: ${r.error}${r.needed ? ` (treba ${r.needed})` : ''}`; break }
    // deno-lint-ignore no-explicit-any
    memberOf.push(...(r.channels ?? []).map((c: any) => c.name))
    // deno-lint-ignore no-explicit-any
    const ch = (r.channels ?? []).find((c: any) => c.name === name)
    if (ch) return { id: ch.id, created: false }
    cursor = r.response_metadata?.next_cursor ?? ''
    if (!cursor) break
  }
  cursor = ''
  for (let i = 0; i < 20; i++) {
    const r = await slack('conversations.list', { types: 'public_channel', exclude_archived: true, limit: 1000, ...(cursor ? { cursor } : {}) })
    if (!r.ok) return { error: `conversations.list: ${r.error}${r.needed ? ` (treba ${r.needed})` : ''}` }
    // deno-lint-ignore no-explicit-any
    const ch = (r.channels ?? []).find((c: any) => c.name === name)
    if (ch) {
      if (!ch.is_member) {
        const j = await slack('conversations.join', { channel: ch.id })
        if (!j.ok) return { error: `conversations.join: ${j.error}${j.needed ? ` (treba ${j.needed})` : ''}`, id: ch.id }
      }
      return { id: ch.id, created: false }
    }
    cursor = r.response_metadata?.next_cursor ?? ''
    if (!cursor) break
  }
  const c = await slack('conversations.create', { name, is_private: false })
  if (!c.ok) return { error: `kanal #${name} nije pronađen; bot je član: ${memberOf.join(', ') || '(nijednog)'}${memberError ? `; ${memberError}` : ''}; conversations.create: ${c.error}` }
  return { id: c.channel.id, created: true }
}

Deno.serve(async (req) => {
  try {
    const key = req.headers.get('x-api-key') ?? ''
    if (!key) return json({ error: 'missing x-api-key' }, 401)
    const { data: k } = await sb.from('external_api_keys').select('id').eq('key_sha256', await sha256(key)).eq('scope', SCOPE).eq('active', true).maybeSingle()
    if (!k) return json({ error: 'invalid key' }, 403)
    if (!TOKEN) return json({ error: 'SLACK_BOT_TOKEN missing' }, 500)

    const body = await req.json().catch(() => ({}))
    // Which bot this token belongs to (the one to invite to the channel).
    if (body.action === 'whoami') {
      const a = await slack('auth.test', {})
      const u = a.ok && a.user_id ? await slack('users.info', { user: a.user_id }) : null
      return json({ ok: a.ok, error: a.error, team: a.team, bot_user: a.user, user_id: a.user_id, display_name: u?.user?.profile?.display_name || u?.user?.real_name || null })
    }
    const name = String(body.channel ?? body.name ?? '').replace(/^#/, '')
    if (!ALLOWED.has(name)) return json({ error: `kanal ${name} nije dozvoljen` }, 400)
    const ch = await ensureChannel(name)
    if ('error' in ch) return json(ch, 502)

    if (body.action === 'ensure_channel') return json(ch)
    if (body.action === 'post') {
      const text = String(body.text ?? '').slice(0, 3500)
      if (!text) return json({ error: 'text je obavezan' }, 400)
      const full = (body.mention_channel ? '<!channel> ' : '') + text
      const r = await slack('chat.postMessage', { channel: ch.id, text: full, unfurl_links: false, unfurl_media: false })
      if (!r.ok) return json({ error: `chat.postMessage: ${r.error}${r.needed ? ` (treba ${r.needed})` : ''}` }, 502)
      return json({ ok: true, channel: ch.id, created: ch.created, ts: r.ts })
    }
    return json({ error: `unknown action ${body.action}` }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
