import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!
const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY') ?? ''
const MODEL = 'claude-sonnet-5'
const sb = createClient(SUPABASE_URL, SERVICE)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const strip = (s: string) =>
  s.toLowerCase().replace(/[čć]/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/đ/g, 'dj')

function tokensOf(theme: string): string[] {
  const stop = new Set(['outlet', 'sale', 'akcija', 'brand', 'generic', 'search', 'kampanja', 'online'])
  return [...new Set(strip(theme).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !stop.has(t)))].slice(0, 5)
}

async function windsorAds(accountId: string) {
  if (!WINDSOR_API_KEY) return []
  const fields = [
    'campaign', 'ad_group_ad_ad_final_urls', 'ad_responsive_search_ad_headlines_combined_text',
    'ad_responsive_search_ad_descriptions_combined_text', 'clicks', 'conversions',
  ].join(',')
  const url = `https://connectors.windsor.ai/google_ads?date_preset=last_30d&fields=${fields}&select_accounts=${accountId}&api_key=${WINDSOR_API_KEY}`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(45000) })
    const j = await r.json()
    return (j.data ?? j ?? []) as Record<string, string>[]
  } catch (_e) {
    return []
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
    const { data: u, error: ue } = await sb.auth.getUser(jwt)
    if (ue || !u?.user) return json({ error: 'Niste ulogovani' }, 401)

    const { client_id, theme, ct, market, extra } = await req.json()
    if (!client_id || !theme) return json({ error: 'client_id i theme su obavezni' }, 400)
    const tokens = tokensOf(theme)

    // RLS check: user must be able to see this client
    const userSb = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    })
    const { data: cl } = await userSb.from('clients').select('id,name,ga4_store').eq('id', client_id).maybeSingle()
    if (!cl) return json({ error: 'Nemate pristup klijentu' }, 403)

    const { data: inputs, error: ie } = await sb.rpc('suggest_campaign_inputs', { p_client_id: client_id, p_tokens: tokens, p_days: 90 })
    if (ie) return json({ error: ie.message }, 500)

    const { data: ds } = await sb.from('data_sources').select('windsor_connection_id').eq('client_id', client_id).eq('provider', 'google_ads').limit(1)
    const accountId = ds?.[0]?.windsor_connection_id?.split('__')[1]
    let ads = accountId ? await windsorAds(accountId) : []
    const wantCt = ct ? String(ct) : ''
    const rel = ads.filter((a) => {
      const c = strip(a.campaign ?? '')
      return (!wantCt || (a.campaign ?? '').includes(wantCt)) && (tokens.length === 0 || tokens.some((t) => c.includes(t) || strip(a.ad_group_ad_ad_final_urls ?? '').includes(t)))
    })
    const pool = (rel.length ? rel : ads.filter((a) => !wantCt || (a.campaign ?? '').includes(wantCt)))
      .sort((a, b) => Number(b.conversions ?? 0) - Number(a.conversions ?? 0) || Number(b.clicks ?? 0) - Number(a.clicks ?? 0))
      .slice(0, 6)
    const adSamples = pool.map((a) => ({
      campaign: a.campaign,
      final_url: (() => { try { return JSON.parse(a.ad_group_ad_ad_final_urls)[0] } catch { return a.ad_group_ad_ad_final_urls } })(),
      headlines: a.ad_responsive_search_ad_headlines_combined_text,
      descriptions: a.ad_responsive_search_ad_descriptions_combined_text,
      conversions: a.conversions,
    }))

    // typical daily spend of similar campaigns (last 30d)
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
    const { data: m } = await sb.from('google_ads_metrics').select('campaign,spend,report_date').eq('client_id', client_id).gte('report_date', since).limit(5000)
    const byC: Record<string, { s: number; d: Set<string> }> = {}
    for (const r of m ?? []) {
      if (wantCt && !String(r.campaign).includes(wantCt)) continue
      const o = (byC[r.campaign] ??= { s: 0, d: new Set() })
      o.s += Number(r.spend); o.d.add(r.report_date)
    }
    const dailySpends = Object.entries(byC).map(([c, o]) => ({ campaign: c, avg_daily: +(o.s / Math.max(o.d.size, 1)).toFixed(2) }))
      .sort((a, b) => b.avg_daily - a.avg_daily).slice(0, 8)

    const tool = {
      name: 'fill_form',
      description: 'Popuni formu za novu Google Search kampanju',
      input_schema: {
        type: 'object',
        properties: {
          ad_group: { type: 'string' },
          final_url: { type: 'string' },
          path1: { type: 'string', description: 'max 15 znakova' },
          path2: { type: 'string', description: 'max 15 znakova' },
          daily_budget: { type: 'number' },
          headlines: { type: 'array', items: { type: 'string' }, description: '10-15 naslova, svaki max 30 znakova, razliciti' },
          descriptions: { type: 'array', items: { type: 'string' }, description: '3-4 opisa, svaki max 90 znakova' },
          keywords: { type: 'array', items: { type: 'string' }, description: '[exact], "phrase" ili bez navodnika' },
          negatives: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string', description: 'kratko na srpskom: na osnovu cega je predlog' },
        },
        required: ['ad_group', 'final_url', 'headlines', 'descriptions', 'keywords', 'negatives', 'rationale'],
      },
    }
    const prompt =
      `Klijent: ${cl.name}. Trziste: ${market ?? ''}. Tip: ${wantCt || 'Search'}. Tema nove kampanje: ${theme}.${extra ? ' Napomena: ' + extra : ''}\n\n` +
      `PODACI (poslednjih 90 dana, iz naloga):\n` +
      `Search terms koji se poklapaju sa temom (sortirano po konverzijama):\n${JSON.stringify(inputs.search_terms)}\n\n` +
      `Postojece keyword-e sa teme:\n${JSON.stringify(inputs.keywords)}\n\n` +
      `Search termi sa potrosnjom i 0 konverzija (kandidati za negative; uzmi samo one koji NISU relevantni za temu):\n${JSON.stringify(inputs.wasted_terms)}\n\n` +
      `Postojeci RSA oglasi slicnih kampanja (stil, final URL struktura):\n${JSON.stringify(adSamples)}\n\n` +
      `Prosecna dnevna potrosnja slicnih kampanja:\n${JSON.stringify(dailySpends)}\n\n` +
      `Pravila: pisi na srpskom (latinica) u stilu postojecih oglasa; koristi samo URL-ove koji se vide u podacima (najslicniji temi); ` +
      `ne izmisljaj popuste, cene ni rokove koji se ne vide u podacima; naslovi max 30 znakova, opisi max 90; ` +
      `keyword-e uzmi iz search terms/keyword-a koji konvertuju (pojedinacni keyword, ne cele recenice od 6+ reci); ` +
      `za Brand_Search drzi se samo brend termina; negatives samo nerelevantno za temu. Pozovi fill_form.`

    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 3000,
        system: 'Ti si PPC specijalista za agenciju. Pises predloge Search kampanja iskljucivo na osnovu podataka koje dobijes.',
        tools: [tool], tool_choice: { type: 'tool', name: 'fill_form' },
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!ar.ok) return json({ error: `Anthropic HTTP ${ar.status}: ${(await ar.text()).slice(0, 300)}` }, 502)
    const resp = await ar.json()
    const out = resp.content?.find((b: { type: string }) => b.type === 'tool_use')?.input
    if (!out) return json({ error: 'Model nije vratio predlog' }, 502)

    const uniq = (a: string[]) => [...new Set((a ?? []).map((s) => String(s).trim()).filter(Boolean))]
    const dropped: string[] = []
    const headlines = uniq(out.headlines).filter((h) => (h.length <= 30 ? true : (dropped.push(h), false))).slice(0, 15)
    const descriptions = uniq(out.descriptions).filter((d) => (d.length <= 90 ? true : (dropped.push(d), false))).slice(0, 4)
    return json({
      ad_group: out.ad_group, final_url: out.final_url,
      path1: String(out.path1 ?? '').slice(0, 15), path2: String(out.path2 ?? '').slice(0, 15),
      daily_budget: out.daily_budget ?? null,
      headlines, descriptions, keywords: uniq(out.keywords), negatives: uniq(out.negatives),
      rationale: out.rationale, dropped_too_long: dropped,
      meta: { tokens, ads_found: ads.length, ad_samples: adSamples.length, search_terms: inputs.search_terms.length, keywords: inputs.keywords.length, windsor_key: !!WINDSOR_API_KEY },
    })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
