import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { landingFor } from '../lib/briefFill'
import { type Attachment, type Brief, type ImageAsset, assetFileName, checkImage, downloadEditorPackage, downloadText, imageSize } from '../lib/creatives'
import { type BaseAdSet, type MetaCampaign, type Objective, type Targeting, META_URL_TAGS, OBJECTIVES, downloadMetaPackage } from '../lib/metaBulk'
import {
  type PastAction, type PastRow, type PlanItem, KIND_LABEL, actionLabel, actionName, bestAction, buildItems, fillBudgets, groupActions, opLabel, planCsv, shortRange,
} from '../lib/actionPlan'

// "Dupliraj prošlu akciju": pick the brief, Brain finds the same (or the last) action in the account and lays out
// everything it had, renamed for the new action with the new dates, budgets from the media plan and the landing page.
// Texts are written once for the whole action and images are picked once; the plan is saved with all of it.
// Out of it come the Meta import file (new ad sets copy the old ones' targeting), the Editor file for the new PMax
// asset groups and the plan as a sheet. Everything goes in Paused; the Ads APIs will later run the same plan.

type ClientRow = { id: string; name: string; ga4_store: string | null }
type Props = { client: ClientRow; market: string; brief: Brief | null; attachments: Attachment[]; onMessage: (m: { kind: 'ok' | 'err'; text: string } | null) => void }
type PlanImage = { attachment_id: string; name: string; file: string; width: number; height: number; content_type: string | null; size_bytes: number | null }
type MetaCopy = { primary_texts: string[]; headlines: string[]; description: string; cta: string }
type Copy = {
  pmax?: { headlines: string[]; long_headlines: string[]; descriptions: string[]; search_themes: string[] }
  search?: { headlines: string[]; descriptions: string[] }
  demand_gen?: { headlines: string[]; long_headlines: string[]; descriptions: string[] }
  meta?: Record<string, MetaCopy>
  note?: string
}
type Plan = { id: string; brief_task_id: string | null; name: string; start_date: string | null; end_date: string | null; source: { action: string | null }; items: PlanItem[]; copy: Copy; images: PlanImage[]; status: string; updated_at: string }

const STATUS_LABEL: Record<string, string> = { nacrt: 'Nacrt', spremno: 'Spremno', napravljeno: 'Napravljeno (Paused)', 'odbačeno': 'Odbačeno' }
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)
const clean = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w%-]+/g, '_').replace(/^_|_$/g, '')
const asAttachment = (i: PlanImage) => ({ content_type: i.content_type, size_bytes: i.size_bytes, name: i.name }) as Attachment
const asset = (i: PlanImage, ratio: string, field?: ImageAsset['field']): ImageAsset => ({ attachment_id: i.attachment_id, name: i.name, file: i.file, width: i.width, height: i.height, ratio, field })

function googleImage(i: PlanImage) { const r = checkImage(asAttachment(i), i.width, i.height, 'pmax'); return 'problem' in r ? null : asset(i, r.ratio, r.field) }
function metaImage(i: PlanImage) { const r = checkImage(asAttachment(i), i.width, i.height, 'meta'); return 'problem' in r ? null : asset(i, r.ratio, r.field) }

function copyText(t: string) { navigator.clipboard?.writeText(t).catch(() => {}) }

export default function DuplicateAction({ client, market, brief, attachments, onMessage }: Props) {
  const [rows, setRows] = useState<PastRow[] | null>(null)
  const [rowsError, setRowsError] = useState('')
  const [plans, setPlans] = useState<Plan[]>([])
  const [planId, setPlanId] = useState<string | null>(null)
  const [status, setStatus] = useState('nacrt')
  const [actionKey, setActionKey] = useState('')
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [items, setItems] = useState<PlanItem[]>([])
  const [copy, setCopy] = useState<Copy>({})
  const [images, setImages] = useState<PlanImage[]>([])
  const [imgNotes, setImgNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [notes, setNotes] = useState<string[]>([])

  useEffect(() => {
    setRows(null); setRowsError('')
    supabase.rpc('past_actions', { p_client_id: client.id, p_days: 180 }).then(({ data, error }) => {
      if (error) { setRowsError(error.message); setRows([]); return }
      setRows((data ?? []) as PastRow[])
    })
    loadPlans()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id])

  async function loadPlans() {
    const { data } = await supabase.from('action_plans').select('id, brief_task_id, name, start_date, end_date, source, items, copy, images, status, updated_at').eq('client_id', client.id).order('updated_at', { ascending: false }).limit(30)
    setPlans((data ?? []) as Plan[])
    return (data ?? []) as Plan[]
  }

  const actions = useMemo(() => (rows ? groupActions(rows, brief) : []), [rows, brief])
  const action = actions.find((a) => a.key === actionKey) ?? null

  // A brief opens its saved plan; a brief without one gets a fresh plan from the best matching past action.
  useEffect(() => {
    if (!brief || !rows) return
    const saved = plans.find((p) => p.brief_task_id === brief.task_id && p.status !== 'odbačeno')
    if (saved) { openPlan(saved); return }
    setPlanId(null); setStatus('nacrt'); setCopy({}); setImages([]); setImgNotes({})
    const n = actionName(brief)
    setName(n); setStart(brief.start_date ?? ''); setEnd(brief.end_date ?? brief.start_date ?? '')
    const best = bestAction(actions)
    setActionKey(best?.key ?? '')
    if (best && brief.start_date) rebuild(best, n, brief.start_date, brief.end_date ?? brief.start_date)
    else setItems([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief?.task_id, rows, plans.length])

  function openPlan(p: Plan) {
    setPlanId(p.id); setStatus(p.status); setName(p.name); setStart(p.start_date ?? ''); setEnd(p.end_date ?? '')
    setItems(p.items ?? []); setCopy(p.copy ?? {}); setImages(p.images ?? []); setActionKey(p.source?.action ?? ''); setNotes([])
  }

  async function rebuild(a: PastAction, n: string, s: string, e: string) {
    if (!brief) return
    setBusy('Slažem plan…')
    let list = buildItems(a, n, s, e)
    list = await fillBudgets(client.id, brief, list)
    const out: string[] = []
    // The new action's page: from the brief, else the account's page that matches the action's name.
    const l = await landingFor(client.id, brief)
    if (l) list = list.map((it) => ({ ...it, final_url: l.url, url_why: l.why }))
    else out.push('Landing page nije pronađen ni u briefu ni u nalogu; upiši ga za svaku stavku.')
    setItems(list); setNotes(out); setBusy('')
  }

  function patch(key: string, p: Partial<PlanItem>) { setItems((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x))) }
  function setAll(p: Partial<PlanItem>) { setItems((l) => l.map((x) => ({ ...x, ...p }))) }

  const on = items.filter((i) => i.include)
  const has = (k: PlanItem['kind']) => on.some((i) => i.kind === k)

  // ---------- texts, once for the whole action ----------
  async function writeCopy() {
    if (!brief) return
    setBusy('Pišem tekstove za celu akciju…'); onMessage(null)
    const meta = on.filter((i) => i.network === 'meta')
    const calls: Promise<void>[] = []
    const next: Copy = { ...copy }
    const errs: string[] = []
    const fn = (action: string, apply: (d: Record<string, unknown>) => void, body: Record<string, unknown> = {}) =>
      supabase.functions.invoke('productive-briefs', { body: { action, brief, client_name: client.name, market, ...body } }).then(({ data, error }) => {
        if (error || data?.error) errs.push(`${action}: ${data?.error ?? error?.message}`); else apply(data)
      })
    if (has('pmax')) calls.push(fn('draft_pmax', (d) => { next.pmax = { headlines: d.headlines as string[], long_headlines: d.long_headlines as string[], descriptions: d.descriptions as string[], search_themes: d.search_themes as string[] } }))
    if (has('search')) calls.push(fn('draft', (d) => { next.search = { headlines: d.headlines as string[], descriptions: d.descriptions as string[] } }, { ct: 'Generic_Search' }))
    if (has('demand_gen')) calls.push(fn('draft_demand_gen', (d) => { next.demand_gen = { headlines: d.headlines as string[], long_headlines: d.long_headlines as string[], descriptions: d.descriptions as string[] } }))
    if (meta.length) {
      calls.push(supabase.functions.invoke('meta-campaigns', {
        body: {
          action: 'draft', brief, client_name: client.name, market, objective: 'po ad setu (vidi napomenu uz svaki)',
          adsets: meta.map((i) => ({ name: i.child || i.campaign, note: `${i.source_campaign}${i.source_child ? ` / ${i.source_child}` : ''}` })),
        },
      }).then(({ data, error }) => {
        if (error || data?.error) { errs.push(`Meta: ${data?.error ?? error?.message}`); return }
        const byName = new Map<string, MetaCopy>((data.adsets ?? []).map((x: MetaCopy & { name: string }) => [x.name, x]))
        next.meta = Object.fromEntries(meta.map((i, n) => {
          const x = byName.get(i.child || i.campaign) ?? data.adsets?.[n]
          return [i.key, x ? { primary_texts: x.primary_texts, headlines: x.headlines, description: x.description, cta: x.cta } : { primary_texts: [], headlines: [], description: '', cta: 'SHOP_NOW' }]
        }))
        next.note = data.rationale
      }))
    }
    await Promise.all(calls)
    setCopy(next); setBusy('')
    onMessage(errs.length ? { kind: 'err', text: `Deo tekstova nije napisan: ${errs.join(' · ')}` } : { kind: 'ok', text: 'Tekstovi su napisani jednom za celu akciju; pregledaj ih ispod pre izvoza.' })
  }

  // ---------- images, picked once ----------
  const pictures = attachments.filter((a) => (a.content_type ?? '').startsWith('image/'))
  async function addImages(list: Attachment[]) {
    setBusy('Proveravam slike…')
    const have = new Set(images.map((i) => i.attachment_id))
    const added: PlanImage[] = []
    const n: Record<string, string> = {}
    for (const a of list) {
      if (have.has(a.id)) continue
      try {
        const { w, h } = await imageSize(a.url)
        const img: PlanImage = { attachment_id: a.id, name: a.name ?? '', file: assetFileName(a), width: w, height: h, content_type: a.content_type, size_bytes: a.size_bytes }
        const g = googleImage(img); const m = metaImage(img)
        if (!g && !m) { n[a.id] = `${w}×${h}: ne odgovara ni Google-u ni Meti`; continue }
        n[a.id] = `${w}×${h} · ${[g && `Google ${g.ratio}`, m && `Meta ${m.ratio}`].filter(Boolean).join(' · ')}`
        added.push(img)
      } catch (e) { n[a.id] = (e as Error).message }
    }
    setImgNotes((x) => ({ ...x, ...n })); setImages((l) => [...l, ...added]); setBusy('')
  }

  // ---------- save ----------
  async function save(nextStatus = status): Promise<string | null> {
    const row = {
      client_id: client.id, brief_task_id: brief?.task_id ?? null, brief_title: brief?.title ?? null, name: name.trim() || 'Akcija',
      start_date: start || null, end_date: end || null, source: { action: actionKey || null, label: action ? actionLabel(action) : null },
      items, copy, images, status: nextStatus, updated_at: new Date().toISOString(),
    }
    const res = planId
      ? await supabase.from('action_plans').update(row).eq('id', planId).select('id').single()
      : await supabase.from('action_plans').insert(row).select('id').single()
    if (res.error) { onMessage({ kind: 'err', text: `Plan nije sačuvan: ${res.error.message}` }); return null }
    setPlanId(res.data.id); setStatus(nextStatus); loadPlans()
    return res.data.id
  }

  // ---------- Meta: one import file for all new ad sets and campaigns ----------
  async function exportMeta() {
    const meta = on.filter((i) => i.network === 'meta')
    if (!meta.length) return
    setBusy('Čitam Meta ad setove iz Windsora…'); onMessage(null)
    // Far enough back to find the copied ad sets.
    const daysBack = action ? Math.min(180, Math.max(60, Math.ceil((Date.now() - Date.parse(action.start)) / 864e5) + 7)) : 180
    const { data, error } = await supabase.functions.invoke('meta-campaigns', { body: { action: 'profile', client_id: client.id, days: daysBack } })
    if (error || data?.error) { setBusy(''); onMessage({ kind: 'err', text: `Meta nalog nije pročitan: ${data?.error ?? error?.message}` }); return }
    const adsets = (data.adsets ?? []) as BaseAdSet[]
    const defaults = data.defaults ?? {}
    const imgs = images.map(metaImage).filter((x): x is ImageAsset => !!x)
    const problems: string[] = []
    const byCampaign = new Map<string, MetaCampaign>()
    for (const i of meta) {
      const base = adsets.find((a) => a.campaign === i.source_campaign && a.adset_name === i.source_child) ?? adsets.find((a) => a.campaign === i.source_campaign) ?? null
      const c = copy.meta?.[i.key]
      if (!base) problems.push(`${i.child}: stari ad set „${i.source_child}“ nije pronađen u Windsoru`)
      if (!c?.primary_texts?.length) problems.push(`${i.child}: nema tekstova`)
      if (!/^https?:\/\//.test(i.final_url)) problems.push(`${i.child}: nema landing page`)
      if (!(Number(i.budget) > 0)) problems.push(`${i.child}: nema budžeta`)
      const objective = (OBJECTIVES.some((o) => o.key === base?.objective) ? base!.objective : 'OUTCOME_SALES') as Objective
      const cbo = Number(base?.campaign_daily_budget ?? 0) > 0 || Number(base?.campaign_lifetime_budget ?? 0) > 0
      const existing = i.op === 'new_child' && base?.campaign_id
      const key = existing ? `id:${base!.campaign_id}` : `new:${i.campaign}`
      const camp = byCampaign.get(key) ?? {
        campaign_id: existing ? base!.campaign_id : null, name: existing ? base!.campaign : i.campaign, objective,
        budget_level: existing && cbo ? 'campaign' : 'adset', budget_type: 'lifetime', budget: null, start: i.start, end: i.end,
        page_id: base?.page_id ?? defaults.page_id ?? '', instagram_id: base?.instagram_id ?? defaults.instagram_id ?? '',
        pixel_id: String((base?.promoted_object as { pixel_id?: string } | null)?.pixel_id ?? defaults.pixel_id ?? ''), event: 'PURCHASE',
        adsets: [], brief_title: brief?.title ?? null, task_url: brief?.task_url ?? null,
      } as MetaCampaign
      if (existing && cbo) problems.push(`${i.child}: kampanja „${base!.campaign}“ ima budžet na nivou kampanje; budžet ad seta (${i.budget} €) podesi u kampanji ručno`)
      const ad = (img: ImageAsset | null, n: number) => ({
        name: `${clean(name)}${img ? `_${img.ratio.replace(':', 'x')}` : ''}${n ? `_${n + 1}` : ''}(At:SI)`,
        primary_texts: c?.primary_texts ?? [], headlines: c?.headlines ?? [], description: c?.description ?? '', cta: c?.cta ?? 'SHOP_NOW', link: i.final_url, image: img,
      })
      camp.adsets.push({
        name: i.child, base_adset_id: base?.adset_id ?? null, base_label: base ? `${base.adset_name} · ${base.campaign}` : null,
        targeting: (base?.targeting ?? { geo_locations: { countries: [market], location_types: ['home', 'recent'] } }) as Targeting,
        optimization_goal: base?.optimization_goal ?? OBJECTIVES.find((o) => o.key === objective)!.goal, billing_event: base?.billing_event ?? 'IMPRESSIONS',
        budget: camp.budget_level === 'adset' ? Number(i.budget) : null,
        ads: imgs.length ? imgs.map((img, n) => ad(img, imgs.filter((x, j) => j < n && x.ratio === img.ratio).length)) : [ad(null, 0)],
      })
      byCampaign.set(key, camp)
    }
    const blocking = problems.filter((p) => !/budžet na nivou kampanje/.test(p))
    if (blocking.length) { setBusy(''); onMessage({ kind: 'err', text: `Meta fajl nije napravljen: ${blocking.join(' · ')}` }); return }
    await save()
    const res = await downloadMetaPackage(`meta_${clean(client.name).toLowerCase()}_${clean(name).toLowerCase()}`, [...byCampaign.values()])
    setBusy('')
    onMessage({ kind: res.ok ? 'ok' : 'err', text: `${res.text}${problems.length ? ` Napomena: ${problems.join(' · ')}` : ''}${imgs.length ? '' : ' Plan nema slika za Metu (1:1, 4:5, 9:16).'}` })
  }

  // ---------- Google: the new PMax asset groups as one Editor file ----------
  async function exportPmax() {
    const list = on.filter((i) => i.kind === 'pmax' && i.op === 'new_child')
    if (!list.length) return
    const t = copy.pmax
    if (!t || t.headlines.length < 3 || !t.long_headlines.length || t.descriptions.length < 2) { onMessage({ kind: 'err', text: 'Prvo napiši tekstove (PMax traži bar 3 naslova, 1 dugi naslov i 2 opisa).' }); return }
    if (list.some((i) => !/^https?:\/\//.test(i.final_url))) { onMessage({ kind: 'err', text: 'Svaka asset grupa mora imati landing page.' }); return }
    setBusy('Pravim Editor fajl za asset grupe…'); onMessage(null)
    const { data: def } = await supabase.from('client_editor_defaults').select('pmax_audience, business_name').eq('client_id', client.id).maybeSingle()
    const imgs = images.map(googleImage).filter((x): x is ImageAsset => !!x)
    const { data: rowsIn, error } = await supabase.from('pmax_asset_group_drafts').insert(list.map((i) => ({
      client_id: client.id, campaign_name: i.campaign, asset_group_name: i.child, final_url: i.final_url,
      headlines: t.headlines, long_headlines: t.long_headlines, descriptions: t.descriptions, search_themes: t.search_themes ?? [],
      business_name: def?.business_name ?? null, images: imgs, video_ids: [], audience: def?.pmax_audience ?? {},
      brief_task_id: brief?.task_id ?? null, brief_title: brief?.title ?? null, start_date: i.start || null, end_date: i.end || null, created_by: 'brain-ui',
    }))).select('id')
    if (error || !rowsIn) { setBusy(''); onMessage({ kind: 'err', text: `Asset grupe nisu sačuvane: ${error?.message}` }); return }
    const { data: csv, error: e2 } = await supabase.functions.invoke('export-pmax-csv', { body: { client_id: client.id, draft_ids: rowsIn.map((r) => r.id) } })
    if (e2 || typeof csv !== 'string') { setBusy(''); onMessage({ kind: 'err', text: 'Editor fajl nije napravljen.' }); return }
    await save()
    const res = await downloadEditorPackage(`editor_pmax_${clean(client.name).toLowerCase()}_${clean(name).toLowerCase()}`, csv, imgs)
    setBusy('')
    const budgets = list.filter((i) => i.budget).map((i) => `„${i.campaign}“ ${i.budget} €/dan od ${shortRange(i.start, i.end)}`).join(', ')
    onMessage({ kind: res.ok ? 'ok' : 'err', text: `${res.text}${budgets ? ` Budžet kampanje za akciju: ${budgets} (Editor: kampanja → Budget).` : ''}${imgs.length ? '' : ' Plan nema slika za Google (1.91:1, 1:1, 4:5, logo).'}` })
  }

  async function exportPlan() {
    await save()
    downloadText(`plan_${clean(client.name).toLowerCase()}_${clean(name).toLowerCase()}.csv`, planCsv(items, META_URL_TAGS))
    onMessage({ kind: 'ok', text: 'Plan akcije je preuzet: sve stavke sa imenima, datumima, budžetima i URL-ovima, za rad u Editoru i Ads Manageru.' })
  }

  // ---------- how to make each item today ----------
  function howTo(i: PlanItem) {
    const b = i.budget ? `${i.budget} € ${i.budget_kind === 'daily' ? 'dnevno' : 'ukupno'}` : 'budžet upiši'
    if (i.network === 'meta') return `U Meta fajlu (dugme ispod): ${i.op === 'new_child' ? `nov ad set u „${i.source_campaign}“` : `nova kampanja`}, targeting kopiran iz „${i.source_child}“, ${b}.`
    if (i.kind === 'pmax' && i.op === 'new_child') return `U Editor fajlu (dugme ispod): nova asset grupa u „${i.campaign}“; dnevni budžet kampanje ${b} za ${shortRange(i.start, i.end)}.`
    if (i.op === 'new_child') return `U Editoru: kopiraj ad grupu „${i.source_child}“ u istoj kampanji, preimenuj u „${i.child}“, zameni oglase tekstovima iz plana.`
    return `U Editoru: kopiraj kampanju „${i.source_campaign}“, nalepi, preimenuj u „${i.campaign}“, datumi ${shortRange(i.start, i.end)}, ${b}, Paused; zameni tekstove, slike i URL.`
  }

  if (!brief) {
    return (
      <section className="card mb-10 p-5">
        <p className="text-sm font-semibold">Dupliraj prošlu akciju</p>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Izaberi akciju iz Productive briefa iznad: Brain nađe istu (ili poslednju) akciju u nalogu i složi novu po njoj.</p>
        {plans.length > 0 && <p className="mt-3 text-xs text-[var(--color-ink-soft)]">Sačuvani planovi: {plans.slice(0, 6).map((p) => `${p.name} (${STATUS_LABEL[p.status] ?? p.status})`).join(' · ')}</p>}
      </section>
    )
  }

  const inp = 'w-full rounded border border-[var(--color-line)] bg-white px-2 py-1 text-sm'
  const meta = on.filter((i) => i.network === 'meta')
  const pmaxNew = on.filter((i) => i.kind === 'pmax' && i.op === 'new_child')
  const total = (n: 'google' | 'meta') => on.filter((i) => i.network === n).reduce((s, i) => s + (Number(i.budget) || 0) * (i.budget_kind === 'daily' && i.start && i.end ? Math.round((Date.parse(i.end) - Date.parse(i.start)) / 864e5) + 1 : 1), 0)

  return (
    <section className="card mb-10 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">Dupliraj prošlu akciju{planId ? <span className="ml-2 font-normal text-[var(--color-ink-soft)]">· plan sačuvan · {STATUS_LABEL[status] ?? status}</span> : null}</p>
        {busy && <span className="text-xs text-[var(--color-indigo)]">{busy}</span>}
      </div>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        Nova akcija kopira strukturu prošle: iste kampanje, isti targeting i publike, nove samo imena, datumi, budžeti, landing page, tekstovi i slike.
        Sve ide kao Paused. Kad povežemo API, Brain pravi baš ove stavke direktno u nalogu.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <label className="md:col-span-2"><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">Naziv nove akcije (ulazi u imena)</span><input className={inp} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">Početak</span><input type="date" className={inp} value={start} onChange={(e) => { setStart(e.target.value); setAll({ start: e.target.value }) }} /></label>
        <label><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">Kraj</span><input type="date" className={inp} value={end} onChange={(e) => { setEnd(e.target.value); setAll({ end: e.target.value }) }} /></label>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1"><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">Kopira se prošla akcija</span>
          <select className={inp} value={actionKey} onChange={(e) => setActionKey(e.target.value)}>
            <option value="">{rows ? (actions.length ? '— izaberi —' : 'u nalogu nema akcija sa ograničenim trajanjem (180 dana)') : 'Učitavam akcije iz naloga…'}</option>
            {actions.map((a) => <option key={a.key} value={a.key}>{actionLabel(a)}</option>)}
          </select>
        </label>
        <button className="btn-secondary text-sm" disabled={!action || !start || !!busy} onClick={() => action && rebuild(action, name.trim() || 'Akcija', start, end || start)}>
          {items.length ? 'Složi ponovo iz ove akcije' : 'Složi plan'}
        </button>
      </div>
      {rowsError && <p className="mt-2 text-xs text-[var(--color-rust)]">Akcije nisu učitane: {rowsError}</p>}
      {!start && <p className="mt-2 text-xs text-[var(--color-rust)]">Brief nema datume akcije; upiši početak i kraj.</p>}
      {notes.map((n) => <p key={n} className="mt-2 text-xs text-amber-800">{n}</p>)}

      {items.length > 0 && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="text-left text-xs text-[var(--color-ink-soft)]">
              <tr><th className="py-1 pr-2"></th><th className="pr-2">Šta se pravi</th><th className="pr-2">Novo ime</th><th className="pr-2">Budžet (€)</th><th>Landing page</th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.key} className={`border-t border-slate-100 align-top ${i.include ? '' : 'opacity-40'}`}>
                  <td className="py-2 pr-2"><input type="checkbox" checked={i.include} onChange={(e) => patch(i.key, { include: e.target.checked })} /></td>
                  <td className="py-2 pr-2 text-xs">
                    <b>{i.network === 'google' ? 'Google' : 'Meta'} {KIND_LABEL[i.kind] !== 'Meta' ? KIND_LABEL[i.kind] : ''}</b> · {opLabel(i)}
                    <span className="block text-[var(--color-ink-soft)]">kopija od: {i.source_child ?? i.source_campaign}{i.source_child ? ` (${i.source_campaign})` : ''} · prošli put {Math.round(i.source_spend).toLocaleString('sr-RS')} € za {i.source_days} d</span>
                    {i.network === 'google' && i.op === 'copy_campaign' && i.bidding && <span className="block text-[var(--color-ink-soft)]">{i.bidding}{i.target_roas ? ` · tROAS ${Math.round(i.target_roas * 100)}%` : ''}</span>}
                  </td>
                  <td className="py-2 pr-2">
                    {i.op === 'copy_campaign' && <input className={`${inp} mb-1`} value={i.campaign} onChange={(e) => patch(i.key, { campaign: e.target.value })} title="Kampanja" />}
                    {i.op === 'new_child' && <span className="mb-1 block text-xs text-[var(--color-ink-soft)]">u „{i.campaign}“</span>}
                    {i.child && <input className={inp} value={i.child} onChange={(e) => patch(i.key, { child: e.target.value })} title="Asset grupa / ad set" />}
                    <button className="mt-1 text-xs text-[var(--color-indigo)]" onClick={() => copyText(i.child || i.campaign)}>kopiraj ime</button>
                  </td>
                  <td className="py-2 pr-2">
                    <input type="number" className={`${inp} w-24`} value={i.budget ?? ''} onChange={(e) => patch(i.key, { budget: e.target.value ? Number(e.target.value) : null })} />
                    <span className="block text-xs text-[var(--color-ink-soft)]">{i.budget_kind === 'daily' ? 'dnevno' : 'ukupno za akciju'}</span>
                    <span className="block max-w-48 text-xs text-[var(--color-ink-soft)]">{i.budget_why}</span>
                  </td>
                  <td className="py-2">
                    <input className={inp} value={i.final_url} onChange={(e) => patch(i.key, { final_url: e.target.value, url_why: 'upisano ručno' })} />
                    <span className="block text-xs text-[var(--color-ink-soft)]">{i.url_why}</span>
                    <span className="block text-xs">{howTo(i)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-[var(--color-ink-soft)]">Ukupno za akciju: Google {Math.round(total('google')).toLocaleString('sr-RS')} € · Meta {Math.round(total('meta')).toLocaleString('sr-RS')} €</p>
        </div>
      )}

      {on.length > 0 && (
        <div className="mt-6 border-t border-[var(--color-line)] pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium">Tekstovi, jednom za celu akciju</p>
            <button className="btn-secondary text-sm" disabled={!!busy} onClick={writeCopy}>{Object.keys(copy).length ? 'Napiši ponovo' : 'Napiši tekstove iz briefa'}</button>
          </div>
          {copy.note && <p className="mt-2 text-xs text-[var(--color-ink-soft)]">{copy.note}</p>}
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
            {copy.pmax && (['headlines', 'long_headlines', 'descriptions'] as const).map((f) => (
              <label key={f}><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">PMax · {f === 'headlines' ? 'naslovi (30)' : f === 'long_headlines' ? 'dugi naslovi (90)' : 'opisi (90)'}</span>
                <textarea rows={4} className={inp} value={copy.pmax![f].join('\n')} onChange={(e) => setCopy({ ...copy, pmax: { ...copy.pmax!, [f]: lines(e.target.value) } })} /></label>
            ))}
            {copy.search && (['headlines', 'descriptions'] as const).map((f) => (
              <label key={`s-${f}`}><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">Search · {f === 'headlines' ? 'naslovi (30)' : 'opisi (90)'}</span>
                <textarea rows={4} className={inp} value={copy.search![f].join('\n')} onChange={(e) => setCopy({ ...copy, search: { ...copy.search!, [f]: lines(e.target.value) } })} /></label>
            ))}
            {copy.demand_gen && (['headlines', 'descriptions'] as const).map((f) => (
              <label key={`d-${f}`}><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">Demand Gen · {f === 'headlines' ? 'naslovi (40)' : 'opisi (90)'}</span>
                <textarea rows={4} className={inp} value={copy.demand_gen![f].join('\n')} onChange={(e) => setCopy({ ...copy, demand_gen: { ...copy.demand_gen!, [f]: lines(e.target.value) } })} /></label>
            ))}
            {meta.map((i) => copy.meta?.[i.key] && (
              <label key={`m-${i.key}`}><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">Meta · {i.child} · primarni tekstovi, pa naslovi posle prazne linije</span>
                <textarea rows={5} className={inp}
                  value={`${copy.meta[i.key].primary_texts.join('\n')}\n\n${copy.meta[i.key].headlines.join('\n')}`}
                  onChange={(e) => {
                    const [a, ...b] = e.target.value.split(/\n\s*\n/)
                    setCopy({ ...copy, meta: { ...copy.meta, [i.key]: { ...copy.meta![i.key], primary_texts: lines(a ?? ''), headlines: lines(b.join('\n')) } } })
                  }} /></label>
            ))}
          </div>
        </div>
      )}

      {on.length > 0 && (
        <div className="mt-6 border-t border-[var(--color-line)] pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium">Slike za celu akciju · {images.length}</p>
            {pictures.length > 0 && <button className="btn-secondary text-sm" disabled={!!busy} onClick={() => addImages(pictures)}>Dodaj sve slike iz briefa ({pictures.length})</button>}
            {images.length > 0 && <button className="text-xs text-[var(--color-ink-soft)]" onClick={() => setImages([])}>ukloni sve</button>}
          </div>
          <p className="mt-1 text-xs text-[var(--color-ink-soft)]">Svaka slika ide gde odgovara: Google (1.91:1, 1:1, 4:5, logo) u asset grupe, Meta (1:1, 4:5, 9:16) u oglase. Čuvaju se uz plan.</p>
          {pictures.length === 0 && <p className="mt-2 text-xs text-[var(--color-ink-soft)]">Brief nema slika.</p>}
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8">
            {pictures.map((a) => {
              const picked = images.some((i) => i.attachment_id === a.id)
              return (
                <button key={a.id} type="button" onClick={() => (picked ? setImages(images.filter((i) => i.attachment_id !== a.id)) : addImages([a]))}
                  className={`overflow-hidden rounded border text-left ${picked ? 'border-[var(--color-indigo)] ring-2 ring-[var(--color-indigo)]' : 'border-[var(--color-line)]'}`}>
                  <span className="flex aspect-square items-center justify-center bg-slate-100">{a.thumb_url && <img src={a.thumb_url} alt="" loading="lazy" className="h-full w-full object-contain" />}</span>
                  <span className="block truncate px-1 text-[10px]">{imgNotes[a.id] ?? a.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {on.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[var(--color-line)] pt-4">
          <button className="btn-primary text-sm" disabled={!!busy} onClick={() => save().then((id) => id && onMessage({ kind: 'ok', text: 'Plan akcije je sačuvan (sa tekstovima i slikama).' }))}>Sačuvaj plan</button>
          {meta.length > 0 && <button className="btn-secondary text-sm" disabled={!!busy} onClick={exportMeta}>Meta fajl ({meta.length} {meta.length === 1 ? 'ad set' : 'ad seta'})</button>}
          {pmaxNew.length > 0 && <button className="btn-secondary text-sm" disabled={!!busy} onClick={exportPmax}>Editor fajl ({pmaxNew.length} PMax {pmaxNew.length === 1 ? 'asset grupa' : 'asset grupe'})</button>}
          <button className="btn-secondary text-sm" disabled={!!busy} onClick={exportPlan}>Plan kao tabela (CSV)</button>
          {planId && status !== 'napravljeno' && <button className="text-xs text-[var(--color-indigo)]" onClick={() => save('napravljeno')}>označi: napravljeno u nalogu (Paused)</button>}
          {planId && <button className="text-xs text-[var(--color-ink-soft)]" onClick={() => save('odbačeno')}>odbaci plan</button>}
        </div>
      )}
    </section>
  )
}
