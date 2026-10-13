import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type ClientRow = { id: string; name: string; ga4_store: string | null }
type Draft = {
  id: string
  client_id: string
  kind: 'campaign' | 'ad_group' | 'rsa' | 'keyword' | 'negative_keyword'
  campaign_name: string
  ad_group_name: string | null
  payload: Record<string, unknown>
  status: 'draft' | 'approved' | 'exported' | 'published' | 'rejected'
  created_at: string
}

type Brief = {
  task_id: string
  task_url: string
  title: string
  headline: string | null
  duration_text: string | null
  start_date: string | null
  end_date: string | null
  discount: string | null
  applies_to: string | null
  excludes: string | null
  landing_page: string | null
  copy: string | null
  legal_line: string | null
  created_at: string
}

const MARKETS = ['RS', 'HR', 'BA', 'ME', 'SI', 'AL']
const CAMPAIGN_TYPES = ['Generic_Search', 'Brand_Search']
const MAX_HEADLINE = 30
const MAX_DESCRIPTION = 90
const MAX_PATH = 15

// Productive project names use the country name instead of the market code.
const MARKET_COUNTRY: Record<string, string> = { RS: 'srbija', HR: 'hrvatska', BA: 'bosna', ME: 'crna gora', SI: 'slovenia', AL: 'albanija' }

function guessProject(projects: { productive_id: string; name: string }[], clientName: string, market: string): string {
  const words = clientName.toLowerCase().replace(/\b(rs|hr|ba|me|si|al)\b/g, '').split(/\s+/).filter((w) => w.length > 2)
  const country = MARKET_COUNTRY[market] ?? ''
  const scored = projects.map((p) => {
    const n = p.name.toLowerCase()
    return { id: p.productive_id, score: words.filter((w) => n.includes(w)).length * 2 + (country && n.includes(country) ? 1 : 0) }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0] && scored[0].score > 0 ? scored[0].id : ''
}

const shortDate = (d: string | null) => (d ? `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.` : '')

const STATUS_LABEL: Record<Draft['status'], string> = {
  draft: 'Nacrt', approved: 'Odobreno', exported: 'Izvezeno', published: 'Objavljeno', rejected: 'Odbačeno',
}

function lines(s: string): string[] {
  return s.split('\n').map((x) => x.trim()).filter(Boolean)
}

// "[exact]" -> Exact, "\"phrase\"" or plain -> Phrase
function parseKeyword(raw: string): { keyword: string; match_type: 'Exact' | 'Phrase' } {
  const t = raw.trim()
  if (t.startsWith('[') && t.endsWith(']')) return { keyword: t.slice(1, -1).trim(), match_type: 'Exact' }
  if (t.startsWith('"') && t.endsWith('"')) return { keyword: t.slice(1, -1).trim(), match_type: 'Phrase' }
  return { keyword: t, match_type: 'Phrase' }
}

function downloadText(filename: string, text: string) {
  const blob = new Blob(['' + text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function CampaignBuilder() {
  const [clients, setClients] = useState<ClientRow[]>([])
  const [clientId, setClientId] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // form
  const [name, setName] = useState('')
  const [market, setMarket] = useState('')
  const [ctype, setCtype] = useState(CAMPAIGN_TYPES[0])
  const [budget, setBudget] = useState('')
  const [adGroup, setAdGroup] = useState('')
  const [finalUrl, setFinalUrl] = useState('')
  const [path1, setPath1] = useState('')
  const [path2, setPath2] = useState('')
  const [headlines, setHeadlines] = useState('')
  const [descriptions, setDescriptions] = useState('')
  const [keywords, setKeywords] = useState('')
  const [negatives, setNegatives] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [rationale, setRationale] = useState('')
  const [projects, setProjects] = useState<{ productive_id: string; name: string }[]>([])
  const [projectId, setProjectId] = useState('')
  const [briefs, setBriefs] = useState<Brief[]>([])
  const [briefId, setBriefId] = useState('')
  const [briefLoading, setBriefLoading] = useState(false)
  const [drafting, setDrafting] = useState(false)

  useEffect(() => {
    supabase.from('clients').select('id, name, ga4_store').order('name').then(({ data }) => {
      const list = (data ?? []) as ClientRow[]
      setClients(list)
      if (list.length) setClientId(list[0].id)
    })
  }, [])

  const client = clients.find((c) => c.id === clientId)
  useEffect(() => {
    if (client?.ga4_store && MARKETS.includes(client.ga4_store)) setMarket(client.ga4_store)
    else setMarket('')
  }, [clientId, client?.ga4_store])

  async function loadDrafts() {
    if (!clientId) return
    const { data, error } = await supabase
      .from('automation_drafts')
      .select('id, client_id, kind, campaign_name, ad_group_name, payload, status, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
    if (error) setMessage({ kind: 'err', text: 'Nije moguće učitati nacrte.' })
    else setDrafts((data ?? []) as Draft[])
  }
  useEffect(() => { loadDrafts() }, [clientId])

  const campaignName = useMemo(() => {
    const base = name.trim().replace(/\s+/g, ' ').replace(/[(),;]/g, '')
    if (!base) return ''
    const underscored = base.replace(/ /g, '-')
    return `LB_${underscored} (Mkt:${market || 'XX'};Ct:${ctype})`
  }, [name, market, ctype])

  const hl = lines(headlines)
  const ds = lines(descriptions)
  const kw = lines(keywords).map(parseKeyword).filter((k) => k.keyword)
  const neg = lines(negatives).map(parseKeyword).filter((k) => k.keyword)

  const problems: string[] = []
  if (!name.trim()) problems.push('Unesi naziv kampanje.')
  if (!market) problems.push('Izaberi tržište.')
  if (!(parseFloat(budget) > 0)) problems.push('Dnevni budžet mora biti veći od 0.')
  if (!adGroup.trim()) problems.push('Unesi naziv ad grupe.')
  if (!/^https?:\/\//.test(finalUrl.trim())) problems.push('Final URL mora početi sa http(s)://.')
  if (hl.length < 3) problems.push('Potrebna su najmanje 3 naslova.')
  if (hl.length > 15) problems.push('Najviše 15 naslova.')
  if (hl.some((h) => h.length > MAX_HEADLINE)) problems.push(`Naslov duži od ${MAX_HEADLINE} znakova.`)
  if (ds.length < 2) problems.push('Potrebna su najmanje 2 opisa.')
  if (ds.length > 4) problems.push('Najviše 4 opisa.')
  if (ds.some((d) => d.length > MAX_DESCRIPTION)) problems.push(`Opis duži od ${MAX_DESCRIPTION} znakova.`)
  if (path1.length > MAX_PATH || path2.length > MAX_PATH) problems.push(`Path može imati najviše ${MAX_PATH} znakova.`)
  if (kw.length === 0) problems.push('Dodaj bar jednu ključnu reč.')
  if (new Set(hl).size !== hl.length) problems.push('Naslovi se ponavljaju.')

  async function suggest() {
    if (!clientId || !name.trim()) return
    setSuggesting(true); setMessage(null); setRationale('')
    const { data, error } = await supabase.functions.invoke('suggest-campaign', {
      body: { client_id: clientId, theme: name.trim(), ct: ctype, market },
    })
    setSuggesting(false)
    if (error || !data || data.error) {
      setMessage({ kind: 'err', text: `Predlog nije uspeo: ${data?.error ?? error?.message ?? 'nepoznata greška'}` })
      return
    }
    setAdGroup(data.ad_group ?? ''); setFinalUrl(data.final_url ?? '')
    setPath1(data.path1 ?? ''); setPath2(data.path2 ?? '')
    if (data.daily_budget && !budget) setBudget(String(data.daily_budget))
    setHeadlines((data.headlines ?? []).join('\n')); setDescriptions((data.descriptions ?? []).join('\n'))
    setKeywords((data.keywords ?? []).join('\n')); setNegatives((data.negatives ?? []).join('\n'))
    const m = data.meta ?? {}
    setRationale(`${data.rationale ?? ''} (search termi: ${m.search_terms ?? 0}, keyword-i: ${m.keywords ?? 0}, oglasi u uzorku: ${m.ad_samples ?? 0})` +
      (data.dropped_too_long?.length ? ` Izbačeno jer je predugo: ${data.dropped_too_long.length}.` : ''))
  }

  // Productive briefs (via Feed Hub): load projects once, pick the client's project, list its briefs.
  useEffect(() => {
    supabase.functions.invoke('productive-briefs', { body: { action: 'projects' } }).then(({ data }) => {
      if (data?.projects) setProjects(data.projects)
    })
  }, [])

  useEffect(() => {
    if (!client || projects.length === 0) return
    setProjectId(guessProject(projects, client.name, market))
  }, [client?.id, market, projects.length])

  useEffect(() => {
    setBriefs([])
    setBriefId('')
    if (!projectId) return
    setBriefLoading(true)
    supabase.functions.invoke('productive-briefs', { body: { action: 'briefs', project_id: projectId } }).then(({ data, error }) => {
      setBriefLoading(false)
      if (error || data?.error) {
        setMessage({ kind: 'err', text: `Briefovi nisu učitani: ${data?.error ?? error?.message}` })
        return
      }
      setBriefs(data?.briefs ?? [])
    })
  }, [projectId])

  const brief = briefs.find((b) => b.task_id === briefId) ?? null

  async function draftFromBrief() {
    if (!brief || !client) return
    setDrafting(true); setMessage(null); setRationale('')
    const { data, error } = await supabase.functions.invoke('productive-briefs', {
      body: { action: 'draft', brief, client_name: client.name, market, ct: ctype },
    })
    setDrafting(false)
    if (error || !data || data.error) {
      setMessage({ kind: 'err', text: `Nacrt iz briefa nije uspeo: ${data?.error ?? error?.message ?? 'nepoznata greška'}` })
      return
    }
    setName(data.theme ?? brief.headline ?? '')
    setAdGroup(data.ad_group ?? ''); setFinalUrl(data.final_url ?? '')
    setPath1(data.path1 ?? ''); setPath2(data.path2 ?? '')
    setHeadlines((data.headlines ?? []).join('\n')); setDescriptions((data.descriptions ?? []).join('\n'))
    setKeywords((data.keywords ?? []).join('\n'))
    const period = brief.start_date ? ` Period akcije: ${shortDate(brief.start_date)}${brief.end_date && brief.end_date !== brief.start_date ? ` – ${shortDate(brief.end_date)}` : ''}; kampanju pusti i zaustavi u tom periodu.` : ''
    setRationale(`Iz Productive briefa „${brief.title}“. ${data.rationale ?? ''}${period}` +
      (data.dropped_too_long?.length ? ` Izbačeno jer je predugo: ${data.dropped_too_long.length}.` : ''))
  }

  async function saveDraft() {
    if (problems.length || !clientId) return
    setBusy(true)
    setMessage(null)
    const camp = campaignName
    const ag = adGroup.trim()
    const rows = [
      { kind: 'campaign', campaign_name: camp, ad_group_name: null, payload: { campaign_type: 'Search', daily_budget: parseFloat(budget) } },
      { kind: 'ad_group', campaign_name: camp, ad_group_name: ag, payload: {} },
      { kind: 'rsa', campaign_name: camp, ad_group_name: ag, payload: { headlines: hl, descriptions: ds, final_url: finalUrl.trim(), path1: path1.trim(), path2: path2.trim() } },
      ...kw.map((k) => ({ kind: 'keyword', campaign_name: camp, ad_group_name: ag, payload: k })),
      ...neg.map((k) => ({ kind: 'negative_keyword', campaign_name: camp, ad_group_name: null, payload: k })),
    ].map((r) => ({ ...r, client_id: clientId, status: 'draft', created_by: 'brain-ui' }))
    const { error } = await supabase.from('automation_drafts').insert(rows)
    setBusy(false)
    if (error) {
      setMessage({ kind: 'err', text: `Čuvanje nije uspelo: ${error.message}` })
      return
    }
    setMessage({ kind: 'ok', text: `Nacrt sačuvan (${rows.length} redova). Sve se izvozi kao Paused.` })
    setName(''); setAdGroup(''); setHeadlines(''); setDescriptions(''); setKeywords(''); setNegatives('')
    loadDrafts()
  }

  async function exportCsv(ids: string[] | null, label: string) {
    setBusy(true)
    setMessage(null)
    const { data, error } = await supabase.functions.invoke('export-editor-csv', {
      body: { client_id: clientId, ...(ids ? { draft_ids: ids } : {}) },
    })
    setBusy(false)
    if (error || typeof data !== 'string') {
      setMessage({ kind: 'err', text: 'Izvoz nije uspeo (nema nacrta ili nemaš pristup).' })
      return
    }
    const slug = (client?.name ?? 'klijent').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    downloadText(`editor_${slug}_${label}.csv`, data)
    setMessage({ kind: 'ok', text: 'CSV je preuzet. U Editoru: Import → proveri listu izmena → Post → uključi posle provere.' })
    loadDrafts()
  }

  async function setStatus(ids: string[], status: Draft['status']) {
    const patch: Record<string, unknown> = { status }
    if (status === 'published') patch.published_at = new Date().toISOString()
    const { error } = await supabase.from('automation_drafts').update(patch).in('id', ids)
    if (error) setMessage({ kind: 'err', text: 'Promena statusa nije uspela.' })
    loadDrafts()
  }

  // group drafts by campaign
  const groups = useMemo(() => {
    const m = new Map<string, Draft[]>()
    for (const d of drafts) {
      if (!m.has(d.campaign_name)) m.set(d.campaign_name, [])
      m.get(d.campaign_name)!.push(d)
    }
    return [...m.entries()]
  }, [drafts])

  const inputCls = 'w-full rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'
  const labelCls = 'mb-1 block text-xs font-medium text-[var(--color-ink-soft)]'
  const counter = (n: number, max: number) => <span className={n > max ? 'text-[var(--color-rust)]' : ''}>{n}/{max}</span>

  return (
    <div>
      <header className="mb-8 flex items-end justify-between border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Google Ads Editor &middot; nacrti kampanja</p>
          <h1 className="font-display mt-1 text-4xl font-medium">Nove kampanje</h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--color-ink-soft)]">
            Napravi nacrt, izvezi CSV i importuj ga u Google Ads Editor. Sve ulazi kao <b>Paused</b> i samo se dodaje; ništa ne ide u nalog dok ti ne klikneš Post.
          </p>
        </div>
        <label className="text-sm">
          <span className="mr-2 text-[var(--color-ink-soft)]">Klijent</span>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="rounded border border-[var(--color-line)] bg-white px-3 py-1.5">
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </header>

      {message && (
        <p className={`mb-6 rounded px-4 py-2 text-sm ${message.kind === 'ok' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-red-50 text-[var(--color-rust)]'}`}>
          {message.text}
        </p>
      )}

      <section className="mb-10 rounded border border-dashed border-[var(--color-line)] bg-white p-5">
        <p className="mb-1 text-sm font-medium">Uvezi iz Productive briefa</p>
        <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
          Briefovi akcija iz Productive-a (preko Feed Hub-a, osvežava se svako jutro). Izaberi akciju, pa popuni formu: naslovi i opisi se pišu
          samo iz briefa (popust, period, uslovi, legal line), a ti ih pregledaš pre čuvanja.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block text-[var(--color-ink-soft)]">Productive projekat</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="max-w-64 rounded border border-[var(--color-line)] bg-white px-3 py-1.5">
              <option value="">— izaberi —</option>
              {projects.map((p) => (
                <option key={p.productive_id} value={p.productive_id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-[var(--color-ink-soft)]">Akcija</span>
            <select value={briefId} onChange={(e) => setBriefId(e.target.value)} disabled={briefLoading || briefs.length === 0} className="max-w-80 rounded border border-[var(--color-line)] bg-white px-3 py-1.5">
              <option value="">{briefLoading ? 'Učitavam…' : briefs.length ? '— izaberi —' : 'nema briefova'}</option>
              {briefs.map((b) => (
                <option key={b.task_id} value={b.task_id}>
                  {`${b.title}${b.start_date ? ` · ${shortDate(b.start_date)}${b.end_date && b.end_date !== b.start_date ? `–${shortDate(b.end_date)}` : ''}` : ''}${b.discount ? ` · ${b.discount}` : ''}`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={draftFromBrief}
            disabled={!brief || drafting}
            className="rounded border border-[var(--color-indigo)] px-4 py-2 text-sm font-medium text-[var(--color-indigo)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {drafting ? 'Pišem oglase…' : 'Popuni formu iz briefa'}
          </button>
        </div>
        {brief && (
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
            {[
              ['Akcija', brief.headline],
              ['Trajanje', brief.duration_text],
              ['Popust', brief.discount],
              ['Odnosi se na', brief.applies_to],
              ['Isključuje', brief.excludes],
              ['Landing page', brief.landing_page],
              ['Copy', brief.copy],
              ['Legal line', brief.legal_line],
            ].filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className={k === 'Legal line' || k === 'Copy' ? 'md:col-span-2' : ''}>
                <dt className="inline text-[var(--color-ink-soft)]">{k}: </dt>
                <dd className="inline whitespace-pre-line">{v}</dd>
              </div>
            ))}
            <div className="md:col-span-2">
              <a href={brief.task_url} target="_blank" rel="noreferrer" className="text-[var(--color-indigo-dark)] underline">Otvori task u Productive-u</a>
            </div>
          </dl>
        )}
      </section>

      <section className="mb-12">
        <h2 className="font-display mb-4 text-xl font-medium">Nova Search kampanja</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <label className="md:col-span-2"><span className={labelCls}>Naziv (npr. Outlet Obuca)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></label>
          <label><span className={labelCls}>Tržište</span>
            <select value={market} onChange={(e) => setMarket(e.target.value)} className={inputCls}>
              <option value="">—</option>{MARKETS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select></label>
          <label><span className={labelCls}>Tip (Ct)</span>
            <select value={ctype} onChange={(e) => setCtype(e.target.value)} className={inputCls}>
              {CAMPAIGN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></label>
          <p className="md:col-span-4 -mt-2 text-xs text-[var(--color-ink-soft)]">
            Ime u Editoru: <code className="rounded bg-slate-100 px-1.5 py-0.5">{campaignName || 'LB_… (Mkt:XX;Ct:…)'}</code>
            &nbsp;— isto ime mora biti u UTM-u (<code>utm_campaign</code>) da GA4 revenue radi.
          </p>
          <div className="md:col-span-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={suggest} disabled={suggesting || !name.trim() || !clientId}
              className="rounded border border-[var(--color-indigo)] px-4 py-2 text-sm font-medium text-[var(--color-indigo)] disabled:cursor-not-allowed disabled:opacity-40">
              {suggesting ? 'Generišem…' : 'Generiši predlog iz podataka'}
            </button>
            <span className="text-xs text-[var(--color-ink-soft)]">Upiši temu u „Naziv", izaberi tip, pa klikni. Sve polja možeš da izmeniš pre čuvanja.</span>
          </div>
          {rationale && <p className="md:col-span-4 rounded bg-[var(--color-indigo-soft)] px-4 py-2 text-xs text-[var(--color-indigo-dark)]">{rationale}</p>}
          <label><span className={labelCls}>Dnevni budžet (€)</span>
            <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" className={inputCls} /></label>
          <label className="md:col-span-3"><span className={labelCls}>Ad grupa</span>
            <input value={adGroup} onChange={(e) => setAdGroup(e.target.value)} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Final URL</span>
            <input value={finalUrl} onChange={(e) => setFinalUrl(e.target.value)} placeholder="https://…" className={inputCls} /></label>
          <label><span className={labelCls}>Path 1 ({counter(path1.length, MAX_PATH)})</span>
            <input value={path1} onChange={(e) => setPath1(e.target.value)} className={inputCls} /></label>
          <label><span className={labelCls}>Path 2 ({counter(path2.length, MAX_PATH)})</span>
            <input value={path2} onChange={(e) => setPath2(e.target.value)} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Naslovi, jedan po redu (3–15, do {MAX_HEADLINE} znakova) · {hl.length} naslova</span>
            <textarea value={headlines} onChange={(e) => setHeadlines(e.target.value)} rows={7} className={inputCls} />
            {hl.some((h) => h.length > MAX_HEADLINE) && <span className="text-xs text-[var(--color-rust)]">Predugi: {hl.filter((h) => h.length > MAX_HEADLINE).join(' | ')}</span>}
          </label>
          <label className="md:col-span-2"><span className={labelCls}>Opisi, jedan po redu (2–4, do {MAX_DESCRIPTION} znakova) · {ds.length} opisa</span>
            <textarea value={descriptions} onChange={(e) => setDescriptions(e.target.value)} rows={7} className={inputCls} />
            {ds.some((d) => d.length > MAX_DESCRIPTION) && <span className="text-xs text-[var(--color-rust)]">Predugi opis.</span>}
          </label>
          <label className="md:col-span-2"><span className={labelCls}>Ključne reči, jedna po redu — <code>[exact]</code>, <code>"phrase"</code> ili bez navodnika (= phrase) · {kw.length}</span>
            <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={6} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Negativne ključne reči (nivo kampanje), isti format · {neg.length}</span>
            <textarea value={negatives} onChange={(e) => setNegatives(e.target.value)} rows={6} className={inputCls} /></label>
        </div>
        {problems.length > 0 && name.trim() !== '' && (
          <ul className="mt-4 list-disc pl-5 text-xs text-[var(--color-rust)]">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        )}
        <button
          onClick={saveDraft}
          disabled={busy || problems.length > 0}
          className="mt-5 rounded bg-[var(--color-indigo)] px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Sačuvaj nacrt
        </button>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-medium">Nacrti za {client?.name ?? '…'}</h2>
          <button
            onClick={() => exportCsv(null, 'svi-nacrti')}
            disabled={busy || !drafts.some((d) => ['draft', 'approved', 'exported'].includes(d.status))}
            className="rounded border border-[var(--color-indigo)] px-4 py-1.5 text-sm font-medium text-[var(--color-indigo-dark)] disabled:opacity-40"
          >
            Izvezi sve za Editor
          </button>
        </div>
        {groups.length === 0 && <p className="text-sm text-[var(--color-ink-soft)]">Još nema nacrta za ovog klijenta.</p>}
        <div className="space-y-3">
          {groups.map(([camp, rows]) => {
            const status = rows[0].status
            const ids = rows.map((r) => r.id)
            const count = (k: Draft['kind']) => rows.filter((r) => r.kind === k).length
            const budgetVal = rows.find((r) => r.kind === 'campaign')?.payload?.daily_budget
            return (
              <div key={camp} className="rounded border border-[var(--color-line)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{camp}</p>
                    <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                      {STATUS_LABEL[status]} · budžet {budgetVal ? `${budgetVal} €/dan` : '—'} · {count('keyword')} ključnih reči · {count('negative_keyword')} negativnih · {rows.find((r) => r.kind === 'rsa') ? 'RSA ✓' : 'bez RSA'}
                    </p>
                  </div>
                  <div className="flex gap-2 text-xs">
                    {['draft', 'approved', 'exported'].includes(status) && (
                      <button onClick={() => exportCsv(ids, 'kampanja')} disabled={busy} className="rounded border border-[var(--color-indigo)] px-3 py-1 text-[var(--color-indigo-dark)]">Izvezi CSV</button>
                    )}
                    {status === 'exported' && (
                      <button onClick={() => setStatus(ids, 'published')} className="rounded border border-[var(--color-line)] px-3 py-1">Označi kao objavljeno</button>
                    )}
                    {['draft', 'approved'].includes(status) && (
                      <button onClick={() => setStatus(ids, 'rejected')} className="rounded border border-[var(--color-line)] px-3 py-1 text-[var(--color-rust)]">Odbaci</button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
