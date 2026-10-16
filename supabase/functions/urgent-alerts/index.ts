import { createClient } from 'jsr:@supabase/supabase-js@2'

// Hitni PPC alarmi tokom dana, na Slack (#ppc-alarmi) preko Feed Hub bota. Pokreće ga cron svakog sata 8–22h
// (Beograd); svaki alarm ide najviše jednom dnevno (tabela urgent_alerts). Samo klijenti sa params.alerts.
// - no_conversions: trošak danas, a 0 kupovina, u 12h i 16h; samo nalozi koji inače imaju bar min_baseline kupovina dnevno.
// - overspend: Google kampanja je danas potrošila bar overspend_ratio × dnevni budžet.
// - landing_down: landing strana aktivnog oglasa vraća grešku (4xx/5xx ili ne odgovara).

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const SLACK_FN = 'https://bagpjjejeuteojpsufto.supabase.co/functions/v1/brain-slack-notify'
const sb = createClient(SUPABASE_URL, SERVICE)
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

type Alert = { kind: string; key: string; text: string; payload: Record<string, unknown> }

// Belgrade date and hour (the accounts and the team are in that time zone).
function local() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date())
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 }
}
const eur = (n: number) => `${Math.round(n).toLocaleString('sr-RS')} €`

async function secret(name: string) {
  const { data } = await sb.from('integration_secrets').select('value').eq('name', name).maybeSingle()
  return data?.value as string | undefined
}

// deno-lint-ignore no-explicit-any
async function windsor(connector: string, account: string, fields: string, day: string): Promise<any[]> {
  const p = new URLSearchParams({ api_key: WINDSOR_API_KEY, select_accounts: account, fields, date_from: day, date_to: day })
  const r = await fetch(`https://connectors.windsor.ai/${connector}?${p}`, { signal: AbortSignal.timeout(90000) })
  if (!r.ok) throw new Error(`Windsor ${connector} HTTP ${r.status}`)
  return (await r.json()).data ?? []
}

async function account(clientId: string, provider: string) {
  const { data } = await sb.from('data_sources').select('windsor_connection_id').eq('client_id', clientId).eq('provider', provider).not('windsor_connection_id', 'is', null).limit(1)
  return data?.[0] ? String(data[0].windsor_connection_id).split('__').pop()! : null
}

// Usual purchases per day over the last 28 days, per network (summed in the database).
async function baseline(clientId: string) {
  const { data, error } = await sb.rpc('daily_purchases_baseline', { p_client_id: clientId })
  if (error) throw error
  const out: Record<string, number> = { google: 0, meta: 0 }
  for (const r of (data ?? []) as { network: string; per_day: number }[]) out[r.network] = Number(r.per_day) || 0
  return out
}

async function checkClient(clientId: string, name: string, cfg: Record<string, unknown>, day: string, hour: number): Promise<Alert[]> {
  const alerts: Alert[] = []
  const gAcc = await account(clientId, 'google_ads')
  const mAcc = await account(clientId, 'facebook')
  // deno-lint-ignore no-explicit-any
  let gRows: any[] = []
  if (gAcc) gRows = await windsor('google_ads', gAcc, 'date,campaign,spend', day)

  // 1. Spend today, no purchases (at the configured hours only).
  const convHours = (cfg.no_conv_hours ?? [12, 16]) as number[]
  if (convHours.includes(hour)) {
    const base = await baseline(clientId)
    const minSpend = Number(cfg.no_conv_min_spend ?? 30)
    const minBase = Number(cfg.min_baseline ?? 10)
    if (gAcc && base.google >= minBase) {
      const conv = await windsor('google_ads', gAcc, 'date,campaign,conversion_action_name,conversions', day)
      const purchases = conv.filter((r) => String(r.conversion_action_name ?? '').toLowerCase().includes('purchase')).reduce((s, r) => s + (Number(r.conversions) || 0), 0)
      const spend = gRows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
      if (spend >= minSpend && purchases === 0) alerts.push({ kind: 'no_conversions', key: `google:${hour}`, payload: { network: 'google', spend, purchases, baseline: base.google, hour },
        text: `*${name} · Google:* ${eur(spend)} troška danas do ${hour}h, a 0 kupovina (inače ~${Math.round(base.google)} kupovina dnevno). Proveriti tracking i sajt.` })
    }
    if (mAcc && base.meta >= minBase) {
      const rows = await windsor('facebook', mAcc, 'date,campaign,spend,actions_omni_purchase', day)
      const spend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
      const purchases = rows.reduce((s, r) => s + (Number(r.actions_omni_purchase) || 0), 0)
      if (spend >= minSpend && purchases === 0) alerts.push({ kind: 'no_conversions', key: `meta:${hour}`, payload: { network: 'meta', spend, purchases, baseline: base.meta, hour },
        text: `*${name} · Meta:* ${eur(spend)} troška danas do ${hour}h, a 0 kupovina (inače ~${Math.round(base.meta)} kupovina dnevno). Proveriti pixel i sajt.` })
    }
  }

  // 2. Google campaigns past overspend_ratio × daily budget (budgets from the latest settings snapshot).
  if (gAcc && gRows.length) {
    const ratio = Number(cfg.overspend_ratio ?? 1.5)
    const { data: snap } = await sb.from('google_campaign_settings').select('snapshot_date').eq('client_id', clientId).order('snapshot_date', { ascending: false }).limit(1)
    const { data: settings } = snap?.length ? await sb.from('google_campaign_settings').select('campaign, daily_budget, budget_shared').eq('client_id', clientId).eq('snapshot_date', snap[0].snapshot_date) : { data: [] }
    const budget = new Map((settings ?? []).filter((s) => !s.budget_shared && Number(s.daily_budget) > 0).map((s) => [s.campaign, Number(s.daily_budget)]))
    const spendBy = new Map<string, number>()
    for (const r of gRows) spendBy.set(r.campaign, (spendBy.get(r.campaign) ?? 0) + (Number(r.spend) || 0))
    for (const [campaign, spend] of spendBy) {
      const b = budget.get(campaign)
      if (b && spend >= b * ratio) alerts.push({ kind: 'overspend', key: `google:${campaign}`, payload: { campaign, spend, daily_budget: b },
        text: `*${name} · Google ${campaign}:* danas ${eur(spend)}, a dnevni budžet je ${eur(b)} (${Math.round((spend / b) * 100)}%).` })
    }
  }

  // 3. Landing pages of active ads (Google RSA final URLs from the latest snapshot), checked every 2 hours.
  if (hour % 2 === 0) {
    const { data: snap } = await sb.from('google_search_ads').select('snapshot_date').eq('client_id', clientId).order('snapshot_date', { ascending: false }).limit(1)
    const { data: ads } = snap?.length ? await sb.from('google_search_ads').select('final_url, campaign, impressions').eq('client_id', clientId).eq('snapshot_date', snap[0].snapshot_date).eq('ad_status', 'ENABLED') : { data: [] }
    const urls = [...new Map((ads ?? []).filter((a) => /^https?:\/\//.test(String(a.final_url ?? ''))).map((a) => [String(a.final_url), a.campaign])).entries()].slice(0, 60)
    for (const [url, campaign] of urls) {
      let status = 0
      try {
        const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0 (Brain landing check)' } })
        status = r.status
        await r.body?.cancel()
      } catch { status = 0 }
      if (status === 0 || status >= 400) alerts.push({ kind: 'landing_down', key: url, payload: { url, campaign, status },
        text: `*${name} · landing strana ne radi* (${status || 'ne odgovara'}): ${url} — kampanja ${campaign}.` })
    }
  }
  return alerts
}

Deno.serve(async (req) => {
  try {
    const internal = req.headers.get('x-internal-key')
    if (!internal || internal !== await secret('review_cron_key')) return json({ error: 'Pogrešan interni ključ' }, 403)
    const body = await req.json().catch(() => ({}))
    const now = local()
    const hour = body.hour != null ? Number(body.hour) : now.hour
    const slackKey = await secret('feedhub_slack_key')
    const { data: settings } = await sb.from('review_settings').select('client_id, params, clients(name)').eq('enabled', true)
    const results = []
    for (const s of settings ?? []) {
      const cfg = (s.params as Record<string, unknown>)?.alerts as Record<string, unknown> | undefined
      if (!cfg?.channel) continue
      if (body.client_id && body.client_id !== s.client_id) continue
      const name = (s.clients as unknown as { name: string })?.name ?? ''
      try {
        const found = await checkClient(s.client_id, name, cfg, now.date, hour)
        // A test run (dry_run) only reports what it would send; nothing is stored or posted.
        if (body.dry_run) { results.push({ client: name, would_send: found.map((a) => a.text) }); continue }
        let sent = 0
        for (const a of found) {
          // Once a day per alarm (the unique key decides); one that failed to send is tried again on the next run.
          const { data: prev } = await sb.from('urgent_alerts').select('sent_at').eq('client_id', s.client_id).eq('alert_date', now.date).eq('kind', a.kind).eq('key', a.key).maybeSingle()
          if (prev?.sent_at) continue
          if (!prev) {
            const { error } = await sb.from('urgent_alerts').insert({ client_id: s.client_id, alert_date: now.date, kind: a.kind, key: a.key, text: a.text, payload: a.payload })
            if (error) continue
          }
          const r = await fetch(SLACK_FN, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': slackKey ?? '' },
            body: JSON.stringify({ action: 'post', channel: cfg.channel, mention_channel: cfg.mention_channel !== false, text: `:rotating_light: ${a.text}` }) })
          const j = await r.json().catch(() => ({}))
          await sb.from('urgent_alerts').update({ sent_at: j.ok ? new Date().toISOString() : null, error: j.ok ? null : String(j.error ?? r.status) })
            .eq('client_id', s.client_id).eq('alert_date', now.date).eq('kind', a.kind).eq('key', a.key)
          if (j.ok) sent++
        }
        results.push({ client: name, found: found.length, sent })
      } catch (e) {
        results.push({ client: name, error: (e as Error).message })
      }
    }
    return json({ ok: true, date: now.date, hour, results })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
