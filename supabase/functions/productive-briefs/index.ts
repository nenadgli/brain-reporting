import { createClient } from 'jsr:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

// Productive "akcija" briefs (via Feed Hub) → Search campaign drafts in the Nove kampanje form.
// Actions: projects | briefs | refresh | attachments | comments | file_urls | draft | draft_pmax | draft_demand_gen | draft_video | draft_display. Only agency users may call it.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const FEEDHUB_URL = 'https://bagpjjejeuteojpsufto.supabase.co/functions/v1/export-campaign-briefs'
const MODEL = 'claude-opus-5-5'
const sb = createClient(SUPABASE_URL, SERVICE)
const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

async function feedhub(body: Record<string, unknown>, timeoutMs = 30000) {
  const { data: secret } = await sb.from('integration_secrets').select('value').eq('name', 'feedhub_briefs_key').maybeSingle()
  if (!secret) throw new Error('Nedostaje ključ za Feed Hub')
  const r = await fetch(FEEDHUB_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': secret.value },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await r.json().catch(() => ({ error: `Feed Hub HTTP ${r.status}` }))
  if (!r.ok || j.error) throw new Error(j.error ?? `Feed Hub HTTP ${r.status}`)
  return j
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    theme: { type: 'string', description: 'kratak naziv kampanje iz naziva akcije, 2-4 reci, bez datuma' },
    ad_group: { type: 'string' },
    path1: { type: 'string', description: 'max 15 znakova' },
    path2: { type: 'string', description: 'max 15 znakova' },
    headlines: { type: 'array', items: { type: 'string' }, description: '12-15 razlicitih naslova, svaki max 30 znakova' },
    descriptions: { type: 'array', items: { type: 'string' }, description: '4 opisa, svaki max 90 znakova' },
    keywords: { type: 'array', items: { type: 'string' }, description: 'kljucne reci: [exact] ili "phrase"' },
    rationale: { type: 'string', description: 'kratko na srpskom: sta je uzeto iz briefa i sta treba proveriti' },
  },
  required: ['theme', 'ad_group', 'path1', 'path2', 'headlines', 'descriptions', 'keywords', 'rationale'],
  additionalProperties: false,
}

const PMAX_SCHEMA = {
  type: 'object',
  properties: {
    headlines: { type: 'array', items: { type: 'string' }, description: '8-15 naslova, svaki max 30 znakova; bar dva max 15 znakova' },
    long_headlines: { type: 'array', items: { type: 'string' }, description: '3-5 dugih naslova, svaki max 90 znakova' },
    descriptions: { type: 'array', items: { type: 'string' }, description: '4-5 opisa, svaki max 90 znakova; bar jedan max 60 znakova' },
    search_themes: { type: 'array', items: { type: 'string' }, description: 'do 15 tema pretrage (kako ljudi traze ovu ponudu), svaka max 80 znakova' },
    rationale: { type: 'string', description: 'kratko na srpskom: sta je uzeto iz briefa i sta treba proveriti' },
  },
  required: ['headlines', 'long_headlines', 'descriptions', 'search_themes', 'rationale'],
  additionalProperties: false,
}

const DEMAND_GEN_SCHEMA = {
  type: 'object',
  properties: {
    headlines: { type: 'array', items: { type: 'string' }, description: '5 naslova, svaki max 40 znakova' },
    long_headlines: { type: 'array', items: { type: 'string' }, description: '3-5 dugih naslova za video oglas, svaki max 90 znakova' },
    descriptions: { type: 'array', items: { type: 'string' }, description: '5 opisa, svaki max 90 znakova' },
    rationale: { type: 'string', description: 'kratko na srpskom: sta je uzeto iz briefa i sta treba proveriti' },
  },
  required: ['headlines', 'long_headlines', 'descriptions', 'rationale'],
  additionalProperties: false,
}

// Limits of the responsive video ad (Editor's export shows 30-character headlines and 90-character descriptions).
const VIDEO_SCHEMA = {
  type: 'object',
  properties: {
    headlines: { type: 'array', items: { type: 'string' }, description: '5 kratkih naslova, svaki max 30 znakova' },
    long_headlines: { type: 'array', items: { type: 'string' }, description: '3-5 dugih naslova, svaki max 90 znakova' },
    descriptions: { type: 'array', items: { type: 'string' }, description: '3-5 opisa, svaki max 90 znakova' },
    call_to_action: { type: 'string', description: 'poziv na akciju, max 10 znakova, npr. Kupi kartu, Saznaj više' },
    rationale: { type: 'string', description: 'kratko na srpskom: sta je uzeto iz opisa i sta treba proveriti' },
  },
  required: ['headlines', 'long_headlines', 'descriptions', 'call_to_action', 'rationale'],
  additionalProperties: false,
}

const DISPLAY_SCHEMA = {
  type: 'object',
  properties: {
    headlines: { type: 'array', items: { type: 'string' }, description: '5 kratkih naslova, svaki max 30 znakova' },
    long_headline: { type: 'string', description: 'jedan dugi naslov, max 90 znakova' },
    descriptions: { type: 'array', items: { type: 'string' }, description: '5 opisa, svaki max 90 znakova; bar jedan max 60' },
    rationale: { type: 'string', description: 'kratko na srpskom: sta je uzeto iz briefa ili napomena i sta treba proveriti' },
  },
  required: ['headlines', 'long_headline', 'descriptions', 'rationale'],
  additionalProperties: false,
}

function briefFacts(b: Record<string, unknown>) {
  return {
    naziv_akcije: b.headline, trajanje: b.duration_text, popust: b.discount,
    dodaje_se_na_postojeci_popust: b.stacks_with_existing, odnosi_se_na: b.applies_to,
    iskljucuje: b.excludes, vazi_i_u_radnjama: b.in_stores, landing_page: b.landing_page,
    copy_iz_briefa: b.copy, legal_line: b.legal_line, napomena: b.intro,
    // Comments on the task in which someone wrote "odobren" (the approved copy is often there, not in the description).
    odobreno_u_komentarima: Array.isArray(b.approved_copy) && b.approved_copy.length ? b.approved_copy : undefined,
  }
}

const LANGUAGE_RULES =
  '- Piši na jeziku tržišta (RS srpski latinica; HR hrvatski; ME/BA ijekavica), u tonu copy-ja iz briefa.\n' +
  '- Koristi samo činjenice iz briefa: popust, na šta se odnosi, period, uslove. Ne izmišljaj cene, procente, brendove ni rokove.\n' +
  '- Poštuj legal line: ako akcija isključuje brendove ili ima uslov (npr. minimalan račun), ne obećavaj ono što ne važi.\n' +
  '- Ako brief ima copy ili odobreno_u_komentarima, preuzmi te rečenice i fraze doslovno (bez prepravljanja) gde staju u ograničenje znakova; novo piši samo za ono što nedostaje. Novija odobrenja važe pre starijih (npr. izmenjen legal line ili adresa radnje).\n'

// deno-lint-ignore no-explicit-any
async function structured(schema: unknown, system: string, prompt: string): Promise<{ out: any; model: string } | { error: string }> {
  const resp = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  // deno-lint-ignore no-explicit-any
  } as any)
  if (resp.stop_reason === 'refusal') return { error: 'Model je odbio zahtev' }
  const text = resp.content.find((c: { type: string }) => c.type === 'text') as { text: string } | undefined
  if (!text) return { error: 'Model nije vratio predlog' }
  return { out: JSON.parse(text.text), model: resp.model }
}

const uniq = (a: string[]) => [...new Set((a ?? []).map((s) => String(s).trim()).filter(Boolean))]

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    // Server-to-server calls (tests, schedulers) send the internal key instead of a user session.
    const internal = req.headers.get('x-internal-key')
    if (internal) {
      const { data: secret } = await sb.from('integration_secrets').select('value').eq('name', 'feedhub_briefs_key').maybeSingle()
      if (!secret || internal !== secret.value) return json({ error: 'Pogrešan interni ključ' }, 403)
    } else {
      const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
      const { data: u, error: ue } = await sb.auth.getUser(jwt)
      if (ue || !u?.user) return json({ error: 'Niste ulogovani' }, 401)
      const { data: au } = await sb.from('app_users').select('agency_id, client_id').eq('id', u.user.id).maybeSingle()
      if (!au?.agency_id || au.client_id) return json({ error: 'Samo korisnici agencije mogu da uvoze briefove' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const action = body.action ?? 'briefs'

    if (action === 'projects') return json(await feedhub({ action: 'projects' }))

    if (action === 'briefs') {
      if (!body.project_id) return json({ error: 'project_id je obavezan' }, 400)
      return json(await feedhub({ action: 'briefs', project_id: body.project_id, since_days: body.since_days ?? 120, limit: 40 }))
    }

    // Pulls the project's tasks from Productive right now (otherwise they arrive with the 07:10 daily sync).
    if (action === 'refresh') {
      if (!/^\d+$/.test(String(body.project_id ?? ''))) return json({ error: 'project_id je obavezan' }, 400)
      return json(await feedhub({ action: 'refresh_project', project_id: String(body.project_id) }, 90000))
    }

    // Images, videos and files from the brief task, its subtasks and comments (streamed from Productive, not stored).
    if (action === 'attachments') {
      if (!/^\d+$/.test(String(body.task_id ?? ''))) return json({ error: 'task_id je obavezan' }, 400)
      return json(await feedhub({ action: 'attachments', task_id: String(body.task_id), sync: body.sync !== false }, 60000))
    }

    // Comments on the brief and its subtasks, subtask descriptions and links (approved copy, Google Sheets).
    if (action === 'comments') {
      if (!/^\d+$/.test(String(body.task_id ?? ''))) return json({ error: 'task_id je obavezan' }, 400)
      return json(await feedhub({ action: 'comments', task_id: String(body.task_id) }, 60000))
    }

    // Fresh signed links for attachments saved in drafts (used when exporting the Editor package).
    if (action === 'file_urls') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x: string) => /^\d+$/.test(x))
      return json(await feedhub({ action: 'file_urls', ids }))
    }

    if (action === 'draft') {
      const b = body.brief
      if (!b?.headline && !b?.copy) return json({ error: 'Brief nema naziv ni copy' }, 400)
      const prompt =
        `Napravi Google Search RSA oglas za akciju klijenta ${body.client_name ?? ''} (tržište ${body.market ?? ''}, tip ${body.ct ?? 'Generic_Search'}).\n\n` +
        `BRIEF AKCIJE (jedini izvor činjenica):\n${JSON.stringify(briefFacts(b), null, 2)}\n\n` +
        'Pravila:\n' + LANGUAGE_RULES +
        '- Naslovi najviše 30 znakova, opisi najviše 90, path1/path2 najviše 15; brojevi znakova moraju biti tačni.\n' +
        '- Ključne reči samo za ono na šta se akcija odnosi (kategorije ili brendovi iz briefa) i naziv brenda klijenta.'
      const r = await structured(DRAFT_SCHEMA, 'Ti si PPC specijalista u agenciji. Pišeš Search oglase isključivo na osnovu briefa koji dobiješ.', prompt)
      if ('error' in r) return json({ error: r.error }, 502)
      const out = r.out
      const dropped: string[] = []
      const headlines = uniq(out.headlines).filter((h) => (h.length <= 30 ? true : (dropped.push(h), false))).slice(0, 15)
      const descriptions = uniq(out.descriptions).filter((d) => (d.length <= 90 ? true : (dropped.push(d), false))).slice(0, 4)
      return json({
        theme: out.theme, ad_group: out.ad_group, final_url: b.landing_page ?? '',
        path1: String(out.path1 ?? '').slice(0, 15), path2: String(out.path2 ?? '').slice(0, 15),
        headlines, descriptions, keywords: uniq(out.keywords), rationale: out.rationale, dropped_too_long: dropped,
        start_date: b.start_date, end_date: b.end_date, task_url: b.task_url, served_by: r.model,
      })
    }

    // Text assets for a Performance Max asset group (images and videos are picked by hand).
    if (action === 'draft_pmax') {
      const b = body.brief
      if (!b?.headline && !b?.copy) return json({ error: 'Brief nema naziv ni copy' }, 400)
      const prompt =
        `Napravi tekstove za Performance Max asset grupu za akciju klijenta ${body.client_name ?? ''} (tržište ${body.market ?? ''}).\n\n` +
        `BRIEF AKCIJE (jedini izvor činjenica):\n${JSON.stringify(briefFacts(b), null, 2)}\n\n` +
        'Pravila:\n' + LANGUAGE_RULES +
        '- Naslovi najviše 30 znakova (bar dva najviše 15), dugi naslovi najviše 90, opisi najviše 90 (bar jedan najviše 60); brojevi znakova moraju biti tačni.\n' +
        '- Naslovi treba da budu različiti: popust, period akcije, kategorija/kolekcija, brend klijenta, poziv na kupovinu.\n' +
        '- Teme pretrage: kratke fraze kojima ljudi traže ono na šta se akcija odnosi, bez isključenih brendova.'
      const r = await structured(PMAX_SCHEMA, 'Ti si PPC specijalista u agenciji. Pišeš tekstove za Performance Max isključivo na osnovu briefa koji dobiješ.', prompt)
      if ('error' in r) return json({ error: r.error }, 502)
      const out = r.out
      const dropped: string[] = []
      const fit = (list: string[], max: number, n: number) => uniq(list).filter((x) => (x.length <= max ? true : (dropped.push(x), false))).slice(0, n)
      return json({
        headlines: fit(out.headlines, 30, 15),
        long_headlines: fit(out.long_headlines, 90, 5),
        descriptions: fit(out.descriptions, 90, 5),
        search_themes: fit(out.search_themes, 80, 25),
        rationale: out.rationale, dropped_too_long: dropped, served_by: r.model,
      })
    }

    // Text assets for a Demand Gen ad group (multi-image ad, plus a video ad when videos are given).
    if (action === 'draft_demand_gen') {
      const b = body.brief
      if (!b?.headline && !b?.copy) return json({ error: 'Brief nema naziv ni copy' }, 400)
      const prompt =
        `Napravi tekstove za Demand Gen oglase (YouTube, Discover, Gmail) za akciju klijenta ${body.client_name ?? ''} (tržište ${body.market ?? ''}).\n\n` +
        `BRIEF AKCIJE (jedini izvor činjenica):\n${JSON.stringify(briefFacts(b), null, 2)}\n\n` +
        'Pravila:\n' + LANGUAGE_RULES +
        '- Naslovi najviše 40 znakova, dugi naslovi najviše 90, opisi najviše 90; brojevi znakova moraju biti tačni.\n' +
        '- Demand Gen se prikazuje ljudima koji ne traže aktivno: naslovi treba da zaustave skrolovanje (popust, rok, kolekcija), ne da ponavljaju ključne reči.\n' +
        '- Naslovi i opisi treba da budu različiti međusobno i da svaki radi sam za sebe, jer ih Google kombinuje.'
      const r = await structured(DEMAND_GEN_SCHEMA, 'Ti si PPC specijalista u agenciji. Pišeš tekstove za Demand Gen oglase isključivo na osnovu briefa koji dobiješ.', prompt)
      if ('error' in r) return json({ error: r.error }, 502)
      const out = r.out
      const dropped: string[] = []
      const fit = (list: string[], max: number, n: number) => uniq(list).filter((x) => (x.length <= max ? true : (dropped.push(x), false))).slice(0, n)
      return json({
        headlines: fit(out.headlines, 40, 5),
        long_headlines: fit(out.long_headlines, 90, 5),
        descriptions: fit(out.descriptions, 90, 5),
        rationale: out.rationale, dropped_too_long: dropped, served_by: r.model,
      })
    }

    // Text for a YouTube video campaign of one title (a film, a product launch, a collection).
    if (action === 'draft_video') {
      const title = String(body.title ?? '').trim()
      if (!title) return json({ error: 'Nedostaje naziv' }, 400)
      const facts = body.brief ? briefFacts(body.brief) : {}
      const prompt =
        `Napravi tekstove za YouTube video oglase (responsive video ad) za „${title}“, klijent ${body.client_name ?? ''}, tržište ${body.market ?? ''}.\n\n` +
        `CILJ KAMPANJE: ${body.goal === 'views' ? 'pregledi videa (Video views)' : 'doseg (Video reach)'}\n` +
        `ČINJENICE (jedini izvor): ${JSON.stringify({ ...facts, napomene_tima: body.notes ?? null }, null, 2)}\n\n` +
        'Pravila:\n' + LANGUAGE_RULES +
        '- Naslovi najviše 30 znakova, dugi naslovi najviše 90, opisi najviše 90, poziv na akciju najviše 10; brojevi znakova moraju biti tačni.\n' +
        '- Ako je u pitanju film ili događaj, koristi samo naziv, datum premijere i podatke iz napomena; ne izmišljaj glumce, radnju ni ocene.\n' +
        '- Tekst prati video koji gledalac vidi: kratko, sa jasnim pozivom (gledaj trejler, kupi kartu, saznaj više).'
      const r = await structured(VIDEO_SCHEMA, 'Ti si PPC specijalista u agenciji. Pišeš tekstove za YouTube video oglase isključivo na osnovu činjenica koje dobiješ.', prompt)
      if ('error' in r) return json({ error: r.error }, 502)
      const out = r.out
      const dropped: string[] = []
      const fit = (list: string[], max: number, n: number) => uniq(list).filter((x) => (x.length <= max ? true : (dropped.push(x), false))).slice(0, n)
      return json({
        headlines: fit(out.headlines, 30, 5),
        long_headlines: fit(out.long_headlines, 90, 5),
        descriptions: fit(out.descriptions, 90, 5),
        call_to_action: String(out.call_to_action ?? '').slice(0, 10),
        rationale: out.rationale, dropped_too_long: dropped, served_by: r.model,
      })
    }

    // Text assets for a responsive display ad (from a brief, or a title with the team's notes).
    if (action === 'draft_display') {
      const title = String(body.title ?? '').trim()
      if (!body.brief && !title) return json({ error: 'Nedostaje brief ili naziv' }, 400)
      const facts = { ...(body.brief ? briefFacts(body.brief) : {}), naziv: title || null, napomene_tima: body.notes ?? null }
      const prompt =
        `Napravi tekstove za responsive display oglas (Google Display mreža) za klijenta ${body.client_name ?? ''}, tržište ${body.market ?? ''}.\n\n` +
        `ČINJENICE (jedini izvor):\n${JSON.stringify(facts, null, 2)}\n\n` +
        'Pravila:\n' + LANGUAGE_RULES +
        '- Naslovi najviše 30 znakova, dugi naslov najviše 90, opisi najviše 90 (bar jedan najviše 60); brojevi znakova moraju biti tačni.\n' +
        '- Display oglas se prikazuje uz sliku na sajtovima i u aplikacijama: kratko, jasna ponuda ili poruka, poziv na akciju.\n' +
        '- Za film ili događaj koristi samo naziv, datum i podatke iz napomena; ne izmišljaj glumce, radnju ni ocene.'
      const r = await structured(DISPLAY_SCHEMA, 'Ti si PPC specijalista u agenciji. Pišeš tekstove za responsive display oglase isključivo na osnovu činjenica koje dobiješ.', prompt)
      if ('error' in r) return json({ error: r.error }, 502)
      const out = r.out
      const dropped: string[] = []
      const fit = (list: string[], max: number, n: number) => uniq(list).filter((x) => (x.length <= max ? true : (dropped.push(x), false))).slice(0, n)
      const lh = String(out.long_headline ?? '').trim()
      return json({
        headlines: fit(out.headlines, 30, 5),
        long_headline: lh.length <= 90 ? lh : (dropped.push(lh), ''),
        descriptions: fit(out.descriptions, 90, 5),
        rationale: out.rationale, dropped_too_long: dropped, served_by: r.model,
      })
    }

    return json({ error: `Nepoznata akcija ${action}` }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
