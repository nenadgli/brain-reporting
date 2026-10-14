import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { type Brief, type ImageAsset, FIELD_LABEL, downloadEditorPackage } from '../lib/creatives'

// Demand Gen for an action: a new ad group "<akcija> (Tg:Mix)" in the existing Demand Gen campaign,
// with a multi-image ad (and a video ad when YouTube videos are given). Exported Paused for Editor.

type ClientRow = { id: string; name: string; ga4_store: string | null }
type DgCampaign = { campaign: string; last_date: string; spend_30d: number; ad_groups: string[] }
type DgDraft = {
  id: string
  campaign_name: string
  ad_group_name: string
  copy_settings_from: string | null
  headlines: string[]
  long_headlines: string[]
  descriptions: string[]
  images: ImageAsset[]
  video_ids: string[]
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

const STATUS_LABEL: Record<DgDraft['status'], string> = { draft: 'Nacrt', exported: 'Izvezeno', published: 'Objavljeno', rejected: 'Odbačeno' }
// Editor values; empty = Automated.
const CTAS = ['', 'Shop now', 'Learn more', 'Get offer', 'Sign up', 'Contact us', 'See more']

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)

const pad = (n: number) => String(n).padStart(2, '0')

// "Akcija 08.-11.10. (Tg:Mix)": the campaign's naming, with the dates so that repeated
// generic actions ("Akcija") stay apart.
function groupNameFromBrief(b: Brief): string {
  const base = (b.headline ?? b.title).trim()
  if (!b.start_date) return `${base} (Tg:Mix)`
  const [, sm, sd] = b.start_date.split('-').map(Number)
  if (!b.end_date || b.end_date === b.start_date) return `${base} ${pad(sd)}.${pad(sm)}. (Tg:Mix)`
  const [, em, ed] = b.end_date.split('-').map(Number)
  const dates = sm === em ? `${pad(sd)}.-${pad(ed)}.${pad(em)}.` : `${pad(sd)}.${pad(sm)}.-${pad(ed)}.${pad(em)}.`
  return `${base} ${dates} (Tg:Mix)`
}

function youtubeId(raw: string): string | null {
  const t = raw.trim()
  if (/^[\w-]{11}$/.test(t)) return t
  const m = t.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)
  return m ? m[1] : null
}

export default function DemandGenAdGroupForm({ client, market, brief, images, onSaved, onMessage }: Props) {
  const [campaigns, setCampaigns] = useState<DgCampaign[]>([])
  const [campaign, setCampaign] = useState('')
  const [groupName, setGroupName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [finalUrl, setFinalUrl] = useState('')
  const [headlines, setHeadlines] = useState('')
  const [longHeadlines, setLongHeadlines] = useState('')
  const [descriptions, setDescriptions] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [cta, setCta] = useState('Shop now')
  // Editor sets a Demand Gen ad group's audience by its name ("DMG - Audience"); the client default fills it.
  const [audienceName, setAudienceName] = useState('')
  const [videos, setVideos] = useState('')
  const [rationale, setRationale] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [drafts, setDrafts] = useState<DgDraft[]>([])

  useEffect(() => {
    setBusinessName(client.name.replace(/\s+(RS|HR|BA|ME|SI|AL)$/i, '').slice(0, 25))
    supabase.rpc('demand_gen_campaigns', { p_client_id: client.id }).then(({ data }) => {
      const list = (data ?? []) as DgCampaign[]
      setCampaigns(list)
      setCampaign(list[0]?.campaign ?? '')
    })
  }, [client.id, client.name])

  // The newest ad group of the campaign carries the audience and settings to copy in Editor.
  useEffect(() => {
    setCopyFrom(campaigns.find((c) => c.campaign === campaign)?.ad_groups[0] ?? '')
  }, [campaign, campaigns])

  useEffect(() => {
    setAudienceName('')
    supabase.from('client_editor_defaults').select('dg_audience_name').eq('client_id', client.id).maybeSingle()
      .then(({ data }) => setAudienceName(data?.dg_audience_name ?? ''))
  }, [client.id])

  useEffect(() => {
    if (!brief) return
    setGroupName(groupNameFromBrief(brief))
    setFinalUrl(brief.landing_page ?? '')
  }, [brief])

  async function loadDrafts() {
    const { data, error } = await supabase
      .from('demand_gen_drafts')
      .select('id, campaign_name, ad_group_name, copy_settings_from, headlines, long_headlines, descriptions, images, video_ids, status, brief_title, created_at')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
    if (error) onMessage({ kind: 'err', text: 'Demand Gen nacrti nisu učitani.' })
    else setDrafts((data ?? []) as DgDraft[])
  }
  useEffect(() => { loadDrafts() }, [client.id])

  async function draftFromBrief() {
    if (!brief) return
    setDrafting(true); onMessage(null); setRationale('')
    const { data, error } = await supabase.functions.invoke('productive-briefs', {
      body: { action: 'draft_demand_gen', brief, client_name: client.name, market },
    })
    setDrafting(false)
    if (error || !data || data.error) {
      onMessage({ kind: 'err', text: `Predlog iz briefa nije uspeo: ${data?.error ?? error?.message ?? 'nepoznata greška'}` })
      return
    }
    setHeadlines((data.headlines ?? []).join('\n'))
    setLongHeadlines((data.long_headlines ?? []).join('\n'))
    setDescriptions((data.descriptions ?? []).join('\n'))
    setRationale(`Iz Productive briefa „${brief.title}“. ${data.rationale ?? ''}` +
      (data.dropped_too_long?.length ? ` Izbačeno jer je predugo: ${data.dropped_too_long.length}.` : ''))
  }

  const hl = lines(headlines)
  const lh = lines(longHeadlines)
  const ds = lines(descriptions)
  const vids = lines(videos).map(youtubeId)
  const count = (f: ImageAsset['field']) => images.filter((i) => i.field === f).length
  const logos = count('LOGO')
  const marketing = images.length - logos

  // Blocking problems (Google rejects the ad) and warnings (it works, but weaker).
  const problems: string[] = []
  if (!campaign) problems.push('Izaberi Demand Gen kampanju.')
  if (!groupName.trim()) problems.push('Unesi naziv ad grupe.')
  if (!/^https?:\/\//.test(finalUrl.trim())) problems.push('Final URL mora početi sa http(s)://.')
  if (hl.length < 1 || hl.length > 5) problems.push('Potrebno je 1–5 naslova.')
  if (hl.some((h) => h.length > 40)) problems.push('Naslov duži od 40 znakova.')
  if (ds.length < 1 || ds.length > 5) problems.push('Potrebno je 1–5 opisa.')
  if (ds.some((d) => d.length > 90)) problems.push('Opis duži od 90 znakova.')
  if (!businessName.trim()) problems.push('Unesi naziv firme.')
  if (businessName.length > 25) problems.push('Naziv firme može imati najviše 25 znakova.')
  if (!marketing) problems.push('Izaberi bar jednu sliku (1.91:1 ili 1:1).')
  if (marketing > 20) problems.push('Najviše 20 slika po oglasu.')
  if (!logos) problems.push('Izaberi logo (kvadratna slika, označi „ovo je logo“).')
  if (logos > 1) problems.push('Demand Gen oglas ima jedan logo.')
  if (vids.some((v) => !v)) problems.push('Neki video nije YouTube link ni ID.')
  if (vids.length > 5) problems.push('Najviše 5 videa.')
  if (vids.length && (lh.length < 1 || lh.length > 5)) problems.push('Za video oglas je potrebno 1–5 dugih naslova.')
  if (lh.some((h) => h.length > 90)) problems.push('Dugi naslov duži od 90 znakova.')

  const warnings: string[] = []
  if (!count('MARKETING_IMAGE')) warnings.push('Nema horizontalne slike 1.91:1; oglas se neće prikazivati u svim formatima.')
  if (!count('SQUARE_MARKETING_IMAGE')) warnings.push('Nema kvadratne slike 1:1.')
  if (!count('PORTRAIT_MARKETING_IMAGE')) warnings.push('Nema vertikalne slike 4:5 (preporučeno za YouTube Shorts i Discover).')
  if (hl.length < 5) warnings.push('Google preporučuje 5 naslova.')
  if (!audienceName.trim()) warnings.push('Nema publike ad grupe; bez nje Demand Gen cilja široko (optimized targeting).')
  if (groupName && campaigns.find((c) => c.campaign === campaign)?.ad_groups.includes(groupName.trim())) warnings.push('Ad grupa sa tim imenom već postoji u kampanji.')

  async function save() {
    if (problems.length) return
    setBusy(true); onMessage(null)
    const { error } = await supabase.from('demand_gen_drafts').insert({
      client_id: client.id,
      campaign_name: campaign,
      ad_group_name: groupName.trim(),
      copy_settings_from: copyFrom || null,
      audience_name: audienceName.trim() || null,
      final_url: finalUrl.trim(),
      headlines: hl,
      long_headlines: vids.length ? lh : [],
      descriptions: ds,
      business_name: businessName.trim(),
      call_to_action: cta || null,
      images,
      video_ids: vids.filter(Boolean),
      brief_task_id: brief?.task_id ?? null,
      brief_title: brief?.title ?? null,
      start_date: brief?.start_date ?? null,
      end_date: brief?.end_date ?? null,
      created_by: 'brain-ui',
    })
    setBusy(false)
    if (error) {
      onMessage({ kind: 'err', text: `Čuvanje nije uspelo: ${error.message}` })
      return
    }
    onMessage({ kind: 'ok', text: `Ad grupa „${groupName.trim()}“ sačuvana kao nacrt (${marketing} slika, ${vids.length} videa). Izvozi se kao Paused.` })
    setHeadlines(''); setLongHeadlines(''); setDescriptions(''); setVideos(''); setRationale('')
    onSaved()
    loadDrafts()
  }

  async function exportDrafts(list: DgDraft[]) {
    setBusy(true); onMessage(null)
    const { data, error } = await supabase.functions.invoke('export-demand-gen-csv', {
      body: { client_id: client.id, draft_ids: list.map((d) => d.id) },
    })
    if (error || typeof data !== 'string') {
      setBusy(false)
      onMessage({ kind: 'err', text: `Izvoz nije uspeo: ${data?.error ?? 'nema nacrta ili nemaš pristup'}` })
      return
    }
    const slug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const label = list.length === 1 ? list[0].ad_group_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'demand-gen'
    const res = await downloadEditorPackage(`editor_dg_${slug}_${label}`, data, list.flatMap((d) => d.images ?? []))
    setBusy(false)
    const copy = list.find((d) => d.copy_settings_from)?.copy_settings_from
    onMessage({ kind: res.ok ? 'ok' : 'err', text: res.text + (copy ? ` Ostala podešavanja ad grupe proveri prema „${copy}“ pre uključivanja.` : '') })
    loadDrafts()
  }

  async function setStatus(id: string, status: DgDraft['status']) {
    const patch: Record<string, unknown> = { status }
    if (status === 'published') patch.published_at = new Date().toISOString()
    const { error } = await supabase.from('demand_gen_drafts').update(patch).eq('id', id)
    if (error) onMessage({ kind: 'err', text: 'Promena statusa nije uspela.' })
    loadDrafts()
  }

  const inputCls = 'w-full rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'
  const labelCls = 'mb-1 block text-xs font-medium text-[var(--color-ink-soft)]'
  const n = (s: string[], max: number) => <span className={s.some((x) => x.length > max) ? 'text-[var(--color-rust)]' : ''}>{s.length}</span>

  return (
    <>
      <section className="mb-12">
        <h2 className="font-display mb-1 text-xl font-medium">Nova Demand Gen ad grupa</h2>
        <p className="mb-4 max-w-2xl text-xs text-[var(--color-ink-soft)]">
          Dodaje se kao <b>Paused</b> ad grupa u postojeću Demand Gen kampanju, kao što se do sada radilo za akcije, uz PMax asset grupu iz istog briefa.
          Tekstove piše Claude iz briefa; slike i logo biraš gore u prilozima. Publiku preuzmi iz prethodne ad grupe pre uključivanja.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <label className="md:col-span-2"><span className={labelCls}>Demand Gen kampanja</span>
            <select value={campaign} onChange={(e) => setCampaign(e.target.value)} className={inputCls}>
              <option value="">{campaigns.length ? '— izaberi —' : 'nema Demand Gen kampanja u podacima'}</option>
              {campaigns.map((c) => (
                <option key={c.campaign} value={c.campaign}>{c.campaign} · {c.ad_groups.length} ad grupa · {Number(c.spend_30d).toLocaleString('sr-RS')} (30 d)</option>
              ))}
            </select></label>
          <label className="md:col-span-2"><span className={labelCls}>Naziv ad grupe</span>
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Akcija (Tg:Mix)" className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Publika ad grupe (Audience name, kao u Editoru)</span>
            <input value={audienceName} onChange={(e) => setAudienceName(e.target.value)} placeholder="DMG - Audience" className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Ostala podešavanja (lokacije, jezici) kao u ad grupi</span>
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} className={inputCls}>
              <option value="">— ne kopiraj —</option>
              {(campaigns.find((c) => c.campaign === campaign)?.ad_groups ?? []).map((g) => <option key={g} value={g}>{g}</option>)}
            </select></label>
          <label className="md:col-span-2"><span className={labelCls}>Final URL</span>
            <input value={finalUrl} onChange={(e) => setFinalUrl(e.target.value)} placeholder="https://…" className={inputCls} /></label>
          <div className="md:col-span-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={draftFromBrief} disabled={!brief || drafting}
              className="rounded border border-[var(--color-indigo)] px-4 py-2 text-sm font-medium text-[var(--color-indigo)] disabled:cursor-not-allowed disabled:opacity-40">
              {drafting ? 'Pišem tekstove…' : 'Popuni tekstove iz briefa'}
            </button>
            <span className="text-xs text-[var(--color-ink-soft)]">{brief ? `Brief: ${brief.title}` : 'Izaberi akciju gore.'}</span>
          </div>
          {rationale && <p className="md:col-span-4 rounded bg-[var(--color-indigo-soft)] px-4 py-2 text-xs text-[var(--color-indigo-dark)]">{rationale}</p>}
          <label className="md:col-span-2"><span className={labelCls}>Naslovi, jedan po redu (1–5, do 40 znakova) · {n(hl, 40)}</span>
            <textarea value={headlines} onChange={(e) => setHeadlines(e.target.value)} rows={5} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Opisi (1–5, do 90 znakova) · {n(ds, 90)}</span>
            <textarea value={descriptions} onChange={(e) => setDescriptions(e.target.value)} rows={5} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>YouTube videi, link ili ID po redu (do 5; prazno = samo oglas sa slikama) · {vids.filter(Boolean).length}</span>
            <textarea value={videos} onChange={(e) => setVideos(e.target.value)} rows={3} placeholder="https://youtu.be/…" className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Dugi naslovi za video oglas (1–5, do 90 znakova) · {n(lh, 90)}</span>
            <textarea value={longHeadlines} onChange={(e) => setLongHeadlines(e.target.value)} rows={3} className={inputCls} /></label>
          <label><span className={labelCls}>Naziv firme ({businessName.length}/25)</span>
            <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={inputCls} /></label>
          <label><span className={labelCls}>Call to action</span>
            <select value={cta} onChange={(e) => setCta(e.target.value)} className={inputCls}>
              {CTAS.map((c) => <option key={c} value={c}>{c || 'Automatski'}</option>)}
            </select></label>
          <div className="md:col-span-4 text-xs text-[var(--color-ink-soft)]">
            Izabrane slike: {images.length === 0 ? 'nijedna' : images.map((i) => `${i.name} (${FIELD_LABEL[i.field ?? 'MARKETING_IMAGE']})`).join(' · ')}
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
          Sačuvaj ad grupu
        </button>
      </section>

      <section>
        <h2 className="font-display mb-4 text-xl font-medium">Demand Gen nacrti za {client.name}</h2>
        {drafts.length === 0 && <p className="text-sm text-[var(--color-ink-soft)]">Još nema Demand Gen nacrta za ovog klijenta.</p>}
        <div className="space-y-3">
          {drafts.map((d) => (
            <div key={d.id} className="rounded border border-[var(--color-line)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{d.ad_group_name} <span className="font-normal text-[var(--color-ink-soft)]">→ {d.campaign_name}</span></p>
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                    {STATUS_LABEL[d.status]} · {d.headlines.length} naslova · {d.descriptions.length} opisa · {d.images?.length ?? 0} slika · {d.video_ids.length} videa
                    {d.copy_settings_from && ` · publika kao „${d.copy_settings_from}“`}
                    {d.brief_title && ` · brief „${d.brief_title}“`}
                  </p>
                </div>
                <div className="flex gap-2 text-xs">
                  {['draft', 'exported'].includes(d.status) && (
                    <button onClick={() => exportDrafts([d])} disabled={busy} className="rounded border border-[var(--color-indigo)] px-3 py-1 text-[var(--color-indigo-dark)]">
                      {d.images?.length ? 'Izvezi paket (CSV + slike)' : 'Izvezi CSV'}
                    </button>
                  )}
                  {d.status === 'exported' && (
                    <button onClick={() => setStatus(d.id, 'published')} className="rounded border border-[var(--color-line)] px-3 py-1">Označi kao objavljeno</button>
                  )}
                  {d.status === 'draft' && (
                    <button onClick={() => setStatus(d.id, 'rejected')} className="rounded border border-[var(--color-line)] px-3 py-1 text-[var(--color-rust)]">Odbaci</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
