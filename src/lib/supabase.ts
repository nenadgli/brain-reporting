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

export type GoogleAdsMetric = {
  id: string
  client_id: string
  report_date: string
  campaign: string
  campaign_type: string | null
  device: string | null
  impressions: number
  clicks: number
  spend: number
  conversions: number
  conversion_value: number
  search_impression_share: number | null
  search_lost_is_budget: number | null
  search_lost_is_rank: number | null
  quality_score: number | null
}

export type GoogleAdsKeyword = {
  id: string
  client_id: string
  report_date: string
  campaign: string
  keyword_text: string
  keyword_match_type: string | null
  impressions: number
  clicks: number
  spend: number
  conversions: number
  conversion_value: number
  quality_score: number | null
}

export type GoogleAdsSearchTerm = {
  id: string
  client_id: string
  report_date: string
  campaign: string
  search_term: string
  impressions: number
  clicks: number
  spend: number
  conversions: number
}

export type GoogleAdsCompetitor = {
  id: string
  client_id: string
  report_date: string
  campaign: string
  domain: string
}
