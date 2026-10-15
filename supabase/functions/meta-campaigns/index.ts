import { createClient } from 'jsr:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

// Meta campaigns from Productive briefs, exported as an Ads Manager bulk import file (everything Paused).
// Actions: profile (how the client's recent campaigns are set up, from Windsor) | draft (ad copy per ad set).
// Only agency users may call it.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const sb = createClient(SUPABASE_URL, SERVICE)
const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
const MODEL = 'claude-opus-5-5'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const PROFILE_FIELDS = [
  'campaign', 'campaign_id', 'campaign_objective', 'campaign_status', 'campaign_daily_budget', 'campaign_lifetime_budget', 'campaign_bid_strategy',
  'adset_name', 'adset_id', 'adset_status', 'adset_targeting', 'adset_promoted_object', 'adsset_optimization_goal', 'adset_billing_event',
  'adset_bid_strategy', 'adset_destination_type', 'adset_start_time', 'adset_end_time', 'adset_daily_budget', 'adset_lifetime_budget',
  'ad_name', 'actor_id', 'instagram_actor_id', 'call_to_action_type', 'link_url', 'spend', 'impressions', 'reach',
].join(',')

// deno-lint-ignore no-explicit-any
const parse = (v: unknown): any => {
  if (typeof v !== 'string') return v ?? null
  try { return JSON.parse(v) } catch { return v }
}
// deno-lint-ignore no-explicit-any
const mostCommon = (vals: any[]) => {
  const m = new Map<string, number>()
  for (const v of vals) if (v != null && v !== '') m.set(String(v), (m.get(String(v)) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

async function profile(clientId: string, days: number) {
  const { data: sources, error } = await sb.from('data_sources').select('windsor_connection_id').eq('client_id', clientId).eq('provider', 'facebook').not('windsor_connection_id', 'is', null)
  if (error) throw error
  if (!sources?.length) return { error: 'Klijent nema Meta nalog u Windsoru' }
  const accountId = String(sources[0].windsor_connection_id).split('__').pop()!
  const to = new Date()
  const from = new Date(to.getTime() - days * 864e5)
  const params = new URLSearchParams({ api_key: WINDSOR_API_KEY, select_accounts: accountId, fields: PROFILE_FIELDS, date_from: from.toISOString().slice(0, 10), date_to: to.toISOString().slice(0, 10) })
  const r = await fetch(`https://connectors.windsor.ai/facebook?${params}`, { signal: AbortSignal.timeout(120000) })
  if (!r.ok) throw new Error(`Windsor HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
  // deno-lint-ignore no-explicit-any
  const rows: any[] = (await r.json()).data ?? []
  // One entry per ad set (rows come per ad), newest first.
  // deno-lint-ignore no-explicit-any
  const adsets = new Map<string, any>()
  for (const x of rows) {
    const key = String(x.adset_id ?? x.adset_name)
    const a = adsets.get(key) ?? {
      campaign: x.campaign, campaign_id: x.campaign_id, objective: x.campaign_objective, campaign_status: x.campaign_status,
      campaign_daily_budget: x.campaign_daily_budget, campaign_lifetime_budget: x.campaign_lifetime_budget, campaign_bid_strategy: x.campaign_bid_strategy,
      adset_name: x.adset_name, adset_id: x.adset_id, status: x.adset_status, targeting: parse(x.adset_targeting), promoted_object: parse(x.adset_promoted_object),
      optimization_goal: x.adsset_optimization_goal, billing_event: x.adset_billing_event, bid_strategy: x.adset_bid_strategy, destination_type: x.adset_destination_type,
      start_time: x.adset_start_time, end_time: x.adset_end_time, daily_budget: x.adset_daily_budget, lifetime_budget: x.adset_lifetime_budget,
      page_ids: [] as string[], instagram_ids: [] as string[], ctas: [] as string[], links: [] as string[], ads: [] as string[], spend: 0, impressions: 0, reach: 0,
    }
    if (x.actor_id) a.page_ids.push(String(x.actor_id))
    if (x.instagram_actor_id) a.instagram_ids.push(String(x.instagram_actor_id))
    if (x.call_to_action_type) a.ctas.push(String(x.call_to_action_type))
    if (x.link_url) a.links.push(String(x.link_url))
    if (x.ad_name && !a.ads.includes(x.ad_name)) a.ads.push(x.ad_name)
    a.spend += Number(x.spend) || 0
    a.impressions += Number(x.impressions) || 0
    a.reach += Number(x.reach) || 0
    adsets.set(key, a)
  }
  const list = [...adsets.values()].map((a) => ({
    ...a, page_id: mostCommon(a.page_ids), instagram_id: mostCommon(a.instagram_ids), cta: mostCommon(a.ctas), link: mostCommon(a.links),
    page_ids: undefined, instagram_ids: undefined, ctas: undefined, links: undefined,
  })).sort((x, y) => String(y.start_time ?? '').localeCompare(String(x.start_time ?? '')))
  return {
    account_id: accountId,
    defaults: {
      page_id: mostCommon(list.map((a) => a.page_id)),
      instagram_id: mostCommon(list.map((a) => a.instagram_id)),
      pixel_id: mostCommon(list.map((a) => a.promoted_object?.pixel_id)),
    },
    adsets: list,
  }
}

export const CTAS = ['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'GET_OFFER', 'BOOK_NOW', 'CONTACT_US', 'SUBSCRIBE', 'GET_DIRECTIONS', 'NO_BUTTON']

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    adsets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'tačno ime ad seta kako je dato' },
          primary_texts: { type: 'array', items: { type: 'string' }, description: '3-5 primarnih tekstova, preporuka do 125 znakova' },
          headlines: { type: 'array', items: { type: 'string' }, description: '3-5 naslova, preporuka do 40 znakova' },
          description: { type: 'string', description: 'opis ispod naslova, preporuka do 30 znakova' },
          cta: { type: 'string', enum: CTAS },
        },
        required: ['name', 'primary_texts', 'headlines', 'description', 'cta'],
        additionalProperties: false,
      },
    },
    rationale: { type: 'string', description: 'kratko na srpskom: odakle je copy uzet i šta treba proveriti' },
  },
  required: ['adsets', 'rationale'],
  additionalProperties: false,
}

// deno-lint-ignore no-explicit-any
async function draft(body: any) {
  const b = body.brief ?? {}
  const adsets = (Array.isArray(body.adsets) ? body.adsets : []).map((a: { name?: string; note?: string }) => ({ name: String(a.name ?? '').trim(), napomena: a.note ?? null })).filter((a: { name: string }) => a.name)
  if (!adsets.length) return { error: 'Dodaj bar jedan ad set' }
  const facts = {
    naziv_akcije: b.headline, trajanje: b.duration_text, popust: b.discount, odnosi_se_na: b.applies_to, iskljucuje: b.excludes,
    vazi_i_u_radnjama: b.in_stores, landing_page: b.landing_page, copy_iz_briefa: b.copy, legal_line: b.legal_line,
    odobreno_u_komentarima: Array.isArray(b.approved_copy) && b.approved_copy.length ? b.approved_copy : undefined,
    odobreni_copy_iz_sheeta: body.sheet_copy ? String(body.sheet_copy).slice(0, 20000) : undefined,
  }
  const prompt =
    `Napravi tekstove za Meta oglase (Facebook i Instagram) za akciju klijenta ${body.client_name ?? ''} (tržište ${body.market ?? ''}, cilj kampanje ${body.objective ?? ''}).\n\n` +
    `AD SETOVI (za svaki posebno):\n${JSON.stringify(adsets, null, 2)}\n\n` +
    `BRIEF AKCIJE (jedini izvor činjenica):\n${JSON.stringify(facts, null, 2)}\n\n` +
    'Pravila:\n' +
    '- Ako postoji odobreni copy (iz sheeta, komentara ili briefa), preuzmi ga DOSLOVNO, slovo po slovo, za odgovarajući ad set (npr. kolona ili blok za Beograd ide u ad set za Beograd). Ne skraćuj ga i ne prepravljaj, čak ni kad je duži od preporuke.\n' +
    '- Novo piši samo za ono što nedostaje (npr. nema opisa ili CTA), u tonu odobrenog copy-ja.\n' +
    '- Piši na jeziku tržišta (RS srpski latinica; HR hrvatski; ME/BA ijekavica). Ne izmišljaj popuste, datume, adrese ni brendove.\n' +
    '- Poštuj legal line i izuzetke (npr. brend koji se ne odnosi). Novije odobrenje važi pre starijeg.\n' +
    '- CTA izaberi prema cilju i linku (npr. SIGN_UP za učlanjenje, SHOP_NOW za kupovinu, GET_DIRECTIONS za dolazak u radnju, LEARN_MORE kad nije jasno).'
  const resp = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
    system: 'Ti si specijalista za Meta oglase u agenciji. Pišeš oglase isključivo na osnovu briefa i odobrenog copy-ja koji dobiješ.',
    messages: [{ role: 'user', content: prompt }],
  // deno-lint-ignore no-explicit-any
  } as any)
  if (resp.stop_reason === 'refusal') return { error: 'Model je odbio zahtev' }
  const text = resp.content.find((c: { type: string }) => c.type === 'text') as { text: string } | undefined
  if (!text) return { error: 'Model nije vratio predlog' }
  const out = JSON.parse(text.text)
  const uniq = (a: string[]) => [...new Set((a ?? []).map((s) => String(s).trim()).filter(Boolean))]
  return {
    // deno-lint-ignore no-explicit-any
    adsets: (out.adsets ?? []).map((a: any) => ({ name: a.name, primary_texts: uniq(a.primary_texts).slice(0, 5), headlines: uniq(a.headlines).slice(0, 5), description: String(a.description ?? '').trim(), cta: CTAS.includes(a.cta) ? a.cta : 'LEARN_MORE' })),
    rationale: out.rationale, served_by: resp.model,
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const internal = req.headers.get('x-internal-key')
    if (internal) {
      const { data: secret } = await sb.from('integration_secrets').select('value').eq('name', 'feedhub_briefs_key').maybeSingle()
      if (!secret || internal !== secret.value) return json({ error: 'Pogrešan interni ključ' }, 403)
    } else {
      const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
      const { data: u, error: ue } = await sb.auth.getUser(jwt)
      if (ue || !u?.user) return json({ error: 'Niste ulogovani' }, 401)
      const { data: au } = await sb.from('app_users').select('agency_id, client_id').eq('id', u.user.id).maybeSingle()
      if (!au?.agency_id || au.client_id) return json({ error: 'Samo korisnici agencije' }, 403)
    }
    const body = await req.json().catch(() => ({}))
    const action = body.action ?? 'profile'
    if (action === 'profile') {
      if (!body.client_id) return json({ error: 'client_id je obavezan' }, 400)
      const out = await profile(String(body.client_id), Math.min(Number(body.days) || 60, 180))
      return json(out, 'error' in out ? 404 : 200)
    }
    if (action === 'draft') {
      const out = await draft(body)
      return json(out, 'error' in out ? 400 : 200)
    }
    return json({ error: `Nepoznata akcija ${action}` }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
