import { createClient } from 'jsr:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

// Kvartalno osvežavanje Search oglasa. action "draft": for each chosen responsive search ad Claude
// writes replacements for the headlines and descriptions Google labels LOW and fills the ad up to
// 15 headlines and 4 descriptions, in the ad's own language and style, from its best assets and the
// campaign's search terms. Assets that are not LOW are kept with their pins. Every text is checked
// here (length, duplicates, competitors, numbers that are not in the current ad). action "export":
// Google Ads Editor CSV with each refreshed ad as a new Paused ad in the same ad group; the team
// enables it and pauses the old one. Nothing is changed in any account.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MODEL = 'claude-opus-5-5'
const sb = createClient(SUPABASE_URL, SERVICE)
const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

type Asset = { text: string; label: string | null; pin: number | null }
type Out = { text: string; pin: number | null; source: 'kept' | 'new'; replaces: string | null }
const MAX_H = 15, MAX_D = 4, LEN_H = 30, LEN_D = 90

// Google counts a keyword insertion by its default text.
const visible = (s: string) => s.replace(/\{key[wW]ord:([^}]*)\}/gi, '$1')
const norm = (s: string) => visible(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const numbersIn = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) => x.replace(',', '.'))

const SCHEMA = {
  type: 'object',
  properties: {
    headlines: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, replaces: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['text', 'replaces'], additionalProperties: false } },
    descriptions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, replaces: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['text', 'replaces'], additionalProperties: false } },
    rationale: { type: 'string', description: 'jedna do dve rečenice na srpskom: šta je promenjeno i šta proveriti' },
  },
  required: ['headlines', 'descriptions', 'rationale'],
  additionalProperties: false,
}
const SYSTEM =
  'Ti si iskusan copywriter za Google Search oglase u agenciji Loft19. Pišeš nove naslove i opise za postojeći responzivni oglas. ' +
  'Piši na istom jeziku i istoj varijanti kao postojeći oglas (npr. ijekavica „cijene“ ako je oglas tako napisan), istim stilom velikih slova, sa svim dijakritičkim znacima. ' +
  'Naslov najviše 30 znakova, opis najviše 90 znakova, računajući razmake. Svaki tekst mora biti drugačiji od postojećih i od ostalih novih. ' +
  'Ne pominji konkurente. Ne izmišljaj popuste, cene, rokove dostave ni druge brojeve; broj sme samo ako postoji u postojećem oglasu. ' +
  'Koristi teme iz pretraga koje donose klikove i konverzije i ton najboljih (BEST) asseta. Ne koristi uzvičnike u naslovima.'

async function auth(req: Request) {
  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const { data: u, error } = await sb.auth.getUser(jwt)
  if (error || !u?.user) return null
  const { data: au } = await sb.from('app_users').select('agency_id, client_id').eq('id', u.user.id).maybeSingle()
  if (!au?.agency_id || au.client_id) return null
  return { id: u.user.id, agency_id: au.agency_id as string }
}

// deno-lint-ignore no-explicit-any
async function draftOne(clientId: string, ad: any, params: Record<string, unknown>, terms: string[], userId: string) {
  const heads = (ad.headlines ?? []) as Asset[]
  const descs = (ad.descriptions ?? []) as Asset[]
  const lowH = heads.filter((a) => a.label === 'LOW')
  const lowD = descs.filter((a) => a.label === 'LOW')
  const keptH = heads.filter((a) => a.label !== 'LOW')
  const keptD = descs.filter((a) => a.label !== 'LOW')
  const needH = Math.max(0, MAX_H - keptH.length)
  const needD = Math.max(0, MAX_D - keptD.length)
  if (!needH && !needD) return { ad_id: ad.ad_id, skipped: 'Oglas već ima 15 naslova i 4 opisa bez LOW asseta.' }

  const competitors = ((params.competitors ?? []) as string[]).map((c) => String(c).toLowerCase()).filter(Boolean)
  const prompt = [
    `Kampanja: ${ad.campaign}. Grupa oglasa: ${ad.ad_group}. Odredišna stranica: ${ad.final_url}. Putanja: ${[ad.path1, ad.path2].filter(Boolean).join('/')}.`,
    `Ad Strength: ${ad.ad_strength}. Brendovi koje klijent prodaje: ${JSON.stringify(params.brands_sold ?? [])}. Konkurenti (ne pominjati): ${JSON.stringify(params.competitors ?? [])}.`,
    'Postojeći naslovi (label = Google ocena; LOW se menja, ostali ostaju):',
    JSON.stringify(heads.map((a) => ({ text: a.text, label: a.label, pin: a.pin }))),
    'Postojeći opisi:',
    JSON.stringify(descs.map((a) => ({ text: a.text, label: a.label, pin: a.pin }))),
    `Pretrage sa najviše klikova i konverzija u ovoj kampanji (30 dana): ${JSON.stringify(terms)}`,
    `Napiši tačno ${needH} novih naslova i ${needD} novih opisa. Za svaki novi tekst koji menja LOW asset, u "replaces" upiši tačan tekst asseta koji menja; ostali imaju replaces null.`,
    lowH.length || lowD.length ? `LOW naslovi: ${JSON.stringify(lowH.map((a) => a.text))}; LOW opisi: ${JSON.stringify(lowD.map((a) => a.text))}.` : 'Nema LOW asseta; samo dopuni oglas.',
  ].join('\n')

  const resp = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 6000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  // deno-lint-ignore no-explicit-any
  } as any)
  if (resp.stop_reason === 'refusal') throw new Error('Model je odbio zahtev')
  const text = resp.content.find((c: { type: string }) => c.type === 'text') as { text: string } | undefined
  if (!text) throw new Error('Model nije vratio odgovor')
  const out = JSON.parse(text.text) as { headlines: { text: string; replaces: string | null }[]; descriptions: { text: string; replaces: string | null }[]; rationale: string }

  // Numbers allowed in new texts: only those already in this ad.
  const allowedNums = new Set([...heads, ...descs].flatMap((a) => numbersIn(visible(a.text))))
  const dropped: string[] = []
  function build(kept: Asset[], low: Asset[], fresh: { text: string; replaces: string | null }[], max: number, len: number): Out[] {
    const res: Out[] = kept.map((a) => ({ text: a.text, pin: a.pin, source: 'kept', replaces: null }))
    const seen = new Set([...kept, ...low].map((a) => norm(a.text)))
    const lowLeft = new Map(low.map((a) => [a.text, a]))
    for (const f of fresh ?? []) {
      const t = String(f.text ?? '').trim().replace(/\s+/g, ' ')
      const why = !t ? 'prazno' : visible(t).length > len ? `predugačko (${visible(t).length})`
        : seen.has(norm(t)) ? 'ponavlja postojeći tekst'
        : competitors.some((c) => c.length > 2 && t.toLowerCase().includes(c)) ? 'pominje konkurenta'
        : numbersIn(visible(t)).some((n) => !allowedNums.has(n)) ? 'broj kog nema u oglasu' : ''
      if (why) { dropped.push(`${t} (${why})`); continue }
      if (res.length >= max) break
      const old = f.replaces && lowLeft.get(f.replaces)
      if (old) lowLeft.delete(f.replaces!)
      res.push({ text: t, pin: old ? old.pin : null, source: 'new', replaces: old ? old.text : null })
      seen.add(norm(t))
    }
    return res
  }
  const headlines = build(keptH, lowH, out.headlines, MAX_H, LEN_H)
  const descriptions = build(keptD, lowD, out.descriptions, MAX_D, LEN_D)
  // A pinned LOW asset whose replacement was dropped leaves its position empty; keep the old text there.
  for (const [list, low, max] of [[headlines, lowH, MAX_H], [descriptions, lowD, MAX_D]] as const) {
    for (const a of low) {
      if (!a.pin || list.some((x) => x.pin === a.pin)) continue
      if (list.length >= max) {
        const i = list.map((x) => x.source === 'new' && !x.pin).lastIndexOf(true)
        if (i < 0) continue
        list.splice(i, 1)
      }
      list.push({ text: a.text, pin: a.pin, source: 'kept', replaces: null })
    }
  }
  const added = headlines.filter((x) => x.source === 'new').length + descriptions.filter((x) => x.source === 'new').length
  if (!added) return { ad_id: ad.ad_id, skipped: `Nijedan predlog nije prošao proveru${dropped.length ? `: ${dropped.slice(0, 3).join('; ')}` : ''}.` }

  const reasons = [
    ['POOR', 'AVERAGE'].includes(ad.ad_strength) ? 'ad_strength' : null,
    lowH.length + lowD.length ? 'low_assets' : null,
    heads.length < 10 || descs.length < 4 ? 'malo_asseta' : null,
  ].filter(Boolean) as string[]
  const { data: saved, error } = await sb.from('rsa_refresh_drafts').insert({
    client_id: clientId, ad_id: ad.ad_id, campaign: ad.campaign, ad_group: ad.ad_group, final_url: ad.final_url,
    path1: ad.path1, path2: ad.path2, headlines, descriptions, reasons,
    rationale: [out.rationale, dropped.length ? `Odbačeno pri proveri: ${dropped.join('; ')}.` : ''].filter(Boolean).join(' '),
    created_by: userId,
  }).select('*').single()
  if (error) throw error
  return { ad_id: ad.ad_id, draft: saved }
}

const HEAD = Array.from({ length: MAX_H }, (_, i) => `Headline ${i + 1}`)
const HPOS = Array.from({ length: MAX_H }, (_, i) => `Headline ${i + 1} position`)
const DESC = Array.from({ length: MAX_D }, (_, i) => `Description ${i + 1}`)
const DPOS = Array.from({ length: MAX_D }, (_, i) => `Description ${i + 1} position`)
// Column names as in Google Ads Editor's export of the F&F BA account (2026-10-14).
const HEADER = ['Campaign', 'Ad Group', 'Ad type', ...HEAD, ...HPOS, ...DESC, ...DPOS, 'Path 1', 'Path 2', 'Final URL', 'Status']
const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const user = await auth(req)
    if (!user) return json({ error: 'Samo ulogovani korisnici agencije' }, 403)
    const body = await req.json().catch(() => ({}))
    const clientId = String(body.client_id ?? '')
    const { data: client } = await sb.from('clients').select('id, name, agency_id').eq('id', clientId).maybeSingle()
    if (!client || client.agency_id !== user.agency_id) return json({ error: 'Klijent nije pronađen' }, 404)

    if (body.action === 'draft') {
      const ids = (Array.isArray(body.ad_ids) ? body.ad_ids : []).map(String).slice(0, 5)
      if (!ids.length) return json({ error: 'Izaberi do 5 oglasa' }, 400)
      const { data: last } = await sb.from('google_search_ads').select('snapshot_date').eq('client_id', clientId).order('snapshot_date', { ascending: false }).limit(1)
      if (!last?.length) return json({ error: 'Za ovog klijenta još nema sinhronizovanih Search oglasa' }, 404)
      const { data: ads, error } = await sb.from('google_search_ads').select('*').eq('client_id', clientId).eq('snapshot_date', last[0].snapshot_date).in('ad_id', ids)
      if (error) throw error
      const { data: rs } = await sb.from('review_settings').select('params').eq('client_id', clientId).maybeSingle()
      const params = (rs?.params ?? {}) as Record<string, unknown>
      const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
      const results = await Promise.all((ads ?? []).map(async (ad) => {
        try {
          const { data: st } = await sb.from('google_ads_search_terms').select('search_term, clicks, conversions')
            .eq('client_id', clientId).eq('campaign', ad.campaign).gte('report_date', since).limit(5000)
          const agg = new Map<string, { c: number; v: number }>()
          for (const t of st ?? []) {
            const x = agg.get(t.search_term) ?? { c: 0, v: 0 }
            x.c += Number(t.clicks) || 0; x.v += Number(t.conversions) || 0
            agg.set(t.search_term, x)
          }
          const terms = [...agg.entries()].sort((a, b) => b[1].v - a[1].v || b[1].c - a[1].c).slice(0, 20).map(([k]) => k)
          return await draftOne(clientId, ad, params, terms, user.id)
        } catch (e) {
          return { ad_id: ad.ad_id, error: (e as Error).message }
        }
      }))
      return json({ ok: true, results })
    }

    if (body.action === 'export') {
      const ids = (Array.isArray(body.draft_ids) ? body.draft_ids : []).map(String)
      let q = sb.from('rsa_refresh_drafts').select('*').eq('client_id', clientId).in('status', ['draft', 'exported']).order('created_at')
      if (ids.length) q = q.in('id', ids)
      const { data: drafts, error } = await q
      if (error) throw error
      if (!drafts?.length) return json({ error: 'Nema nacrta za izvoz' }, 404)
      const lines = [HEADER.join(',')]
      for (const d of drafts) {
        const r: Record<string, unknown> = { Campaign: d.campaign, 'Ad Group': d.ad_group, 'Ad type': 'Responsive search ad', 'Path 1': d.path1, 'Path 2': d.path2, 'Final URL': d.final_url, Status: 'Paused' }
        ;(d.headlines as Out[]).slice(0, MAX_H).forEach((h, i) => { r[HEAD[i]] = h.text; if (h.pin) r[HPOS[i]] = h.pin })
        ;(d.descriptions as Out[]).slice(0, MAX_D).forEach((h, i) => { r[DESC[i]] = h.text; if (h.pin) r[DPOS[i]] = h.pin })
        lines.push(HEADER.map((h) => esc(r[h])).join(','))
      }
      const now = new Date().toISOString()
      const { error: ue } = await sb.from('rsa_refresh_drafts').update({ status: 'exported', exported_at: now }).in('id', drafts.map((d) => d.id))
      if (ue) throw ue
      await sb.from('automation_log').insert({ client_id: clientId, source: 'rsa-refresh', action: 'export', target: `${drafts.length} Search oglasa`, new_value: { draft_ids: drafts.map((d) => d.id) }, mode: 'suggest' })
      return json({ ok: true, count: drafts.length, csv: lines.join('\r\n') + '\r\n' })
    }

    return json({ error: 'Nepoznata akcija' }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
