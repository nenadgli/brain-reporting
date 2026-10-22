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
      .eq('client_id', client_id).eq('provider', 'facebook').not('windsor_connection_id', 'is', null)
    if (sourcesError) throw sourcesError
    if (!sources || sources.length === 0) return new Response(JSON.stringify({ error: 'Nema Facebook Ads konekcije' }), { status: 404, headers: { 'Content-Type': 'application/json' } })

    const results = []
    for (const source of sources) {
      const rawAccountId = source.windsor_connection_id.includes('__') ? source.windsor_connection_id.split('__')[1] : source.windsor_connection_id
      // Backfill (body.link_clicks_only): only link clicks are written into the rows already stored, matched by date and
      // name (and ad set). A full re-pull would rename old rows to today's campaign names and break the GA4 matching
      // and the report rows built on the old names.
      if (body.link_clicks_only) {
        const p = new URLSearchParams({ ...dateParams(body), api_key: WINDSOR_API_KEY, select_accounts: rawAccountId, fields: 'date,campaign,adset_name,inline_link_clicks' })
        const r0 = await fetch(`https://connectors.windsor.ai/facebook?${p.toString()}`)
        if (!r0.ok) { results.push({ source: source.windsor_connection_id, error: `HTTP ${r0.status}` }); continue }
        const rows = ((await r0.json()).data ?? []).map((r: Record<string, unknown>) => ({ date: r.date, campaign: r.campaign, adset_name: r.adset_name ?? null, link_clicks: Number(r.inline_link_clicks) || 0 }))
        let updated = 0
        for (let i = 0; i < rows.length; i += 1000) {
          const { data, error } = await supabase.rpc('meta_link_clicks_fill', { p_source: source.id, p_level: 'adset', p_rows: rows.slice(i, i + 1000) })
          if (error) throw error
          updated += Number(data) || 0
        }
        results.push({ source: source.windsor_connection_id, link_clicks_rows: rows.length, updated })
        continue
      }
      const params = new URLSearchParams({
        ...dateParams(body), api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
        fields: 'date,campaign,adset_name,impressions,clicks,inline_link_clicks,spend,reach,actions_omni_purchase,action_values_offsite_conversion_fb_pixel_purchase',
      })
      const res = await fetch(`https://connectors.windsor.ai/facebook?${params.toString()}`)
      if (!res.ok) { results.push({ source: source.windsor_connection_id, error: `HTTP ${res.status}` }); continue }
      const json = await res.json()
      const rows = json.data ?? []
      const metricRows = rows.map((r: Record<string, unknown>) => ({
        client_id, data_source_id: source.id, report_date: r.date, campaign: r.campaign, adset_name: r.adset_name,
        impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, link_clicks: r.inline_link_clicks ?? 0, spend: r.spend ?? 0, reach: r.reach ?? 0,
        conversions: r.actions_omni_purchase ?? 0, conversion_value: r.action_values_offsite_conversion_fb_pixel_purchase ?? 0,
      }))
      if (metricRows.length > 0) {
        const dates = [...new Set(rows.map((r: Record<string, unknown>) => r.date))]
        await supabase.from('meta_ad_set_metrics').delete().eq('data_source_id', source.id).in('report_date', dates)
        for (let i = 0; i < metricRows.length; i += 500) {
          await supabase.from('meta_ad_set_metrics').insert(metricRows.slice(i, i + 500))
        }
      }
      results.push({ source: source.windsor_connection_id, rows: metricRows.length })
    }
    return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
