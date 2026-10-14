import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { type Brief, downloadText } from '../lib/creatives'

// YouTube video campaigns for one title (a film, a launch): a Video reach campaign (Combo ad group,
// target CPM) and/or a Video views campaign (responsive video ad, target CPV), each with a campaign
// total budget and flight dates, named the way the team names them. Exported Paused for Editor.

type ClientRow = { id: string; name: string; ga4_store: string | null }
type Goal = 'reach' | 'views'
type History = { campaign: string; first_date: string; last_date: string; days: number; spend: number; impressions: number; clicks: number }
type VideoDraft = {
  id: string
  goal: Goal
  title: string
  campaign_name: string
  ad_group_name: string
  start_date: string
  end_date: string
  total_budget: number
  video_ids: string[]
  status: 'draft' | 'exported' | 'published' | 'rejected'
  created_at: string
}
type Props = {
  client: ClientRow
  market: string
  brief: Brief | null
  onMessage: (m: { kind: 'ok' | 'err'; text: string } | null) => void
}

const STATUS_LABEL: Record<VideoDraft['status'], string> = { draft: 'Nacrt', exported: 'Izvezeno', published: 'Objavljeno', rejected: 'Odbačeno' }
// Editor location and language names per market.
const MARKET_GEO: Record<string, { location: string; language: string }> = {
  RS: { location: 'Serbia', language: 'Serbian' },
  HR: { location: 'Croatia', language: 'Croatian' },
  BA: { location: 'Bosnia and Herzegovina', language: 'Bosnian' },
  ME: { location: 'Montenegro', language: 'Serbian' },
  SI: { location: 'Slovenia', language: 'Slovenian' },
  AL: { location: 'Albania', language: 'Albanian' },
}
const GOAL_LABEL: Record<Goal, string> = { reach: 'Video reach (Combo, target CPM)', views: 'Video views (responsive video, target CPV)' }

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)
const names = (title: string, market: string, goal: Goal) => ({
  campaign: `${title} (Mkt:${market};Ct:${goal === 'reach' ? 'Video_Reach' : 'Video_Views'};Ph:All)`,
  adGroup: goal === 'reach' ? `${title} (Tg:Mix;Ad:Combo)` : `${title} (Tg:All;Ad:RVA)`,
})

function youtubeId(raw: string): string | null {
  const t = raw.trim()
  if (/^[\w-]{11}$/.test(t)) return t
  const m = t.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)
  return m ? m[1] : null
}

export default function VideoCampaignForm({ client, market, brief, onMessage }: Props) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [goals, setGoals] = useState<Record<Goal, boolean>>({ reach: true, views: true })
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [budget, setBudget] = useState<Record<Goal, string>>({ reach: '', views: '' })
  const [bid, setBid] = useState<Record<Goal, string>>({ reach: '', views: '' })
  const [finalUrl, setFinalUrl] = useState('')
  const [videos, setVideos] = useState('')
  const [headlines, setHeadlines] = useState('')
  const [longHeadlines, setLongHeadlines] = useState('')
  const [descriptions, setDescriptions] = useState('')
  const [cta, setCta] = useState('')
  const [rationale, setRationale] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<History[]>([])
  const [drafts, setDrafts] = useState<VideoDraft[]>([])
  const mkt = market || 'RS'
  const geo = MARKET_GEO[mkt] ?? MARKET_GEO.RS

  useEffect(() => {
    supabase.rpc('video_campaign_history', { p_client_id: client.id }).then(({ data }) => setHistory((data ?? []) as History[]))
  }, [client.id])

  useEffect(() => {
    if (!brief) return
    setTitle((brief.headline ?? brief.title).trim().toUpperCase())
    setFinalUrl(brief.landing_page ?? '')
    if (brief.start_date) setStart(brief.start_date)
    if (brief.end_date) setEnd(brief.end_date)
  }, [brief])

  async function loadDrafts() {
    const { data, error } = await supabase.from('video_campaign_drafts')
      .select('id, goal, title, campaign_name, ad_group_name, start_date, end_date, total_budget, video_ids, status, created_at')
      .eq('client_id', client.id).order('created_at', { ascending: false })
    if (error) onMessage({ kind: 'err', text: 'Video nacrti nisu učitani.' })
    else setDrafts((data ?? []) as VideoDraft[])
  }
  useEffect(() => { loadDrafts() }, [client.id])

  async function draftTexts() {
    setDrafting(true); onMessage(null); setRationale('')
    const goal: Goal = goals.views && !goals.reach ? 'views' : 'reach'
    const { data, error } = await supabase.functions.invoke('productive-briefs', {
      body: { action: 'draft_video', title, notes, goal, brief, client_name: client.name, market: mkt },
    })
    setDrafting(false)
    if (error || !data || data.error) {
      onMessage({ kind: 'err', text: `Predlog tekstova nije uspeo: ${data?.error ?? error?.message ?? 'nepoznata greška'}` })
      return
    }
    setHeadlines((data.headlines ?? []).join('\n'))
    setLongHeadlines((data.long_headlines ?? []).join('\n'))
    setDescriptions((data.descriptions ?? []).join('\n'))
    setCta(data.call_to_action ?? '')
    setRationale(`${data.rationale ?? ''}${data.dropped_too_long?.length ? ` Izbačeno jer je predugo: ${data.dropped_too_long.length}.` : ''}`)
  }

  const t = title.trim()
  const vids = lines(videos).map(youtubeId)
  const hl = lines(headlines)
  const lh = lines(longHeadlines)
  const ds = lines(descriptions)
  const chosen = (Object.keys(goals) as Goal[]).filter((g) => goals[g])
  const days = start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1 : 0
  const num = (v: string) => Number(v.replace(',', '.'))

  const problems: string[] = []
  if (!t) problems.push('Unesi naziv (npr. naziv filma).')
  if (!chosen.length) problems.push('Izaberi bar jednu kampanju (reach ili views).')
  if (!start || !end || days < 1) problems.push('Unesi datume flighta (kraj posle početka).')
  for (const g of chosen) if (!(num(budget[g]) > 0)) problems.push(`Unesi ukupan budžet za ${g === 'reach' ? 'Video reach' : 'Video views'}.`)
  if (!/^https?:\/\//.test(finalUrl.trim())) problems.push('Final URL mora početi sa http(s)://.')
  if (!vids.length) problems.push('Dodaj bar jedan YouTube video (trejler).')
  if (vids.some((v) => !v)) problems.push('Neki video nije YouTube link ni ID.')
  if (vids.length > 5) problems.push('Najviše 5 videa.')
  if (hl.length < 1 || hl.length > 5 || hl.some((h) => h.length > 15)) problems.push('Potrebno je 1–5 naslova do 15 znakova.')
  if (lh.length < 1 || lh.length > 5 || lh.some((h) => h.length > 90)) problems.push('Potrebno je 1–5 dugih naslova do 90 znakova.')
  if (ds.length < 1 || ds.length > 5 || ds.some((d) => d.length > 70)) problems.push('Potrebno je 1–5 opisa do 70 znakova.')
  if (cta.length > 10) problems.push('Poziv na akciju može imati najviše 10 znakova.')

  const warnings: string[] = []
  for (const g of chosen) {
    const n = names(t, mkt, g)
    if (history.some((h) => h.campaign.replace(/\s+/g, '') === n.campaign.replace(/\s+/g, ''))) warnings.push(`Kampanja „${n.campaign}“ već postoji u nalogu.`)
  }
  if (days > 0 && chosen.length) warnings.push(`Dnevno u proseku: ${chosen.map((g) => `${g === 'reach' ? 'reach' : 'views'} ${(num(budget[g]) / days || 0).toLocaleString('sr-RS', { maximumFractionDigits: 2 })}`).join(', ')}.`)

  async function save() {
    if (problems.length) return
    setBusy(true); onMessage(null)
    const rows = chosen.map((g) => {
      const n = names(t, mkt, g)
      return {
        client_id: client.id, goal: g, title: t, campaign_name: n.campaign, ad_group_name: n.adGroup,
        start_date: start, end_date: end, total_budget: num(budget[g]), target_bid: bid[g] ? num(bid[g]) : null,
        locations: [geo.location], languages: [geo.language], final_url: finalUrl.trim(), video_ids: vids.filter(Boolean),
        headlines: hl, long_headlines: lh, descriptions: ds, call_to_action: cta || null,
        brief_task_id: brief?.task_id ?? null, created_by: 'brain-ui',
      }
    })
    const { error } = await supabase.from('video_campaign_drafts').insert(rows)
    setBusy(false)
    if (error) { onMessage({ kind: 'err', text: `Čuvanje nije uspelo: ${error.message}` }); return }
    onMessage({ kind: 'ok', text: `Sačuvano ${rows.length} video ${rows.length === 1 ? 'kampanja' : 'kampanje'} za „${t}“ kao nacrt. Izvozi se kao Paused.` })
    loadDrafts()
  }

  async function exportDrafts(list: VideoDraft[]) {
    setBusy(true); onMessage(null)
    const { data, error } = await supabase.functions.invoke('export-video-csv', { body: { client_id: client.id, draft_ids: list.map((d) => d.id) } })
    setBusy(false)
    if (error || typeof data !== 'string') {
      onMessage({ kind: 'err', text: `Izvoz nije uspeo: ${data?.error ?? 'nema nacrta ili nemaš pristup'}` })
      return
    }
    const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    downloadText(`editor_video_${slug(client.name)}_${slug(list[0].title)}.csv`, data)
    onMessage({ kind: 'ok', text: 'CSV je preuzet. U Editoru: Import → From file → proveri kampanje (budžet, datumi, publika) → Post; uključi posle provere.' })
    loadDrafts()
  }

  async function setStatus(id: string, status: VideoDraft['status']) {
    const patch: Record<string, unknown> = { status }
    if (status === 'published') patch.published_at = new Date().toISOString()
    const { error } = await supabase.from('video_campaign_drafts').update(patch).eq('id', id)
    if (error) onMessage({ kind: 'err', text: 'Promena statusa nije uspela.' })
    loadDrafts()
  }

  const inputCls = 'w-full rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'
  const labelCls = 'mb-1 block text-xs font-medium text-[var(--color-ink-soft)]'
  const n = (s: string[], max: number) => <span className={s.some((x) => x.length > max) ? 'text-[var(--color-rust)]' : ''}>{s.length}</span>
  // Same title's campaigns side by side.
  const groups = drafts.reduce<Record<string, VideoDraft[]>>((m, d) => ((m[`${d.title}|${d.start_date}`] ??= []).push(d), m), {})

  return (
    <>
      <section className="mb-12">
        <h2 className="font-display mb-1 text-xl font-medium">Nove YouTube video kampanje</h2>
        <p className="mb-4 max-w-2xl text-xs text-[var(--color-ink-soft)]">
          Za jedan naslov (film, kolekciju, lansiranje) pravi kampanju za doseg i/ili preglede, sa ukupnim budžetom i datumima, imenovane kao u nalogu.
          Izvozi se kao <b>Paused</b>; publiku i frekvenciju proveri u Editoru pre uključivanja.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <label className="md:col-span-2"><span className={labelCls}>Naziv (ide u ime kampanje)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ZABORAVLJENI OTOK" className={inputCls} /></label>
          <label><span className={labelCls}>Početak</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} /></label>
          <label><span className={labelCls}>Kraj{days ? ` · ${days} dana` : ''}</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} /></label>
          {(['reach', 'views'] as Goal[]).map((g) => (
            <div key={g} className="md:col-span-2 rounded border border-[var(--color-line)] p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={goals[g]} onChange={(e) => setGoals({ ...goals, [g]: e.target.checked })} />
                {GOAL_LABEL[g]}
              </label>
              {goals[g] && (
                <>
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{t ? `${names(t, mkt, g).campaign} → ${names(t, mkt, g).adGroup}` : 'unesi naziv'}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label><span className={labelCls}>Ukupan budžet (EUR)</span>
                      <input value={budget[g]} onChange={(e) => setBudget({ ...budget, [g]: e.target.value })} className={inputCls} /></label>
                    <label><span className={labelCls}>{g === 'reach' ? 'Target CPM (opciono)' : 'Max CPV (opciono)'}</span>
                      <input value={bid[g]} onChange={(e) => setBid({ ...bid, [g]: e.target.value })} className={inputCls} /></label>
                  </div>
                </>
              )}
            </div>
          ))}
          <label className="md:col-span-2"><span className={labelCls}>Final URL (stranica filma / kupovina karata)</span>
            <input value={finalUrl} onChange={(e) => setFinalUrl(e.target.value)} placeholder="https://…" className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>YouTube videi (trejleri), link ili ID po redu · {vids.filter(Boolean).length}</span>
            <textarea value={videos} onChange={(e) => setVideos(e.target.value)} rows={2} placeholder="https://youtu.be/…" className={inputCls} /></label>
          <label className="md:col-span-4"><span className={labelCls}>Napomene za tekst (premijera, žanr, poruka iz Productive komentara; samo ovo Claude koristi kao činjenice)</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="U kinima od 16.10." className={inputCls} /></label>
          <div className="md:col-span-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={draftTexts} disabled={!t || drafting}
              className="rounded border border-[var(--color-indigo)] px-4 py-2 text-sm font-medium text-[var(--color-indigo)] disabled:cursor-not-allowed disabled:opacity-40">
              {drafting ? 'Pišem tekstove…' : 'Napiši tekstove'}
            </button>
            {rationale && <span className="text-xs text-[var(--color-ink-soft)]">{rationale}</span>}
          </div>
          <label className="md:col-span-2"><span className={labelCls}>Naslovi (1–5, do 15 znakova) · {n(hl, 15)}</span>
            <textarea value={headlines} onChange={(e) => setHeadlines(e.target.value)} rows={5} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Dugi naslovi (1–5, do 90 znakova) · {n(lh, 90)}</span>
            <textarea value={longHeadlines} onChange={(e) => setLongHeadlines(e.target.value)} rows={5} className={inputCls} /></label>
          <label className="md:col-span-2"><span className={labelCls}>Opisi (1–5, do 70 znakova) · {n(ds, 70)}</span>
            <textarea value={descriptions} onChange={(e) => setDescriptions(e.target.value)} rows={4} className={inputCls} /></label>
          <label><span className={labelCls}>Poziv na akciju ({cta.length}/10)</span>
            <input value={cta} onChange={(e) => setCta(e.target.value)} className={inputCls} /></label>
          <div className="text-xs text-[var(--color-ink-soft)]">Lokacija: {geo.location} · jezik: {geo.language}</div>
        </div>
        {(problems.length > 0 || warnings.length > 0) && (
          <ul className="mt-4 list-disc pl-5 text-xs">
            {problems.map((p) => <li key={p} className="text-[var(--color-rust)]">{p}</li>)}
            {warnings.map((w) => <li key={w} className="text-[var(--color-ink-soft)]">{w}</li>)}
          </ul>
        )}
        <button onClick={save} disabled={busy || problems.length > 0}
          className="mt-5 rounded bg-[var(--color-indigo)] px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
          Sačuvaj kampanje
        </button>
      </section>

      {history.length > 0 && (
        <section className="mb-12">
          <h2 className="font-display mb-2 text-xl font-medium">Prethodne video kampanje (referenca za budžet)</h2>
          <table className="w-full text-xs">
            <thead className="text-left text-[var(--color-ink-soft)]"><tr><th className="py-1 pr-3">Kampanja</th><th className="pr-3">Period</th><th className="pr-3 text-right">Dana</th><th className="pr-3 text-right">Potrošeno</th><th className="pr-3 text-right">Prikazi</th><th className="text-right">CPM</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.campaign} className="border-t border-[var(--color-line)]">
                  <td className="py-1 pr-3">{h.campaign}</td><td className="pr-3">{h.first_date} – {h.last_date}</td><td className="pr-3 text-right">{h.days}</td>
                  <td className="pr-3 text-right">{Number(h.spend).toLocaleString('sr-RS')}</td><td className="pr-3 text-right">{Number(h.impressions).toLocaleString('sr-RS')}</td>
                  <td className="text-right">{h.impressions ? (Number(h.spend) / Number(h.impressions) * 1000).toLocaleString('sr-RS', { maximumFractionDigits: 2 }) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2 className="font-display mb-4 text-xl font-medium">Video nacrti za {client.name}</h2>
        {drafts.length === 0 && <p className="text-sm text-[var(--color-ink-soft)]">Još nema video nacrta za ovog klijenta.</p>}
        <div className="space-y-3">
          {Object.values(groups).map((list) => (
            <div key={list[0].id} className="rounded border border-[var(--color-line)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{list[0].title} <span className="font-normal text-[var(--color-ink-soft)]">· {list[0].start_date} – {list[0].end_date}</span></p>
                  {list.map((d) => (
                    <p key={d.id} className="mt-1 text-xs text-[var(--color-ink-soft)]">
                      {d.campaign_name} · {Number(d.total_budget).toLocaleString('sr-RS')} EUR · {d.video_ids.length} videa · {STATUS_LABEL[d.status]}
                      {d.status === 'exported' && <button onClick={() => setStatus(d.id, 'published')} className="ml-2 underline">označi kao objavljeno</button>}
                      {d.status === 'draft' && <button onClick={() => setStatus(d.id, 'rejected')} className="ml-2 text-[var(--color-rust)] underline">odbaci</button>}
                    </p>
                  ))}
                </div>
                {list.some((d) => ['draft', 'exported'].includes(d.status)) && (
                  <button onClick={() => exportDrafts(list.filter((d) => ['draft', 'exported'].includes(d.status)))} disabled={busy}
                    className="rounded border border-[var(--color-indigo)] px-3 py-1 text-xs text-[var(--color-indigo-dark)]">Izvezi CSV</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
