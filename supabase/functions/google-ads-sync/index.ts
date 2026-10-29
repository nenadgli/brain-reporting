import { createClient } from 'jsr:@supabase/supabase-js@2'

const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function dateParams(body: { date_preset?: string; date_from?: string; date_to?: string }) {
  if (body.date_from && body.date_to) return { date_from: body.date_from, date_to: body.date_to }
  return { date_preset: body.date_preset ?? 'last_14d' }
}

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}))
    const { client_id } = body
    if (!client_id) return new Response(JSON.stringify({ error: 'client_id je obavezan' }), { status: 400, headers: { 'Content-Type': 'application/json' } })

    const { data: sources, error: sourcesError } = await supabase
      .from('data_sources').select('id, windsor_connection_id')
      .eq('client_id', client_id).eq('provider', 'google_ads').not('windsor_connection_id', 'is', null)
    if (sourcesError) throw sourcesError
    if (!sources || sources.length === 0) return new Response(JSON.stringify({ error: 'Nema Google Ads konekcije' }), { status: 404, headers: { 'Content-Type': 'application/json' } })

    const dP = dateParams(body)
    const results = []
    for (const source of sources) {
      const rawAccountId = source.windsor_connection_id.includes('__') ? source.windsor_connection_id.split('__')[1] : source.windsor_connection_id

      // Unique users for a whole period (body.period_reach with date_from/date_to): people cannot be added up from daily
      // rows, so they are asked without the date field, per campaign, and kept in google_period_reach.
      if (body.period_reach && body.date_from && body.date_to) {
        const p = new URLSearchParams({ date_from: body.date_from, date_to: body.date_to, api_key: WINDSOR_API_KEY, select_accounts: rawAccountId, fields: 'campaign,unique_users,impressions' })
        const r0 = await fetch(`https://connectors.windsor.ai/google_ads?${p.toString()}`)
        if (!r0.ok) throw new Error(`Windsor unique users HTTP ${r0.status}`)
        const out = new Map<string, Record<string, unknown>>()
        for (const r of ((await r0.json()).data ?? []) as Record<string, unknown>[]) {
          if (!r.campaign || Number(out.get(String(r.campaign))?.unique_users ?? -1) >= Number(r.unique_users ?? 0)) continue
          out.set(String(r.campaign), { client_id, data_source_id: source.id, campaign: r.campaign, date_from: body.date_from, date_to: body.date_to,
            unique_users: r.unique_users ?? null, impressions: r.impressions ?? null, synced_at: new Date().toISOString() })
        }
        await supabase.from('google_period_reach').delete().eq('data_source_id', source.id).eq('date_from', body.date_from).eq('date_to', body.date_to)
        const list = [...out.values()]
        if (list.length) { const { error } = await supabase.from('google_period_reach').insert(list); if (error) throw error }
        results.push({ source: source.windsor_connection_id, period_reach_rows: list.length })
        continue
      }

      // Main performance pull. IMPORTANT: search_impression_share/quality_score fields
      // must NOT be combined in this call - verified that mixing them with device-level
      // metrics causes Windsor to silently truncate ~40% of search campaigns (confirmed
      // against Google Ads UI export). They're fetched in a separate lightweight call below.
      const mainParams = new URLSearchParams({
        ...dP, api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
        fields: 'date,campaign,campaign_type,device,impressions,clicks,spend,conversion_value,unique_users',
      })
      const mainRes = await fetch(`https://connectors.windsor.ai/google_ads?${mainParams.toString()}`)
      if (!mainRes.ok) { results.push({ source: source.windsor_connection_id, error: `HTTP ${mainRes.status}` }); continue }
      const mainJson = await mainRes.json()
      const mainRows: Record<string, unknown>[] = mainJson.data ?? []

      // Impression share / quality score, campaign+date grain only (no device split).
      const isParams = new URLSearchParams({
        ...dP, api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
        // Windsor's names for the lost-share fields; search_lost_is_budget/rank do not exist and came back empty.
        fields: 'date,campaign,search_impression_share,search_budget_lost_impression_share,search_rank_lost_impression_share,quality_score',
      })
      const isRes = await fetch(`https://connectors.windsor.ai/google_ads?${isParams.toString()}`)
      const isRows: Record<string, unknown>[] = isRes.ok ? (await isRes.json()).data ?? [] : []
      const isMap = new Map<string, Record<string, unknown>>()
      for (const r of isRows) isMap.set(`${r.date}|${r.campaign}`, r)

      // Conversions, broken down by conversion_action_name so we can sum ONLY "purchase"
      // actions. The generic "conversions" column mixes in unrelated actions (e.g. app
      // "First Open" installs), inflating the count well above real Purchase totals -
      // confirmed against PPC's manual report (Purchase column) and Google Ads UI.
      const convParams = new URLSearchParams({
        ...dP, api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
        fields: 'date,campaign,conversion_action_name,conversions',
      })
      const convRes = await fetch(`https://connectors.windsor.ai/google_ads?${convParams.toString()}`)
      const convRows: Record<string, unknown>[] = convRes.ok ? (await convRes.json()).data ?? [] : []
      // Test (body.probe_conv, a campaign regex): conversion actions and their totals for the period, nothing stored.
      if (body.probe_conv) {
        const re = new RegExp(String(body.probe_conv))
        const tot = new Map<string, number>()
        for (const r of convRows) {
          if (!re.test(String(r.campaign ?? ''))) continue
          const k = String(r.conversion_action_name ?? '')
          tot.set(k, (tot.get(k) ?? 0) + (Number(r.conversions) || 0))
        }
        results.push({ source: source.windsor_connection_id, actions: Object.fromEntries([...tot].sort((a, b) => b[1] - a[1])) })
        continue
      }
      const convMap = new Map<string, number>()
      // App installs as the PPC team counts them in the platform: the install / first open conversion actions.
      const installMap = new Map<string, number>()
      for (const r of convRows) {
        const actionName = String(r.conversion_action_name ?? '').toLowerCase()
        const key = `${r.date}|${r.campaign}`
        if (/install|first.?open/.test(actionName)) installMap.set(key, (installMap.get(key) ?? 0) + (Number(r.conversions) || 0))
        if (!actionName.includes('purchase')) continue
        convMap.set(key, (convMap.get(key) ?? 0) + (Number(r.conversions) || 0))
      }

      await supabase.from('data_sources').update({ status: 'active', last_synced_at: new Date().toISOString() }).eq('id', source.id)

      // Purchases come per campaign and day, the main rows per device: they go on ONE device row of the campaign and day
      // (the one with the most clicks), the other device rows get 0. Written on every device row they were counted
      // two to four times over in every sum (F&F RS, September 2026: 25,871 instead of 7,225).
      const carrier = new Map<string, Record<string, unknown>>()
      for (const r of mainRows) {
        const key = `${r.date}|${r.campaign}`
        const c = carrier.get(key)
        if (!c || Number(r.clicks ?? 0) > Number(c.clicks ?? 0) || (Number(r.clicks ?? 0) === Number(c.clicks ?? 0) && String(r.device) < String(c.device))) carrier.set(key, r)
      }

      const metricRows = mainRows.map((r: Record<string, unknown>) => {
        const isRow = isMap.get(`${r.date}|${r.campaign}`)
        return {
          client_id, data_source_id: source.id, report_date: r.date, campaign: r.campaign,
          campaign_type: r.campaign_type, device: r.device, impressions: r.impressions ?? 0, clicks: r.clicks ?? 0,
          spend: r.spend ?? 0, conversions: carrier.get(`${r.date}|${r.campaign}`) === r ? convMap.get(`${r.date}|${r.campaign}`) ?? 0 : 0, conversion_value: r.conversion_value ?? 0,
          installs: carrier.get(`${r.date}|${r.campaign}`) === r ? installMap.get(`${r.date}|${r.campaign}`) ?? 0 : 0,
          unique_users: r.unique_users ?? 0,
          search_impression_share: isRow?.search_impression_share ?? null,
          search_lost_is_budget: isRow?.search_budget_lost_impression_share ?? null,
          search_lost_is_rank: isRow?.search_rank_lost_impression_share ?? null,
          quality_score: isRow?.quality_score ?? null,
        }
      })
      if (metricRows.length > 0) {
        const dates = [...new Set(mainRows.map((r: Record<string, unknown>) => r.date))]
        await supabase.from('google_ads_metrics').delete().eq('data_source_id', source.id).in('report_date', dates)
        for (let i = 0; i < metricRows.length; i += 500) {
          await supabase.from('google_ads_metrics').insert(metricRows.slice(i, i + 500))
        }
      }
      results.push({ source: source.windsor_connection_id, rows: metricRows.length })
    }
    return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
