import { createClient } from 'jsr:@supabase/supabase-js@2'

// YouTube video campaign drafts → Google Ads Editor CSV: one Paused Video campaign per draft with a
// campaign total budget and flight dates, one ad group and one responsive video ad.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (obj: unknown, status: number) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// NOTE: column names and values are not yet checked against a real Editor export of a video campaign.
// Adjust them here once a sample export is available; nothing else depends on the names.
const VIDEOS = Array.from({ length: 5 }, (_, i) => `Video ID ${i + 1}`)
const HEADLINES = Array.from({ length: 5 }, (_, i) => `Headline ${i + 1}`)
const LONG_HEADLINES = Array.from({ length: 5 }, (_, i) => `Long headline ${i + 1}`)
const DESCRIPTIONS = Array.from({ length: 5 }, (_, i) => `Description ${i + 1}`)
const HEADER = [
  'Campaign', 'Campaign type', 'Campaign subtype', 'Campaign status', 'Budget', 'Budget type', 'Start date', 'End date',
  'Bid strategy type', 'Target CPM', 'Max CPV', 'Networks', 'Languages', 'Location',
  'Ad group', 'Ad group status', 'Ad type', 'Status', 'Final URL', ...VIDEOS, ...HEADLINES, ...LONG_HEADLINES, ...DESCRIPTIONS, 'Call to action',
]
const GOAL = {
  reach: { subtype: 'Efficient reach', bid: 'Target CPM', bidCol: 'Target CPM' },
  views: { subtype: 'Video views', bid: 'Target CPV', bidCol: 'Max CPV' },
} as const

function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// deno-lint-ignore no-explicit-any
function rowsFor(d: any): Record<string, unknown>[] {
  const g = GOAL[d.goal as 'reach' | 'views']
  const campaign: Record<string, unknown> = {
    Campaign: d.campaign_name, 'Campaign type': 'Video', 'Campaign subtype': g.subtype, 'Campaign status': 'Paused',
    Budget: d.total_budget, 'Budget type': 'Campaign total', 'Start date': d.start_date, 'End date': d.end_date,
    'Bid strategy type': g.bid, [g.bidCol]: d.target_bid, Networks: 'YouTube',
    Languages: (d.languages ?? []).join(';'),
  }
  const rows: Record<string, unknown>[] = [campaign]
  for (const loc of d.locations ?? []) rows.push({ Campaign: d.campaign_name, Location: loc })
  rows.push({ Campaign: d.campaign_name, 'Ad group': d.ad_group_name, 'Ad group status': 'Paused' })
  const ad: Record<string, unknown> = {
    Campaign: d.campaign_name, 'Ad group': d.ad_group_name, 'Ad type': 'Responsive video ad', Status: 'Paused',
    'Final URL': d.final_url, 'Call to action': d.call_to_action,
  }
  ;(d.video_ids ?? []).slice(0, 5).forEach((v: string, i: number) => { ad[VIDEOS[i]] = v })
  ;(d.headlines ?? []).slice(0, 5).forEach((v: string, i: number) => { ad[HEADLINES[i]] = v })
  ;(d.long_headlines ?? []).slice(0, 5).forEach((v: string, i: number) => { ad[LONG_HEADLINES[i]] = v })
  ;(d.descriptions ?? []).slice(0, 5).forEach((v: string, i: number) => { ad[DESCRIPTIONS[i]] = v })
  rows.push(ad)
  return rows
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const auth = req.headers.get('Authorization') ?? ''
    const body = await req.json().catch(() => ({}))
    const { client_id, draft_ids } = body
    if (!client_id) return json({ error: 'client_id je obavezan' }, 400)

    // Caller's own JWT -> RLS decides which drafts are visible.
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } })
    let q = user.from('video_campaign_drafts').select('*').eq('client_id', client_id).in('status', ['draft', 'exported']).order('created_at')
    if (Array.isArray(draft_ids) && draft_ids.length) q = q.in('id', draft_ids)
    const { data: drafts, error } = await q
    if (error) throw error
    if (!drafts?.length) return json({ error: 'Nema video nacrta za izvoz (ili nemate pristup)' }, 404)

    const lines = [HEADER.join(',')]
    for (const d of drafts) for (const r of rowsFor(d)) lines.push(HEADER.map((h) => esc(r[h])).join(','))

    const ids = drafts.map((d) => d.id)
    const { error: upErr } = await user.from('video_campaign_drafts').update({ status: 'exported', exported_at: new Date().toISOString() }).in('id', ids)
    if (upErr) throw upErr
    const admin = createClient(SUPABASE_URL, SERVICE_KEY)
    await admin.from('automation_log').insert({ client_id, source: 'export-video-csv', action: 'export', target: `${ids.length} video kampanja`, new_value: { draft_ids: ids }, mode: 'suggest' })

    return new Response(lines.join('\r\n') + '\r\n', { headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8' } })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
