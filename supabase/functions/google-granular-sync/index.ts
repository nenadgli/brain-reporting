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

      // Purchase-only conversions, campaign+date grain (shared lookup for both ad_group and asset_group pulls below)
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
      // Purchase-conversions do not split by ad_group/asset_group in Google's API the same
      // way spend does; we apply the campaign-level purchase figure proportionally isn't
      // reliable, so instead we keep spend/impressions/clicks exact per ad_group/asset_group
      // and only report conversions at the sub-level using Google's own conversions field
      // filtered the same way, fetched per-dimension below.

      // --- Ad groups ---
      const agParams = new URLSearchParams({
        ...dP, api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
        fields: 'date,campaign,ad_group_name,impressions,clicks,spend,conversion_value',
      })
      const agRes = await fetch(`https://connectors.windsor.ai/google_ads?${agParams.toString()}`)
      if (agRes.ok) {
        const agJson = await agRes.json()
        const agRows = agJson.data ?? []

        const agConvParams = new URLSearchParams({
          ...dP, api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
          fields: 'date,campaign,ad_group_name,conversion_action_name,conversions',
        })
        const agConvRes = await fetch(`https://connectors.windsor.ai/google_ads?${agConvParams.toString()}`)
        const agConvRows: Record<string, unknown>[] = agConvRes.ok ? (await agConvRes.json()).data ?? [] : []
        const agConvMap = new Map<string, number>()
        for (const r of agConvRows) {
          const actionName = String(r.conversion_action_name ?? '').toLowerCase()
          if (!actionName.includes('purchase')) continue
          const key = `${r.date}|${r.campaign}|${r.ad_group_name}`
          agConvMap.set(key, (agConvMap.get(key) ?? 0) + (Number(r.conversions) || 0))
        }

        const agMetricRows = agRows.map((r: Record<string, unknown>) => ({
          client_id, data_source_id: source.id, report_date: r.date, campaign: r.campaign, ad_group_name: r.ad_group_name,
          impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, spend: r.spend ?? 0,
          conversions: agConvMap.get(`${r.date}|${r.campaign}|${r.ad_group_name}`) ?? 0, conversion_value: r.conversion_value ?? 0,
        }))
        if (agMetricRows.length > 0) {
          const dates = [...new Set(agRows.map((r: Record<string, unknown>) => r.date))]
          await supabase.from('google_ad_group_metrics').delete().eq('data_source_id', source.id).in('report_date', dates)
          for (let i = 0; i < agMetricRows.length; i += 500) {
            await supabase.from('google_ad_group_metrics').insert(agMetricRows.slice(i, i + 500))
          }
        }
        results.push({ type: 'ad_group', source: source.windsor_connection_id, rows: agMetricRows.length })
      } else {
        results.push({ type: 'ad_group', source: source.windsor_connection_id, error: `HTTP ${agRes.status}` })
      }

      // --- Asset groups (PMax) ---
      const agrParams = new URLSearchParams({
        ...dP, api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
        fields: 'date,campaign,asset_group_name,impressions,clicks,spend,conversion_value',
      })
      const agrRes = await fetch(`https://connectors.windsor.ai/google_ads?${agrParams.toString()}`)
      if (agrRes.ok) {
        const agrJson = await agrRes.json()
        const agrRows = (agrJson.data ?? []).filter((r: Record<string, unknown>) => r.asset_group_name)

        const agrConvParams = new URLSearchParams({
          ...dP, api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
          fields: 'date,campaign,asset_group_name,conversion_action_name,conversions',
        })
        const agrConvRes = await fetch(`https://connectors.windsor.ai/google_ads?${agrConvParams.toString()}`)
        const agrConvRows: Record<string, unknown>[] = agrConvRes.ok ? (await agrConvRes.json()).data ?? [] : []
        const agrConvMap = new Map<string, number>()
        for (const r of agrConvRows) {
          const actionName = String(r.conversion_action_name ?? '').toLowerCase()
          if (!actionName.includes('purchase')) continue
          const key = `${r.date}|${r.campaign}|${r.asset_group_name}`
          agrConvMap.set(key, (agrConvMap.get(key) ?? 0) + (Number(r.conversions) || 0))
        }

        const agrMetricRows = agrRows.map((r: Record<string, unknown>) => ({
          client_id, data_source_id: source.id, report_date: r.date, campaign: r.campaign, asset_group_name: r.asset_group_name,
          impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, spend: r.spend ?? 0,
          conversions: agrConvMap.get(`${r.date}|${r.campaign}|${r.asset_group_name}`) ?? 0, conversion_value: r.conversion_value ?? 0,
        }))
        if (agrMetricRows.length > 0) {
          const dates = [...new Set(agrRows.map((r: Record<string, unknown>) => r.date))]
          await supabase.from('google_asset_group_metrics').delete().eq('data_source_id', source.id).in('report_date', dates)
          for (let i = 0; i < agrMetricRows.length; i += 500) {
            await supabase.from('google_asset_group_metrics').insert(agrMetricRows.slice(i, i + 500))
          }
        }
        results.push({ type: 'asset_group', source: source.windsor_connection_id, rows: agrMetricRows.length })
      } else {
        results.push({ type: 'asset_group', source: source.windsor_connection_id, error: `HTTP ${agrRes.status}` })
      }
    }
    return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
