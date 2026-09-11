# Brain Reporting Platform — skeleton (bez Lovable-a)

React + Vite + TypeScript + Supabase + Tailwind v4 + Recharts.

## Pokretanje lokalno

```
npm install
npm run dev
```

Supabase projekat: `brain-reporting` (ref: yryclxxuueupuruowjvn, region eu-west-1)
Kredencijali su već u `.env.local`.

## Šta je urađeno

- Multi-tenant šema: `agencies` → `clients` → `app_users`, plus `data_sources` i `report_metrics`
- RLS politike po agenciji/klijentu (vidi migraciju `initial_multitenant_schema`)
- Seed podaci za jednog pilot klijenta (14 dana, Meta Ads + Google Ads)
- Dashboard: grafik potrošnje po danu + tabela ukupnih metrika po kanalu

## Šta NIJE urađeno (sledeći koraci)

- **Auth/login** — trenutno se čita kroz privremenu "demo anon read" RLS politiku
  scoped samo na pilot klijenta. Pre nego što ovo ide pravom klijentu, treba:
  1. Dodati Supabase Auth (magic link ili email/password)
  2. Napraviti login stranicu
  3. Ukloniti `demo_public_read_pilot_client` migraciju (ili je drop-ovati)
  4. Kreirati `app_users` red za svakog pravog korisnika
- Windsor.ai sync (Edge Function koja povlači podatke i puni `report_metrics`)
- Client/agency switcher u UI-ju za multi-tenant (trenutno hardkodovano na pilot klijenta)
- Deploy na Vercel/Netlify + custom domen

## Deploy

```
git init && git add -A && git commit -m "initial skeleton"
git remote add origin <tvoj-github-repo>
git push -u origin main
```

Zatim poveži repo na vercel.com — auto-detektuje Vite, doda env varijable
(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) u Vercel project settings, i to je to.
