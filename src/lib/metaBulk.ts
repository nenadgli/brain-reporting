import { strToU8, zipSync } from 'fflate'
import { supabase } from './supabase'
import { type Attachment, type ImageAsset, downloadBlob, downloadText } from './creatives'

// Meta campaigns as an Ads Manager bulk import file (Ads Manager → Import ads in bulk). Everything goes in Paused;
// the team reviews it in Ads Manager and turns it on when the action starts. Nothing is sent to Meta from Brain.

export type Objective = 'OUTCOME_AWARENESS' | 'OUTCOME_TRAFFIC' | 'OUTCOME_ENGAGEMENT' | 'OUTCOME_LEADS' | 'OUTCOME_SALES'
export const OBJECTIVES: { key: Objective; label: string; ct: string; goal: string }[] = [
  { key: 'OUTCOME_AWARENESS', label: 'Svest (Awareness)', ct: 'Awareness', goal: 'REACH' },
  { key: 'OUTCOME_TRAFFIC', label: 'Saobraćaj (Traffic)', ct: 'Traffic', goal: 'LANDING_PAGE_VIEWS' },
  { key: 'OUTCOME_ENGAGEMENT', label: 'Angažovanje (Engagement)', ct: 'Engagement', goal: 'POST_ENGAGEMENT' },
  { key: 'OUTCOME_LEADS', label: 'Leadovi (Leads)', ct: 'Leads', goal: 'LEAD_GENERATION' },
  { key: 'OUTCOME_SALES', label: 'Prodaja (Sales)', ct: 'Conversions', goal: 'OFFSITE_CONVERSIONS' },
]
export const CTAS = ['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'GET_OFFER', 'BOOK_NOW', 'CONTACT_US', 'SUBSCRIBE', 'GET_DIRECTIONS', 'NO_BUTTON']

// Targeting as Meta's API returns it (Windsor adset_targeting); only the parts the file carries are typed.
export type GeoEntry = { kind: 'country' | 'region' | 'city' | 'place' | 'custom'; label: string; value: Record<string, unknown> | string }
export type Targeting = Record<string, unknown> & {
  geo_locations?: { countries?: string[]; regions?: Record<string, unknown>[]; cities?: Record<string, unknown>[]; places?: Record<string, unknown>[]; custom_locations?: Record<string, unknown>[]; location_types?: string[] }
  age_min?: number; age_max?: number; genders?: number[]
}

// A past ad set from Windsor, used as the base for a new one (its targeting, goal and Page).
export type BaseAdSet = {
  campaign: string; campaign_id: string | null; campaign_status: string | null; campaign_daily_budget: number | null; campaign_lifetime_budget: number | null
  adset_name: string; adset_id: string; objective: string | null; targeting: Targeting | null
  promoted_object: Record<string, unknown> | null; optimization_goal: string | null; billing_event: string | null
  start_time: string | null; end_time: string | null; spend: number; reach: number; page_id: string | null; instagram_id: string | null; cta: string | null; link: string | null
}

export type MetaAd = { name: string; primary_texts: string[]; headlines: string[]; description: string; cta: string; link: string; image: ImageAsset | null }
export type MetaAdSet = { name: string; base_adset_id: string | null; base_label: string | null; targeting: Targeting; optimization_goal: string; billing_event: string; budget: number | null; ads: MetaAd[] }
export type MetaCampaign = {
  // Set when the ad sets go into an existing campaign: the file then references it by ID and leaves it as it is.
  campaign_id?: string | null
  name: string; objective: Objective; budget_level: 'campaign' | 'adset'; budget_type: 'daily' | 'lifetime'; budget: number | null
  start: string | null; end: string | null; page_id: string; instagram_id: string; pixel_id: string; event: string
  adsets: MetaAdSet[]; brief_title: string | null; task_url: string | null
}

const unit = (u: unknown) => (u === 'kilometer' ? 'km' : 'mi')

// Every location in a targeting spec, so a new ad set can keep only some of them (e.g. only Belgrade).
export function geoEntries(t: Targeting | null): GeoEntry[] {
  const g = t?.geo_locations ?? {}
  const out: GeoEntry[] = []
  for (const c of g.countries ?? []) out.push({ kind: 'country', label: `Država ${c}`, value: c })
  for (const r of g.regions ?? []) out.push({ kind: 'region', label: `Region ${r.name ?? r.key}`, value: r })
  for (const c of g.cities ?? []) out.push({ kind: 'city', label: `${c.name}${c.radius ? ` +${c.radius} ${unit(c.distance_unit)}` : ''}`, value: c })
  for (const p of g.places ?? []) out.push({ kind: 'place', label: `${p.name ?? 'Lokacija'} +${p.radius} ${unit(p.distance_unit)}`, value: p })
  for (const c of g.custom_locations ?? []) out.push({ kind: 'custom', label: `${c.address_string ?? `Tačka ${Number(c.latitude).toFixed(3)}, ${Number(c.longitude).toFixed(3)}`} +${c.radius} ${unit(c.distance_unit)}`, value: c })
  return out
}

// The base targeting with only the chosen locations left.
export function withGeo(t: Targeting, keep: GeoEntry[]): Targeting {
  const g = t.geo_locations ?? {}
  const pick = (kind: GeoEntry['kind']) => keep.filter((e) => e.kind === kind).map((e) => e.value)
  const geo: Record<string, unknown> = { location_types: g.location_types ?? ['home', 'recent'] }
  const map: [GeoEntry['kind'], string][] = [['country', 'countries'], ['region', 'regions'], ['city', 'cities'], ['place', 'places'], ['custom', 'custom_locations']]
  for (const [kind, key] of map) if (pick(kind).length) geo[key] = pick(kind)
  return { ...t, geo_locations: geo as Targeting['geo_locations'] }
}

export function describeTargeting(t: Targeting | null): string {
  if (!t) return 'bez podešavanja'
  const geo = geoEntries(t).map((e) => e.label).join(', ') || 'bez lokacije'
  const age = t.age_min || t.age_max ? ` · ${t.age_min ?? 18}–${t.age_max ?? 65}` : ''
  const sex = t.genders?.length === 1 ? (t.genders[0] === 1 ? ' · muškarci' : ' · žene') : ''
  const interests = (t.flexible_spec as { interests?: unknown[] }[] | undefined)?.reduce((n, f) => n + (f.interests?.length ?? 0), 0) ?? 0
  const aud = (t.custom_audiences as unknown[] | undefined)?.length ?? 0
  const pl = (t.publisher_platforms as string[] | undefined)?.join('+')
  return `${geo}${age}${sex}${interests ? ` · ${interests} interesovanja` : ''}${aud ? ` · ${aud} publika` : ''}${pl ? ` · ${pl}` : ' · svi plasmani'}`
}

// ---------- the import file ----------
// Column names follow Ads Manager's export/import template. The first import should be checked in the review
// step of Ads Manager; if Meta rejects a column or format, the fix belongs here only.

const OBJECTIVE_COLUMN: Record<Objective, string> = {
  OUTCOME_AWARENESS: 'Outcome Awareness', OUTCOME_TRAFFIC: 'Outcome Traffic', OUTCOME_ENGAGEMENT: 'Outcome Engagement',
  OUTCOME_LEADS: 'Outcome Leads', OUTCOME_SALES: 'Outcome Sales',
}
const MAX_TEXTS = 5
const HEADERS = [
  'Campaign ID', 'Campaign Name', 'Campaign Status', 'Campaign Objective', 'Buying Type', 'Campaign Daily Budget', 'Campaign Lifetime Budget',
  'Ad Set Run Status', 'Ad Set Name', 'Ad Set Time Start', 'Ad Set Time Stop', 'Ad Set Daily Budget', 'Ad Set Lifetime Budget',
  'Link Object ID', 'Optimized Conversion Tracking Pixels', 'Optimized Event',
  'Countries', 'Regions', 'Cities', 'Addresses', 'Location Types', 'Gender', 'Age Min', 'Age Max',
  'Flexible Inclusions', 'Flexible Exclusions', 'Custom Audiences', 'Excluded Custom Audiences', 'Advantage Audience',
  'Publisher Platforms', 'Facebook Positions', 'Instagram Positions', 'Device Platforms',
  'Optimization Goal', 'Billing Event',
  'Ad Status', 'Ad Name', 'Body', ...Array.from({ length: MAX_TEXTS - 1 }, (_, i) => `Additional Body ${i + 1}`),
  'Title', ...Array.from({ length: MAX_TEXTS - 1 }, (_, i) => `Additional Title ${i + 1}`),
  'Link Description', 'Link', 'Call to Action', 'Image File Name', 'Instagram Account ID',
]

const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
const time = (d: string | null, end = false) => (d ? `${d} ${end ? '23:59:00' : '00:00:00'}` : '')
const money = (n: number | null) => (n == null || !Number.isFinite(n) ? '' : n.toFixed(2))
const json = (v: unknown) => (v == null || (Array.isArray(v) && !v.length) ? '' : JSON.stringify(v))

function geoColumns(t: Targeting) {
  const g = t.geo_locations ?? {}
  const city = (c: Record<string, unknown>) => `${c.name}, ${c.region ?? ''} ${c.country ?? ''}`.replace(/\s+/g, ' ').trim() + (c.radius ? ` (+${c.radius}${unit(c.distance_unit)})` : '')
  const point = (p: Record<string, unknown>) => `(${p.latitude}, ${p.longitude}) +${p.radius}${unit(p.distance_unit)}`
  return {
    Countries: (g.countries ?? []).join(', '),
    Regions: (g.regions ?? []).map((r) => `${r.name}, ${r.country ?? ''}`.trim()).join('; '),
    Cities: (g.cities ?? []).map(city).join('; '),
    Addresses: [...(g.places ?? []), ...(g.custom_locations ?? [])].map(point).join('; '),
    'Location Types': (g.location_types ?? []).join(', '),
  }
}

export function bulkCsv(campaigns: MetaCampaign[]): string {
  const rows: Record<string, string>[] = []
  for (const c of campaigns) {
    const cbo = c.budget_level === 'campaign'
    const sales = c.objective === 'OUTCOME_SALES'
    for (const s of c.adsets) {
      const t = s.targeting
      const auto = (t.targeting_automation as { advantage_audience?: number } | undefined)?.advantage_audience
      for (const a of s.ads) {
        const texts = a.primary_texts.slice(0, MAX_TEXTS)
        const titles = a.headlines.slice(0, MAX_TEXTS)
        const own = !c.campaign_id
        const r: Record<string, string> = {
          'Campaign ID': c.campaign_id ?? '', 'Campaign Name': c.name,
          // An existing campaign is only referenced: no status, objective or budget, so nothing about it changes.
          'Campaign Status': own ? 'PAUSED' : '', 'Campaign Objective': own ? OBJECTIVE_COLUMN[c.objective] : '', 'Buying Type': own ? 'AUCTION' : '',
          'Campaign Daily Budget': own && cbo && c.budget_type === 'daily' ? money(c.budget) : '',
          'Campaign Lifetime Budget': own && cbo && c.budget_type === 'lifetime' ? money(c.budget) : '',
          'Ad Set Run Status': 'PAUSED', 'Ad Set Name': s.name, 'Ad Set Time Start': time(c.start), 'Ad Set Time Stop': time(c.end, true),
          'Ad Set Daily Budget': !cbo && c.budget_type === 'daily' ? money(s.budget) : '',
          'Ad Set Lifetime Budget': !cbo && c.budget_type === 'lifetime' ? money(s.budget) : '',
          'Link Object ID': c.page_id ? `o:${c.page_id}` : '',
          'Optimized Conversion Tracking Pixels': sales && c.pixel_id ? `tp:${c.pixel_id}` : '',
          'Optimized Event': sales ? c.event || 'PURCHASE' : '',
          ...geoColumns(t),
          Gender: t.genders?.length === 1 ? (t.genders[0] === 1 ? 'Men' : 'Women') : '',
          'Age Min': t.age_min ? String(t.age_min) : '', 'Age Max': t.age_max ? String(t.age_max) : '',
          'Flexible Inclusions': json(t.flexible_spec), 'Flexible Exclusions': json(t.exclusions),
          'Custom Audiences': ((t.custom_audiences as { id: string; name?: string }[] | undefined) ?? []).map((x) => `${x.id}:${x.name ?? ''}`).join(', '),
          'Excluded Custom Audiences': ((t.excluded_custom_audiences as { id: string; name?: string }[] | undefined) ?? []).map((x) => `${x.id}:${x.name ?? ''}`).join(', '),
          'Advantage Audience': auto == null ? '' : String(auto),
          'Publisher Platforms': ((t.publisher_platforms as string[] | undefined) ?? []).join(', '),
          'Facebook Positions': ((t.facebook_positions as string[] | undefined) ?? []).join(', '),
          'Instagram Positions': ((t.instagram_positions as string[] | undefined) ?? []).join(', '),
          'Device Platforms': ((t.device_platforms as string[] | undefined) ?? []).join(', '),
          'Optimization Goal': s.optimization_goal, 'Billing Event': s.billing_event || 'IMPRESSIONS',
          'Ad Status': 'PAUSED', 'Ad Name': a.name, Body: texts[0] ?? '', Title: titles[0] ?? '',
          'Link Description': a.description, Link: a.link, 'Call to Action': a.cta === 'NO_BUTTON' ? '' : a.cta,
          'Image File Name': a.image?.file ?? '', 'Instagram Account ID': c.instagram_id,
        }
        texts.slice(1).forEach((x, i) => { r[`Additional Body ${i + 1}`] = x })
        titles.slice(1).forEach((x, i) => { r[`Additional Title ${i + 1}`] = x })
        rows.push(r)
      }
    }
  }
  return [HEADERS.join(','), ...rows.map((r) => HEADERS.map((h) => esc(r[h])).join(','))].join('\r\n') + '\r\n'
}

// The CSV plus the ads' images (to upload to the Media library first, so "Image File Name" finds them).
export async function downloadMetaPackage(basename: string, campaigns: MetaCampaign[]): Promise<{ ok: boolean; text: string }> {
  const csv = bulkCsv(campaigns)
  const assets = campaigns.flatMap((c) => c.adsets.flatMap((s) => s.ads.map((a) => a.image).filter((x): x is ImageAsset => !!x)))
  const steps = 'U Ads Manageru: Import/Export → Import ads in bulk → izaberi meta_import.csv → pregledaj šta će biti napravljeno → Import. Sve ulazi kao Paused.'
  if (!assets.length) {
    downloadText(`${basename}.csv`, csv)
    return { ok: true, text: `Fajl je preuzet. ${steps} Oglasi nemaju slike; dodaj ih u Ads Manageru pre uključivanja.` }
  }
  try {
    const { data, error } = await supabase.functions.invoke('productive-briefs', { body: { action: 'file_urls', ids: [...new Set(assets.map((a) => a.attachment_id))] } })
    if (error || data?.error) throw new Error(data?.error ?? error?.message)
    const urlOf = new Map<string, string>((data.files ?? []).map((f: Attachment) => [f.id, f.url]))
    const files: Record<string, Uint8Array> = { 'meta_import.csv': strToU8('﻿' + csv) }
    for (const a of assets) {
      if (files[`images/${a.file}`]) continue
      const url = urlOf.get(a.attachment_id)
      if (!url) throw new Error(`slika ${a.name} više ne postoji u Productive-u`)
      const r = await fetch(url)
      if (!r.ok) throw new Error(`slika ${a.name}: HTTP ${r.status}`)
      files[`images/${a.file}`] = new Uint8Array(await r.arrayBuffer())
    }
    downloadBlob(`${basename}.zip`, new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' }))
    return { ok: true, text: `Paket je preuzet (CSV + ${Object.keys(files).length - 1} slika). Prvo otpremi slike iz foldera images/ u Media library naloga (imena fajlova ostaju ista), pa: ${steps}` }
  } catch (e) {
    downloadText(`${basename}.csv`, csv)
    return { ok: false, text: `Slike nisu spakovane (${(e as Error).message}). Preuzet je samo CSV. ${steps}` }
  }
}
