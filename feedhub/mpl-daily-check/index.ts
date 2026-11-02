// mpl-daily-check: provera media planova (MPL) sa Drive-a za sva tržišta (bf_mpl_sources), u 07h i 17h po Beogradu.
// Za svako tržište čita listove "MPL & REPORT - <mesec> <godina>." za tekući i sledeći mesec (u prvih 5 dana i prošli, samo mesečni plan) i:
//  - iz redova akcija sastavlja akcije (ključ, datumi, stavke po kanalu, budžet = Regular + Flash) → bf_mpl_reconcile
//    (kalendar akcija: BF Live akcije, izveštaj akcija, pacing); sigurne izmene upisuje, nejasne samo prijavljuje;
//  - sve stavke sa datumima (i always-on, loyalty, TikTok, programmatic) → bf_mpl_sync_lines
//    (mesečni plan po kampanjama: BF Live "Media plan", alarm "troši iznad plana", jutarnji PPC pregled);
//  - iste stavke → brain-reporting (brain_mpl_sync u media_plan_lines), po istom pravilu: nove i izmene se upisuju,
//    stavka koje nema u tabeli ili je pala na 0 se samo prijavljuje. Adresa i ključevi: bf_brain_reporting_sync().
// Posle izmena osvežava BF Live keš (media_plan, promo, promo_live). Kratak izveštaj ide u Slack #ppc-alarm, jednom po terminu.
// POST {"dry_run"?: true, "market"?: "RS", "no_slack"?: true, "at_hour"?: 7}; sa at_hour radi samo kad je u Beogradu taj sat
// (cron se pokreće u oba UTC sata zbog letnjeg/zimskog vremena). Auth: Authorization: Bearer <key> iz bf_dashboard_api_keys.
import { getServiceClient, getPrimaryToken, getValidAccessToken } from "../_shared/google-token.ts";

const CHANNEL = "ppc-alarm";
const TZ = "Europe/Belgrade";
const FLAG: Record<string, string> = { RS: "🇷🇸", BA: "🇧🇦", HR: "🇭🇷", ME: "🇲🇪", AL: "🇦🇱", SI: "🇸🇮" };
const MONTHS: [RegExp, number][] = [
  [/jan/i, 1], [/feb/i, 2], [/mar/i, 3], [/apr/i, 4], [/maj|may/i, 5], [/jun/i, 6],
  [/jul/i, 7], [/avg|aug/i, 8], [/sep/i, 9], [/okt|oct/i, 10], [/nov/i, 11], [/dec/i, 12],
];
// Redosled je bitan: prvi koji se poklopi određuje akciju.
const KEYS: [string, RegExp, string][] = [
  ["halloween", /hallow|hellow/i, "Halloween"],
  ["bf", /black|\bbf\b|cyber|crni petak/i, "Black Friday"],
  ["singles", /single|11\.11/i, "Singles Day"],
  ["loyalty", /loyal|loysl|lojal|član|clan/i, "Loyalty"],
  ["mss_extra", /dodatn.*mss|mss.*dodatn/i, "Dodatni popust na MSS"],
  ["sale_extra", /dodatn/i, "Dodatni popust na Sale"],
  ["mss", /\bmss\b|mid ?season/i, "Mid Season Sale"],
  ["presale", /pre ?-?sale/i, "Pre Sale"],
  ["final", /final/i, "Final Sale"],
  ["sale", /\bsale\b|snižen|sniz/i, "Sale (sezonsko sniženje)"],
  ["fw20", /\bfw\b|fw2\d|jesen/i, "-20% na FW kolekciju"],
  ["ss20", /\bss2\d|nova kolekcij/i, "-20% na novu kolekciju"],
  ["bts", /school|\bbts\b|škol|skol/i, "Back to school"],
  ["valentin", /valentin|zaljub/i, "Dan zaljubljenih"],
  ["8mart", /8\.? ?mart|dan žena/i, "8. mart"],
  ["uskrs", /uskr|easter/i, "Uskrs"],
  ["1maj", /1\.? ?maj|prvomaj/i, "1. maj"],
  ["novagod", /nova godin|novogod|\bny\b/i, "Nova godina"],
  ["bozic", /božić|bozic/i, "Božić"],
  ["patike20", /patik/i, "-20% na patike"],
  ["brend", /brend|brand/i, "Akcija na brendove"],
  ["24h", /24 ?h|24 sata/i, "24h online"],
  ["outlet", /outlet/i, "Outlet akcija"],
  ["online", /samo online|online only/i, "Samo online akcija"],
];
// Stalne kampanje i rezerve nisu akcije.
const SKIP = /main campaign|^main\b|univerzal|universal|kiko|ad ?hoc|always|search|dynamic|app install|programmatic|^\s*(pro|rem)\s*$/i;

type Line = { channel: string; type: string; objective: string; budget: number };
type PlanLine = { name: string; network: string; channel: string; type: string; start: string; end: string; regular: number; flash: number; total: number; row: number };
type Row = { key: string; label: string; name: string; start: string; end: string; line: Line };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const ddmm = (iso: string) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}.`;
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d,.-]/g, "").replace(",", ".")) || 0);

function tabMonth(title: string): { y: number; m: number } | null {
  if (!/report/i.test(title)) return null;
  const y = Number(/(20\d\d)/.exec(title)?.[1]);
  const m = MONTHS.find(([re]) => re.test(title.replace(/mpl|report/gi, "")))?.[1];
  return y && m ? { y, m } : null;
}

/** "1.10.", "29.10", "20.9.2026", "10/1/2026" → ISO; godina iz lista (decembar/januar preko granice godine). */
function parseDate(v: unknown, tab: { y: number; m: number }): string | null {
  const s = String(v ?? "").trim();
  let d: number, m: number, y = tab.y;
  let x = /^(\d{1,2})\.(\d{1,2})\.?(\d{4})?\.?$/.exec(s);
  if (x) { d = +x[1]; m = +x[2]; if (x[3]) y = +x[3]; }
  else if ((x = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) { m = +x[1]; d = +x[2]; y = +x[3]; }
  else return null;
  if (!x[3]) { if (tab.m === 1 && m === 12) y -= 1; if (tab.m === 12 && m === 1) y += 1; }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function lineFor(network: string, name: string): Line | null {
  const n = `${network} ${name}`;
  if (/programmatic/i.test(network)) return null;
  if (/tiktok/i.test(network)) return { channel: "TikTok", type: "Prospecting", objective: "Conversion", budget: 0 };
  if (/meta|facebook|\bfb\b/i.test(network)) {
    if (/dpa/i.test(network) || /remarketing/i.test(name)) return { channel: "Meta", type: "Remarketing", objective: "Conversion", budget: 0 };
    if (/awareness/i.test(name)) return { channel: "Meta", type: "Awareness", objective: "Reach", budget: 0 };
    if (/traffic/i.test(name)) return { channel: "Meta", type: "Prospecting", objective: "Traffic", budget: 0 };
    return { channel: "Meta", type: "Prospecting", objective: "Conversion", budget: 0 };
  }
  if (/google/i.test(n)) {
    const type = /pmax/i.test(n) ? "PMax" : /deman|youtube/i.test(n) ? "Demand Gen / YouTube" : /search/i.test(network) ? "Search" : /display/i.test(network) ? "Display" : "PMax";
    return { channel: "Google", type, objective: "Conversion", budget: 0 };
  }
  return null;
}

/** Redovi akcija iz jednog lista. Redovi čiji datumi nisu u mesecu lista (zaostali iz prošlog meseca) se preskaču. */
function parseTab(values: unknown[][], tab: { y: number; m: number }, unknown: string[]): Row[] {
  const from = `${tab.y}-${pad(tab.m)}-01`, to = `${tab.y}-${pad(tab.m)}-${pad(lastDay(tab.y, tab.m))}`;
  const rows: Row[] = [];
  let h: { net: number; start: number; end: number; name: number; reg: number; flash: number } | null = null;
  for (const r of values) {
    const cells = (r ?? []).map((c) => String(c ?? "").trim());
    const start = cells.indexOf("Start"), end = cells.indexOf("End"), reg = cells.findIndex((c) => /^regular$/i.test(c));
    if (start >= 0 && end >= 0) {
      h = { net: cells.indexOf("Network"), start, end, name: end + 1, reg, flash: cells.findIndex((c) => /^flash$/i.test(c)) };
      continue;
    }
    if (!h || h.reg < 0 || /subtotal|total/i.test(cells[h.net - 1] ?? "")) continue;
    const name = cells[h.name] ?? "";
    const s = parseDate(r[h.start], tab), e = parseDate(r[h.end], tab);
    if (!name || !s || !e || e < from || s > to) continue;
    const budget = num(r[h.reg]) + (h.flash >= 0 ? num(r[h.flash]) : 0);
    if (SKIP.test(name)) continue;
    const line = lineFor(cells[h.net] ?? "", name);
    if (!line) continue;
    const base = name.replace(/\s*[-–]?\s*(conversion|traffic|remarketing|awareness|pmax|deman[d]? ?gen|youtube)\s*$/i, "").replace(/^[\s\-–]+/, "").trim();
    const k = KEYS.find(([, re]) => re.test(base));
    if (!k) { if (budget > 0) unknown.push(`${name} (${ddmm(s)}–${ddmm(e)}, ${Math.round(budget)} €)`); continue; }
    rows.push({ key: k[0], label: k[2], name: base, start: s, end: e, line: { ...line, budget } });
  }
  return rows;
}

/** Sve stavke lista sa datumima u mesecu lista (mesečni plan po kampanjama), uključujući loyalty ("Loyalty Budget Split"). */
function parsePlanLines(values: unknown[][], tab: { y: number; m: number }): PlanLine[] {
  const from = `${tab.y}-${pad(tab.m)}-01`, to = `${tab.y}-${pad(tab.m)}-${pad(lastDay(tab.y, tab.m))}`;
  const out: PlanLine[] = [];
  let h: { type: number; net: number; start: number; end: number; name: number; reg: number; flash: number; split: number } | null = null;
  values.forEach((r, i) => {
    const cells = (r ?? []).map((c) => String(c ?? "").trim());
    const start = cells.indexOf("Start"), end = cells.indexOf("End");
    if (start >= 0 && end >= 0) {
      h = { type: cells.findIndex((c) => /^(type|funnel)$/i.test(c)), net: cells.indexOf("Network"), start, end, name: end + 1,
            reg: cells.findIndex((c) => /^regular$/i.test(c)), flash: cells.findIndex((c) => /^flash$/i.test(c)),
            split: cells.findIndex((c) => /budget split/i.test(c)) };
      return;
    }
    if (!h) return;
    const type = cells[h.type] ?? "", name = cells[h.name] ?? "", network = cells[h.net] ?? "";
    if (!name || /subtotal|total/i.test(type)) return;
    const s = parseDate(r[h.start], tab), e = parseDate(r[h.end], tab);
    if (!s || !e || e < from || s > to) return;
    const regular = h.reg >= 0 ? num(r[h.reg]) : 0, flash = h.flash >= 0 ? num(r[h.flash]) : 0;
    const total = h.reg >= 0 ? regular + flash : h.split >= 0 ? num(r[h.split]) : 0;
    const channel = /meta|facebook/i.test(network) ? "Meta Ads" : /google/i.test(network) ? "Google Ads" : /tiktok/i.test(network) ? "TikTok"
      : /programmatic/i.test(network) ? "Programmatic" : network;
    out.push({ name, network, channel, type, start: s, end: e, regular, flash, total, row: i + 1 });
  });
  return out;
}

/** Redovi iste akcije čiji se datumi preklapaju ili su do 2 dana razmaka čine jednu akciju. */
function group(rows: Row[]) {
  const out: { key: string; label: string; name: string; start: string; end: string; lines: Line[] }[] = [];
  const byKey = new Map<string, Row[]>();
  for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  for (const [, rs] of byKey) {
    rs.sort((a, b) => a.start.localeCompare(b.start));
    for (const r of rs) {
      const cur = out.findLast((p) => p.key === r.key);
      const gap = cur ? (Date.parse(r.start) - Date.parse(cur.end)) / 86400_000 : Infinity;
      if (cur && gap <= 2) {
        if (r.end > cur.end) cur.end = r.end;
        cur.lines.push(r.line);
      } else out.push({ key: r.key, label: r.label, name: r.name, start: r.start, end: r.end, lines: [r.line] });
    }
  }
  return out;
}

Deno.serve(async (req) => {
  try {
    const supabase = getServiceClient();
    const presented = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const { data: keys } = await supabase.from("bf_dashboard_api_keys").select("id").eq("key", presented).eq("active", true).limit(1);
    if (!presented || !keys?.length) return json({ error: "invalid_api_key" }, 401);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const dry = body?.dry_run === true;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    if (body?.at_hour != null && Number(body.at_hour) !== hour) return json({ ok: true, skipped: `u Beogradu je ${hour}h` });

    const { data: reporting } = await supabase.rpc("bf_brain_reporting_sync");
    const token = await getPrimaryToken(supabase);
    const access = await getValidAccessToken(supabase, token);
    const auth = { headers: { Authorization: `Bearer ${access}` } };

    const t = today();
    const y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
    // U prvih 5 dana meseca i prošli mesec, ali samo za mesečni plan (PPC tada završava plan i report prošlog meseca);
    // kalendar akcija za prošli mesec se ne dira.
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    const planOnly = Number(t.slice(8, 10)) <= 5 ? [prev] : [];
    const isPlanOnly = (w: { y: number; m: number }) => planOnly.some((p) => p.y === w.y && p.m === w.m);
    const wanted = [...planOnly, { y, m }, m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }];

    let q = supabase.from("bf_mpl_sources").select("market,file_id").order("market");
    if (body?.market) q = q.eq("market", body.market);
    const { data: sources } = await q;
    const report: Record<string, unknown>[] = [];

    for (const src of sources ?? []) {
      const r: Record<string, any> = { market: src.market };
      try {
        const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${src.file_id}?fields=name,modifiedTime&supportsAllDrives=true`, auth);
        if (!meta.ok) throw new Error(`fajl nije dostupan (Drive ${meta.status})`);
        const mj = await meta.json();
        r.modified = mj.modifiedTime;
        const sres = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${src.file_id}?fields=sheets.properties.title`, auth);
        if (!sres.ok) throw new Error(`tabela nije dostupna (Sheets ${sres.status})`);
        const titles: string[] = ((await sres.json()).sheets ?? []).map((s: any) => s.properties?.title ?? "");
        const tabs = wanted.map((w) => ({ w, title: titles.find((x) => { const tm = tabMonth(x); return tm?.y === w.y && tm?.m === w.m; }) }))
          .filter((x) => x.title) as { w: { y: number; m: number }; title: string }[];
        if (!tabs.length) throw new Error(`nema lista za ${pad(m)}.${y}.`);
        r.tabs = tabs.map((x) => x.title);

        const rows: Row[] = [];
        const unknown: string[] = [];
        const planByMonth: { w: { y: number; m: number }; lines: PlanLine[] }[] = [];
        for (const tb of tabs) {
          const range = encodeURIComponent(`'${tb.title.replace(/'/g, "''")}'!A1:Z300`);
          const vres = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${src.file_id}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, auth);
          if (!vres.ok) throw new Error(`list ${tb.title}: Sheets ${vres.status}`);
          const values = (await vres.json()).values ?? [];
          if (!isPlanOnly(tb.w)) rows.push(...parseTab(values, tb.w, unknown));
          planByMonth.push({ w: tb.w, lines: parsePlanLines(values, tb.w) });
        }
        const promos = group(rows);
        const last = tabs[tabs.length - 1].w;
        // Kalendar akcija samo za tekući i sledeći mesec; ako je tu samo list prošlog meseca, akcije se ne usklađuju.
        const firstTab = tabs.find((x) => !isPlanOnly(x.w));
        if (firstTab) {
          const first = firstTab.w;
          const { data: changes, error } = await supabase.rpc("bf_mpl_reconcile", {
            p_market: src.market, p_promos: promos,
            p_from: `${first.y}-${pad(first.m)}-01`, p_to: `${last.y}-${pad(last.m)}-${pad(lastDay(last.y, last.m))}`,
            p_apply: !dry,
          });
          if (error) throw new Error(error.message);
          r.changes = changes ?? [];
        } else r.changes = [];
        r.unknown = unknown;
        r.plan = [];
        for (const pm of planByMonth) {
          const { data: sync, error: se } = await supabase.rpc("bf_mpl_sync_lines", { p_market: src.market, p_year: pm.w.y, p_month: pm.w.m, p_lines: pm.lines, p_apply: !dry });
          if (se) throw new Error(`mesečni plan: ${se.message}`);
          r.plan.push({ month: `${pad(pm.w.m)}.${pm.w.y}.`, lines: pm.lines.length, ...sync });
        }
        // Isti plan u brain-reporting; greška tamo ne zaustavlja proveru za brain.
        r.reporting = [];
        for (const pm of planByMonth) {
          const month = `${pad(pm.w.m)}.${pm.w.y}.`;
          try {
            if (!reporting?.key || !reporting?.apikey) throw new Error("nema ključa za brain-reporting");
            const res = await fetch(reporting.url, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: reporting.apikey },
              body: JSON.stringify({ p_key: reporting.key, p_market: src.market, p_month: `${pm.w.y}-${pad(pm.w.m)}-01`, p_lines: pm.lines, p_apply: !dry }),
            });
            const out = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(out?.message ?? `HTTP ${res.status}`);
            r.reporting.push({ month, ...out });
          } catch (e) {
            r.reporting.push({ month, error: (e as Error).message });
          }
        }
        if (dry) r.promos = promos;
        if (!dry) await supabase.from("bf_mpl_sources").update({ name: mj.name, modified_time: mj.modifiedTime, checked_at: new Date().toISOString(), status: "ok", error: null }).eq("market", src.market);
      } catch (e) {
        r.error = (e as Error).message;
        if (!dry) await supabase.from("bf_mpl_sources").update({ checked_at: new Date().toISOString(), status: "error", error: r.error }).eq("market", src.market);
      }
      report.push(r);
    }

    // Posle upisa osveži BF Live keš da se izmene odmah vide.
    const changed = report.some((r: any) => (r.changes ?? []).some((c: any) => c.applied) || (r.plan ?? []).some((p: any) => p.new + p.updated > 0));
    let refreshed = false;
    if (!dry && changed) {
      const { error: re } = await supabase.rpc("bf_refresh_cache", { p_keys: ["media_plan", "promo", "promo_live"] });
      refreshed = !re;
    }

    // Slack: samo kad ima izmena, pitanja ili grešaka; jednom po terminu (jutro / popodne).
    const blocks = report.map((r: any) => {
      const done = (r.changes ?? []).filter((c: any) => c.applied).map((c: any) => `✅ ${c.message}`);
      const ask = [...(r.changes ?? []).filter((c: any) => !c.applied).map((c: any) => `❓ ${c.message}`),
                   ...(r.unknown ?? []).map((u: string) => `❓ ne prepoznajem akciju: ${u}`),
                   ...(r.plan ?? []).flatMap((p: any) => ((p.questions ?? []) as string[]).map((q) => `❓ mesečni plan ${p.month}: ${q}`))];
      const err = [...(r.error ? [`⚠️ ${r.error}`] : []),
                   ...(r.reporting ?? []).filter((x: any) => x.error).map((x: any) => `⚠️ brain-reporting ${x.month}: ${x.error}`)];
      const plan = (r.plan ?? []).filter((p: any) => p.new + p.updated > 0).map((p: any) => {
        const list = (p.changes ?? []) as string[];
        return `📒 mesečni plan ${p.month}: ${[p.updated && `${p.updated} izmenjeno`, p.new && `${p.new} novo`].filter(Boolean).join(", ")}` +
          `\n      ${list.slice(0, 6).join("\n      ")}${list.length > 6 ? `\n      … i još ${list.length - 6}` : ""}`;
      });
      if (!done.length && !ask.length && !err.length && !plan.length) return null;
      const when = r.modified ? ` · plan izmenjen ${new Date(r.modified).toLocaleString("sr-RS", { timeZone: TZ, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
      return `${FLAG[r.market] ?? ""} *${r.market}*${when}\n${[...err, ...done, ...plan, ...ask].join("\n")}`;
    }).filter(Boolean);

    let slack: string | null = null;
    const slackToken = Deno.env.get("SLACK_BOT_TOKEN") ?? "";
    if (!dry && !body?.no_slack && blocks.length && slackToken) {
      const slot = hour < 12 ? "jutro" : "popodne";
      const key = `mpl:${t}:${slot}`;
      const { data: sent } = await supabase.from("bf_slack_sent").select("key").eq("key", key).limit(1);
      if (!sent?.length) {
        const text = `*📋 Media plan · ${slot === "jutro" ? "jutarnja" : "popodnevna"} provera (${ddmm(t)}, ${hour}h)*\n_Brain čita MPL tabele sa Drive-a i upisuje izmene u kalendar akcija i mesečni plan (BF Live, pacing, PPC pregled). ✅ = upisano, 📒 = mesečni plan po kampanjama, ❓ = nije menjano, proveri._\n\n${blocks.join("\n\n")}`;
        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { Authorization: `Bearer ${slackToken}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ channel: CHANNEL, text, unfurl_links: false }),
        });
        const d = await res.json().catch(() => ({}));
        slack = d.ok ? "sent" : `error: ${d.error ?? res.status}`;
        if (d.ok) await supabase.from("bf_slack_sent").insert({ key, kind: "mpl", channel: CHANNEL, slack_ts: d.ts });
      } else slack = "already sent today";
    }
    return json({ ok: true, dry_run: dry, refreshed, slack, report });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
