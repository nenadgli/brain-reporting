import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { type Brief, type ImageAsset, FIELD_LABEL, downloadEditorPackage } from '../lib/creatives'

type ClientRow = { id: string; name: string; ga4_store: string | null }
type PmaxCampaign = { campaign: string; last_date: string; spend_30d: number; asset_groups: string[] }
type PmaxDraft = {
  id: string
  campaign_name: string
  asset_group_name: string
  headlines: string[]
  long_headlines: string[]
  descriptions: string[]
  search_themes: string[]
  images: ImageAsset[]
  video_ids: string[]
  status: 'draft' | 'exported' | 'published' | 'rejected'
  brief_title: string | null
  start_date: string | null
  end_date: string | null
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

const STATUS_LABEL: Record<PmaxDraft['status'], string> = { draft: 'Nacrt', exported: 'Izvezeno', published: 'Objavljeno', rejected: 'Odbačeno' }
// Editor values; empty = Automated.
const CTAS = ['', 'Shop now', 'Learn more', 'Get offer', 'Sign up', 'Contact us']

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)
const pad = (n: number) => String(n).padStart(2, '0')

// "Akcija 08.-11.10." like the asset groups already in the account.
function groupNameFromBrief(b: Brief): string {
  const base = (b.headline ?? b.title).trim()
  if (!b.start_date) return base
  const [, sm, sd] = b.start_date.split('-').map(Number)
  if (!b.end_date || b.end_date === b.start_date) return `${base} ${pad(sd)}.${pad(sm)}.`
  const [, em, ed] = b.end_date.split('-').map(Number)
  return sm === em ? `${base} ${pad(sd)}.-${pad(ed)}.${pad(em)}.` : `${base} ${pad(sd)}.${pad(sm)}.-${pad(ed)}.${pad(em)}.`
}

// Accepts a bare 11-character id or any YouTube link.
function youtubeId(raw: string): string | null {
  const t = raw.trim()
  if (/^[\w-]{11}$/.test(t)) return t
  const m = t.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)
  return m ? m[1] : null
}

export default function PmaxAssetGroupForm({ client, market, brief, images, onSaved, onMessage }: Props) {
  const [campaigns, setCampaigns] = useState<PmaxCampaign[]>([])
  const [campaign, setCampaign] = useState('')
  const [groupName, setGroupName] = useState('')
  const [finalUrl, setFinalUrl] = useState('')
  const [path1, setPath1] = useState('')
  const [path2, setPath2] = useState('')
  const [headlines, setHeadlines] = useState('')
  const [longHeadlines, setLongHeadlines] = useState('')
  const [descriptions, setDescriptions] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [cta, setCta] = useState('')
  const [themes, setThemes] = useState('')
  const [videos, setVideos] = useState('')
  const [rationale, setRationale] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [drafts, setDrafts] = useState<PmaxDraft[]>([])

  useEffect(() => {
    // F&F PMax campaigns use Brand guidelines: business name and logos live on the campaign, so empty here.
    setBusinessName('')
    supabase.rpc('pmax_campaigns', { p_client_id: client.id }).then(({ data }) => {
      const list = ((data ?? []) as PmaxCampaign[]).filter((c) => /pmax|performance/i.test(c.campaign))
      setCampaigns(list)
      // Actions usually get their own asset group in the campaign that already holds earlier actions.
      const withActions = list.find((c) => c.asset_groups.some((g) => /^akcij/i.test(g)))
      setCampaign((withActions ?? list[0])?.campaign ?? '')
    })
  }, [client.id, client.name])

  useEffect(() => {
    if (!brief) return
    setGroupName(groupNameFromBrief(brief))
    setFinalUrl(brief.landing_page ?? '')
  }, [brief])

  async function loadDrafts() {
    const { data, error } = await supabase
      .from('pmax_asset_group_drafts')
      .select('id, campaign_name, asset_group_name, headlines, long_headlines, descriptions, search_themes, images, video_ids, status, brief_title, start_date, end_date, created_at')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
    if (error) onMessage({ kind: 'err', text: 'PMax nacrti nisu učitani.' })
    else setDrafts((data ?? []) as PmaxDraft[])
  }
  useEffect(() => { loadDrafts() }, [client.id])

  async function draftFromBrief() {
    if (!brief) return
    setDrafting(true); onMessage(null); setRationale('')
    const { data, error } = await supabase.functions.invoke('productive-briefs', {
      body: { action: 'draft_pmax', brief, client_name: client.name, market },
    })
    setDrafting(false)
    if (error || !data || data.error) {
      onMessage({ kind: 'err', text: `Predlog iz briefa nije uspeo: ${data?.error ?? error?.message ?? 'nepoznata greška'}` })
      return
    }
    setHeadlines((data.headlines ?? []).join('\n'))
    setLongHeadlines((data.long_headlines ?? []).join('\n'))
    setDescriptions((data.descriptions ?? []).join('\n'))
    setThemes((data.search_themes ?? []).join('\n'))
    setRationale(`Iz Productive briefa „${brief.title}“. ${data.rationale ?? ''}` +
      (data.dropped_too_long?.length ? ` Izbačeno jer je predugo: ${data.dropped_too_long.length}.` : ''))
  }

  const hl = lines(headlines)
  const lh = lines(longHeadlines)
  const ds = lines(descriptions)
  const th = lines(themes)
  const vidRaw = lines(videos)
  const vids = vidRaw.map(youtubeId)
  const count = (f: ImageAsset['field']) => images.filter((i) => i.field === f).length
  const logos = count('LOGO') + count('LANDSCAPE_LOGO')

  // Blocking problems (Google rejects the asset group) and warnings (it works, but weaker).
  const problems: string[] = []
  if (!campaign) problems.push('Izaberi PMax kampanju.')
  if (!groupName.trim()) problems.push('Unesi naziv asset grupe.')
  if (!/^https?:\/\//.test(finalUrl.trim())) problems.push('Final URL mora početi sa http(s)://.')
  if (path1.length > 15 || path2.length > 15) problems.push('Path može imati najviše 15 znakova.')
  if (hl.length < 3 || hl.length > 15) problems.push('Potrebno je 3–15 naslova.')
  if (hl.some((h) => h.length > 30)) problems.push('Naslov duži od 30 znakova.')
  if (hl.length && !hl.some((h) => h.length <= 15)) problems.push('Bar jedan naslov mora imati najviše 15 znakova.')
  if (lh.length < 1 || lh.length > 5) problems.push('Potrebno je 1–5 dugih naslova.')
  if (lh.some((h) => h.length > 90)) problems.push('Dugi naslov duži od 90 znakova.')
  if (ds.length < 2 || ds.length > 5) problems.push('Potrebno je 2–5 opisa.')
  if (ds.some((d) => d.length > 90)) problems.push('Opis duži od 90 znakova.')
  if (ds.length && !ds.some((d) => d.length <= 60)) problems.push('Bar jedan opis mora imati najviše 60 znakova.')
  if (businessName.length > 25) problems.push('Naziv firme može imati najviše 25 znakova.')
  if (images.length - logos > 20) problems.push('Najviše 20 slika.')
  if (logos > 5) problems.push('Najviše 5 logotipa.')
  if (vids.some((v) => !v)) problems.push('Neki video nije YouTube link ni ID.')
  if (vids.length > 5) problems.push('Najviše 5 videa.')
  if (th.length > 25) problems.push('Najviše 25 tema pretrage.')
  if (th.some((t) => t.length > 80)) problems.push('Tema pretrage duža od 80 znakova.')

  const warnings: string[] = []
  if (!count('MARKETING_IMAGE')) warnings.push('Nema horizontalne slike 1.91:1 (Google traži bar jednu).')
  if (!count('SQUARE_MARKETING_IMAGE')) warnings.push('Nema kvadratne slike 1:1 (Google traži bar jednu).')
  if (!logos) warnings.push('Nema logotipa; ok samo ako kampanja koristi Brand guidelines.')
  if (!businessName.trim()) warnings.push('Nema naziva firme; ok samo ako kampanja koristi Brand guidelines.')
  if (!vids.length) warnings.push('Bez videa Google sam pravi video od slika; YT verzije iz podtaska prvo okači na YouTube pa nalepi linkove.')
  if (groupName && campaigns.find((c) => c.campaign === campaign)?.asset_groups.includes(groupName.trim())) warnings.push('Asset grupa sa tim imenom već postoji u kampanji.')

  async function save() {
    if (problems.length) return
    setBusy(true); onMessage(null)
    const { error } = await supabase.from('pmax_asset_group_drafts').insert({
      client_id: client.id,
      campaign_name: campaign,
      asset_group_name: groupName.trim(),
      final_url: finalUrl.trim(),
      path1: path1.trim() || null,
      path2: path2.trim() || null,
      headlines: hl,
      long_headlines: lh,
      descriptions: ds,
      business_name: businessName.trim() || null,
      call_to_action: cta || null,
      search_themes: th,
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
    onMessage({ kind: 'ok', text: `Asset grupa „${groupName.trim()}“ sačuvana kao nacrt (${images.length} slika, ${vids.length} videa). Izvozi se kao Paused.` })
    setHeadlines(''); setLongHeadlines(''); setDescriptions(''); setThemes(''); setVideos(''); setRationale('')
    onSaved()
    loadDrafts()
  }

  async function exportDrafts(ds: PmaxDraft[]) {
    setBusy(true); onMessage(null)
    const { data, error } = await supabase.functions.invoke('export-pmax-csv', {
      body: { client_id: client.id, draft_ids: ds.map((d) => d.id) },
    })
    if (error || typeof data !== 'string') {
      setBusy(false)
      onMessage({ kind: 'err', text: `Izvoz nije uspeo: ${data?.error ?? 'nema nacrta ili nemaš pristup'}` })
      return
    }
    const slug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const label = ds.length === 1 ? ds[0].asset_group_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'pmax'
    const res = await downloadEditorPackage(`editor_pmax_${slug}_${label}`, data, ds.flatMap((d) => d.images ?? []))
    setBusy(false)
    const imgs = ds.reduce((n, d) => n + (d.images?.length ?? 0), 0)
    onMessage({ kind: res.ok ? 'ok' : 'err', text: res.text + (imgs ? ` Slike (${imgs}) su u folderu images/: u Editoru ih dodaj asset grupi ručno (Editor ne uvozi slike asset grupe iz CSV-a).` : '') })
    loadDrafts()
  }

  async function setStatus(id: string, status: PmaxDraft['status']) {
    const patch: Record<string, unknown> = { status }
    if (status === 'published') patch.published_at = new Date().toISOString()
    const { error } = await supabase.from('pmax_asset_group_drafts').update(patch).eq('id', id)
    if (error) onMessage({ kind: 'err', text: 'Promena statusa nije uspela.' })
    loadDrafts()
  }

  const inputCls = 'w-full rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'
  const labelCls = 'mb-1 block text-xs font-medium text-[var(--color-ink-soft)]'
  const n = (s: string[], max: number) => <span className={s.some((x) => x.length > max) ? 'text-[var(--color-rust)]' : ''}>{s.length}</span>

  return (
    <>
      <section className="mb-12">
        <h2 className="font-display mb-1 text-xl font-medium">Nova PMax asset grupa</h2>
        <p className="mb-4 max-w-2xl text-xs text-[var(--color-ink-soft)]">
          Dodaje se kao <b>Paused</b> asset grupa u postojeću PMax kampanju, kao što se do sada radilo za akcije. Tekstove piše Claude iz briefa;
          slike i logotipe biraš gore u prilozima. Proveri listing grupe (proizvode) u Editoru pre uključivanja.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <label className="md:col-span-2"><span className={labelCls}>PMax kampanja</span>
            <select value={campaign} onChange={(e) => setCampaign(e.target.value)} className={inputCls}>
              <option value="">{campaigns.length ? '— izaberi —' : 'nema PMax kampanja u podacima'}</option>
              {campaigns.map((c) => (
                <option key={c.campaign} value={c.campaign}>{c.campaign} · {c.asset_groups.length} grupa · {c.spend_30d.toLocaleString('sr-RS')} (30 d)</option>
              ))}
            </select></label>
          <label className="md:col-span-2"><span className={labelCls}>Naziv asset grupe</span>
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Akcija 08.-11.10." className={inputCls} /></label>
          <div className="md:col-span-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={draftFromBrief} disabled={!brief || drafting}
              className="rounded border border-[var(--color-indigo)] px-4 py-2 text-sm font-medium text-[var(--color-indigo)] disabled:cursor-not-allowed disabled:opacity-40">
              {drafting ? 'Pišem tekstove…' : 'Popuni tekstove iz briefa'}
            </button>
            <span className="text-xs text-[var(--color-ink-soft)]">{brief ? `Brief: ${brief.title}` : 'Izaberi akciju gore.'}</span>
          </div>
          {rationale && <p className="md:col-span-4 rounded bg-[var(--color-indigo-soft)] px-4 py-2 text-xs text-[var(--color-indigo-dark)]">{rationale}</p>}
          <label className="md:col-span-2"><span className={labelCls}>Final URL</span>
            <input value={finalUrl} onChange={(e) => setFinalUrl(e.target.value)} placeholder="https://…" className={inputCls} /></label>
          <label><span className={labelCls}>Path 1 ({path1.length}/15)</span>
            <input value={path1} onChange={(e) => setPath1(e.target.value)} className={inputCls} /></label>
          <label><span className={labelCls}>Path 2 ({path2.length}/15)</span>
            <input value={path2} onChange={(e) => setPath2(e.target.value)} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Naslovi, jedan po redu (3–15, do 30 znakova, bar jedan do 15) · {n(hl, 30)}</span>
            <textarea value={headlines} onChange={(e) => setHeadlines(e.target.value)} rows={8} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Dugi naslovi (1–5, do 90 znakova) · {n(lh, 90)}</span>
            <textarea value={longHeadlines} onChange={(e) => setLongHeadlines(e.target.value)} rows={8} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Opisi (2–5, do 90 znakova, bar jedan do 60) · {n(ds, 90)}</span>
            <textarea value={descriptions} onChange={(e) => setDescriptions(e.target.value)} rows={6} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Teme pretrage (search themes, do 25) · {n(th, 80)}</span>
            <textarea value={themes} onChange={(e) => setThemes(e.target.value)} rows={6} className={inputCls} /></label>
          <label><span className={labelCls}>Naziv firme ({businessName.length}/25; prazno ako kampanja koristi Brand guidelines)</span>
            <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={inputCls} /></label>
          <label><span className={labelCls}>Call to action</span>
            <select value={cta} onChange={(e) => setCta(e.target.value)} className={inputCls}>
              {CTAS.map((c) => <option key={c} value={c}>{c || 'Automatski'}</option>)}
            </select></label>
          <label className="md:col-span-2"><span className={labelCls}>YouTube videi, link ili ID po redu (do 5) · {vids.filter(Boolean).length}</span>
            <textarea value={videos} onChange={(e) => setVideos(e.target.value)} rows={3} placeholder="https://youtu.be/…" className={inputCls} /></label>
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
          Sačuvaj asset grupu
        </button>
      </section>

      <section>
        <h2 className="font-display mb-4 text-xl font-medium">PMax nacrti za {client.name}</h2>
        {drafts.length === 0 && <p className="text-sm text-[var(--color-ink-soft)]">Još nema PMax nacrta za ovog klijenta.</p>}
        <div className="space-y-3">
          {drafts.map((d) => (
            <div key={d.id} className="rounded border border-[var(--color-line)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{d.asset_group_name} <span className="font-normal text-[var(--color-ink-soft)]">→ {d.campaign_name}</span></p>
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                    {STATUS_LABEL[d.status]} · {d.headlines.length} naslova · {d.long_headlines.length} dugih · {d.descriptions.length} opisa · {d.images?.length ?? 0} slika · {d.video_ids.length} videa · {d.search_themes.length} tema
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
