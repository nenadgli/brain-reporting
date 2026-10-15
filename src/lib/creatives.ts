import { strToU8, zipSync } from 'fflate'
import { supabase } from './supabase'

// Productive attachments (via Feed Hub) and the Google Ads Editor packages built from them.

export type Attachment = {
  id: string
  task_id: string
  task_title: string | null
  from_subtask: boolean
  name: string | null
  content_type: string | null
  size_bytes: number | null
  url: string
  thumb_url: string | null
  productive_url: string | null
}

export type Brief = {
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
  // Text of task comments in which someone approved something ("odobren"), oldest first.
  approved_copy?: string[]
}

// A comment on the brief task or a subtask (read from Productive, nothing is written back).
export type BriefComment = { id: string; task_id: string; task_title: string | null; from_subtask: boolean; author: string | null; created_at: string | null; text: string; links: string[] }

export const isApproval = (text: string) => /odobren/i.test(text)
// Google Sheets / Docs / Drive links; Productive avatar and file links are left out.
export const docLinks = (links: string[]) => links.filter((l) => /^https:\/\/(docs|drive)\.google\.com\//.test(l))

// Whether a generated line was taken from the brief or the approved comments ("iz briefa") or written new.
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9%]+/g, ' ').trim()
export function fromBrief(line: string, sources: (string | null | undefined)[]): boolean {
  const n = norm(line)
  return n.length > 0 && sources.some((s) => s && norm(s).includes(n))
}

export type ImageField = 'MARKETING_IMAGE' | 'SQUARE_MARKETING_IMAGE' | 'PORTRAIT_MARKETING_IMAGE' | 'VERTICAL_IMAGE' | 'LOGO' | 'LANDSCAPE_LOGO'

// Saved on drafts; `file` is the name inside the images/ folder of the Editor package.
export type ImageAsset = { attachment_id: string; name: string; file: string; width: number; height: number; ratio: string; field?: ImageField }

// search: image assets of a Search ad group; pmax: asset group (logos too); dg: Demand Gen ad (square logo,
// no landscape logo); video: YouTube campaigns (no images); display: responsive display ad (1.91:1, 1:1, logos);
// meta: Facebook/Instagram ads (1:1, 4:5, 9:16, 1.91:1).
export type AssetMode = 'search' | 'pmax' | 'dg' | 'video' | 'display' | 'meta'

type Shape = { ratio: string; value: number; minW: number; minH: number; field: ImageField }

// Google Ads image specs. Search image assets take the three marketing shapes; PMax and Demand Gen also take logos.
const MARKETING_SHAPES: Shape[] = [
  { ratio: '1.91:1', value: 1.91, minW: 600, minH: 314, field: 'MARKETING_IMAGE' },
  { ratio: '1:1', value: 1, minW: 300, minH: 300, field: 'SQUARE_MARKETING_IMAGE' },
  { ratio: '4:5', value: 0.8, minW: 480, minH: 600, field: 'PORTRAIT_MARKETING_IMAGE' },
]
// Meta's recommended sizes for feed, stories/reels and link ads.
const META_SHAPES: Shape[] = [
  { ratio: '1:1', value: 1, minW: 600, minH: 600, field: 'SQUARE_MARKETING_IMAGE' },
  { ratio: '4:5', value: 0.8, minW: 600, minH: 750, field: 'PORTRAIT_MARKETING_IMAGE' },
  { ratio: '9:16', value: 0.5625, minW: 600, minH: 1067, field: 'VERTICAL_IMAGE' },
  { ratio: '1.91:1', value: 1.91, minW: 600, minH: 314, field: 'MARKETING_IMAGE' },
]
const LANDSCAPE_LOGO: Shape = { ratio: '4:1', value: 4, minW: 512, minH: 128, field: 'LANDSCAPE_LOGO' }
const LOGO_MIN = 128

export const FIELD_LABEL: Record<ImageField, string> = {
  MARKETING_IMAGE: 'horizontalna 1.91:1',
  SQUARE_MARKETING_IMAGE: 'kvadrat 1:1',
  PORTRAIT_MARKETING_IMAGE: 'vertikalna 4:5',
  VERTICAL_IMAGE: 'story 9:16',
  LOGO: 'logo 1:1',
  LANDSCAPE_LOGO: 'logo 4:1',
}

export function checkImage(a: Attachment, w: number, h: number, mode: AssetMode): { ratio: string; field: ImageField } | { problem: string } {
  if (!/^image\/(jpeg|png|gif)$/.test(a.content_type ?? '')) return { problem: 'format nije JPG/PNG/GIF' }
  if (mode === 'meta') {
    if ((a.size_bytes ?? 0) > 30 * 1024 * 1024) return { problem: 'veće od 30 MB' }
    const m = META_SHAPES.find((s) => Math.abs(w / h / s.value - 1) <= 0.02)
    if (!m) return { problem: `${w}×${h} nije ${META_SHAPES.map((s) => s.ratio).join(', ')}` }
    if (w < m.minW || h < m.minH) return { problem: `${w}×${h} je manje od ${m.minW}×${m.minH}` }
    return { ratio: m.ratio, field: m.field }
  }
  if ((a.size_bytes ?? 0) > 5 * 1024 * 1024) return { problem: 'veće od 5 MB' }
  // Responsive display ads take landscape and square images (no 4:5) and both logo shapes.
  const shapes = mode === 'pmax' ? [...MARKETING_SHAPES, LANDSCAPE_LOGO]
    : mode === 'display' ? [MARKETING_SHAPES[0], MARKETING_SHAPES[1], LANDSCAPE_LOGO]
    : MARKETING_SHAPES
  const shape = shapes.find((s) => Math.abs(w / h / s.value - 1) <= 0.02)
  if (!shape) return { problem: `${w}×${h} nije ${shapes.map((s) => s.ratio).join(', ')}` }
  // A square file named like a logo is a logo in PMax and Demand Gen (smaller minimum).
  if (mode !== 'search' && shape.field === 'SQUARE_MARKETING_IMAGE' && /logo/i.test(a.name ?? '')) {
    if (w < LOGO_MIN) return { problem: `${w}×${h} je manje od ${LOGO_MIN}×${LOGO_MIN} za logo` }
    return { ratio: shape.ratio, field: 'LOGO' }
  }
  if (w < shape.minW || h < shape.minH) return { problem: `${w}×${h} je manje od ${shape.minW}×${shape.minH}` }
  return { ratio: shape.ratio, field: shape.field }
}

export function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => reject(new Error('slika se ne učitava'))
    img.src = url
  })
}

export const assetFileName = (a: Attachment) =>
  `${a.id}-${(a.name ?? 'image').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-80)}`

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadText(filename: string, text: string) {
  downloadBlob(filename, new Blob(['' + text], { type: 'text/csv;charset=utf-8' }))
}

// Downloads editor.csv plus images/<file> as one ZIP; with no images, just the CSV.
// Image bytes come straight from Productive through fresh signed links.
export async function downloadEditorPackage(basename: string, csv: string, assets: ImageAsset[]): Promise<{ ok: boolean; text: string }> {
  if (assets.length === 0) {
    downloadText(`${basename}.csv`, csv)
    return { ok: true, text: 'CSV je preuzet. U Editoru: Import → proveri listu izmena → Post → uključi posle provere.' }
  }
  try {
    const { data, error } = await supabase.functions.invoke('productive-briefs', {
      body: { action: 'file_urls', ids: [...new Set(assets.map((a) => a.attachment_id))] },
    })
    if (error || data?.error) throw new Error(data?.error ?? error?.message)
    const urlOf = new Map<string, string>((data.files ?? []).map((f: Attachment) => [f.id, f.url]))
    const files: Record<string, Uint8Array> = { 'editor.csv': strToU8(csv) }
    for (const a of assets) {
      if (files[`images/${a.file}`]) continue
      const url = urlOf.get(a.attachment_id)
      if (!url) throw new Error(`slika ${a.name} više ne postoji u Productive-u`)
      const r = await fetch(url)
      if (!r.ok) throw new Error(`slika ${a.name}: HTTP ${r.status}`)
      files[`images/${a.file}`] = new Uint8Array(await r.arrayBuffer())
    }
    // Images are already compressed; level 0 just stores them.
    const zip = zipSync(files, { level: 0 })
    downloadBlob(`${basename}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }))
    const n = Object.keys(files).length - 1
    return { ok: true, text: `Paket je preuzet (CSV + ${n} slika). Otpakuj ga, pa u Editoru: Import → From file → editor.csv → proveri izmene; slike iz foldera images/ dodaj oglasima ručno (Editor ih ne uvozi iz CSV-a) → Post.` }
  } catch (e) {
    downloadText(`${basename}.csv`, csv)
    return { ok: false, text: `Slike nisu spakovane (${(e as Error).message}). Preuzet je samo CSV; slike preuzmi iz Productive-a i dodaj ih u Editoru ručno.` }
  }
}
