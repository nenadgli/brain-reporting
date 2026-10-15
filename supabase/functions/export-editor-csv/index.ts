import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (obj: unknown, status: number) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Column names and values as in Google Ads Editor's exports of the F&F BA (2026-10-14) and F&F RS (2026-10-15) accounts.
// New Search campaigns get the team's usual settings: Google search + Search Partners (no Display), the market's
// country by presence, all languages, broad match off, the EU political ads declaration and the action's dates.
// Image assets are not part of Editor's CSV (ads have no image columns); they travel in the
// images/ folder of the package and are added in Editor by hand.
const HEADLINES = Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`)
const DESCRIPTIONS = Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`)
const SETTINGS = ['Networks', 'EU political ads', 'Languages', 'Bid Strategy Type', 'Start Date', 'End Date', 'Broad match keywords', 'Targeting method', 'Exclusion method']
const HEADER = ['Campaign', 'Campaign Type', 'Budget', 'Budget type', ...SETTINGS, 'Location', 'Ad Group', 'Ad type', ...HEADLINES, ...DESCRIPTIONS, 'Final URL', 'Path 1', 'Path 2', 'Keyword', 'Criterion Type', 'Shared set name', 'Shared set type', 'Campaign Status', 'Ad Group Status', 'Status']
// Editor location names for the "(Mkt:XX;" part of Brain's campaign names.
const COUNTRY: Record<string, string> = { RS: 'Serbia', HR: 'Croatia', BA: 'Bosnia and Herzegovina', ME: 'Montenegro', SI: 'Slovenia', AL: 'Albania', MK: 'North Macedonia', XK: 'Kosovo', DE: 'Germany' }
const KIND_ORDER = ['campaign', 'ad_group', 'rsa', 'keyword', 'negative_keyword']

function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function rowsFor(d: Record<string, any>): Record<string, unknown>[] {
  const p = d.payload ?? {}
  const base: Record<string, unknown> = { Campaign: d.campaign_name, 'Ad Group': d.ad_group_name ?? '' }
  switch (d.kind) {
    case 'campaign': {
      const country = COUNTRY[String(d.campaign_name).match(/\(Mkt:([A-Z]{2})/)?.[1] ?? '']
      return [{
        Campaign: d.campaign_name, 'Campaign Type': p.campaign_type ?? 'Search', Budget: p.daily_budget ?? '', 'Budget type': 'Daily',
        Networks: 'Google search;Search Partners', 'EU political ads': "Doesn't have EU political ads", Languages: 'All',
        'Bid Strategy Type': 'Maximize conversion value', 'Start Date': p.start_date ?? '', 'End Date': p.end_date ?? '', 'Broad match keywords': 'Off',
        'Targeting method': 'Location of presence', 'Exclusion method': 'Location of presence', 'Campaign Status': 'Paused',
      }, ...(country ? [{ Campaign: d.campaign_name, Location: country }] : []),
      // Existing shared negative lists the campaign is attached to (copied from another campaign); the list itself is not changed.
      ...((p.shared_sets ?? []) as string[]).map((name) => ({ Campaign: d.campaign_name, 'Shared set name': name, 'Shared set type': 'Shared negative keyword list', Status: 'Enabled' }))]
    }
    case 'ad_group':
      return [{ ...base, 'Ad Group Status': 'Paused' }]
    case 'rsa': {
      const r: Record<string, unknown> = { ...base, 'Ad type': 'Responsive search ad', 'Final URL': p.final_url, 'Path 1': p.path1, 'Path 2': p.path2, Status: 'Paused' }
      ;(p.headlines ?? []).slice(0, 15).forEach((h: string, i: number) => { r[HEADLINES[i]] = h })
      ;(p.descriptions ?? []).slice(0, 4).forEach((x: string, i: number) => { r[DESCRIPTIONS[i]] = x })
      return [r]
    }
    case 'keyword':
      return [{ ...base, Keyword: p.keyword, 'Criterion Type': p.match_type ?? 'Phrase', Status: 'Enabled' }]
    case 'negative_keyword':
      // Campaign-level negative: no ad group, "Campaign Negative <match>" as in Editor's export.
      return [{ Campaign: d.campaign_name, Keyword: p.keyword, 'Criterion Type': 'Campaign Negative ' + (p.match_type ?? 'Phrase'), Status: 'Enabled' }]
    default:
      return []
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const auth = req.headers.get('Authorization') ?? ''
    const body = await req.json().catch(() => ({}))
    const { client_id, draft_ids } = body
    if (!client_id) return json({ error: 'client_id je obavezan' }, 400)

    // Caller's own JWT -> RLS decides which drafts are visible (anon key sees nothing).
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } })
    let q = user.from('automation_drafts').select('*').eq('client_id', client_id).in('status', ['draft', 'approved', 'exported']).order('created_at')
    if (Array.isArray(draft_ids) && draft_ids.length) q = q.in('id', draft_ids)
    const { data: drafts, error } = await q
    if (error) throw error
    if (!drafts || drafts.length === 0) return json({ error: 'Nema nacrta za izvoz (ili nemate pristup)' }, 404)

    drafts.sort((a: any, b: any) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    const lines = [HEADER.join(',')]
    const exported: string[] = []
    for (const d of drafts) {
      if (!String(d.campaign_name).startsWith('LB_')) continue // safety: only system-owned campaigns
      const rows = rowsFor(d)
      if (!rows.length) continue
      for (const r of rows) lines.push(HEADER.map((h) => esc(r[h])).join(','))
      exported.push(d.id)
    }
    if (exported.length === 0) return json({ error: 'Nijedan nacrt nije validan za izvoz' }, 422)

    const now = new Date().toISOString()
    const { error: upErr } = await user.from('automation_drafts').update({ status: 'exported', exported_at: now }).in('id', exported).neq('status', 'published')
    if (upErr) throw upErr
    const admin = createClient(SUPABASE_URL, SERVICE_KEY)
    await admin.from('automation_log').insert({ client_id, source: 'export-editor-csv', action: 'export', target: `${exported.length} redova`, new_value: { draft_ids: exported }, mode: 'suggest' })

    return new Response(lines.join('\r\n') + '\r\n', { headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8' } })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
