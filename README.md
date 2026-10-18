# Byty Brno – hlídač pronájmů

## Nasazení (jednou)
1. `npm i -g wrangler && wrangler login`
2. `wrangler d1 create byty-brno` → zkopíruj `database_id` do `wrangler.toml`
3. `wrangler d1 execute byty-brno --remote --file=schema.sql`
4. Do `NTFY_TOPIC` ve `wrangler.toml` vymysli unikátní název (např. `byty-teta-x7k2`)
5. `wrangler deploy` → dostaneš adresu `byty-brno.<tvuj-ucet>.workers.dev`
6. Otevři `/` a klikni „Hledat teď“ (první naplnění databáze)

Nebo přes Git: pushni složku na GitHub a v Cloudflare → Workers → Import from Git.

## Pro tetu
- Odkaz otevře v Safari/Chrome → Sdílet → Přidat na plochu.
- Aplikace se sama obnovuje každou minutu, nové byty mají štítek NOVÉ.
- Notifikace: nainstaluje si **ntfy** (App Store / Google Play), přihlásí se k odběru stejného názvu jako `NTFY_TOPIC`. Klik na notifikaci otevře inzerát.

## Nastavení
- Bod (Domov pro seniory Mikuláškovo nám. 706/20): `HOME_LAT`, `HOME_LON`
- Notifikace jen pro byty do `NOTIFY_MAX_PRICE` Kč a do `NOTIFY_MAX_KM` km
- Kontrola každých 20 minut (`crons`)

## Zdroje
Sreality, Bezrealitky, UlovDomov (API s GPS), iDNES Reality a Bazoš (HTML, poloha se dohledává přes Nominatim a ukládá do tabulky `geo`).
Další zdroj = nová funkce v poli `SOURCES` v `src/index.js`. Statistiky posledního běhu jsou v tabulce `meta` pod klíčem `last_stats`.
Stejný byt z více webů aplikace sloučí do jedné karty („Také na …“).
