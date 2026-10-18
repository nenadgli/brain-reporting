import { createClient } from 'jsr:@supabase/supabase-js@2'

// Hitni PPC alarmi tokom dana, na Slack (#ppc-alarm) preko Feed Hub bota. Pokreće ga cron svakog sata 8–22h
// (Beograd); svaki alarm ide najviše jednom dnevno (tabela urgent_alerts). Samo klijenti sa params.alerts.
// - no_conversions: u 12h i 16h platforma prijavljuje 0 kupovina, i sat ranije takođe 0, a trošak se u međuvremenu pomerio
//   (inače su podaci zaglavljeni); samo nalozi koji inače imaju bar min_baseline kupovina dnevno (samo purchase akcije).
// - overspend: Google kampanja je danas potrošila bar overspend_ratio × dnevni budžet; na Meti kampanja (CBO) ili ad set
//   bar meta_overspend_ratio × svoj dnevni budžet.
// - landing_down: landing strana aktivnog oglasa ne postoji (404/410), server greška (5xx) ili ne odgovara; jedna poruka
//   za sve takve strane. 401/403/429 znači da sajt blokira proveru (zaštita od botova), a ne da strana ne radi.

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
async function windsor(connector: string, account: string, fields: string, day: string, dayTo = day): Promise<any[]> {
  const p = new URLSearchParams({ api_key: WINDSOR_API_KEY, select_accounts: account, fields, date_from: day, date_to: dayTo })
  const r = await fetch(`https://connectors.windsor.ai/${connector}?${p}`, { signal: AbortSignal.timeout(90000) })
  if (!r.ok) throw new Error(`Windsor ${connector} HTTP ${r.status}`)
  return (await r.json()).data ?? []
}

async function account(clientId: string, provider: string) {
  const { data } = await sb.from('data_sources').select('windsor_connection_id').eq('client_id', clientId).eq('provider', provider).not('windsor_connection_id', 'is', null).limit(1)
  return data?.[0] ? String(data[0].windsor_connection_id).split('__').pop()! : null
}

// Usual purchases per day over the last 28 days, counted from purchase conversion actions only (Google's conversions
// column in the database holds every action, which made "~140 purchases a day" out of add-to-carts). From Windsor,
// once a day per account, kept in alert_baselines.
const isPurchase = (r: { conversion_action_name?: unknown }) => /purchase|kupovin/i.test(String(r.conversion_action_name ?? ''))
async function purchaseBaseline(clientId: string, gAcc: string | null, mAcc: string | null, day: string) {
  const out: Record<string, number> = { google: 0, meta: 0 }
  const { data } = await sb.from('alert_baselines').select('network, computed_on, purchases_per_day').eq('client_id', clientId)
  const from = new Date(Date.parse(day) - 28 * 864e5).toISOString().slice(0, 10)
  const to = new Date(Date.parse(day) - 864e5).toISOString().slice(0, 10)
  for (const [net, acc] of [['google', gAcc], ['meta', mAcc]] as const) {
    if (!acc) continue
    const kept = (data ?? []).find((b) => b.network === net)
    if (kept && kept.computed_on === day) { out[net] = Number(kept.purchases_per_day); continue }
    const rows = net === 'google'
      ? (await windsor('google_ads', acc, 'date,conversion_action_name,conversions', from, to)).filter(isPurchase).map((r) => Number(r.conversions) || 0)
      : (await windsor('facebook', acc, 'date,actions_omni_purchase', from, to)).map((r) => Number(r.actions_omni_purchase) || 0)
    out[net] = rows.reduce((a, b) => a + b, 0) / 28
    await sb.from('alert_baselines').upsert({ client_id: clientId, network: net, computed_on: day, purchases_per_day: out[net] })
  }
  return out
}

async function checkClient(clientId: string, name: string, cfg: Record<string, unknown>, day: string, hour: number, dry: boolean, notes: string[]): Promise<Alert[]> {
  const alerts: Alert[] = []
  const gAcc = await account(clientId, 'google_ads')
  const mAcc = await account(clientId, 'facebook')
  // deno-lint-ignore no-explicit-any
  let gRows: any[] = []
  // Today's Google spend for the whole account: the fresh number the per-campaign rows are checked against.
  let gTotal = 0
  if (gAcc) {
    gTotal = (await windsor('google_ads', gAcc, 'date,spend', day)).reduce((s, r) => s + (Number(r.spend) || 0), 0)
    gRows = await windsor('google_ads', gAcc, 'date,campaign,spend', day)
    // Windsor caches each field combination (the order of the fields does not matter); when the per-campaign total lags
    // the account total, ask again with a pair of extra fields that changes every hour, so it is a new combination.
    // Still lagging: the budget check is skipped and noted.
    const sum = (rows: { spend?: unknown }[]) => rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
    const lags = (rows: { spend?: unknown }[]) => gTotal - sum(rows) > Math.max(5, gTotal * 0.05)
    if (lags(gRows)) {
      const extra = ['impressions', 'clicks', 'conversions', 'ctr', 'cpc', 'conversion_value']
      const pairs = extra.flatMap((a, i) => extra.slice(i + 1).map((b) => `${a},${b}`))
      const again = await windsor('google_ads', gAcc, `date,campaign,spend,${pairs[hour % pairs.length]}`, day)
      if (!lags(again)) gRows = again
      else { notes.push(`${name} · google: trošak po kampanjama (${eur(sum(gRows))}) zaostaje za nalogom (${eur(gTotal)}), provera budžeta preskočena`); gRows = [] }
    }
  }

  // 1. Spend today, no purchases. A reading is taken every hour (9-21h) for accounts that usually sell; the alarm goes
  //    out at the configured hours only when this reading and the one an hour earlier both show 0 purchases and the
  //    spend moved in between. Unchanged spend means Windsor is returning a stuck picture of the day: that is not
  //    sent as a PPC alarm, only reported in the run result.
  if (hour >= 9 && hour <= 21) {
    const convHours = (cfg.no_conv_hours ?? [12, 16]) as number[]
    const minSpend = Number(cfg.no_conv_min_spend ?? 30)
    const minBase = Number(cfg.min_baseline ?? 10)
    const base = await purchaseBaseline(clientId, gAcc, mAcc, day)
    for (const net of ['google', 'meta'] as const) {
      const acc = net === 'google' ? gAcc : mAcc
      if (!acc || base[net] < minBase) continue
      let spend = 0, purchases = 0
      // Account-level totals: Windsor caches each field combination separately, and the per-campaign answer was seen
      // returning the morning's numbers hours later while the account-level one was current.
      if (net === 'google') {
        spend = gTotal
        purchases = (await windsor('google_ads', acc, 'date,conversion_action_name,conversions', day)).filter(isPurchase).reduce((s, r) => s + (Number(r.conversions) || 0), 0)
      } else {
        const rows = await windsor('facebook', acc, 'date,spend,actions_omni_purchase', day)
        spend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
        purchases = rows.reduce((s, r) => s + (Number(r.actions_omni_purchase) || 0), 0)
      }
      const { data: prev } = await sb.from('urgent_alert_readings').select('spend, purchases').eq('client_id', clientId).eq('network', net).eq('reading_date', day).eq('hour', hour - 1).maybeSingle()
      if (!dry) await sb.from('urgent_alert_readings').upsert({ client_id: clientId, network: net, reading_date: day, hour, spend, purchases })
      if (!convHours.includes(hour) || spend < minSpend || purchases > 0) continue
      if (!prev) { notes.push(`${name} · ${net}: nema čitanja iz ${hour - 1}h, alarm preskočen`); continue }
      const moved = spend - Number(prev.spend)
      if (moved < Math.max(1, Number(prev.spend) * 0.02)) { notes.push(`${name} · ${net}: trošak se nije pomerio od ${hour - 1}h (${eur(spend)}), Windsor podaci zaglavljeni`); continue }
      if (Number(prev.purchases) > 0) continue
      const label = net === 'google' ? 'Google Ads' : 'Meta'
      alerts.push({ kind: 'no_conversions', key: `${net}:${hour}`, payload: { network: net, spend, purchases, baseline: base[net], hour, spend_last_hour: moved },
        text: `*${name} · ${label}:* prijavljuje 0 kupovina danas do ${hour}h uz ${eur(spend)} troška, i u poslednjih sat vremena (+${eur(moved)}) i dalje 0; inače ~${Math.round(base[net])} kupovina dnevno. ` +
          (net === 'google' ? 'Google konverzije kasne nekoliko sati: proveriti u Google Ads i GA4 da li kupovine stižu, pa tag i sajt.' : 'Proveriti u Ads Manageru da li kupovine stižu, pa pixel i sajt.') })
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
      if (b && spend >= b * ratio && spend - b >= Number(cfg.overspend_min_eur ?? 10)) alerts.push({ kind: 'overspend', key: `google:${campaign}`, payload: { campaign, spend, daily_budget: b },
        text: `*${name} · Google ${campaign}:* danas ${eur(spend)}, a dnevni budžet je ${eur(b)} (${Math.round((spend / b) * 100)}%).` })
    }
  }

  // 2b. Meta: a campaign with its own daily budget (CBO), or an ad set with one, past meta_overspend_ratio × that budget.
  //     Windsor passes Meta budgets as the API gives them, in cents (15937 = 159,37 €).
  //     Meta may spend up to 75% over a daily budget on one day and evens it out over the week, so 150% is rare but legitimate.
  if (mAcc) {
    const ratio = Number(cfg.meta_overspend_ratio ?? 1.5)
    const rows = await windsor('facebook', mAcc, 'date,campaign,adset_name,spend,campaign_daily_budget,adset_daily_budget', day)
    const camp = new Map<string, { spend: number; budget: number }>()
    const adset = new Map<string, { campaign: string; spend: number; budget: number }>()
    for (const r of rows) {
      const sp = Number(r.spend) || 0
      const c = camp.get(r.campaign) ?? { spend: 0, budget: 0 }
      c.spend += sp
      c.budget = Math.max(c.budget, (Number(r.campaign_daily_budget) || 0) / 100)
      camp.set(r.campaign, c)
      const k = `${r.campaign}|${r.adset_name}`
      const a = adset.get(k) ?? { campaign: r.campaign, spend: 0, budget: 0 }
      a.spend += sp
      a.budget = Math.max(a.budget, (Number(r.adset_daily_budget) || 0) / 100)
      adset.set(k, a)
    }
    const over = (spend: number, b: number) => b > 0 && spend >= b * ratio && spend - b >= Number(cfg.overspend_min_eur ?? 10)
    for (const [campaign, c] of camp) {
      if (over(c.spend, c.budget)) alerts.push({ kind: 'overspend', key: `meta:${campaign}`, payload: { network: 'meta', campaign, spend: c.spend, daily_budget: c.budget },
        text: `*${name} · Meta ${campaign}:* danas ${eur(c.spend)}, a dnevni budžet kampanje je ${eur(c.budget)} (${Math.round((c.spend / c.budget) * 100)}%).` })
    }
    for (const [k, a] of adset) {
      if ((camp.get(a.campaign)?.budget ?? 0) > 0) continue
      const set = k.slice(a.campaign.length + 1)
      if (over(a.spend, a.budget)) alerts.push({ kind: 'overspend', key: `meta:${k}`, payload: { network: 'meta', campaign: a.campaign, adset: set, spend: a.spend, daily_budget: a.budget },
        text: `*${name} · Meta ${a.campaign} › ${set}:* danas ${eur(a.spend)}, a dnevni budžet ad seta je ${eur(a.budget)} (${Math.round((a.spend / a.budget) * 100)}%).` })
    }
  }

  // 3. Landing pages of active ads (Google RSA final URLs from the latest snapshot), checked every 2 hours.
  if (hour % 2 === 0) {
    const { data: snap } = await sb.from('google_search_ads').select('snapshot_date').eq('client_id', clientId).order('snapshot_date', { ascending: false }).limit(1)
    const { data: ads } = snap?.length ? await sb.from('google_search_ads').select('final_url, campaign, impressions').eq('client_id', clientId).eq('snapshot_date', snap[0].snapshot_date).eq('ad_status', 'ENABLED') : { data: [] }
    const urls = [...new Map((ads ?? []).filter((a) => /^https?:\/\//.test(String(a.final_url ?? ''))).map((a) => [String(a.final_url), a.campaign])).entries()].slice(0, 60)
    const down: { url: string; campaign: string; status: number }[] = []
    for (const [url, campaign] of urls) {
      let status = 0
      try {
        const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0 (Brain landing check)' } })
        status = r.status
        await r.body?.cancel()
      } catch { status = 0 }
      if (status === 0 || status === 404 || status === 410 || status >= 500) down.push({ url, campaign, status })
    }
    if (down.length) alerts.push({ kind: 'landing_down', key: down.map((d) => d.url).sort().join('|').slice(0, 500), payload: { down },
      text: `*${name} · landing strane ne rade* (${down.length}):\n${down.slice(0, 10).map((d) => `• ${d.url} (${d.status || 'ne odgovara'}) — ${d.campaign}`).join('\n')}${down.length > 10 ? `\n… i još ${down.length - 10}` : ''}` })
  }
  return alerts
}

// Reactions on a sent alarm: who took it, who solved it, who marked it a false alarm. Read every hour for the alarms of
// the last two days that are not closed; an alarm nobody took within reminder_hours gets one reminder in its thread.
const HOW_TO_REACT = '_Reaguj: :eyes: preuzimam · :white_check_mark: rešeno · :x: lažna uzbuna_'
const TAKE = ['eyes'], DONE = ['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'], FALSE = ['x', 'no_entry_sign']
async function followUp(slackKey: string) {
  const since = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)
  const { data: open } = await sb.from('urgent_alerts').select('client_id, alert_date, kind, key, slack_channel, slack_ts, sent_at, taken_by, reminded_at')
    .gte('alert_date', since).not('slack_ts', 'is', null).is('resolved_at', null).is('false_alarm_by', null)
  const call = async (b: Record<string, unknown>) => (await fetch(SLACK_FN, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': slackKey }, body: JSON.stringify(b) })).json().catch(() => ({}))
  let read = 0, reminded = 0
  let firstError: string | null = null
  for (const a of open ?? []) {
    const r = await call({ action: 'reactions', channel: a.slack_channel, ts: a.slack_ts })
    if (!r.ok) { firstError ??= String(r.error ?? 'reactions'); continue }
    read++
    const by = (names: string[]) => ((r.reactions ?? []) as { name: string; users: string[] }[]).filter((x) => names.includes(x.name)).flatMap((x) => x.users)
    const now = new Date().toISOString()
    const patch: Record<string, unknown> = {}
    const taken = by(TAKE), done = by(DONE), wrong = by(FALSE)
    if (taken.length && !a.taken_by) Object.assign(patch, { taken_by: taken.join(', '), taken_at: now })
    if (done.length) Object.assign(patch, { resolved_by: done.join(', '), resolved_at: now })
    if (wrong.length) Object.assign(patch, { false_alarm_by: wrong.join(', ') })
    const reminderHours = 2
    if (!taken.length && !done.length && !wrong.length && !a.reminded_at && Date.parse(a.sent_at) < Date.now() - reminderHours * 36e5) {
      const p = await call({ action: 'post', channel: a.slack_channel, thread_ts: a.slack_ts, text: `Niko još nije preuzeo ovaj alarm (${reminderHours} h). Ko ga gleda, neka stavi :eyes:.` })
      if (p.ok) { patch.reminded_at = now; reminded++ }
    }
    if (Object.keys(patch).length) await sb.from('urgent_alerts').update(patch).eq('client_id', a.client_id).eq('alert_date', a.alert_date).eq('kind', a.kind).eq('key', a.key)
  }
  return { open: open?.length ?? 0, read, reminded, error: firstError }
}

Deno.serve(async (req) => {
  try {
    const internal = req.headers.get('x-internal-key')
    if (!internal || internal !== await secret('review_cron_key')) return json({ error: 'Pogrešan interni ključ' }, 403)
    const body = await req.json().catch(() => ({}))
    const now = local()
    // Test: the raw Meta rows Windsor returns for one client (fields given), nothing stored or sent.
    if (body.probe_meta && body.client_id) {
      const acc = await account(body.client_id, 'facebook')
      const rows = acc ? await windsor('facebook', acc, String(body.probe_meta), now.date) : []
      return json({ account: acc, rows: rows.slice(0, 15) })
    }
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
        const notes: string[] = []
        const found = await checkClient(s.client_id, name, cfg, now.date, hour, !!body.dry_run, notes)
        // A test run (dry_run) only reports what it would send; nothing is stored or posted.
        if (body.dry_run) { results.push({ client: name, would_send: found.map((a) => a.text), notes }); continue }
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
            body: JSON.stringify({ action: 'post', channel: cfg.channel, mention_channel: cfg.mention_channel !== false, text: `:rotating_light: ${a.text}\n${HOW_TO_REACT}` }) })
          const j = await r.json().catch(() => ({}))
          await sb.from('urgent_alerts').update({ sent_at: j.ok ? new Date().toISOString() : null, error: j.ok ? null : String(j.error ?? r.status), slack_channel: j.ok ? String(cfg.channel) : null, slack_ts: j.ok ? j.ts : null })
            .eq('client_id', s.client_id).eq('alert_date', now.date).eq('kind', a.kind).eq('key', a.key)
          if (j.ok) sent++
        }
        results.push({ client: name, found: found.length, sent, notes })
      } catch (e) {
        results.push({ client: name, error: (e as Error).message })
      }
    }
    const followup = body.dry_run ? null : await followUp(slackKey ?? '').catch((e) => ({ error: (e as Error).message }))
    return json({ ok: true, date: now.date, hour, results, followup })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
