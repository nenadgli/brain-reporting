import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { type Brief, type ImageAsset, FIELD_LABEL, fromBrief } from '../lib/creatives'
import {
  type BaseAdSet, type GeoEntry, type MetaAd, type MetaCampaign, type Objective, type Targeting,
  CTAS, OBJECTIVES, describeTargeting, downloadMetaPackage, geoEntries, withGeo,
} from '../lib/metaBulk'

// Meta campaign from a Productive brief: settings copied from one of the client's recent ad sets (Windsor),
// copy taken word for word from the approved brief/comments/sheet, exported as an Ads Manager import file (Paused).

type ClientRow = { id: string; name: string; ga4_store: string | null }
type Props = {
  client: ClientRow
  market: string
  brief: Brief | null
  images: ImageAsset[]
  onSaved: () => void
  onMessage: (m: { kind: 'ok' | 'err'; text: string } | null) => void
}
type Profile = { account_id: string; defaults: { page_id: string | null; instagram_id: string | null; pixel_id: string | null }; adsets: BaseAdSet[] }
type AdSetForm = { key: string; name: string; note: string; base: string; keep: string[]; budget: string; texts: string; titles: string; description: string; cta: string }
type Draft = { id: string; name: string; status: 'nacrt' | 'odobreno' | 'izvezeno' | 'odbijeno'; payload: MetaCampaign; created_at: string; exported_at: string | null }

const STATUS_LABEL: Record<Draft['status'], string> = { nacrt: 'Nacrt', odobreno: 'Odobreno', izvezeno: 'Izvezeno', odbijeno: 'Odbačeno' }
const PHASES = ['Tof', 'Mof', 'Bof']
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)
const clean = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '')
const newKey = () => Math.random().toString(36).slice(2)
const emptyAdSet = (): AdSetForm => ({ key: newKey(), name: '', note: '', base: '', keep: [], budget: '', texts: '', titles: '', description: '', cta: 'LEARN_MORE' })
const entryKey = (e: GeoEntry) => `${e.kind}:${e.label}`

export default function MetaCampaignForm({ client, market, brief, images, onSaved, onMessage }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [theme, setTheme] = useState('')
  const [objective, setObjective] = useState<Objective>('OUTCOME_AWARENESS')
  const [phase, setPhase] = useState('Tof')
  const [budgetLevel, setBudgetLevel] = useState<'campaign' | 'adset'>('adset')
  // Actions usually get new ad sets in existing campaigns (ADV, remarketing, collection); a new campaign is the exception.
  const [target, setTarget] = useState<'existing' | 'new'>('existing')
  const [existingId, setExistingId] = useState('')
  const [budgetType, setBudgetType] = useState<'daily' | 'lifetime'>('lifetime')
  const [budget, setBudget] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [link, setLink] = useState('')
  const [pageId, setPageId] = useState('')
  const [igId, setIgId] = useState('')
  const [pixelId, setPixelId] = useState('')
  const [adsets, setAdsets] = useState<AdSetForm[]>([emptyAdSet()])
  const [sheetCopy, setSheetCopy] = useState('')
  const [writing, setWriting] = useState(false)
  const [rationale, setRationale] = useState('')
  const [saving, setSaving] = useState(false)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [picked, setPicked] = useState<string[]>([])

  // How the client's recent Meta ad sets are set up (Windsor, last 60 days).
  useEffect(() => {
    setProfile(null); setProfileError(''); setProfileLoading(true)
    supabase.functions.invoke('meta-campaigns', { body: { action: 'profile', client_id: client.id, days: 60 } }).then(({ data, error }) => {
      setProfileLoading(false)
      if (error || data?.error) { setProfileError(data?.error ?? error?.message ?? 'nepoznata greška'); return }
      setProfile(data)
      setPageId(data.defaults?.page_id ?? ''); setIgId(data.defaults?.instagram_id ?? ''); setPixelId(data.defaults?.pixel_id ?? '')
    })
    loadDrafts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id])

  // Brief → theme, dates and link.
  useEffect(() => {
    if (!brief) return
    setTheme(clean(brief.headline ?? brief.title ?? '').slice(0, 40))
    setStart(brief.start_date ?? ''); setEnd(brief.end_date ?? '')
    if (brief.landing_page) setLink(brief.landing_page)
  }, [brief])

  async function loadDrafts() {
    const { data } = await supabase.from('meta_campaign_drafts').select('id, name, status, payload, created_at, exported_at').eq('client_id', client.id).order('created_at', { ascending: false }).limit(50)
    setDrafts((data ?? []) as Draft[])
  }

  const baseOf = (id: string) => profile?.adsets.find((a) => a.adset_id === id) ?? null
  const obj = OBJECTIVES.find((o) => o.key === objective)!
  // The client's campaigns from Windsor (active first); CBO when the campaign itself has a budget.
  const campaigns = useMemo(() => {
    const m = new Map<string, { id: string; name: string; objective: string | null; status: string | null; cbo: boolean; spend: number }>()
    for (const a of profile?.adsets ?? []) {
      if (!a.campaign_id) continue
      const prev = m.get(a.campaign_id)
      const cbo = Number(a.campaign_daily_budget ?? 0) > 0 || Number(a.campaign_lifetime_budget ?? 0) > 0
      m.set(a.campaign_id, { id: a.campaign_id, name: a.campaign, objective: a.objective, status: a.campaign_status, cbo, spend: (prev?.spend ?? 0) + Number(a.spend ?? 0) })
    }
    return [...m.values()].sort((x, y) => Number(y.status === 'ACTIVE') - Number(x.status === 'ACTIVE') || y.spend - x.spend)
  }, [profile])
  const existing = target === 'existing' ? campaigns.find((c) => c.id === existingId) ?? null : null
  const campaignName = existing ? existing.name : `LFT19_${theme || 'Akcija'} (Mkt:${market || 'XX'};Ct:${obj.ct};Ph:${phase})`
  function pickExisting(id: string) {
    setExistingId(id)
    const c = campaigns.find((x) => x.id === id)
    if (!c) return
    if (c.objective && OBJECTIVES.some((o) => o.key === c.objective)) setObjective(c.objective as Objective)
    setBudgetLevel(c.cbo ? 'campaign' : 'adset')
  }

  // Team convention for Meta ad sets: "Akcija_20%_na_FW26(Mkt:RS;Tg:Broad)"; Tg:LP_Visitors when it targets custom audiences (remarketing).
  function adsetNameOf(name: string, t: Targeting | null) {
    const tg = (t?.custom_audiences as unknown[] | undefined)?.length ? 'LP_Visitors' : 'Broad'
    return `${theme}_${clean(name)}(Mkt:${market || 'XX'};Tg:${tg})`
  }

  function patch(key: string, p: Partial<AdSetForm>) {
    setAdsets((list) => list.map((a) => (a.key === key ? { ...a, ...p } : a)))
  }
  function pickBase(key: string, id: string) {
    const b = baseOf(id)
    patch(key, { base: id, keep: geoEntries(b?.targeting ?? null).map(entryKey) })
    if (b?.link && !link) setLink(b.link)
    if (b?.objective && OBJECTIVES.some((o) => o.key === b.objective)) setObjective(b.objective as Objective)
  }

  async function writeCopy() {
    if (!brief) return
    setWriting(true); onMessage(null); setRationale('')
    const { data, error } = await supabase.functions.invoke('meta-campaigns', {
      body: {
        action: 'draft', brief, client_name: client.name, market, objective: obj.label, sheet_copy: sheetCopy || undefined,
        adsets: adsets.map((a) => ({ name: a.name || 'Ad set', note: [a.note, describeTargeting(baseOf(a.base)?.targeting ?? null)].filter(Boolean).join(' · ') })),
      },
    })
    setWriting(false)
    if (error || data?.error) { onMessage({ kind: 'err', text: `Pisanje oglasa nije uspelo: ${data?.error ?? error?.message}` }); return }
    const byName = new Map<string, { primary_texts: string[]; headlines: string[]; description: string; cta: string }>((data.adsets ?? []).map((x: { name: string }) => [x.name, x]))
    setAdsets((list) => list.map((a, i) => {
      const d = byName.get(a.name || 'Ad set') ?? data.adsets?.[i]
      return d ? { ...a, texts: d.primary_texts.join('\n'), titles: d.headlines.join('\n'), description: d.description, cta: d.cta } : a
    }))
    setRationale(data.rationale ?? '')
  }

  // Lines Claude wrote new (not found in the brief, approved comments or the pasted sheet).
  const sources = useMemo(() => [brief?.copy, brief?.headline, brief?.legal_line, brief?.discount, ...(brief?.approved_copy ?? []), sheetCopy], [brief, sheetCopy])
  const fresh = (a: AdSetForm) => [...lines(a.texts), ...lines(a.titles), a.description].filter((l) => l && !fromBrief(l, sources))

  function buildCampaign(): MetaCampaign {
    return {
      name: campaignName, campaign_id: existing?.id ?? null, objective, budget_level: budgetLevel, budget_type: budgetType,
      budget: budgetLevel === 'campaign' && !existing ? parseFloat(budget) : null, start: start || null, end: end || null,
      page_id: pageId.trim(), instagram_id: igId.trim(), pixel_id: pixelId.trim(), event: 'PURCHASE',
      brief_title: brief?.title ?? null, task_url: brief?.task_url ?? null,
      adsets: adsets.map((a) => {
        const b = baseOf(a.base)
        const keep = geoEntries(b?.targeting ?? null).filter((e) => a.keep.includes(entryKey(e)))
        const targeting: Targeting = b?.targeting ? withGeo(b.targeting, keep) : { geo_locations: { countries: [market], location_types: ['home', 'recent'] } }
        const adsetName = adsetNameOf(a.name, targeting)
        const ad = (img: ImageAsset | null, i: number): MetaAd => ({
          name: `${theme}_${clean(a.name)}${img ? `_${img.ratio.replace(':', 'x')}` : ''}${i ? `_${i + 1}` : ''}(At:SI)`,
          primary_texts: lines(a.texts), headlines: lines(a.titles), description: a.description.trim(), cta: a.cta, link: link.trim(), image: img,
        })
        return {
          name: adsetName, base_adset_id: b?.adset_id ?? null, base_label: b ? `${b.adset_name} · ${b.campaign}` : null, targeting,
          optimization_goal: obj.goal, billing_event: 'IMPRESSIONS', budget: budgetLevel === 'adset' ? parseFloat(a.budget) : null,
          ads: images.length ? images.map((img, i) => ad(img, images.filter((x, j) => j < i && x.ratio === img.ratio).length)) : [ad(null, 0)],
        }
      }),
    }
  }

  const problems: string[] = []
  if (!theme.trim()) problems.push('Upiši temu kampanje.')
  if (!pageId.trim()) problems.push('Nedostaje Facebook Page ID.')
  if (!link.trim().startsWith('http')) problems.push('Link mora biti pun URL (https://…).')
  if (budgetType === 'lifetime' && !end) problems.push('Lifetime budžet traži datum kraja.')
  if (target === 'existing' && !existing) problems.push('Izaberi postojeću kampanju.')
  if (!existing && budgetLevel === 'campaign' && !(parseFloat(budget) > 0)) problems.push('Upiši budžet kampanje.')
  adsets.forEach((a, i) => {
    const n = `Ad set ${i + 1}`
    if (!a.name.trim()) problems.push(`${n}: upiši ime.`)
    if (a.base && !a.keep.length) problems.push(`${n}: izaberi bar jednu lokaciju.`)
    if (budgetLevel === 'adset' && !(parseFloat(a.budget) > 0)) problems.push(`${n}: upiši budžet.`)
    if (!lines(a.texts).length || !lines(a.titles).length) problems.push(`${n}: nedostaju tekstovi ili naslovi.`)
  })
  if (objective === 'OUTCOME_SALES' && !pixelId.trim()) problems.push('Za cilj Prodaja treba Pixel ID.')

  async function save() {
    if (problems.length) return
    setSaving(true)
    const payload = buildCampaign()
    const { error } = await supabase.from('meta_campaign_drafts').insert({ client_id: client.id, brief_task_id: brief?.task_id ?? null, name: payload.name, payload })
    setSaving(false)
    if (error) { onMessage({ kind: 'err', text: `Čuvanje nije uspelo: ${error.message}` }); return }
    const ads = payload.adsets.reduce((n, s) => n + s.ads.length, 0)
    onMessage({ kind: 'ok', text: `Meta kampanja sačuvana: ${payload.adsets.length} ad seta, ${ads} oglasa. Izvozi se kao Paused.` })
    setAdsets([emptyAdSet()]); setRationale(''); setSheetCopy('')
    onSaved(); loadDrafts()
  }

  async function exportPicked() {
    const list = drafts.filter((d) => picked.includes(d.id))
    if (!list.length) return
    const slug = clean(client.name).toLowerCase()
    const res = await downloadMetaPackage(`meta_${slug}_${new Date().toISOString().slice(0, 10)}`, list.map((d) => d.payload))
    onMessage({ kind: res.ok ? 'ok' : 'err', text: res.text })
    await supabase.from('meta_campaign_drafts').update({ status: 'izvezeno', exported_at: new Date().toISOString() }).in('id', list.map((d) => d.id))
    setPicked([]); loadDrafts()
  }
  async function setStatus(ids: string[], status: Draft['status']) {
    await supabase.from('meta_campaign_drafts').update({ status, updated_at: new Date().toISOString() }).in('id', ids)
    setPicked([]); loadDrafts()
  }

  const label = 'mb-1 block text-xs font-medium text-[var(--color-ink-soft)]'
  const counter = (s: string, max: number) => lines(s).map((l, i) => <span key={i} className={l.length > max ? 'text-[var(--color-rust)]' : ''}>{i ? ' · ' : ''}{l.length}</span>)

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <p className="mb-1 text-sm font-semibold">1. Kampanja</p>
        <p className="mb-3 text-xs text-[var(--color-ink-soft)]">Akcija obično dobija nove ad setove u postojećim kampanjama (ADV, remarketing, collection); postojeća kampanja se ne menja. Novi ad setovi i oglasi se izvoze kao Paused.</p>
        <div className="mb-4 inline-flex rounded-lg border border-[var(--color-line)] p-0.5 text-sm">
          {([['existing', 'Novi ad set u postojećoj kampanji'], ['new', 'Nova kampanja']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTarget(k)} className={`rounded-md px-3 py-1.5 ${target === k ? 'bg-[var(--color-indigo)] text-white' : 'text-[var(--color-ink-soft)]'}`}>{l}</button>
          ))}
        </div>
        {target === 'existing' && (
          <label className="mb-4 block"><span className={label}>Postojeća kampanja (iz Windsora, aktivne prve)</span>
            <select className="input w-full" value={existingId} onChange={(e) => pickExisting(e.target.value)}>
              <option value="">{profileLoading ? 'Učitavam…' : '— izaberi —'}</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{`${c.name} · ${c.status === 'ACTIVE' ? 'aktivna' : 'pauzirana'} · ${c.cbo ? 'budžet na kampanji' : 'budžet po ad setu'}`}</option>)}
            </select>
          </label>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label><span className={label}>Tema (za imena ad setova i oglasa)</span><input className="input w-full" value={theme} onChange={(e) => setTheme(clean(e.target.value))} placeholder="Privilege_Exclusive" /></label>
          {!existing && <><label><span className={label}>Cilj</span>
            <select className="input w-full" value={objective} onChange={(e) => setObjective(e.target.value as Objective)}>
              {OBJECTIVES.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
          <label><span className={label}>Faza</span>
            <select className="input w-full" value={phase} onChange={(e) => setPhase(e.target.value)}>{PHASES.map((p) => <option key={p}>{p}</option>)}</select>
          </label></>}
          <label><span className={label}>Početak</span><input type="date" className="input w-full" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label><span className={label}>Kraj</span><input type="date" className="input w-full" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          <label><span className={label}>Link oglasa</span><input className="input w-full" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" /></label>
          {!existing && <label><span className={label}>Budžet na nivou</span>
            <select className="input w-full" value={budgetLevel} onChange={(e) => setBudgetLevel(e.target.value as 'campaign' | 'adset')}>
              <option value="adset">ad seta (svaki svoj)</option><option value="campaign">kampanje (CBO)</option>
            </select>
          </label>}
          {!(existing && budgetLevel === 'campaign') && <label><span className={label}>Vrsta budžeta</span>
            <select className="input w-full" value={budgetType} onChange={(e) => setBudgetType(e.target.value as 'daily' | 'lifetime')}>
              <option value="lifetime">ukupan za period</option><option value="daily">dnevni</option>
            </select>
          </label>}
          {!existing && budgetLevel === 'campaign' && <label><span className={label}>Budžet kampanje (valuta naloga)</span><input className="input w-full" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>}
        </div>
        <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
          {existing ? <>Ad setovi idu u: <b className="text-[var(--color-ink)]">{campaignName}</b>{existing.cbo ? ' (budžet je na kampanji, ad set ga deli)' : ''}</> : <>Ime kampanje: <b className="text-[var(--color-ink)]">{campaignName}</b></>}
        </p>
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-[var(--color-ink-soft)]">Nalog: Page {pageId || '—'} · Instagram {igId || 'preko Page-a'} · Pixel {pixelId || '—'}</summary>
          <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
            <label><span className={label}>Facebook Page ID</span><input className="input w-full" value={pageId} onChange={(e) => setPageId(e.target.value)} /></label>
            <label><span className={label}>Instagram account ID</span><input className="input w-full" value={igId} onChange={(e) => setIgId(e.target.value)} /></label>
            <label><span className={label}>Pixel ID</span><input className="input w-full" value={pixelId} onChange={(e) => setPixelId(e.target.value)} /></label>
          </div>
          <p className="mt-1 text-[var(--color-ink-soft)]">Popunjeno iz poslednjih kampanja klijenta (Windsor).</p>
        </details>
      </section>

      <section className="card p-5">
        <p className="mb-1 text-sm font-semibold">2. Ad setovi</p>
        <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
          Za svaki ad set izaberi postojeći ad set iz kog se kopira ciljanje (lokacije, uzrast, interesovanja, plasmani), pa ostavi samo lokacije koje važe, npr. samo Beograd.
          {profileLoading && ' Učitavam ad setove iz Windsora…'}
          {profileError && <span className="text-[var(--color-rust)]"> Windsor: {profileError}</span>}
        </p>
        <div className="space-y-4">
          {adsets.map((a, i) => {
            const b = baseOf(a.base)
            const entries = geoEntries(b?.targeting ?? null)
            return (
              <div key={a.key} className="rounded-xl border border-[var(--color-line)] p-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <label><span className={label}>Ad set {i + 1}: ime</span><input className="input w-full" value={a.name} onChange={(e) => patch(a.key, { name: e.target.value })} placeholder="Beograd" />
                    {a.name.trim() && <span className="mt-1 block text-xs text-[var(--color-ink-soft)]">U nalogu: <b className="text-[var(--color-ink)]">{adsetNameOf(a.name, b?.targeting ?? null)}</b></span>}
                  </label>
                  <label className="md:col-span-2"><span className={label}>Napomena za tekst (radnja, adresa, publika)</span><input className="input w-full" value={a.note} onChange={(e) => patch(a.key, { note: e.target.value })} placeholder="MOVEM Fashion Merkator, Beograd" /></label>
                  <label className="md:col-span-2"><span className={label}>Kopiraj ciljanje iz</span>
                    <select className="input w-full" value={a.base} onChange={(e) => pickBase(a.key, e.target.value)}>
                      <option value="">— samo država {market || ''}, bez ostalog ciljanja —</option>
                      {[...(profile?.adsets ?? [])].sort((x, y) => Number(y.campaign_id === existingId) - Number(x.campaign_id === existingId)).map((x) => (
                        <option key={x.adset_id} value={x.adset_id}>{`${x.adset_name} · ${x.campaign}${x.spend ? ` · ${Math.round(x.spend)} potrošeno` : ''}`}</option>
                      ))}
                    </select>
                  </label>
                  {budgetLevel === 'adset' && <label><span className={label}>Budžet (valuta naloga)</span><input className="input w-full" inputMode="decimal" value={a.budget} onChange={(e) => patch(a.key, { budget: e.target.value })} /></label>}
                </div>
                {b && (
                  <div className="mt-3 text-xs">
                    <p className="mb-1 text-[var(--color-ink-soft)]">{describeTargeting(b.targeting)}</p>
                    <div className="flex flex-wrap gap-2">
                      {entries.map((e) => {
                        const k = entryKey(e)
                        const on = a.keep.includes(k)
                        return (
                          <label key={k} className={`cursor-pointer rounded-full border px-3 py-1 ${on ? 'border-[var(--color-indigo)] bg-[var(--color-indigo-soft)]' : 'border-[var(--color-line)] text-[var(--color-ink-soft)]'}`}>
                            <input type="checkbox" className="mr-1" checked={on} onChange={() => patch(a.key, { keep: on ? a.keep.filter((x) => x !== k) : [...a.keep, k] })} />{e.label}
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label><span className={label}>Primarni tekstovi, jedan po redu (do 5; preporuka 125 znakova: {counter(a.texts, 125)})</span>
                    <textarea className="input h-32 w-full" value={a.texts} onChange={(e) => patch(a.key, { texts: e.target.value })} /></label>
                  <label><span className={label}>Naslovi, jedan po redu (do 5; preporuka 40: {counter(a.titles, 40)})</span>
                    <textarea className="input h-32 w-full" value={a.titles} onChange={(e) => patch(a.key, { titles: e.target.value })} /></label>
                  <label><span className={label}>Opis ({a.description.length}/30)</span><input className="input w-full" value={a.description} onChange={(e) => patch(a.key, { description: e.target.value })} /></label>
                  <label><span className={label}>Dugme (CTA)</span>
                    <select className="input w-full" value={a.cta} onChange={(e) => patch(a.key, { cta: e.target.value })}>{CTAS.map((c) => <option key={c}>{c}</option>)}</select>
                  </label>
                </div>
                {(a.texts || a.titles) && (
                  <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                    {fresh(a).length ? <>Novo (nije iz briefa ni odobrenog copy-ja), pročitaj pažljivo: {fresh(a).map((l) => `„${l}“`).join(', ')}</> : 'Sve je preuzeto iz briefa ili odobrenog copy-ja.'}
                  </p>
                )}
                {adsets.length > 1 && <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => setAdsets(adsets.filter((x) => x.key !== a.key))}>Ukloni ad set</button>}
              </div>
            )
          })}
        </div>
        <button type="button" className="btn-secondary mt-3" onClick={() => setAdsets([...adsets, emptyAdSet()])}>+ Dodaj ad set</button>
      </section>

      <section className="card p-5">
        <p className="mb-1 text-sm font-semibold">3. Tekstovi i slike</p>
        <p className="mb-3 text-xs text-[var(--color-ink-soft)]">
          Claude preuzima odobreni copy doslovno (iz briefa, odobrenih komentara i sheeta koji nalepiš ovde) i piše samo ono što fali. Sheet otvori preko dugmeta „Odobren copy“ gore, označi sve (Ctrl+A), kopiraj i nalepi.
        </p>
        <textarea className="input h-28 w-full" value={sheetCopy} onChange={(e) => setSheetCopy(e.target.value)} placeholder="Nalepi odobreni copy iz sheeta (nije obavezno)" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" onClick={writeCopy} disabled={!brief || writing}>{writing ? 'Pišem oglase…' : 'Napiši oglase iz briefa'}</button>
          {!brief && <span className="text-xs text-[var(--color-ink-soft)]">Prvo izaberi akciju gore.</span>}
        </div>
        {rationale && <p className="mt-3 rounded-lg bg-[var(--color-indigo-soft)] px-3 py-2 text-xs">{rationale}</p>}
        <p className="mt-4 text-xs text-[var(--color-ink-soft)]">
          Slike: {images.length ? images.map((i) => `${i.name} (${FIELD_LABEL[i.field ?? 'SQUARE_MARKETING_IMAGE']})`).join(', ') : 'nijedna; čekiraj ih gore u „Kreative i prilozi“'}. Za svaku sliku pravi se po jedan oglas u svakom ad setu.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={save} disabled={saving || problems.length > 0}>{saving ? 'Čuvam…' : 'Sačuvaj Meta kampanju'}</button>
        {problems.length > 0 && <span className="text-xs text-[var(--color-rust)]">{problems.join(' ')}</span>}
      </div>

      <section className="card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold">Meta kampanje za izvoz · {client.name}</p>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" disabled={!picked.length} onClick={() => setStatus(picked, 'odobreno')}>Odobri</button>
            <button type="button" className="btn-secondary" disabled={!picked.length} onClick={() => setStatus(picked, 'odbijeno')}>Odbaci</button>
            <button type="button" className="btn-primary" disabled={!picked.length} onClick={exportPicked}>Izvezi izabrane u jedan fajl</button>
          </div>
        </div>
        {!drafts.length && <p className="text-xs text-[var(--color-ink-soft)]">Još nema sačuvanih Meta kampanja.</p>}
        <ul className="divide-y divide-[var(--color-line)]">
          {drafts.map((d) => {
            const ads = d.payload.adsets?.reduce((n, s) => n + s.ads.length, 0) ?? 0
            return (
              <li key={d.id} className="flex items-start gap-3 py-2 text-sm">
                <input type="checkbox" className="mt-1" checked={picked.includes(d.id)} disabled={d.status === 'odbijeno'}
                  onChange={() => setPicked(picked.includes(d.id) ? picked.filter((x) => x !== d.id) : [...picked, d.id])} />
                <div className="flex-1">
                  <p className="font-medium">{d.name}</p>
                  <p className="text-xs text-[var(--color-ink-soft)]">
                    {d.payload.adsets?.map((s) => s.name).join(', ')} · {ads} oglasa{d.payload.start ? ` · ${d.payload.start} – ${d.payload.end ?? ''}` : ''}{d.payload.brief_title ? ` · brief „${d.payload.brief_title}“` : ''}
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{STATUS_LABEL[d.status]}{d.exported_at ? ` ${new Date(d.exported_at).toLocaleDateString('sr-RS')}` : ''}</span>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
