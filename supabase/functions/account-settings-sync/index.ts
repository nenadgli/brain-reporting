import { createClient } from 'jsr:@supabase/supabase-js@2'

// Daily snapshot of account settings the PPC team checks by hand: Google campaign daily budgets,
// bidding strategy and tROAS/tCPA, ad approval status, optimization score and recommendations,
// and the Meta account spending limit. Read-only against Windsor.
// Windsor repeats these attributes on every date row; summing them over dates is wrong, so the
// latest row per campaign is kept.

const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

async function windsor(connector: string, account: string, fields: string, preset: string) {
  const params = new URLSearchParams({ api_key: WINDSOR_API_KEY, select_accounts: account, fields, date_preset: preset })
  const r = await fetch(`https://connectors.windsor.ai/${connector}?${params}`, { signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`Windsor ${connector} HTTP ${r.status}`)
  return ((await r.json()).data ?? []) as Record<string, unknown>[]
}

// Latest date row per campaign id.
function latest(rows: Record<string, unknown>[]) {
  const m = new Map<string, Record<string, unknown>>()
  for (const r of rows) {
    const k = String(r.campaign_id ?? r.campaign)
    const prev = m.get(k)
    if (!prev || String(r.date ?? '') > String(prev.date ?? '')) m.set(k, r)
  }
  return m
}

Deno.serve(async (req: Request) => {
  try {
    const { client_id } = await req.json().catch(() => ({}))
    if (!client_id) return json({ error: 'client_id je obavezan' }, 400)
    const { data: sources, error } = await supabase.from('data_sources').select('id, provider, windsor_connection_id')
      .eq('client_id', client_id).in('provider', ['google_ads', 'facebook']).not('windsor_connection_id', 'is', null)
    if (error) throw error
    const today = new Date().toISOString().slice(0, 10)
    const out: Record<string, unknown>[] = []

    for (const s of sources ?? []) {
      const account = s.windsor_connection_id.includes('__') ? s.windsor_connection_id.split('__')[1] : s.windsor_connection_id
      if (s.provider === 'google_ads') {
        // Budget and bidding fields cannot be requested in one Windsor call.
        const budgets = latest(await windsor('google_ads', account,
          'date,campaign,campaign_id,campaign_status,budget_amount,campaign_budget_type,is_budget_explicitly_shared', 'last_3d'))
        const bids = latest(await windsor('google_ads', account,
          'date,campaign,campaign_id,bidding_strategy_type,maximize_conversion_value_target_roas,campaign_target_cpa_target_cpa_micros,campaign_maximize_conversions_target_cpa_micros', 'last_3d'))
        const rows = [...new Set([...budgets.keys(), ...bids.keys()])].map((id) => {
          const b = budgets.get(id) ?? {}
          const x = bids.get(id) ?? {}
          const cpaMicros = num(x.campaign_target_cpa_target_cpa_micros) ?? num(x.campaign_maximize_conversions_target_cpa_micros)
          return {
            client_id, data_source_id: s.id, snapshot_date: today, campaign_id: id,
            campaign: String(b.campaign ?? x.campaign ?? ''),
            campaign_status: (b.campaign_status as string) ?? null,
            daily_budget: num(b.budget_amount),
            budget_type: (b.campaign_budget_type as string) ?? null,
            budget_shared: b.is_budget_explicitly_shared == null ? null : String(b.is_budget_explicitly_shared) === 'true',
            bidding_strategy_type: (x.bidding_strategy_type as string) ?? null,
            target_roas: num(x.maximize_conversion_value_target_roas),
            target_cpa: cpaMicros == null || cpaMicros === 0 ? null : cpaMicros / 1e6,
          }
        })
        if (rows.length) {
          const { error: e } = await supabase.from('google_campaign_settings').upsert(rows, { onConflict: 'client_id,snapshot_date,campaign_id' })
          if (e) throw e
        }
        out.push({ provider: 'google_ads', campaigns: rows.length })

        // The weekly account check reads these; a failure here must not lose the budget snapshot above.
        try {
          const ads = await windsor('google_ads', account,
            'campaign,ad_group_name,ad_id,ad_group_ad_status,ad_group_ad_policy_summary_approval_status,ad_group_ad_policy_summary_review_status,ad_group_ad_policy_summary_policy_topic_entries', 'last_7d')
          const seen = new Set<string>()
          const adRows = ads.filter((a) => a.ad_id != null && !seen.has(String(a.ad_id)) && seen.add(String(a.ad_id))).map((a) => ({
            client_id, data_source_id: s.id, snapshot_date: today, ad_id: String(a.ad_id),
            campaign: String(a.campaign ?? ''), ad_group: (a.ad_group_name as string) ?? null,
            ad_status: (a.ad_group_ad_status as string) ?? null,
            approval_status: (a.ad_group_ad_policy_summary_approval_status as string) ?? null,
            review_status: (a.ad_group_ad_policy_summary_review_status as string) ?? null,
            policy_topics: (a.ad_group_ad_policy_summary_policy_topic_entries as string) ?? null,
          }))
          for (let i = 0; i < adRows.length; i += 500) {
            const { error: e } = await supabase.from('google_ad_policy').upsert(adRows.slice(i, i + 500), { onConflict: 'client_id,snapshot_date,ad_id' })
            if (e) throw e
          }
          const scores = latest(await windsor('google_ads', account, 'date,customer_optimization_score,campaign,campaign_id,campaign_optimization_score', 'last_3d'))
          const recs = await windsor('google_ads', account, 'campaign,recommendation_type,recommended_budget_amount', 'last_1d')
          const byCampaign = new Map<string, { types: Set<string>; budget: number | null }>()
          for (const r of recs) {
            const k = String(r.campaign ?? '')
            const x = byCampaign.get(k) ?? { types: new Set<string>(), budget: null }
            if (r.recommendation_type) x.types.add(String(r.recommendation_type))
            // The budget amount is copied onto every recommendation row; only the budget one is meaningful (micros).
            if (r.recommendation_type === 'CAMPAIGN_BUDGET' && num(r.recommended_budget_amount)) x.budget = Number(r.recommended_budget_amount) / 1e6
            byCampaign.set(k, x)
          }
          const optRows = [...scores.values()].map((r) => {
            const rc = byCampaign.get(String(r.campaign ?? ''))
            return {
              client_id, data_source_id: s.id, snapshot_date: today, campaign_id: String(r.campaign_id ?? r.campaign),
              campaign: String(r.campaign ?? ''), account_score: num(r.customer_optimization_score), campaign_score: num(r.campaign_optimization_score),
              recommendation_types: rc ? [...rc.types].filter((t) => t !== 'UNKNOWN').sort() : [], recommended_budget: rc?.budget ?? null,
            }
          })
          if (optRows.length) {
            const { error: e } = await supabase.from('google_optimization').upsert(optRows, { onConflict: 'client_id,snapshot_date,campaign_id' })
            if (e) throw e
          }
          out.push({ provider: 'google_ads', ads: adRows.length, optimization: optRows.length })
        } catch (e) {
          out.push({ provider: 'google_ads', weekly_check_data_error: (e as Error).message })
        }
      } else {
        const acc = (await windsor('facebook', account,
          'account_id,account_name,account_currency,account_status,spend_cap,amount_spent,account_balance', 'last_1d'))[0]
        if (acc) {
          // Meta reports these in minor units (cents); spend_cap 0 means no limit.
          const cents = (v: unknown) => (num(v) == null ? null : Number(v) / 100)
          const { error: e } = await supabase.from('meta_account_limits').upsert({
            client_id, data_source_id: s.id, snapshot_date: today, account_id: String(acc.account_id ?? account),
            account_name: (acc.account_name as string) ?? null, currency: (acc.account_currency as string) ?? null,
            account_status: (acc.account_status as string) ?? null,
            spend_cap: num(acc.spend_cap) ? cents(acc.spend_cap) : null,
            amount_spent: cents(acc.amount_spent), balance: cents(acc.account_balance),
          }, { onConflict: 'client_id,snapshot_date,account_id' })
          if (e) throw e
        }
        out.push({ provider: 'facebook', account: !!acc })
      }
    }
    return json({ ok: true, results: out })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
