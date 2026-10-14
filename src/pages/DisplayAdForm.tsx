import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { type Brief, type ImageAsset, FIELD_LABEL, downloadEditorPackage } from '../lib/creatives'

// Responsive display ads, the two ways the team builds Display:
// - a new ad group in existing Display campaigns (KIKO Tof and Bof together, Movem Flight, Planika Brendovi),
//   named like the campaign's latest ad group ("Akcija (Tg:In-market;Ad:RDA&IA)");
// - a new campaign per title (Editus): "FILM (Mkt:HR;Ct:Display;Ph:Mix, Ad:RDA)" with a daily budget.
// Exported Paused for Editor; images travel in the package and are added in Editor.

type ClientRow = { id: string; name: string; ga4_store: string | null }
type Mode = 'ad_group' | 'campaign'
type DisplayCampaign = { campaign: string; last_date: string; spend_30d: number; ad_groups: string[] }
type DisplayDraft = {
  id: string
  mode: Mode
  campaign_name: string
  ad_group_name: string
  daily_budget: number | null
  start_date: string | null
  end_date: string | null
  headlines: string[]
  descriptions: string[]
  images: ImageAsset[]
  status: 'draft' | 'exported' | 'published' | 'rejected'
  brief_title: string | null
  created_at: string
}
type Props = {
  client: ClientRow
  market: string
  brief: Brief | null
  images: ImageAsset[]
  onSaved: () => void
  onMessage: (m: { kind: 'ok' | 'err'; text: string } | null) => void
}

const STATUS_LABEL: Record<DisplayDraft['status'], string> = { draft: 'Nacrt', exported: 'Izvezeno', published: 'Objavljeno', rejected: 'Odbačeno' }
const CTAS = ['', 'Shop now', 'Learn more', 'Get offer', 'Book now', 'Sign up', 'Contact us']
// Editor location and language names per market.
const MARKET_GEO: Record<string, { location: string; language: string }> = {
  RS: { location: 'Serbia', language: 'Serbian' },
  HR: { location: 'Croatia', language: 'Croatian' },
  BA: { location: 'Bosnia and Herzegovina', language: 'Bosnian' },
  ME: { location: 'Montenegro', language: 'Serbian' },
  SI: { location: 'Slovenia', language: 'Slovenian' },
  AL: { location: 'Albania', language: 'Albanian' },
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)
// "(Tg:In-market;Ad:RDA&IA)" from the campaign's latest ad group, so the new one follows the same naming.
const suffixOf = (adGroup: string | undefined) => adGroup?.match(/\s?\((Tg:[^)]*)\)\s*$/)?.[0] ?? ' (Tg:Mix;Ad:RDA)'

function youtubeId(raw: string): string | null {
  const t = raw.trim()
  if (/^[\w-]{11}$/.test(t)) return t
  const m = t.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)
  return m ? m[1] : null
}

export default function DisplayAdForm({ client, market, brief, images, onSaved, onMessage }: Props) {
  const [mode, setMode] = useState<Mode>('ad_group')
  const [campaigns, setCampaigns] = useState<DisplayCampaign[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [base, setBase] = useState('')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [budget, setBudget] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [finalUrl, setFinalUrl] = useState('')
  const [headlines, setHeadlines] = useState('')
  const [longHeadline, setLongHeadline] = useState('')
  const [descriptions, setDescriptions] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [cta, setCta] = useState('')
  const [videos, setVideos] = useState('')
  const [rationale, setRationale] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [drafts, setDrafts] = useState<DisplayDraft[]>([])
  const mkt = market || 'RS'
  const geo = MARKET_GEO[mkt] ?? MARKET_GEO.RS

  useEffect(() => {
    setBusinessName(client.name.replace(/\s+(RS|HR|BA|ME|SI|AL)$/i, '').slice(0, 25))
    supabase.from('client_editor_defaults').select('business_name').eq('client_id', client.id).maybeSingle()
      .then(({ data }) => { if (data?.business_name) setBusinessName(data.business_name) })
    supabase.rpc('display_campaigns', { p_client_id: client.id }).then(({ data }) => {
      const list = (data ?? []) as DisplayCampaign[]
      setCampaigns(list)
      setPicked([])
      // A client without hand-built Display campaigns (or one that builds a campaign per title) starts in campaign mode.
      setMode(list.length ? 'ad_group' : 'campaign')
    })
  }, [client.id, client.name])

  useEffect(() => {
    if (!brief) return
    const name = (brief.headline ?? brief.title).trim()
    setBase(name); setTitle(name.toUpperCase())
    setFinalUrl(brief.landing_page ?? '')
    if (brief.start_date) setStart(brief.start_date)
    if (brief.end_date) setEnd(brief.end_date)
  }, [brief])

  async function loadDrafts() {
    const { data, error } = await supabase.from('display_ad_drafts')
      .select('id, mode, campaign_name, ad_group_name, daily_budget, start_date, end_date, headlines, descriptions, images, status, brief_title, created_at')
      .eq('client_id', client.id).order('created_at', { ascending: false })
    if (error) onMessage({ kind: 'err', text: 'Display nacrti nisu učitani.' })
    else setDrafts((data ?? []) as DisplayDraft[])
  }
  useEffect(() => { loadDrafts() }, [client.id])

  async function draftTexts() {
    setDrafting(true); onMessage(null); setRationale('')
    const { data, error } = await supabase.functions.invoke('productive-briefs', {
      body: { action: 'draft_display', brief, title: mode === 'campaign' ? title : base, notes, client_name: client.name, market: mkt },
    })
    setDrafting(false)
    if (error || !data || data.error) {
      onMessage({ kind: 'err', text: `Predlog tekstova nije uspeo: ${data?.error ?? error?.message ?? 'nepoznata greška'}` })
      return
    }
    setHeadlines((data.headlines ?? []).join('\n'))
    setLongHeadline(data.long_headline ?? '')
    setDescriptions((data.descriptions ?? []).join('\n'))
    setRationale(`${data.rationale ?? ''}${data.dropped_too_long?.length ? ` Izbačeno jer je predugo: ${data.dropped_too_long.length}.` : ''}`)
  }

  // One draft per target: each picked campaign gets an ad group, or one new campaign.
  const targets = mode === 'ad_group'
    ? picked.map((c) => ({ campaign: c, adGroup: `${base.trim()}${suffixOf(campaigns.find((x) => x.campaign === c)?.ad_groups[0])}` }))
    : title.trim() ? [{ campaign: `${title.trim()} (Mkt:${mkt};Ct:Display;Ph:Mix, Ad:RDA)`, adGroup: `${title.trim()} (Tg:Mix;Ad:RDA)` }] : []

  const hl = lines(headlines)
  const ds = lines(descriptions)
  const vids = lines(videos).map(youtubeId)
  const count = (f: ImageAsset['field']) => images.filter((i) => i.field === f).length
  const logos = count('LOGO') + count('LANDSCAPE_LOGO')
  const marketing = images.length - logos
  const num = (v: string) => Number(v.replace(',', '.'))

  const problems: string[] = []
  if (mode === 'ad_group' && !picked.length) problems.push('Izaberi bar jednu Display kampanju.')
  if (mode === 'ad_group' && !base.trim()) problems.push('Unesi naziv ad grupe (akcija, brend, kolekcija).')
  if (mode === 'campaign' && !title.trim()) problems.push('Unesi naziv kampanje (npr. naziv filma).')
  if (mode === 'campaign' && !(num(budget) > 0)) problems.push('Unesi dnevni budžet.')
  if (mode === 'campaign' && !start) problems.push('Unesi datum početka.')
  if (mode === 'campaign' && end && end < start) problems.push('Kraj je pre početka.')
  if (!/^https?:\/\//.test(finalUrl.trim())) problems.push('Final URL mora početi sa http(s)://.')
  if (hl.length < 1 || hl.length > 5 || hl.some((h) => h.length > 30)) problems.push('Potrebno je 1–5 naslova do 30 znakova.')
  if (!longHeadline.trim() || longHeadline.length > 90) problems.push('Potreban je dugi naslov do 90 znakova.')
  if (ds.length < 1 || ds.length > 5 || ds.some((d) => d.length > 90)) problems.push('Potrebno je 1–5 opisa do 90 znakova.')
  if (ds.length && !ds.some((d) => d.length <= 60)) problems.push('Bar jedan opis mora imati najviše 60 znakova.')
  if (!businessName.trim() || businessName.length > 25) problems.push('Naziv firme je obavezan, najviše 25 znakova.')
  if (!count('MARKETING_IMAGE')) problems.push('Potrebna je bar jedna horizontalna slika 1.91:1.')
  if (!count('SQUARE_MARKETING_IMAGE')) problems.push('Potrebna je bar jedna kvadratna slika 1:1.')
  if (marketing > 15) problems.push('Najviše 15 slika.')
  if (logos > 5) problems.push('Najviše 5 logotipa.')
  if (vids.some((v) => !v) || vids.length > 5) problems.push('Do 5 YouTube videa, link ili ID.')

  const warnings: string[] = []
  if (!logos) warnings.push('Nema logotipa (preporučen kvadratni 1:1).')
  for (const t of targets) {
    if (mode === 'ad_group' && campaigns.find((c) => c.campaign === t.campaign)?.ad_groups.includes(t.adGroup)) warnings.push(`Ad grupa „${t.adGroup}“ već postoji u ${t.campaign}.`)
    if (mode === 'campaign' && campaigns.some((c) => c.campaign.replace(/\s+/g, '') === t.campaign.replace(/\s+/g, ''))) warnings.push(`Kampanja „${t.campaign}“ već postoji.`)
  }

  async function save() {
    if (problems.length) return
    setBusy(true); onMessage(null)
    const rows = targets.map((t) => ({
      client_id: client.id, mode, campaign_name: t.campaign, ad_group_name: t.adGroup,
      daily_budget: mode === 'campaign' ? num(budget) : null, start_date: mode === 'campaign' ? start : null, end_date: mode === 'campaign' ? (end || null) : null,
      locations: mode === 'campaign' ? [geo.location] : [], languages: mode === 'campaign' ? [geo.language] : [],
      final_url: finalUrl.trim(), headlines: hl, long_headline: longHeadline.trim(), descriptions: ds,
      business_name: businessName.trim(), call_to_action: cta || null, images, video_ids: vids.filter(Boolean),
      brief_task_id: brief?.task_id ?? null, brief_title: brief?.title ?? null, created_by: 'brain-ui',
    }))
    const { error } = await supabase.from('display_ad_drafts').insert(rows)
    setBusy(false)
    if (error) { onMessage({ kind: 'err', text: `Čuvanje nije uspelo: ${error.message}` }); return }
    onMessage({ kind: 'ok', text: `Sačuvano kao nacrt: ${rows.map((r) => r.ad_group_name).join(', ')}. Izvozi se kao Paused.` })
    setHeadlines(''); setLongHeadline(''); setDescriptions(''); setVideos(''); setRationale('')
    onSaved()
    loadDrafts()
  }

  async function exportDrafts(list: DisplayDraft[]) {
    setBusy(true); onMessage(null)
    const { data, error } = await supabase.functions.invoke('export-display-csv', { body: { client_id: client.id, draft_ids: list.map((d) => d.id) } })
    if (error || typeof data !== 'string') {
      setBusy(false)
      onMessage({ kind: 'err', text: `Izvoz nije uspeo: ${data?.error ?? 'nema nacrta ili nemaš pristup'}` })
      return
    }
    const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    // Drafts saved together share their images; pack each file once.
    const imgs = [...new Map(list.flatMap((d) => d.images ?? []).map((i) => [i.file, i])).values()]
    const res = await downloadEditorPackage(`editor_display_${slug(client.name)}_${slug(list[0].ad_group_name).slice(0, 40)}`, data, imgs)
    setBusy(false)
    onMessage({ kind: res.ok ? 'ok' : 'err', text: res.text + (imgs.length ? ` Slike (${imgs.length}) su u folderu images/: u Editoru ih dodaj oglasu ručno, pa proveri publiku ad grupe.` : '') })
    loadDrafts()
  }

  async function setStatus(id: string, status: DisplayDraft['status']) {
    const patch: Record<string, unknown> = { status }
    if (status === 'published') patch.published_at = new Date().toISOString()
    const { error } = await supabase.from('display_ad_drafts').update(patch).eq('id', id)
    if (error) onMessage({ kind: 'err', text: 'Promena statusa nije uspela.' })
    loadDrafts()
  }

  const inputCls = 'w-full rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'
  const labelCls = 'mb-1 block text-xs font-medium text-[var(--color-ink-soft)]'
  const n = (s: string[], max: number) => <span className={s.some((x) => x.length > max) ? 'text-[var(--color-rust)]' : ''}>{s.length}</span>
  // Drafts saved in one go (same ad group name, e.g. KIKO Tof + Bof) export together.
  const groups = drafts.reduce<Record<string, DisplayDraft[]>>((m, d) => ((m[`${d.ad_group_name.replace(/\s?\(Tg:.*$/, '')}|${d.created_at.slice(0, 16)}`] ??= []).push(d), m), {})

  return (
    <>
      <section className="mb-12">
        <h2 className="font-display mb-1 text-xl font-medium">Responsive display oglas</h2>
        <p className="mb-4 max-w-2xl text-xs text-[var(--color-ink-soft)]">
          Nova ad grupa u postojećim Display kampanjama (npr. KIKO Tof i Bof odjednom) ili nova kampanja za naslov (npr. film).
          Izvozi se kao <b>Paused</b>; slike iz priloga se dodaju oglasu u Editoru, publiku proveri pre uključivanja.
        </p>
        <div className="mb-4 inline-flex rounded border border-[var(--color-line)] bg-white p-0.5 text-sm">
          {([['ad_group', 'Nova ad grupa u postojećoj kampanji'], ['campaign', 'Nova kampanja']] as const).map(([m, label]) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={`rounded px-3 py-1 ${mode === m ? 'bg-[var(--color-indigo)] text-white' : 'text-[var(--color-ink-soft)]'}`}>{label}</button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          {mode === 'ad_group' ? (
            <>
              <div className="md:col-span-2">
                <span className={labelCls}>Display kampanje (može više, npr. Tof i Bof)</span>
                {campaigns.length === 0 && <p className="text-xs text-[var(--color-ink-soft)]">Nema ručno pravljenih Display kampanja u podacima.</p>}
                {campaigns.map((c) => (
                  <label key={c.campaign} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={picked.includes(c.campaign)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, c.campaign] : picked.filter((x) => x !== c.campaign))} />
                    {c.campaign} <span className="text-xs text-[var(--color-ink-soft)]">· {c.ad_groups.length} ad grupa · {Number(c.spend_30d).toLocaleString('sr-RS')} (30 d)</span>
                  </label>
                ))}
              </div>
              <label className="md:col-span-2"><span className={labelCls}>Naziv ad grupe (akcija, brend, kolekcija)</span>
                <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="Madonna x KIKO" className={inputCls} />
                {targets.map((t) => <span key={t.campaign} className="mt-1 block text-xs text-[var(--color-ink-soft)]">→ {t.adGroup} u {t.campaign}</span>)}
              </label>
            </>
          ) : (
            <>
              <label className="md:col-span-2"><span className={labelCls}>Naziv (ide u ime kampanje)</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ZABORAVLJENI OTOK" className={inputCls} />
                {targets.map((t) => <span key={t.campaign} className="mt-1 block text-xs text-[var(--color-ink-soft)]">→ {t.campaign} / {t.adGroup}</span>)}
              </label>
              <label><span className={labelCls}>Dnevni budžet (EUR)</span>
                <input value={budget} onChange={(e) => setBudget(e.target.value)} className={inputCls} /></label>
              <div className="grid grid-cols-2 gap-2">
                <label><span className={labelCls}>Početak</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} /></label>
                <label><span className={labelCls}>Kraj</span><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} /></label>
              </div>
            </>
          )}
          <label className="md:col-span-2"><span className={labelCls}>Final URL</span>
            <input value={finalUrl} onChange={(e) => setFinalUrl(e.target.value)} placeholder="https://…" className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Napomene za tekst (ako nema briefa: ponuda, premijera, poruka)</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} /></label>
          <div className="md:col-span-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={draftTexts} disabled={drafting || (!brief && !(mode === 'campaign' ? title : base).trim())}
              className="rounded border border-[var(--color-indigo)] px-4 py-2 text-sm font-medium text-[var(--color-indigo)] disabled:cursor-not-allowed disabled:opacity-40">
              {drafting ? 'Pišem tekstove…' : brief ? 'Popuni tekstove iz briefa' : 'Napiši tekstove'}
            </button>
            {rationale && <span className="text-xs text-[var(--color-ink-soft)]">{rationale}</span>}
          </div>
          <label className="md:col-span-2"><span className={labelCls}>Naslovi (1–5, do 30 znakova) · {n(hl, 30)}</span>
            <textarea value={headlines} onChange={(e) => setHeadlines(e.target.value)} rows={5} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Opisi (1–5, do 90 znakova, bar jedan do 60) · {n(ds, 90)}</span>
            <textarea value={descriptions} onChange={(e) => setDescriptions(e.target.value)} rows={5} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Dugi naslov ({longHeadline.length}/90)</span>
            <input value={longHeadline} onChange={(e) => setLongHeadline(e.target.value)} className={inputCls} /></label>
          <label><span className={labelCls}>Naziv firme ({businessName.length}/25)</span>
            <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={inputCls} /></label>
          <label><span className={labelCls}>Call to action</span>
            <select value={cta} onChange={(e) => setCta(e.target.value)} className={inputCls}>
              {CTAS.map((c) => <option key={c} value={c}>{c || 'Automatski'}</option>)}
            </select></label>
          <label className="md:col-span-2"><span className={labelCls}>YouTube videi (opciono, do 5) · {vids.filter(Boolean).length}</span>
            <textarea value={videos} onChange={(e) => setVideos(e.target.value)} rows={2} placeholder="https://youtu.be/…" className={inputCls} /></label>
          <div className="md:col-span-2 text-xs text-[var(--color-ink-soft)]">
            Izabrane slike: {images.length === 0 ? 'nijedna (izaberi gore u prilozima)' : images.map((i) => `${i.name} (${FIELD_LABEL[i.field ?? 'MARKETING_IMAGE']})`).join(' · ')}
            {mode === 'campaign' && <> · Lokacija: {geo.location} · jezik: {geo.language}</>}
          </div>
        </div>
        {(problems.length > 0 || warnings.length > 0) && (
          <ul className="mt-4 list-disc pl-5 text-xs">
            {problems.map((p) => <li key={p} className="text-[var(--color-rust)]">{p}</li>)}
            {warnings.map((w) => <li key={w} className="text-[var(--color-ink-soft)]">{w}</li>)}
          </ul>
        )}
        <button onClick={save} disabled={busy || problems.length > 0}
          className="mt-5 rounded bg-[var(--color-indigo)] px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
          Sačuvaj {targets.length > 1 ? `${targets.length} ad grupe` : mode === 'campaign' ? 'kampanju' : 'ad grupu'}
        </button>
      </section>

      <section>
        <h2 className="font-display mb-4 text-xl font-medium">Display nacrti za {client.name}</h2>
        {drafts.length === 0 && <p className="text-sm text-[var(--color-ink-soft)]">Još nema Display nacrta za ovog klijenta.</p>}
        <div className="space-y-3">
          {Object.values(groups).map((list) => (
            <div key={list[0].id} className="rounded border border-[var(--color-line)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  {list.map((d) => (
                    <p key={d.id} className="text-sm">
                      <span className="font-medium">{d.ad_group_name}</span> <span className="text-[var(--color-ink-soft)]">→ {d.campaign_name}{d.mode === 'campaign' ? ` (nova, ${d.daily_budget} EUR dnevno od ${d.start_date})` : ''}</span>
                      <span className="ml-2 text-xs text-[var(--color-ink-soft)]">{STATUS_LABEL[d.status]}</span>
                      {d.status === 'exported' && <button onClick={() => setStatus(d.id, 'published')} className="ml-2 text-xs underline">označi kao objavljeno</button>}
                      {d.status === 'draft' && <button onClick={() => setStatus(d.id, 'rejected')} className="ml-2 text-xs text-[var(--color-rust)] underline">odbaci</button>}
                    </p>
                  ))}
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                    {list[0].headlines.length} naslova · {list[0].descriptions.length} opisa · {list[0].images?.length ?? 0} slika{list[0].brief_title ? ` · brief „${list[0].brief_title}“` : ''}
                  </p>
                </div>
                {list.some((d) => ['draft', 'exported'].includes(d.status)) && (
                  <button onClick={() => exportDrafts(list.filter((d) => ['draft', 'exported'].includes(d.status)))} disabled={busy}
                    className="rounded border border-[var(--color-indigo)] px-3 py-1 text-xs text-[var(--color-indigo-dark)]">
                    {list[0].images?.length ? 'Izvezi paket (CSV + slike)' : 'Izvezi CSV'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
