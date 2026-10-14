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
        fields: 'date,campaign,search_impression_share,search_lost_is_budget,search_lost_is_rank,quality_score',
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
      const convMap = new Map<string, number>()
      for (const r of convRows) {
        const actionName = String(r.conversion_action_name ?? '').toLowerCase()
        if (!actionName.includes('purchase')) continue
        const key = `${r.date}|${r.campaign}`
        convMap.set(key, (convMap.get(key) ?? 0) + (Number(r.conversions) || 0))
      }

      await supabase.from('data_sources').update({ status: 'active', last_synced_at: new Date().toISOString() }).eq('id', source.id)

      const metricRows = mainRows.map((r: Record<string, unknown>) => {
        const isRow = isMap.get(`${r.date}|${r.campaign}`)
        return {
          client_id, data_source_id: source.id, report_date: r.date, campaign: r.campaign,
          campaign_type: r.campaign_type, device: r.device, impressions: r.impressions ?? 0, clicks: r.clicks ?? 0,
          spend: r.spend ?? 0, conversions: convMap.get(`${r.date}|${r.campaign}`) ?? 0, conversion_value: r.conversion_value ?? 0,
          unique_users: r.unique_users ?? 0,
          search_impression_share: isRow?.search_impression_share ?? null,
          search_lost_is_budget: isRow?.search_lost_is_budget ?? null,
          search_lost_is_rank: isRow?.search_lost_is_rank ?? null,
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
