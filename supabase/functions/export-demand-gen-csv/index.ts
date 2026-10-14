import { createClient } from 'jsr:@supabase/supabase-js@2'

// Demand Gen ad group drafts → Google Ads Editor CSV: one Paused ad group per draft in an existing
// Demand Gen campaign, with a multi-image ad and, when videos are given, a video ad.
// Images are referenced as images/<file>, packed next to the CSV.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (obj: unknown, status: number) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// NOTE: shared columns follow Editor's PMax export (Ad Group, Ad Group Status, Video ID n); the
// ad-type and image columns are not yet checked against an Editor export of a Demand Gen ad group.
const HEADLINES = Array.from({ length: 5 }, (_, i) => `Headline ${i + 1}`)
const LONG_HEADLINES = Array.from({ length: 5 }, (_, i) => `Long headline ${i + 1}`)
const DESCRIPTIONS = Array.from({ length: 5 }, (_, i) => `Description ${i + 1}`)
const HEADER = [
  'Campaign', 'Ad Group', 'Ad Group Status', 'Ad type', 'Status', 'Final URL',
  ...HEADLINES, ...LONG_HEADLINES, ...DESCRIPTIONS,
  'Business name', 'Call to action', 'Image', 'Square image', 'Portrait image', 'Logo', ...Array.from({ length: 5 }, (_, i) => `Video ID ${i + 1}`),
]
// Image field → CSV column.
const IMAGE_COLUMN: Record<string, string> = {
  MARKETING_IMAGE: 'Image',
  SQUARE_MARKETING_IMAGE: 'Square image',
  PORTRAIT_MARKETING_IMAGE: 'Portrait image',
  LOGO: 'Logo',
}

function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// deno-lint-ignore no-explicit-any
function rowsFor(d: any): Record<string, unknown>[] {
  const key = { Campaign: d.campaign_name, 'Ad Group': d.ad_group_name }
  const texts = (r: Record<string, unknown>, long: boolean) => {
    ;(d.headlines ?? []).slice(0, 5).forEach((h: string, i: number) => { r[HEADLINES[i]] = h })
    if (long) (d.long_headlines ?? []).slice(0, 5).forEach((h: string, i: number) => { r[LONG_HEADLINES[i]] = h })
    ;(d.descriptions ?? []).slice(0, 5).forEach((x: string, i: number) => { r[DESCRIPTIONS[i]] = x })
    return r
  }
  const common = { 'Final URL': d.final_url, 'Business name': d.business_name, 'Call to action': d.call_to_action, Status: 'Paused' }
  const rows: Record<string, unknown>[] = [{ ...key, 'Ad Group Status': 'Paused' }]
  const ad = texts({ ...key, ...common, 'Ad type': 'Demand Gen multi-image ad' }, false)
  // The first image of each kind goes on the ad row; the rest follow as rows of the same ad.
  const extra: Record<string, unknown>[] = []
  for (const img of d.images ?? []) {
    const col = IMAGE_COLUMN[img?.field]
    if (!col || !img.file || /[\\/]/.test(img.file)) continue
    if (ad[col] == null) ad[col] = `images/${img.file}`
    else extra.push({ ...key, 'Ad type': 'Demand Gen multi-image ad', [col]: `images/${img.file}` })
  }
  rows.push(ad, ...extra)
  if ((d.video_ids ?? []).length) {
    const logo = (d.images ?? []).find((i: { field?: string }) => i.field === 'LOGO')
    const video = texts({ ...key, ...common, 'Ad type': 'Demand Gen video ad', Logo: logo?.file ? `images/${logo.file}` : null }, true)
    d.video_ids.slice(0, 5).forEach((v: string, i: number) => { video[`Video ID ${i + 1}`] = v })
    rows.push(video)
  }
  return rows
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const auth = req.headers.get('Authorization') ?? ''
    const body = await req.json().catch(() => ({}))
    const { client_id, draft_ids } = body
    if (!client_id) return json({ error: 'client_id je obavezan' }, 400)

    // Caller's own JWT -> RLS decides which drafts and campaigns are visible.
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } })
    let q = user.from('demand_gen_drafts').select('*').eq('client_id', client_id).in('status', ['draft', 'exported']).order('created_at')
    if (Array.isArray(draft_ids) && draft_ids.length) q = q.in('id', draft_ids)
    const { data: drafts, error } = await q
    if (error) throw error
    if (!drafts?.length) return json({ error: 'Nema Demand Gen nacrta za izvoz (ili nemate pristup)' }, 404)

    // Safety: ad groups only go into Demand Gen campaigns that already exist for this client.
    const { data: camps, error: ce } = await user.rpc('demand_gen_campaigns', { p_client_id: client_id })
    if (ce) throw ce
    const known = new Set((camps ?? []).map((c: { campaign: string }) => c.campaign))
    const ok = drafts.filter((d) => known.has(d.campaign_name))
    if (!ok.length) return json({ error: 'Nijedan nacrt ne cilja postojeću Demand Gen kampanju ovog klijenta' }, 422)

    const lines = [HEADER.join(',')]
    for (const d of ok) for (const r of rowsFor(d)) lines.push(HEADER.map((h) => esc(r[h])).join(','))

    const ids = ok.map((d) => d.id)
    const { error: upErr } = await user.from('demand_gen_drafts').update({ status: 'exported', exported_at: new Date().toISOString() }).in('id', ids)
    if (upErr) throw upErr
    const admin = createClient(SUPABASE_URL, SERVICE_KEY)
    await admin.from('automation_log').insert({ client_id, source: 'export-demand-gen-csv', action: 'export', target: `${ids.length} Demand Gen ad grupa`, new_value: { draft_ids: ids }, mode: 'suggest' })

    return new Response(lines.join('\r\n') + '\r\n', { headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8' } })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
