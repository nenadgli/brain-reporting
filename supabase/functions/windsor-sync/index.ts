import { createClient } from 'jsr:@supabase/supabase-js@2'

const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

type WindsorRow = {
  date: string
  datasource: string
  account_name: string
  source: string
  campaign: string
  clicks: number
  spend: number
}

Deno.serve(async (req: Request) => {
  try {
    const { client_id, date_preset = 'last_7d' } = await req.json().catch(() => ({}))

    if (!client_id) {
      return new Response(JSON.stringify({ error: 'client_id je obavezan' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Only google_ads/facebook sources go through the /all endpoint — GA4 isn't
    // supported there and has its own dedicated ga4-sync function.
    const { data: sources, error: sourcesError } = await supabase
      .from('data_sources')
      .select('id, provider, windsor_connection_id')
      .eq('client_id', client_id)
      .in('provider', ['google_ads', 'facebook'])
      .not('windsor_connection_id', 'is', null)

    if (sourcesError) throw sourcesError
    if (!sources || sources.length === 0) {
      return new Response(JSON.stringify({ error: 'Nema Windsor konekcija za ovog klijenta' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let totalRowsUpserted = 0
    const results: Record<string, unknown>[] = []

    for (const source of sources) {
      const params = new URLSearchParams({
        date_preset,
        fields: 'date,datasource,account_name,source,campaign,clicks,spend',
        select_accounts: source.windsor_connection_id,
        api_key: WINDSOR_API_KEY,
      })

      const res = await fetch(`https://connectors.windsor.ai/all?${params.toString()}`)
      if (!res.ok) {
        results.push({ source: source.windsor_connection_id, error: `Windsor HTTP ${res.status}` })
        continue
      }

      const json = await res.json()
      const rows: WindsorRow[] = json.data ?? []

      await supabase
        .from('data_sources')
        .update({ status: 'active', last_synced_at: new Date().toISOString() })
        .eq('id', source.id)

      const metricRows = rows.flatMap((r) => [
        {
          client_id,
          data_source_id: source.id,
          report_date: r.date,
          channel: r.source,
          campaign: r.campaign,
          metric_name: 'spend',
          metric_value: r.spend,
        },
        {
          client_id,
          data_source_id: source.id,
          report_date: r.date,
          channel: r.source,
          campaign: r.campaign,
          metric_name: 'clicks',
          metric_value: r.clicks,
        },
      ])

      if (metricRows.length > 0) {
        const dates = [...new Set(rows.map((r) => r.date))]
        await supabase
          .from('report_metrics')
          .delete()
          .eq('data_source_id', source.id)
          .in('report_date', dates)

        const { error: insertError } = await supabase.from('report_metrics').insert(metricRows)
        if (insertError) {
          results.push({ source: source.windsor_connection_id, error: insertError.message })
          continue
        }
        totalRowsUpserted += metricRows.length
      }

      results.push({ source: source.windsor_connection_id, rows_synced: metricRows.length })
    }

    return new Response(JSON.stringify({ ok: true, total_rows: totalRowsUpserted, results }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
