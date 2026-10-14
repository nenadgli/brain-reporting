import { createClient } from 'jsr:@supabase/supabase-js@2'

const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Large accounts (Replay: ~24k search-term rows a day) ran out of worker memory when 14 days
// came back in one Windsor response. Days are now fetched and written one at a time, and the
// function stops before the wall-clock limit, reporting the days it did not reach.
const TIME_BUDGET_MS = 120_000
const INSERT_BATCH = 1000

const iso = (d: Date) => d.toISOString().slice(0, 10)

function daysFor(body: { date_preset?: string; date_from?: string; date_to?: string }): string[] {
  let from: Date
  let to: Date
  if (body.date_from && body.date_to) {
    from = new Date(`${body.date_from}T00:00:00Z`)
    to = new Date(`${body.date_to}T00:00:00Z`)
  } else {
    const n = Number(/^last_(\d+)d$/.exec(body.date_preset ?? 'last_14d')?.[1] ?? 14)
    to = new Date(`${iso(new Date())}T00:00:00Z`)
    from = new Date(to.getTime() - n * 864e5)
  }
  const days: string[] = []
  for (let d = to; d >= from; d = new Date(d.getTime() - 864e5)) days.push(iso(d)) // newest first
  return days
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  const started = Date.now()
  try {
    const body = await req.json().catch(() => ({}))
    const { client_id } = body
    if (!client_id) return json({ error: 'client_id je obavezan' }, 400)

    const { data: sources, error: sourcesError } = await supabase
      .from('data_sources').select('id, windsor_connection_id')
      .eq('client_id', client_id).eq('provider', 'google_ads').not('windsor_connection_id', 'is', null)
    if (sourcesError) throw sourcesError
    if (!sources || sources.length === 0) return json({ error: 'Nema Google Ads konekcije' }, 404)

    const days = daysFor(body)
    const results = []
    const skipped: string[] = []
    for (const source of sources) {
      const rawAccountId = source.windsor_connection_id.includes('__') ? source.windsor_connection_id.split('__')[1] : source.windsor_connection_id
      let rowsTotal = 0
      const errors: string[] = []
      for (const day of days) {
        if (Date.now() - started > TIME_BUDGET_MS) { skipped.push(`${source.windsor_connection_id}:${day}`); continue }
        const params = new URLSearchParams({
          date_from: day, date_to: day, api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
          fields: 'date,campaign,search_term,impressions,clicks,spend,conversions',
        })
        const res = await fetch(`https://connectors.windsor.ai/google_ads?${params.toString()}`)
        if (!res.ok) { errors.push(`${day}: HTTP ${res.status}`); continue }
        const rows = (((await res.json()).data ?? []) as Record<string, unknown>[])
          .filter((r) => r.search_term)
          .map((r) => ({
            client_id, data_source_id: source.id, report_date: r.date ?? day, campaign: r.campaign,
            search_term: r.search_term, impressions: r.impressions ?? 0, clicks: r.clicks ?? 0,
            spend: r.spend ?? 0, conversions: r.conversions ?? 0,
          }))
        // An empty answer for a day is not proof the day is empty; keep what is stored.
        if (rows.length === 0) continue
        const { error: delErr } = await supabase.from('google_ads_search_terms').delete().eq('data_source_id', source.id).eq('report_date', day)
        if (delErr) { errors.push(`${day}: ${delErr.message}`); continue }
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
          const { error: insErr } = await supabase.from('google_ads_search_terms').insert(rows.slice(i, i + INSERT_BATCH))
          if (insErr) { errors.push(`${day}: ${insErr.message}`); break }
        }
        rowsTotal += rows.length
      }
      await supabase.from('data_sources').update({ status: 'active', last_synced_at: new Date().toISOString() }).eq('id', source.id)
      results.push({ source: source.windsor_connection_id, rows: rowsTotal, ...(errors.length ? { errors } : {}) })
    }
    const failed = results.some((r) => 'errors' in r) || skipped.length > 0
    return json({ ok: !failed, results, ...(skipped.length ? { skipped_days: skipped } : {}) }, failed ? 500 : 200)
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
