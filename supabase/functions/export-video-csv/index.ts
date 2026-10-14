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

// Columns and values as in Editor's export of the F&F BA account (2026-10-14): Target CPM campaigns
// with an "Efficient reach" ad group, Target CPV campaigns with a "Responsive video" ad group; the bid
// sits on the ad group; the ad is a "Responsive video ad" with "Call to action 1".
const VIDEOS = Array.from({ length: 5 }, (_, i) => `Video ID ${i + 1}`)
const HEADLINES = Array.from({ length: 5 }, (_, i) => `Headline ${i + 1}`)
const LONG_HEADLINES = Array.from({ length: 5 }, (_, i) => `Long headline ${i + 1}`)
const DESCRIPTIONS = Array.from({ length: 5 }, (_, i) => `Description ${i + 1}`)
const HEADER = [
  'Campaign', 'Campaign Type', 'Networks', 'Budget', 'Budget type', 'Bid Strategy Type', 'Start Date', 'End Date', 'Languages', 'Location',
  'Ad Group', 'Ad Group Type', 'Target CPM', 'Target CPV', 'Ad type', 'Ad Name', 'Final URL', ...VIDEOS, ...HEADLINES, ...LONG_HEADLINES, ...DESCRIPTIONS,
  'Call to action 1', 'Campaign Status', 'Ad Group Status', 'Status',
]
const GOAL = {
  reach: { bid: 'Target CPM', groupType: 'Efficient reach', bidCol: 'Target CPM' },
  views: { bid: 'Target CPV', groupType: 'Responsive video', bidCol: 'Target CPV' },
} as const

function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// deno-lint-ignore no-explicit-any
function rowsFor(d: any): Record<string, unknown>[] {
  const g = GOAL[d.goal as 'reach' | 'views']
  const rows: Record<string, unknown>[] = [{
    Campaign: d.campaign_name, 'Campaign Type': 'Video', Networks: 'YouTube Search;YouTube Videos;Video Partners',
    Budget: d.total_budget, 'Budget type': 'Campaign total', 'Bid Strategy Type': g.bid, 'Start Date': d.start_date, 'End Date': d.end_date,
    Languages: (d.languages ?? []).join(';') || 'All', 'Campaign Status': 'Paused',
  }]
  for (const loc of d.locations ?? []) rows.push({ Campaign: d.campaign_name, Location: loc })
  rows.push({ Campaign: d.campaign_name, 'Ad Group': d.ad_group_name, 'Ad Group Type': g.groupType, [g.bidCol]: d.target_bid, 'Ad Group Status': 'Paused' })
  const ad: Record<string, unknown> = {
    Campaign: d.campaign_name, 'Ad Group': d.ad_group_name, 'Ad type': 'Responsive video ad', 'Ad Name': d.title, Status: 'Paused',
    'Final URL': d.final_url, 'Call to action 1': d.call_to_action,
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
