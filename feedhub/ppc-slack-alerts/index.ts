// ppc-slack-alerts (v4): PPC alarmi i jutarnji pregled u Slack kanal #ppc-alarm.
// mode "alerts" (cron na 5 min): novi alarmi iz bf_alerts + pacing predlozi iz ai_job_events, filtrirani po pravilima
//   PPC tima, svaki se šalje jednom (bf_slack_sent). Svaka poruka objašnjava šta je problem, zašto je važno i šta uraditi.
//   Alarmi provere feeda idu kao jedna poruka sa XLSX primerima u prilogu. BF spiker ide na 4 sata (8, 12, 16 i 20h),
//   zajedno sa „Poslednjih 60 min“ i „Akcije u toku“.
// mode "digest" (cron 06:05 i 07:05 UTC, šalje samo kad je u Beogradu 8h, jednom dnevno): jučerašnji rezultat po
//   tržištu i platformi, akcije danas/sutra, zamor oglasa, top 5 kampanja koje gube prikaze zbog budžeta, provera feeda
//   (sa XLSX primerima).
// mode "feed" (ručno): ponovo pošalji izveštaj poslednje provere feeda sa primerima.
// mode "spiker" (ručno): pošalji poslednji BF spiker sa „Poslednjih 60 min“ i „Akcije u toku“ odmah.
// Auth: Authorization: Bearer <key> iz bf_dashboard_api_keys. POST {"mode": "alerts"|"digest"|"feed"|"spiker", "dry_run": bool, "force": bool}.
import * as XLSX from "npm:xlsx@0.18.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const CHANNEL = "ppc-alarm";
const TZ = "Europe/Belgrade";
const FLAG: Record<string, string> = { RS: "🇷🇸", BA: "🇧🇦", HR: "🇭🇷", ME: "🇲🇪", AL: "🇦🇱", SI: "🇸🇮" };
const MARKETS = ["RS", "BA", "HR", "ME", "AL", "SI"];
// Markets whose spend/revenue data is complete only from this day on; the digest leaves them out before it.
const DATA_FROM: Record<string, string> = { AL: "2026-10-16", SI: "2026-10-16" };

// Thresholds agreed with the PPC team.
const LOSTBUDGET_MIN_ROAS = 5;
const LOSTBUDGET_MIN_LOST_PCT = 50;
const OOS_MIN_EUR = 10;
// BF spiker goes to Slack every 4 hours, at these Belgrade hours.
const SPIKER_HOURS = [8, 12, 16, 20];

const num = (s: string | undefined | null) => (s == null ? NaN : Number(String(s).replace(/\./g, "").replace(",", ".")));
const fmt = (n: number) => Math.round(n).toLocaleString("de-DE");
const dec = (n: number) => n.toFixed(1).replace(".", ",");
const flag = (m?: string | null) => (m ? `${FLAG[m] ?? ""} *${m}*` : "*Sva tržišta*");
const belgrade = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const belgradeHour = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(d));
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ddmm = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.`;

type Alert = { key: string; source: string; severity: string; market: string | null; title: string; detail: string | null; first_seen_at: string };
type StockRow = { market: string; oos_share: number; outlet_oos: number; outlet_sampled: number; regular_oos: number; regular_sampled: number; feed_items: number | null; est_oos_items: number | null; checked_at: string };
type Msg = { key: string; kind: string; text: string; keys?: string[]; attachExamples?: boolean };

/** Builds the detailed Slack text for one bf_alerts row, or null when the PPC rules say to skip it. */
function describe(a: Alert, extra: Record<string, any>): string | null {
  const prefix = a.key.split(":")[0];
  const head = (emoji: string, label: string) => `${emoji} ${flag(a.market)} · ${label}\n*${a.title}*`;
  const detail = a.detail ? `\n${a.detail}` : "";
  switch (prefix) {
    case "mplan":
      return `${head("💸", "Potrošnja iznad media plana")}${detail}\n` +
        `*Šta to znači:* potrošnja na ovoj platformi je više od 110% onoga što media plan predviđa za ovaj period.\n` +
        `*Šta uraditi:* proveri da li je prekoračenje dogovoreno (npr. akcija). Ako nije, smanji dnevne budžete kampanja koje najviše troše ili prebaci deo budžeta na kasnije dane u mesecu.`;
    // The PPC team asked not to get this one as an instant alarm; the morning digest keeps its top 5.
    case "lostbudget":
      return null;
    case "oos": {
      const eur = num(/^([\d.,]+) €/.exec(a.title)?.[1]);
      if (!(eur > OOS_MIN_EUR)) return null;
      return `${head("🚫", "Oglasi za rasprodate proizvode")}${detail}\n` +
        `*Šta to znači:* Meta katalog oglasi (DPA/Advantage+) danas troše novac na proizvode koji na sajtu više nisu dostupni. Kupac klikne, a proizvod ne može da kupi.\n` +
        `*Šta uraditi:* u Meta Commerce Manageru napravi product set sa uslovom „availability = in stock“ i koristi ga u kampanjama, ili privremeno isključi rasprodate artikle iz kataloga. Dugoročno rešenje je ispravan feed (vidi alarme za feed).`;
    }
    case "feed": {
      const s = extra.removed?.[a.market ?? ""];
      const stock = extra.stock?.[a.market ?? ""] as StockRow | undefined;
      let why = "";
      if (s && s.removed > 0) {
        const outletPct = Math.round((s.removed_outlet / s.removed) * 100);
        const brands = (s.top_brands ?? []).slice(0, 3).map((b: any) => `${b.brand} (${fmt(b.n)})`).join(", ");
        why = `\n*Šta je izbačeno:* ${fmt(s.removed)} artikala, od toga ${outletPct}% outlet. Najviše: ${brands}.`;
        why += outletPct >= 80
          ? `\n*Procena:* ovo liči na planirano čišćenje rasprodatih outlet artikala, što je dobro za oglase. Proveri sa e-commerce timom da li je namerno.`
          : `\n*Procena:* izbačeni su i redovni artikli, pa ovo može biti greška u exportu feeda. Proveri sa e-commerce timom što pre.`;
      }
      if (stock) why += `\nJutarnja provera stanja za ${a.market}: ${Math.round(Number(stock.oos_share) * 100)}% artikala iz feeda je rasprodato na sajtu.`;
      return `${head(a.severity === "critical" ? "🔴" : "📦", "Feed: pad broja proizvoda")}${detail}\n` +
        `*Šta to znači:* product feed koji koriste Google Shopping/PMax i Meta katalog naglo je izgubio artikle. Ako je to greška, kampanje gube proizvode za oglašavanje.${why}`;
    }
    case "trendq":
      return `${head("🔎", "Skok u pretrazi na sajtu")}${detail}\n` +
        `*Šta to znači:* kupci na sajtu odjednom traže ovaj pojam mnogo više nego ranije danas (influenser, TV, konkurencija ili vreme).\n` +
        `*Šta uraditi:* proveri da li imamo te proizvode na stanju i da li su istaknuti na sajtu. Ako imamo, pojačaj Search/PMax i Meta oglase za taj brend ili proizvod dok traje interesovanje.`;
    case "ms":
      return `🎉 ${flag(a.market)} · *${a.title}*${detail}`;
    case "automap":
      return `${head("🔗", "Akcija: novi oglasi prepoznati")}${detail}\n` +
        `*Šta to znači:* sistem je sam prepoznao nove akcijske oglase/kampanje (naziv ili tekst sa popustom, pokrenuti uz akciju) i povezao ih sa budžetom akcije i media planom. Od sada se njihova potrošnja i ROAS vide u „Akcijama u toku“.\n` +
        `*Šta uraditi:* ako je nešto povezano pogrešno, javi pa ću ukloniti vezu.`;
    default:
      return null;
  }
}

function pacingText(p: { title: string; body: string; dedupe_key: string }) {
  const market = p.dedupe_key.split(":")[1];
  const below = /ispod plana/i.test(p.title);
  const above = /iznad plana/i.test(p.title);
  const todo = below
    ? "proveri da li kampanje akcije rade i imaju dovoljno budžeta; ako je akcija još aktivna, podigni dnevne budžete da stigneš plan."
    : above
    ? "akcija troši brže od plana: smanji dnevne budžete ili proveri da li je veća potrošnja opravdana rezultatom (ROAS)."
    : "uporedi potrošnju akcije sa planom i prilagodi budžete.";
  return `⏱️ ${flag(market)} · Pacing akcije\n*${p.title}*\n${p.body}\n` +
    `*Šta to znači:* pacing poredi dodatnu potrošnju tokom akcije (iznad uobičajene za te dane) sa budžetom akcije iz media plana. Dobro je između 80% i 120%.\n` +
    `*Šta uraditi:* ${todo}`;
}

function stockCheckText(rows: StockRow[], day: string) {
  const bad = rows.filter((r) => Number(r.oos_share) >= 0.1).sort((a, b) => Number(b.oos_share) - Number(a.oos_share));
  const ok = rows.filter((r) => Number(r.oos_share) < 0.1).map((r) => r.market);
  const worst = bad[0] ? Number(bad[0].oos_share) : 0;
  const lines = bad.map((r) => {
    const share = Math.round(Number(r.oos_share) * 100);
    const est = r.est_oos_items != null && r.feed_items != null ? ` → procena oko ${fmt(r.est_oos_items)} od ${fmt(r.feed_items)} artikala` : "";
    return `${share >= 40 ? "🔴" : "🟠"} ${FLAG[r.market] ?? ""} *${r.market}*: ${share}% rasprodato (outlet ${r.outlet_oos}/${r.outlet_sampled}, redovni ${r.regular_oos}/${r.regular_sampled})${est}`;
  });
  const outletOos = bad.reduce((s, r) => s + r.outlet_oos, 0);
  const regularOos = bad.reduce((s, r) => s + r.regular_oos, 0);
  const mostlyOutlet = outletOos > 0 && outletOos >= 3 * regularOos;
  return `${worst >= 0.4 ? "🔴" : "📦"} *Feed · proizvodi koji su u feedu „na stanju“, a na sajtu rasprodati (provera ${ddmm(day)})*\n` +
    `*Šta je problem:* product feed za Google (Shopping/PMax) i Meta katalog za svaki artikal šalje „in stock“. Jutros smo na sajtu otvorili nasumičnih 40 proizvoda po tržištu (20 outlet i 20 redovnih) i proverili stvarno stanje:\n` +
    lines.join("\n") +
    (ok.length ? `\n🟢 Bez problema: ${ok.join(", ")}` : "") +
    (mostlyOutlet ? `\nProblem je skoro sav u *outletu*: rasprodati outlet artikli ostaju u feedu kao dostupni.` : "") +
    `\n*Zašto je važno:* Google i Meta prikazuju i plaćaju klikove za proizvode koje kupac ne može da kupi. To troši budžet, kvari signal algoritmima i iskustvo kupca.\n` +
    `*Šta uraditi:*\n` +
    `1. E-commerce/dev: feed treba da šalje stvarno stanje (\`availability = out of stock\`) ili da izbaci rasprodate artikle. HR to već radi i tamo je 0%.\n` +
    `2. Dok se to ne reši: u Merchant Centeru i Meta katalogu isključi outlet artikle bez zaliha (supplemental feed ili product set po stanju).\n` +
    `📎 U prilogu su konkretni primeri: naziv, brend, cena, šta feed kaže, šta sajt kaže i link do proizvoda.`;
}

/** Serbian noun form for a count: 1 kupovina, 2-4 kupovine, 5+ kupovina (11-14 take the "many" form). */
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, dd = n % 100;
  return d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
};
const pctChange = (a: number, b: number) => (b > 0 ? `${a >= b ? "+" : "−"}${Math.abs(Math.round(((a - b) / b) * 100))}%` : "");

/** "Poslednjih 60 min" per market, from bf_cache live (web revenue in the last hour and the 60-min funnel vs yesterday). */
function last60Text(live: any) {
  const rows = MARKETS.filter((m) => live?.markets?.[m]).map((m) => {
    const x = live.markets[m];
    const rev = Number(x.last_hour?.web_revenue_eur) || 0, revY = Number(x.last_hour?.web_revenue_yesterday_eur) || 0;
    const f = x.funnel?.now ?? {}, fy = x.funnel?.yesterday ?? {};
    const warn = revY >= 200 && rev < revY * 0.5 ? " ⚠️" : "";
    // begin_checkout is left out: it reads 0 on markets that do have purchases, so it is not tracked reliably.
    const sessions = Number(f.sessions) || 0, purchases = Number(f.purchase) || 0;
    return `${FLAG[m]} *${m}*: ${fmt(rev)} € na sajtu (juče ${fmt(revY)} €${revY > 0 ? `, ${pctChange(rev, revY)}` : ""})${warn} · ` +
      `${fmt(sessions)} ${plural(sessions, "sesija", "sesije", "sesija")} · ${fmt(Number(f.add_to_cart) || 0)} u korpu · ` +
      `${fmt(purchases)} ${plural(purchases, "kupovina", "kupovine", "kupovina")} (juče ${fmt(Number(fy.purchase) || 0)})`;
  });
  return rows.length ? `*⏱️ Poslednjih 60 min* (sajt, isto vreme juče u zagradi)\n${rows.join("\n")}` : "";
}

const short = (n: number) => (n >= 10_000 ? `${dec(n / 1000)}k` : fmt(n));
const signed = (p: number) => `${p >= 0 ? "+" : "−"}${Math.abs(Math.round(p))}%`;
const dm = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`;
const TYPE_LABEL: Record<string, string> = { vikend: "vikend akcija", loyalty: "loyalty akcija" };

/** "Akcije u toku": one block per active promo, from bf_cache promo_live + live (revenue) + insights (pace, products). */
function activePromosText(promo: any, live: any, insights: any, now: Date) {
  const hourLocal = belgradeHour(now), frac = now.getUTCMinutes() / 60;
  const blocks: string[] = [];
  for (const m of MARKETS) {
    for (const a of (promo?.markets?.[m]?.active ?? []) as any[]) {
      const ins = insights?.markets?.[m] ?? {};
      const share = Number(ins.pace?.share_of_day) || 0;
      const h = live?.markets?.[m]?.hourly ?? {};
      const sum = (xs: unknown[] = []) => xs.reduce((s: number, v) => s + (Number(v) || 0), 0);
      const app = sum(h.today_app), web = sum(h.today_web), actual = app + web;
      // Hourly arrays from bf_promo_live are indexed by Belgrade hour.
      const exp = (a.expected_today_utc ?? []) as number[];
      const expDay = Number(a.expected_today_eur) || sum(exp);
      // The share of the day already passed comes from the smooth 16-day curve; the hourly baseline is too spiky on small markets.
      const expSoFar = share > 0 ? expDay * share : sum(exp.slice(0, hourLocal)) + (Number(exp[hourLocal]) || 0) * frac;
      // Under ~10 orders a day one order moves the result by tens of percent.
      const orders = Number(a.orders_expected_day);
      const fewOrders = orders > 0 && orders < 10;
      const L: string[] = [];

      L.push(`${FLAG[m]} *${m} · ${a.label}*`);
      L.push(`_${[a.offer?.label, TYPE_LABEL[a.type] ?? a.type, `dan ${a.day} od ${a.days} (${dm(a.start)}–${dm(a.end)})`].filter(Boolean).join(" · ")}_`);

      // Revenue today vs the expected (no-promo) baseline.
      let rev = `📈 *Prihod danas:* ${fmt(actual)} € (app ${short(app)} € · sajt ${short(web)} €)`;
      if (share > 0.05) rev += ` · projekcija do ponoći ~${fmt(actual / share)} €`;
      if (expSoFar > 0) rev += `\n      Bez akcije bi do sada bilo ~${fmt(expSoFar)} € (ceo dan ~${fmt(expDay)} €) → *${signed(((actual - expSoFar) / expSoFar) * 100)}*`;
      if (fewOrders) rev += `\n      _Malo porudžbina (obično ~${dec(orders)} dnevno): jedna porudžbina pomera rezultat za desetine procenata, procena je okvirna._`;
      L.push(rev);

      const prev = (a.days_so_far ?? []) as any[];
      if (prev.length) {
        L.push(`📊 *Prethodni dani:* ` + prev.map((d) => `dan ${d.day} (${dm(d.date)}): ${fmt(d.actual)} € (${signed(d.uplift_pct)}, obično ${fmt(d.expected)} €)`).join(" · "));
      }

      // Promo budget from the media plan and what the promo campaigns spent so far.
      const mix = (a.mix ?? []) as any[];
      const budget = Number(a.budget_eur) || 0;
      if (budget > 0) {
        const spent = mix.reduce((s, x) => s + (Number(x.spend_eur) || 0), 0);
        const elapsed = Math.min(1, ((Number(a.day) || 1) - 1 + share) / (Number(a.days) || 1));
        let b = `💶 *Budžet akcije:* ${fmt(budget)} € (~${fmt(budget / (Number(a.days) || 1))} €/dan) · potrošeno ${fmt(spent)} € (${Math.round((spent / budget) * 100)}%, a prošlo je ${Math.round(elapsed * 100)}% akcije)`;
        if (spent === 0 && elapsed > 0.15) b += `\n      ⚠️ Nijedna kampanja iz media plana ove akcije još nije prepoznata u potrošnji. Proveri da li su pokrenute i da li se nazivi poklapaju s planom.`;
        else if (elapsed > 0.15 && spent / budget < elapsed * 0.8) b += `\n      ⚠️ Akcijske kampanje troše sporije od plana.`;
        else if (elapsed > 0.15 && spent / budget > elapsed * 1.2) b += `\n      ⚠️ Akcijske kampanje troše brže od plana.`;
        if (mix.length) b += `\n      ` + mix.map((x) => `${x.channel} ${x.type}: ${fmt(Number(x.spend_eur) || 0)}/${fmt(Number(x.budget_eur) || 0)} €${x.roas != null ? ` (ROAS ${dec(Number(x.roas))})` : ""}`).join(" · ");
        L.push(b);
      }

      // All campaigns on the market today, one line per channel.
      const st = ((a.spend_today ?? []) as any[]).filter((s) => Number(s.spend_eur) > 0).sort((x, y) => y.spend_eur - x.spend_eur);
      if (st.length) {
        const tot = st.reduce((s, x) => s + Number(x.spend_eur), 0);
        const val = st.reduce((s, x) => s + Number(x.spend_eur) * (Number(x.roas) || 0), 0);
        const lines = [...new Set(st.map((s) => s.channel))].map((ch) => {
          const xs = st.filter((s) => s.channel === ch);
          const t = xs.reduce((s, x) => s + Number(x.spend_eur), 0);
          return `      *${ch}* ${fmt(t)} €: ` + xs.map((s) => `${s.type} ${fmt(s.spend_eur)} € (ROAS ${dec(Number(s.roas) || 0)})${Number(s.roas) < 2 && s.spend_eur >= 30 && s.type !== "Awareness" ? " ⚠️" : ""}`).join(" · ");
        });
        L.push(`🎯 *Potrošnja danas na tržištu:* ${fmt(tot)} € · ROAS ${dec(val / tot)}\n${lines.join("\n")}`);
      }

      const past = ((a.past ?? []) as any[]).slice(0, 2);
      if (past.length || a.type_avg_uplift_pct != null) {
        const p = past.map((x) => `${dm(x.start)}–${dm(x.end)}${x.start?.slice(0, 4) !== a.start?.slice(0, 4) ? x.start.slice(0, 4) + "." : ""}: ${x.uplift_pct != null ? signed(x.uplift_pct) : "?"}` +
          (x.incr_per_eur != null ? ` (${Number(x.incr_per_eur) < 0 ? "−" : ""}${dec(Math.abs(Number(x.incr_per_eur)))} € dodatnog prihoda po 1 € oglasa)` : ""));
        L.push(`🕘 *Ranije iste akcije:* ${p.join(" · ")}${a.type_avg_uplift_pct != null ? `${p.length ? " · " : ""}prosek ovog tipa akcije ${signed(a.type_avg_uplift_pct)}` : ""}`);
      }

      const ads = ((a.creatives?.top ?? []) as any[]).sort((x, y) => (Number(y.spend_eur) || 0) - (Number(x.spend_eur) || 0)).slice(0, 3);
      if (ads.length) {
        L.push(`🖼️ *Oglasi koji najviše troše u akciji:*\n` + ads.map((c) =>
          `      „${c.ad}“${c.format && c.format !== "Ostalo" ? ` (${c.format})` : ""} · ${fmt(Number(c.spend_eur) || 0)} € · ROAS ${dec(Number(c.roas) || 0)} · CTR ${dec(Number(c.ctr) || 0)}%${c.has_offer ? "" : " · _bez ponude u tekstu_"}`).join("\n"));
      }

      const top = ((ins.top_products ?? []) as any[]).slice(0, 3);
      if (top.length) L.push(`🛍️ *Najprodavanije danas:* ` + top.map((p) => `${p.name} (${p.qty} kom · ${fmt(Number(p.revenue_eur) || 0)} €)`).join(" · "));
      // Only products with real demand; 1-2 views are noise.
      const oos = ((ins.out_of_stock_viewed ?? []) as any[]).filter((p) => Number(p.views_3h) >= 5).slice(0, 3);
      if (oos.length) L.push(`🚫 *Rasprodato, a gledaju ga:* ` + oos.map((p) => `${p.name} (${p.views_3h} ${plural(Number(p.views_3h), "pregled", "pregleda", "pregleda")} za 3 h)`).join(" · "));

      const comp = ((a.competition?.competitors ?? []) as any[])
        .map((c) => {
          const offers = ((c.offers ?? []) as any[]).filter((o) => o.pct);
          if (!offers.length) return null;
          const best = Math.max(...offers.map((o) => Number(o.pct)));
          const code = offers.find((o) => o.kod);
          return { name: c.name, best, text: `${c.name} ${offers.some((o) => o.do && Number(o.pct) === best) ? "do " : ""}−${best}%${code ? ` (kod ${code.kod} −${code.pct}%)` : ""}` };
        })
        .filter(Boolean)
        .sort((x: any, y: any) => y.best - x.best)
        .slice(0, 4) as { text: string }[];
      if (comp.length) L.push(`🥊 *Konkurencija u oglasima:* ${comp.map((c) => c.text).join(" · ")}`);

      blocks.push(L.join("\n"));
    }
  }
  return blocks.length ? `*🏷️ Akcije u toku*\n---\n${blocks.join("\n---\n")}` : "*🏷️ Akcije u toku*\nTrenutno nema aktivnih akcija.";
}

async function slackApi(token: string, method: string, body: unknown, form = false) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
    },
    body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.ok) throw new Error(`slack ${method}: ${d.error ?? res.status}${d.needed ? ` (needed: ${d.needed})` : ""}`);
  return d;
}

/** Posts a message; long texts are split into several section blocks (Slack limit is 3000 chars per block), a "---" line is a divider. */
async function postSlack(token: string, text: string) {
  const blocks: unknown[] = [];
  let chunk = "";
  for (const line of text.split("\n")) {
    if (line === "---") {
      if (chunk) blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
      blocks.push({ type: "divider" });
      chunk = "";
      continue;
    }
    if (chunk.length + line.length + 1 > 2900) { blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } }); chunk = ""; }
    chunk += (chunk ? "\n" : "") + line;
  }
  if (chunk) blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
  const d = await slackApi(token, "chat.postMessage", { channel: CHANNEL, text: text.replace(/\n---\n/g, "\n").slice(0, 3000), blocks, unfurl_links: false, unfurl_media: false });
  return { ts: d.ts as string, channel: d.channel as string };
}

/** Uploads a file into the channel right under the given message (files.getUploadURLExternal flow). */
async function uploadFile(token: string, channelId: string, filename: string, title: string, bytes: Uint8Array, comment: string) {
  const u = await slackApi(token, "files.getUploadURLExternal", { filename, length: String(bytes.length) }, true);
  const up = await fetch(u.upload_url, { method: "POST", body: bytes });
  if (!up.ok) throw new Error(`slack upload: ${up.status}`);
  await slackApi(token, "files.completeUploadExternal", { files: [{ id: u.file_id, title }], channel_id: channelId, initial_comment: comment });
}

function examplesXlsx(rows: Record<string, unknown>[]) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [6, 10, 18, 44, 18, 9, 10, 13, 7, 10, 22, 70].map((wch) => ({ wch }));
  ws["!autofilter"] = { ref: ws["!ref"] ?? "A1" };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Rasprodato na sajtu");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const slackToken = Deno.env.get("SLACK_BOT_TOKEN") ?? "";
  const db = { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const rest = async (path: string) => {
    const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: db });
    if (!r.ok) throw new Error(`rest ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const rpc = async (fn: string, args: unknown) => {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, { method: "POST", headers: db, body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`rpc ${fn}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const markSent = (rows: { key: string; slack_ts: string | null; kind: string }[]) =>
    rows.length === 0 ? Promise.resolve() : fetch(`${supabaseUrl}/rest/v1/bf_slack_sent?on_conflict=key`, {
      method: "POST", headers: { ...db, Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(rows.map((r) => ({ ...r, channel: CHANNEL }))),
    });
  const latestStock = async (since: Date): Promise<StockRow[]> => {
    const rows = await rest(`bf_feed_stock_checks?checked_at=gte.${since.toISOString()}&select=market,oos_share,outlet_oos,outlet_sampled,regular_oos,regular_sampled,feed_items,est_oos_items,checked_at&order=checked_at.desc`) as StockRow[];
    const seen = new Set<string>();
    return rows.filter((x) => (seen.has(x.market) ? false : (seen.add(x.market), true)))
      .sort((a, b) => MARKETS.indexOf(a.market) - MARKETS.indexOf(b.market));
  };
  /** Posts the examples file under a message; a failed upload must not lose the message itself. */
  const attachExamples = async (channelId: string, day: string, since: Date): Promise<string | null> => {
    try {
      const rows = await rpc("bf_feed_stock_examples", { p_since: since.toISOString() }) as Record<string, unknown>[];
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const markets = [...new Set(rows.map((r) => String(r.trziste)))].join(", ");
      await uploadFile(slackToken, channelId, `feed_rasprodato_primeri_${day}.xlsx`, `Feed: rasprodato na sajtu, ${ddmm(day)}`,
        examplesXlsx(rows), `📎 Primeri iz jutarnje provere feeda (${rows.length} artikala, ${markets}): u feedu „in stock“, na sajtu rasprodato.`);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  try {
    const presented = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!presented) return json({ error: "missing_api_key" }, 401);
    const keyRows = await rest(`bf_dashboard_api_keys?key=eq.${encodeURIComponent(presented)}&active=eq.true&select=id`).catch(() => []);
    if (!Array.isArray(keyRows) || keyRows.length === 0) return json({ error: "invalid_api_key" }, 401);
    if (!slackToken) return json({ error: "missing_slack_token" }, 500);

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const mode = ["digest", "feed", "spiker"].includes(body?.mode) ? body.mode : "alerts";
    const dryRun = body?.dry_run === true;
    const now = new Date();
    const today = belgrade(now);
    const stockSince = new Date(now.getTime() - 26 * 3600_000);

    /** Latest BF spiker comment plus "Poslednjih 60 min" and "Akcije u toku". */
    const spiker = async () => {
      const comm = (await rest(`bf_cache?key=eq.commentary&select=payload`).catch(() => []))?.[0]?.payload;
      const last = comm?.history?.[0];
      if (comm?.today !== today || !last?.at || !Array.isArray(last.lines) || last.lines.length === 0) return null;
      const hour = belgradeHour(new Date(last.at));
      const [liveRows, promoRows, insRows] = await Promise.all([
        rest(`bf_cache?key=eq.live&select=payload`).catch(() => []),
        rest(`bf_cache?key=eq.promo_live&select=payload`).catch(() => []),
        rest(`bf_cache?key=eq.insights&select=payload`).catch(() => []),
      ]);
      const live = liveRows?.[0]?.payload, promo = promoRows?.[0]?.payload, insights = insRows?.[0]?.payload;
      const text = [
        `🎙️ *BF spiker · ${last.headline ?? comm.clock}*\n${last.lines.map((l: string) => `• ${l}`).join("\n")}`,
        last60Text(live),
        promo ? activePromosText(promo, live, insights, now) : "",
      ].filter(Boolean).join("\n\n");
      return {
        key: `spiker:${today}:${String(hour).padStart(2, "0")}`, hour, text,
        fresh: now.getTime() - new Date(last.at).getTime() < 20 * 60_000,
      };
    };

    // Manual: send the latest spiker message now (no hourly dedupe).
    if (mode === "spiker") {
      const sp = await spiker();
      if (!sp) return json({ status: "skipped", reason: "no commentary today" });
      if (dryRun) return json({ status: "ok", dry_run: true, text: sp.text });
      await postSlack(slackToken, sp.text);
      return json({ status: "ok", sent: 1 });
    }

    // Manual: (re)send the latest feed stock check report with the examples file.
    if (mode === "feed") {
      const stock = await latestStock(stockSince);
      if (stock.length === 0) return json({ status: "skipped", reason: "no stock check in the last 26h" });
      const text = stockCheckText(stock, belgrade(new Date(stock[0].checked_at)));
      if (dryRun) return json({ status: "ok", dry_run: true, text });
      const { channel } = await postSlack(slackToken, text);
      const warning = await attachExamples(channel, today, stockSince);
      return json({ status: "ok", sent: 1, warning });
    }

    if (mode === "alerts") {
      const since = new Date(now.getTime() - 3 * 3600_000).toISOString();
      const [alerts, pacing, sentRows] = await Promise.all([
        rest(`bf_alerts?first_seen_at=gte.${since}&select=key,source,severity,market,title,detail,first_seen_at&order=first_seen_at.asc&limit=200`),
        rest(`ai_job_events?created_at=gte.${new Date(now.getTime() - 26 * 3600_000).toISOString()}&dedupe_key=like.pacing:*&status=eq.proposed&select=title,body,dedupe_key&order=created_at.asc`),
        rest(`bf_slack_sent?sent_at=gte.${new Date(now.getTime() - 3 * 86400_000).toISOString()}&select=key`),
      ]);
      const sent = new Set((sentRows as { key: string }[]).map((r) => r.key));
      const fresh = (alerts as Alert[]).filter((a) => !sent.has(a.key));

      // Extra context for feed alerts.
      const extra: Record<string, any> = { removed: {}, stock: {} };
      const feedMarkets = [...new Set(fresh.filter((a) => a.key.startsWith("feed:") && a.market).map((a) => a.market!))];
      const needStock = feedMarkets.length > 0 || fresh.some((a) => a.key.startsWith("stockcheck:"));
      const stock = needStock ? await latestStock(stockSince) : [];
      for (const s of stock) extra.stock[s.market] = s;
      await Promise.all(feedMarkets.map(async (m) => {
        extra.removed[m] = await rpc("bf_feed_removed_summary", { p_market: m, p_since: stockSince.toISOString() }).catch(() => null);
      }));

      const out: Msg[] = [];
      // All stock-check alerts of a run go out as one message with the examples file.
      const stockAlerts = fresh.filter((a) => a.key.startsWith("stockcheck:"));
      if (stockAlerts.length > 0 && stock.length > 0) {
        out.push({ key: stockAlerts[0].key, keys: stockAlerts.map((a) => a.key), kind: "stockcheck", text: stockCheckText(stock, today), attachExamples: true });
      }
      for (const a of fresh) {
        if (a.key.startsWith("stockcheck:")) continue;
        const text = describe(a, extra);
        if (text) out.push({ key: a.key, kind: a.key.split(":")[0], text });
      }
      for (const p of pacing as { title: string; body: string; dedupe_key: string }[]) {
        if (!sent.has(p.dedupe_key)) out.push({ key: p.dedupe_key, kind: "pacing", text: pacingText(p) });
      }
      // BF spiker (bf-commentary, every 15 min): sent every 4 hours (08, 12, 16, 20h Belgrade), first fresh comment of that hour.
      const sp = SPIKER_HOURS.includes(belgradeHour(now)) ? await spiker() : null;
      if (sp && sp.fresh && SPIKER_HOURS.includes(sp.hour) && !sent.has(sp.key)) out.push({ key: sp.key, kind: "spiker", text: sp.text });
      if (dryRun) return json({ status: "ok", dry_run: true, would_send: out });

      const done: { key: string; slack_ts: string | null; kind: string }[] = [];
      const warnings: string[] = [];
      let error: string | null = null;
      for (const m of out.slice(0, 15)) {
        try {
          const { ts, channel } = await postSlack(slackToken, m.text);
          for (const k of m.keys ?? [m.key]) done.push({ key: k, slack_ts: ts, kind: m.kind });
          if (m.attachExamples) {
            const w = await attachExamples(channel, today, stockSince);
            if (w) warnings.push(w);
          }
        } catch (e) {
          error = (e as Error).message;
          break;
        }
      }
      await markSent(done);
      return json({ status: error ? "partial" : "ok", sent: done.length, pending: Math.max(0, out.length - done.length), error, warnings }, error ? 502 : 200);
    }

    // ---- digest ----
    const digestKey = `digest:${today}`;
    if (!body?.force && belgradeHour(now) !== 8) return json({ status: "skipped", reason: "not 08h in Belgrade" });
    const already = await rest(`bf_slack_sent?key=eq.${encodeURIComponent(digestKey)}&select=key`);
    if (!body?.force && Array.isArray(already) && already.length > 0) return json({ status: "skipped", reason: "already sent" });

    const yesterday = addDays(today, -1);
    const tomorrow = addDays(today, 1);
    const [mp, hist, promos, fatigue, lost, stock] = await Promise.all([
      rpc("bf_media_plan", { p_date: yesterday }),
      rest(`bf_history_daily?date=eq.${yesterday}&select=market,revenue_eur,purchases`),
      rest(`bf_promo_events?or=(start_date.eq.${today},end_date.eq.${today},start_date.eq.${tomorrow})&select=market,label,start_date,end_date,budget_eur&order=market`),
      rest(`bf_alerts?key=like.fatigue:*&first_seen_at=gte.${new Date(now.getTime() - 30 * 3600_000).toISOString()}&select=market,title,detail&order=market`),
      rest(`bf_alerts?key=like.lostbudget:*&first_seen_at=gte.${new Date(now.getTime() - 30 * 3600_000).toISOString()}&select=market,title,detail`),
      latestStock(stockSince),
    ]);

    const lines: string[] = [`*☀️ PPC jutarnji pregled · ${ddmm(today)}*`];

    // 1) yesterday by market and platform
    const rev: Record<string, number> = {};
    const orders: Record<string, number> = {};
    for (const h of hist as { market: string; revenue_eur: number; purchases: number }[]) {
      rev[h.market] = Number(h.revenue_eur) || 0;
      orders[h.market] = Number(h.purchases) || 0;
    }
    const mk = (mp as any)?.markets ?? {};
    const rows: string[] = [];
    const skipped: string[] = [];
    let tSpend = 0, tPlan = 0, tRev = 0;
    for (const m of MARKETS) {
      const x = mk[m];
      if (!x) continue;
      if (DATA_FROM[m] && yesterday < DATA_FROM[m]) { skipped.push(m); continue; }
      const spend = Number(x.spend_eur) || 0, plan = Number(x.budget_eur) || 0, r = rev[m] ?? 0;
      tSpend += spend; tPlan += plan; tRev += r;
      const pct = plan > 0 ? Math.round((spend / plan) * 100) : null;
      const mark = pct == null ? "" : pct > 110 ? " ⚠️ iznad plana" : pct < 80 ? " ⚠️ ispod plana" : "";
      const vsPlan = pct != null ? ` (${pct}% plana ${fmt(plan)} €)${mark}` : " (nema plana)";
      const roas = spend > 0 ? ` · ROAS ${dec(r / spend)}` : "";
      const bp = x.by_platform ?? {};
      const plat = [["Meta", bp.meta_ads], ["Google", bp.google_ads]]
        .filter(([, v]) => v && (Number(v.spend_eur) > 0 || Number(v.budget_eur) > 0))
        .map(([n, v]: any) => `${n} ${fmt(Number(v.spend_eur) || 0)}/${fmt(Number(v.budget_eur) || 0)} €`).join(" · ");
      rows.push(`${FLAG[m]} *${m}*: potrošeno ${fmt(spend)} €${vsPlan} · prihod ${fmt(r)} €${orders[m] ? ` (${fmt(orders[m])} porudžbina)` : ""}${roas}` +
        (plat ? `\n      ${plat} (potrošeno/plan)` : ""));
    }
    lines.push(`\n*Juče (${ddmm(yesterday)}) po tržištu* — ukupno ${fmt(tSpend)} € od plana ${fmt(tPlan)} €, prihod ${fmt(tRev)} €` +
      (tSpend > 0 ? `, ROAS ${dec(tRev / tSpend)}` : "") + `\n${rows.join("\n")}`);
    lines.push("_ROAS = prihod sajta i aplikacije / potrošnja na Meta i Google. ⚠️ = potrošnja ispod 80% ili iznad 110% dnevnog plana._" +
      (skipped.length ? `\n_${skipped.join(" i ")}: podaci tek od ${ddmm(DATA_FROM[skipped[0]])}, u pregledu od sledećeg dana._` : ""));

    // 2) promos
    const p = promos as { market: string; label: string; start_date: string; end_date: string; budget_eur: number }[];
    const startToday = p.filter((x) => x.start_date === today);
    const endToday = p.filter((x) => x.end_date === today && x.start_date !== today);
    const startTomorrow = p.filter((x) => x.start_date === tomorrow);
    const promoLine = (x: typeof p[number]) => `${FLAG[x.market]} ${x.market}: ${x.label} (${ddmm(x.start_date)}–${ddmm(x.end_date)}, plan ${fmt(Number(x.budget_eur) || 0)} €)`;
    const promoParts: string[] = [];
    if (startToday.length) promoParts.push(`🚀 *Danas počinje* (proveri da su kampanje aktivne i da troše):\n${startToday.map(promoLine).join("\n")}`);
    if (endToday.length) promoParts.push(`🏁 *Danas se završava* (večeras ugasi ili vrati kampanje i budžete na redovne):\n${endToday.map(promoLine).join("\n")}`);
    if (startTomorrow.length) promoParts.push(`⏰ *Sutra kreće* (pripremi kampanje, kreative i budžete danas):\n${startTomorrow.map(promoLine).join("\n")}`);
    lines.push(`\n*Akcije*\n${promoParts.length ? promoParts.join("\n") : "Danas nema početka ni kraja akcije, a ni sutra ne kreće nova."}`);

    // 3) fatigue
    const f = fatigue as { market: string; title: string; detail: string | null }[];
    lines.push(`\n*Zamor oglasa* — isti ljudi vide oglas previše puta (frekvencija) ili CTR pada; vreme za novi kreativ.\n` +
      (f.length ? f.slice(0, 8).map((x) => `${FLAG[x.market] ?? ""} ${x.market}: ${x.title.replace(/^Zamor oglasa /, "")}${x.detail ? `\n      ${x.detail}` : ""}`).join("\n") : "Nema oglasa sa znacima zamora."));

    // 4) top 5 lost to budget, ranked by the estimated extra revenue in the alert detail
    const l = (lost as { market: string; title: string; detail: string | null }[])
      // same thresholds as the instant alarm
      .filter((x) => num(/gubi (\d+)%/.exec(x.title)?.[1]) > LOSTBUDGET_MIN_LOST_PCT && num(/ROAS ([\d.,]+)/.exec(x.title)?.[1]) > LOSTBUDGET_MIN_ROAS)
      .map((x) => ({ ...x, gain: num(/≈ \+([\d.,]+) € prihoda/.exec(x.detail ?? "")?.[1]) || 0 }))
      .sort((a, b) => b.gain - a.gain)
      // the same campaign can raise several alerts within 30h; keep only its best one
      .filter((x, i, arr) => arr.findIndex((y) => y.market === x.market && y.title.split(" gubi ")[0] === x.title.split(" gubi ")[0]) === i)
      .slice(0, 5);
    lines.push(`\n*Top 5 kampanja koje gube prikaze zbog budžeta* — profitabilne kampanje kojima ranije u danu ponestane budžeta; predlog je koliko podići dnevni budžet.\n` +
      (l.length ? l.map((x, i) => `${i + 1}. ${FLAG[x.market] ?? ""} ${x.title}${x.detail ? ` — ${x.detail.split(" · ").slice(-1)[0]}` : ""}`).join("\n") : "Nema kampanja koje gube prikaze zbog budžeta."));

    // 5) feed stock check
    const s = stock as StockRow[];
    const bad = s.filter((x) => Number(x.oos_share) >= 0.1);
    lines.push(`\n*Provera feeda* — artikli koje feed šalje Google-u i Meti kao „na stanju“, a na sajtu su rasprodati (uzorak 40 po tržištu)\n` +
      (s.length ? s.map((x) => {
        const share = Math.round((Number(x.oos_share) || 0) * 100);
        const est = share >= 10 && x.est_oos_items != null && x.feed_items != null ? ` → oko ${fmt(x.est_oos_items)} od ${fmt(x.feed_items)} artikala` : "";
        return `${share >= 40 ? "🔴" : share >= 10 ? "🟠" : "🟢"} ${x.market}: ${share}% (outlet ${x.outlet_oos}/${x.outlet_sampled}, redovni ${x.regular_oos}/${x.regular_sampled})${est}`;
      }).join("\n") + (bad.length ? `\nOglasi troše na klikove za proizvode koji se ne mogu kupiti. Rešenje: feed treba da šalje stvarno stanje (HR to već radi), a do tada isključiti rasprodate outlet artikle u Merchant Centeru i Meta katalogu. Primeri su u prilogu.` : "")
        : "Provera feeda danas još nije urađena."));

    const text = lines.join("\n");
    if (dryRun) return json({ status: "ok", dry_run: true, text });
    const { ts, channel } = await postSlack(slackToken, text);
    const warning = bad.length ? await attachExamples(channel, today, stockSince) : null;
    await markSent([{ key: digestKey, slack_ts: ts, kind: "digest" }]);
    return json({ status: "ok", sent: 1, warning });
  } catch (e) {
    return json({ error: "internal_error", detail: (e as Error).message }, 500);
  }
});
