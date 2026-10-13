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
}

export type ImageField = 'MARKETING_IMAGE' | 'SQUARE_MARKETING_IMAGE' | 'PORTRAIT_MARKETING_IMAGE' | 'LOGO' | 'LANDSCAPE_LOGO'

// Saved on drafts; `file` is the name inside the images/ folder of the Editor package.
export type ImageAsset = { attachment_id: string; name: string; file: string; width: number; height: number; ratio: string; field?: ImageField }

export type AssetMode = 'search' | 'pmax'

type Shape = { ratio: string; value: number; minW: number; minH: number; field: ImageField }

// Google Ads image specs. Search image assets take the three marketing shapes; PMax also takes logos.
const MARKETING_SHAPES: Shape[] = [
  { ratio: '1.91:1', value: 1.91, minW: 600, minH: 314, field: 'MARKETING_IMAGE' },
  { ratio: '1:1', value: 1, minW: 300, minH: 300, field: 'SQUARE_MARKETING_IMAGE' },
  { ratio: '4:5', value: 0.8, minW: 480, minH: 600, field: 'PORTRAIT_MARKETING_IMAGE' },
]
const LANDSCAPE_LOGO: Shape = { ratio: '4:1', value: 4, minW: 512, minH: 128, field: 'LANDSCAPE_LOGO' }
const LOGO_MIN = 128

export const FIELD_LABEL: Record<ImageField, string> = {
  MARKETING_IMAGE: 'horizontalna 1.91:1',
  SQUARE_MARKETING_IMAGE: 'kvadrat 1:1',
  PORTRAIT_MARKETING_IMAGE: 'vertikalna 4:5',
  LOGO: 'logo 1:1',
  LANDSCAPE_LOGO: 'logo 4:1',
}

export function checkImage(a: Attachment, w: number, h: number, mode: AssetMode): { ratio: string; field: ImageField } | { problem: string } {
  if (!/^image\/(jpeg|png|gif)$/.test(a.content_type ?? '')) return { problem: 'format nije JPG/PNG/GIF' }
  if ((a.size_bytes ?? 0) > 5 * 1024 * 1024) return { problem: 'veće od 5 MB' }
  const shapes = mode === 'pmax' ? [...MARKETING_SHAPES, LANDSCAPE_LOGO] : MARKETING_SHAPES
  const shape = shapes.find((s) => Math.abs(w / h / s.value - 1) <= 0.02)
  if (!shape) return { problem: `${w}×${h} nije ${shapes.map((s) => s.ratio).join(', ')}` }
  // A square file named like a logo is a logo in PMax (smaller minimum).
  if (mode === 'pmax' && shape.field === 'SQUARE_MARKETING_IMAGE' && /logo/i.test(a.name ?? '')) {
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
    return { ok: true, text: `Paket je preuzet (CSV + ${n} slika). Otpakuj ga, pa u Editoru: Import → From file → editor.csv iz tog foldera → proveri izmene → Post.` }
  } catch (e) {
    downloadText(`${basename}.csv`, csv)
    return { ok: false, text: `Slike nisu spakovane (${(e as Error).message}). Preuzet je samo CSV; kolone sa slikama očekuju folder images/ pored njega.` }
  }
}
