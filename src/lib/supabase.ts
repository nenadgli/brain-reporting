import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient(url, anonKey)

export type Client = {
  id: string
  agency_id: string
  name: string
  slug: string
}

export type ReportMetric = {
  id: string
  client_id: string
  report_date: string
  channel: string
  campaign: string | null
  metric_name: string
  metric_value: number
}
