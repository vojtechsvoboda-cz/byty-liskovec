// Byty Lískovec – Cloudflare Worker
// Stahuje pronájmy z několika realitních webů, ukládá je do D1, dohledává polohu a datum,
// posílá upozornění přes ntfy a servíruje API pro aplikaci.

const UA = "Mozilla/5.0 (byty-liskovec; osobni hlidac pronajmu)";
const BROWSER = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  "Accept-Language": "cs-CZ,cs;q=0.9",
};
const MAX_KM_STORE = 8;      // ukládáme vše do 8 km od práce, jemné filtrování dělá aplikace
const MAX_PRICE_STORE = 30000;
const SUBREQ_BUDGET = 45;    // bezplatný Workers plán povoluje 50 podpožadavků na jedno spuštění
// D1 free = 100k zapsaných řádků/den pro celý účet → nezměněné inzeráty zapisujeme jen jednou za SEEN_REFRESH
const SEEN_REFRESH = 4 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const KEEP_DAYS = 14;        // inzeráty, které 14 dní nikdo neviděl, se mažou
// úsporný režim podle toho, kdy naposledy někdo (kromě Vojty) appku použil
const ACTIVE_DAYS = 4;       // do 4 dnů od poslední aktivity: kontrola každých 20 min
const SLOW_DAYS = 8;         // 4–8 dní: kontrola jednou za 2 h; déle: pauza, dokud se appka znovu neotevře
const SLOW_EVERY = 2 * 3600 * 1000;
function modeFor(lastActivity, now = Date.now()) {
  const idle = now - (lastActivity || now);
  return idle <= ACTIVE_DAYS * DAY ? "active" : idle <= SLOW_DAYS * DAY ? "slow" : "paused";
}

// ---------- pomocné ----------
function km(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
const decode = (s) => String(s || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, " ").trim();
const toInt = (s) => { const n = parseInt(String(s || "").replace(/[^\d]/g, ""), 10); return Number.isFinite(n) ? n : null; };
// "2+kk", "1+1", "garsoniéra" → jednotný tvar
function dispFrom(text) {
  const t = String(text || "").toLowerCase();
  const m = t.match(/(\d)\s*\+\s*(kk|1)/);
  if (m) return m[1] + "+" + m[2];
  if (/garson/.test(t)) return "1+kk";
  return "";
}
const areaFrom = (text) => { const m = String(text || "").match(/(\d{2,3})\s*m(?:²|2|\b)/i); return m ? parseInt(m[1], 10) : 0; };

// počítadlo podpožadavků, ať nepřekročíme limit Cloudflare
function makeFetcher() {
  const f = async (url, init) => { f.count++; return fetch(url, init); };
  f.count = 0;
  f.left = () => SUBREQ_BUDGET - f.count;
  return f;
}

// ---------- ZDROJ: Sreality (API v1) ----------
async function srcSreality(F) {
  const out = [];
  for (const district of [72, 73]) { // 72 Brno-město, 73 Brno-venkov (Modřice)
    for (let offset = 0; offset < 1500; offset += 100) {
      const res = await F("https://www.sreality.cz/api/v1/estates/search?category_main_cb=1&category_type_cb=2" +
        "&locality_district_id=" + district + "&limit=100&offset=" + offset, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error("Sreality HTTP " + res.status);
      const data = await res.json();
      const results = data?.results || [];
      for (const e of results) {
        const name = (e.advert_name || "").replace(/ /g, " ");
        const disp = (e.category_sub_cb?.name || dispFrom(name)).toLowerCase();
        const loc = e.locality || {};
        const price = e.price_summary_czk || e.price_czk || null;
        const slug = [loc.city_seo_name, loc.citypart_seo_name, loc.street_seo_name].filter(Boolean).join("-") || "brno";
        const img = e.advert_images?.[0] || "";
        out.push({
          id: "sreality-" + e.hash_id, source: "Sreality", title: name,
          price: price ? Math.round(price) : null, disposition: disp, area: areaFrom(name),
          locality: [loc.street, loc.citypart, loc.city].filter(Boolean).join(", "),
          lat: loc.gps_lat, lon: loc.gps_lon,
          url: `https://www.sreality.cz/detail/pronajem/byt/${encodeURIComponent(disp)}/${slug}/${e.hash_id}`,
          image: img ? (img.startsWith("//") ? "https:" + img : img) + "?fl=res,400,300,3|shr,,20|jpg,90" : "",
        });
      }
      const total = data?.pagination?.total ?? 0;
      if (results.length < 100 || offset + 100 >= total) break;
    }
  }
  return out;
}

// ---------- ZDROJ: Bezrealitky (GraphQL) ----------
const BZ_DISP = { GARSONIERA: "1+kk", DISP_1_KK: "1+kk", DISP_1_1: "1+1", DISP_2_KK: "2+kk", DISP_2_1: "2+1", DISP_3_KK: "3+kk", DISP_3_1: "3+1", DISP_4_KK: "4+kk", DISP_4_1: "4+1" };
async function srcBezrealitky(F) {
  const q = "query ListAdverts($offerType:[OfferType],$estateType:[EstateType],$regionOsmIds:[ID],$limit:Int,$offset:Int,$locale:Locale!){listAdverts(offerType:$offerType,estateType:$estateType,regionOsmIds:$regionOsmIds,limit:$limit,offset:$offset){totalCount list{id uri disposition price charges surface address(locale:$locale) gps{lat lng} mainImage{url(filter:RECORD_THUMB)}}}}";
  const out = [];
  for (let offset = 0; offset < 600; offset += 100) {
    const res = await F("https://api.bezrealitky.cz/graphql/", {
      method: "POST", headers: { ...BROWSER, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ operationName: "ListAdverts", query: q, variables: { offerType: ["PRONAJEM"], estateType: ["BYT"], regionOsmIds: ["R438171"], limit: 100, offset, locale: "CS" } }),
    });
    if (!res.ok) throw new Error("Bezrealitky HTTP " + res.status);
    const j = await res.json();
    const d = j?.data?.listAdverts;
    if (!d) throw new Error("Bezrealitky: " + (j?.errors?.[0]?.message || "prázdná odpověď"));
    for (const a of d.list || []) {
      out.push({
        id: "bezrealitky-" + a.id, source: "Bezrealitky",
        title: `Pronájem bytu ${BZ_DISP[a.disposition] || ""} ${a.surface || ""} m²`.trim(),
        price: a.price || null, disposition: BZ_DISP[a.disposition] || "", area: a.surface || 0,
        locality: String(a.address || "").replace(/, Jihomoravský kraj$/, ""),
        lat: a.gps?.lat, lon: a.gps?.lng,
        url: "https://www.bezrealitky.cz/nemovitosti-byty-domy/" + a.uri,
        image: a.mainImage?.url || "",
      });
    }
    if ((d.list || []).length < 100 || offset + 100 >= (d.totalCount || 0)) break;
  }
  return out;
}

// ---------- ZDROJ: UlovDomov (API) ----------
const UD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
function udDisp(s) {
  const m = String(s || "").match(/^(one|two|three|four|five)Plus(Kk|One)$/);
  if (m) return UD_NUM[m[1]] + "+" + (m[2] === "Kk" ? "kk" : "1");
  if (/studio|garson/i.test(s || "")) return "1+kk";
  return "";
}
async function srcUlovDomov(F) {
  const out = [];
  for (let page = 1; page <= 4; page++) {
    const res = await F(`https://ud.api.ulovdomov.cz/v1/offer/find?page=${page}&perPage=100&sorting=latest`, {
      method: "POST", headers: { ...BROWSER, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ offerType: "rent", propertyType: "flat", bounds: { northEast: { lat: 49.235, lng: 16.68 }, southWest: { lat: 49.11, lng: 16.48 } } }),
    });
    if (!res.ok) throw new Error("UlovDomov HTTP " + res.status);
    const j = await res.json();
    const offers = j?.data?.offers || [];
    for (const o of offers) {
      const disp = udDisp(o.disposition) || dispFrom(o.title);
      const street = o.street?.title || "";
      const pub = o.published ? Date.parse(o.published + (/[zZ+]/.test(o.published.slice(10)) ? "" : "+02:00")) : null;
      out.push({
        id: "ulovdomov-" + o.id, source: "UlovDomov", title: o.title || "",
        price: o.rentalPrice?.value || null, disposition: disp, area: o.area || areaFrom(o.title),
        locality: [street, o.address?.villagePart ? "Brno" : ""].filter(Boolean).join(", ") || "Brno",
        lat: o.geoCoordinates?.lat, lon: o.geoCoordinates?.lng,
        url: o.absoluteUrl || `https://www.ulovdomov.cz/inzerat/x/${o.id}`,
        image: o.photos?.[0]?.path || "",
        posted_at: Number.isFinite(pub) ? pub : null, posted_kind: "published",
      });
    }
    const pages = j?.data?.paginator?.totalPages || j?.extraData?.totalPages || 0;
    if (offers.length < 100 || (pages && page >= pages)) break;
  }
  return out;
}

// ---------- ZDROJ: iDNES Reality (HTML, polohu dohledáváme podle adresy) ----------
async function srcIdnes(F) {
  const out = [];
  for (let page = 0; page < 10; page++) {
    const res = await F("https://reality.idnes.cz/s/pronajem/byty/brno-mesto/" + (page ? "?page=" + page : ""), { headers: { ...BROWSER, Accept: "text/html" } });
    if (!res.ok) throw new Error("iDNES HTTP " + res.status);
    const html = await res.text();
    const items = html.split('class="c-products__item').slice(1);
    for (const it of items) {
      const href = (it.match(/<a[^>]+href="(https:\/\/reality\.idnes\.cz\/detail\/[^"]+)"[^>]*class="c-products__link|class="c-products__link"[^>]*href="(https:\/\/reality\.idnes\.cz\/detail\/[^"]+)"/) || []);
      const url = href[1] || href[2] || (it.match(/href="(https:\/\/reality\.idnes\.cz\/detail\/[^"]+)"/) || [])[1];
      if (!url) continue; // reklama apod.
      const idm = url.match(/\/([0-9a-f]{20,})\/?$/);
      const title = decode((it.match(/<h2[^>]*c-products__title[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
      const loc = decode((it.match(/<p[^>]*c-products__info[^>]*>([\s\S]*?)<\/p>/) || [])[1]);
      const priceTxt = decode((it.match(/c-products__price[^>]*>([\s\S]*?)<\/p>/) || [])[1]);
      const img = (it.match(/data-src="([^"]+)"/) || [])[1] || "";
      out.push({
        id: "idnes-" + (idm ? idm[1] : url), source: "iDNES Reality", title: title.replace(/^pronájem\s*/i, "Pronájem "),
        price: /měs/i.test(priceTxt) || /Kč/.test(priceTxt) ? toInt(priceTxt) : null,
        disposition: dispFrom(title), area: areaFrom(title), locality: loc,
        lat: null, lon: null, url, image: img,
        // nejdřív ulice, jinak střed čtvrti ("Brno - Komín" → "Komín, Brno")
        geoq: loc + (/Brno\s*-\s*(.+)$/.test(loc) ? "|" + loc.replace(/^.*Brno\s*-\s*(.+)$/, "$1, Brno") : ""),
      });
    }
    if (!html.includes(`?page=${page + 1}"`)) break;
  }
  return out;
}

// ---------- ZDROJ: Bazoš (HTML, poloha podle ulice/PSČ) ----------
const stats_bazos = {};
async function srcBazos(F) {
  stats_bazos.items = 0;
  const out = [];
  for (let page = 0; page < 4; page++) {
    const res = await F(`https://reality.bazos.cz/pronajmu/byt/${page ? page * 20 + "/" : ""}?hlokalita=62500&humkreis=6&cenado=${MAX_PRICE_STORE}`, { headers: { ...BROWSER, Accept: "text/html" } });
    if (!res.ok) throw new Error("Bazoš HTTP " + res.status);
    const html = await res.text();
    const items = html.split(/class=["']?inzeraty inzeratyflex/).slice(1);
    if (!page && !items.length) throw new Error("Bazoš: nenalezeny inzeráty (délka " + html.length + ", ukázka: " + html.slice(Math.max(0, html.indexOf("inzerat")), Math.max(0, html.indexOf("inzerat")) + 160).replace(/\s+/g, " ") + ")");
    for (const it of items) {
      const a = it.match(/<h2[^>]*nadpis[^>]*>\s*<a[^>]*href=["']?([^"' >]+)["']?[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const path = a[1];
      const idm = path.match(/\/inzerat\/(\d+)\//);
      const title = decode(a[2]);
      const desc = decode((it.match(/<div[^>]*popis[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
      const price = toInt(decode((it.match(/<div[^>]*inzeratycena[^>]*>([\s\S]*?)<\/div>/) || [])[1]));
      const lok = (it.match(/<div[^>]*inzeratylok[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";
      const [city, psc] = lok.split(/<br\s*\/?>/i).map(decode);
      const dm = it.match(/\[(\d{1,2})\.(\d{1,2})\.\s*(\d{4})\]/);
      const img = (it.match(/<img[^>]+src="([^"]+)"[^>]*obrazek|obrazek[^>]*src="([^"]+)"/) || []);
      const disp = dispFrom(title) || dispFrom(desc);
      if (!disp) continue; // pokoje, podnájmy spolubydlení apod.
      out.push({
        id: "bazos-" + (idm ? idm[1] : path), source: "Bazoš", title,
        price: price && price >= 3000 ? price : null, disposition: disp, area: areaFrom(title) || areaFrom(desc),
        locality: [city, psc].filter(Boolean).join(", "),
        lat: null, lon: null,
        // ulice z nadpisu ("…, Bratislavská"), jinak střed PSČ
        geoq: [((title.match(/,\s*([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^\d,]{2,30}?)\s*(?:\d|$|,)/) || [])[1] || "").trim(), city]
          .filter((x, i) => i ? x : x && !/brno|byt|pronáj/i.test(x)).join(", ").replace(/^([^,]+)$/, "") + "|PSC:" + String(psc || "").replace(/\s/g, ""),
        url: path.startsWith("http") ? path : "https://reality.bazos.cz" + path,
        image: img[1] || img[2] || "",
        posted_at: dm ? Date.UTC(+dm[3], +dm[2] - 1, +dm[1], 10) : null, posted_kind: "published",
      });
    }
    stats_bazos.items = (stats_bazos.items || 0) + items.length;
    if (items.length < 20) break;
  }
  return out;
}

const SOURCES = [
  ["Sreality", srcSreality],
  ["Bezrealitky", srcBezrealitky],
  ["UlovDomov", srcUlovDomov],
  ["iDNES Reality", srcIdnes],
  ["Bazoš", srcBazos],
];

// ---------- dohledání polohy (Nominatim, výsledky se ukládají do tabulky geo) ----------
// geoq má podobu "ulice, Brno|čtvrť, Brno" nebo "ulice, Brno|PSC:62500" – od nejpřesnější úrovně po nejhrubší
async function geoLookup(F, q) {
  let url;
  if (q.startsWith("PSC:")) {
    const psc = q.slice(4);
    if (!/^\d{5}$/.test(psc)) return null;
    url = `https://nominatim.openstreetmap.org/search?postalcode=${psc}&country=cz&format=json&limit=1`;
  } else {
    const clean = q.replace(/Brno\s*-\s*[^,]+/, "Brno"); // "Řezáčova, Brno - Komín" → "Řezáčova, Brno"
    url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(clean)}&countrycodes=cz&format=json&limit=1`;
  }
  const res = await F(url, { headers: { "User-Agent": "byty-liskovec/1.0 (osobni hlidac pronajmu; byty-liskovec.vojtechs.workers.dev)" } });
  if (!res.ok) return undefined;
  const r = (await res.json())[0];
  await new Promise((ok) => setTimeout(ok, 1100)); // Nominatim: max 1 dotaz za sekundu
  return r ? { lat: +r.lat, lon: +r.lon } : null;
}

// doplní polohu položkám bez GPS; rozpočet se dělí: nejdřív hrubá poloha pro všechny, pak přesné ulice
async function resolveGeo(env, F, items, known) {
  const need = items.filter((l) => (l.lat == null || l.lon == null) && l.geoq);
  const chains = need.map((l) => l.geoq.split("|").filter(Boolean));
  const allQ = [...new Set(chains.flat())];
  const cache = new Map();
  for (let i = 0; i < allQ.length; i += 50) {
    const part = allQ.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT q, lat, lon, ok FROM geo WHERE q IN (${part.map(() => "?").join(",")})`).bind(...part).all();
    for (const r of results) cache.set(r.q, r.ok ? { lat: r.lat, lon: r.lon } : null);
  }
  // pořadí dotazů do sítě: nejhrubší chybějící úroveň u položek bez polohy, pak přesnější úrovně
  const wanted = [];
  need.forEach((l, i) => {
    const ch = chains[i], prev = known.get(l.id);
    const hasAny = (prev && prev.lat != null) || ch.some((q) => cache.get(q));
    if (!hasAny) { const q = [...ch].reverse().find((q) => !cache.has(q)); if (q) wanted.push([0, q]); }
    const fine = ch.find((q) => !cache.has(q));
    if (fine) wanted.push([1, fine]);
  });
  wanted.sort((a, b) => a[0] - b[0]);
  const done = new Set(), writes = [];
  for (const [, q] of wanted) {
    if (done.has(q) || cache.has(q)) continue;
    if (F.left() <= 6) break;
    done.add(q);
    const g = await geoLookup(F, q);
    if (g === undefined) continue;
    cache.set(q, g);
    writes.push(env.DB.prepare("INSERT OR REPLACE INTO geo (q,lat,lon,ok) VALUES (?,?,?,?)").bind(q, g ? g.lat : null, g ? g.lon : null, g ? 1 : 0));
  }
  if (writes.length) await env.DB.batch(writes);
  // přiřadit nejpřesnější známou polohu; approx 2 = zatím jen hrubá úroveň, zpřesní se příště
  need.forEach((l, i) => {
    const ch = chains[i];
    for (let k = 0; k < ch.length; k++) {
      const g = cache.get(ch[k]);
      if (g) { l.lat = g.lat; l.lon = g.lon; l.approx = ch.slice(0, k).some((q) => !cache.has(q)) ? 2 : 1; return; }
    }
    const prev = known.get(l.id);
    if (prev && prev.lat != null) { l.lat = prev.lat; l.lon = prev.lon; l.approx = prev.approx || 1; }
  });
  return done.size;
}

// ---------- sběr ----------
async function collect(env) {
  const now = Date.now();
  const F = makeFetcher();
  const hLat = parseFloat(env.HOME_LAT), hLon = parseFloat(env.HOME_LON);
  const metaRows = (await env.DB.prepare("SELECT k, v FROM meta").all()).results;
  const meta = Object.fromEntries(metaRows.map((r) => [r.k, r.v]));
  const { results: ex } = await env.DB.prepare("SELECT id, source, first_seen, lat, lon, approx, price, title, url, image, locality, area, km, posted_at, last_seen FROM listings").all();
  const known = new Map(ex.map((r) => [r.id, r]));
  const stats = {}, errors = [], fresh = [], all = [], metaSet = [];

  // 1) stáhnout seznamy ze všech zdrojů (poloha se dohledává až potom, ať na seznamy vždy zbyde rozpočet)
  const got = [];
  for (const [name, fn] of SOURCES) {
    const t0 = Date.now();
    try {
      got.push([name, await fn(F)]);
      stats[name] = { found: got[got.length - 1][1].length, ms: Date.now() - t0 };
      if (name === "Bazoš") stats[name].items = stats_bazos.items;
      metaSet.push(["ok_" + name, String(now)]);
      if (!meta["first_" + name]) metaSet.push(["first_" + name, String(now)]);
    } catch (e) {
      errors.push(name + ": " + String(e.message || e));
      stats[name] = { error: String(e.message || e), ms: Date.now() - t0 };
    }
  }
  // 2) Sreality: datum poslední úpravy z detailu – pár inzerátů za běh, nejbližší první
  try {
    // vybíráme z už načtených řádků, ať se kvůli tomu znovu nečte celá tabulka
    const todo = ex.filter((r) => r.source === "Sreality" && r.posted_at == null && r.km != null && now - (r.last_seen || 0) < SEEN_REFRESH + 3 * 3600 * 1000)
      .sort((a, b) => (b.first_seen - a.first_seen) || (a.km - b.km))
      .slice(0, Math.min(6, Math.max(0, F.left() - 14)));
    const upd = [];
    for (const r of todo) {
      const res = await F("https://www.sreality.cz/api/v1/estates/" + r.id.replace("sreality-", ""), { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 404 || res.status === 410) { upd.push(env.DB.prepare("UPDATE listings SET posted_at=0 WHERE id=?").bind(r.id)); continue; }
      if (!res.ok) continue;
      const ed = (await res.json())?.result?.edited;
      const t = ed ? Date.parse(ed + "T12:00:00+02:00") : NaN;
      upd.push(env.DB.prepare("UPDATE listings SET posted_at=?, posted_kind='edited' WHERE id=?").bind(Number.isFinite(t) ? t : 0, r.id));
    }
    if (upd.length) await env.DB.batch(upd);
    stats.srealityDates = upd.length;
  } catch (e) { errors.push("Sreality datum: " + e.message); }

  // 3) poloha a vzdálenost
  const pool = [];
  for (const [, items] of got) for (const l of items) {
    if (!l.price || l.price > MAX_PRICE_STORE || !l.disposition) continue;
    if (l.lat == null || l.lon == null) {
      const prev = known.get(l.id);
      // už známá přesná poloha → nemusíme znovu dohledávat
      if (prev && prev.lat != null && prev.approx !== 2) { l.lat = prev.lat; l.lon = prev.lon; l.approx = prev.approx || 1; }
    }
    pool.push(l);
  }
  try { stats.geocoded = await resolveGeo(env, F, pool, known); } catch (e) { errors.push("Poloha: " + e.message); }
  const keptBy = {};
  for (const l of pool) {
    if (l.lat != null && l.lon != null) {
      l.km = Math.round(km(hLat, hLon, l.lat, l.lon) * 100) / 100;
      if (l.km > MAX_KM_STORE) continue;
    } else l.km = null; // poloha se dohledá při dalším běhu
    all.push(l);
    keptBy[l.source] = (keptBy[l.source] || 0) + 1;
  }
  for (const [name] of got) stats[name].kept = keptBy[name] || 0;

  const stmt = env.DB.prepare(`INSERT INTO listings (id,source,title,price,disposition,area,locality,lat,lon,km,url,image,first_seen,last_seen,posted_at,posted_kind,approx,geoq)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, price=excluded.price, url=excluded.url, image=excluded.image,
      locality=excluded.locality, title=excluded.title, area=excluded.area,
      lat=COALESCE(excluded.lat, listings.lat), lon=COALESCE(excluded.lon, listings.lon), km=COALESCE(excluded.km, listings.km), approx=excluded.approx,
      posted_at=COALESCE(excluded.posted_at, listings.posted_at), posted_kind=COALESCE(excluded.posted_kind, listings.posted_kind)`);
  const changed = (l, p) => p.price !== l.price || p.title !== l.title || p.url !== l.url || p.image !== l.image ||
    p.locality !== l.locality || (p.area || 0) !== (l.area || 0) ||
    (l.lat != null && (p.lat !== l.lat || p.lon !== l.lon)) || (l.km != null && p.km !== l.km) ||
    (l.posted_at != null && p.posted_at == null);
  const toWrite = all.filter((l) => {
    const p = known.get(l.id);
    if (!p) { fresh.push(l); return true; }
    return changed(l, p) || now - (p.last_seen || 0) >= SEEN_REFRESH;
  });
  stats.written = toWrite.length;
  const stmts = toWrite.map((l) => {
    return stmt.bind(l.id, l.source, l.title, l.price, l.disposition, l.area || 0, l.locality, l.lat ?? null, l.lon ?? null, l.km ?? null,
      l.url, l.image, now, now, l.posted_at ?? null, l.posted_at ? l.posted_kind : null, l.approx || 0, l.geoq ?? null);
  });
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

  // jednou denně smazat inzeráty, které už dlouho nikde nejsou (tabulka zůstane malá → levnější čtení)
  if (now - Number(meta.last_prune || 0) > DAY) {
    try {
      const r = await env.DB.prepare("DELETE FROM listings WHERE last_seen < ?").bind(now - KEEP_DAYS * DAY).run();
      stats.pruned = r.meta?.changes || 0;
      metaSet.push(["last_prune", String(now)]);
    } catch (e) { errors.push("Mazání: " + e.message); }
  }

  metaSet.push(["last_run", String(now)], ["last_errors", JSON.stringify(errors)], ["last_stats", JSON.stringify({ ...stats, subrequests: F.count })]);
  await env.DB.batch(metaSet.map(([k, v]) => env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)").bind(k, v)));

  // upozornění jen na opravdu nové inzeráty (ne první načtení nového zdroje)
  const notifiable = fresh.filter((l) => meta["first_" + l.source] && l.km != null);
  await notify(env, F, notifiable);
  return { new: notifiable.length, errors, stats };
}

async function notify(env, F, fresh) {
  if (!env.NTFY_TOPIC) return;
  const maxP = parseInt(env.NOTIFY_MAX_PRICE, 10), maxK = parseFloat(env.NOTIFY_MAX_KM);
  const hits = fresh.filter((l) => l.price && l.price <= maxP && l.km <= maxK);
  for (const l of hits.slice(0, Math.max(0, Math.min(5, F.left() + 5)))) {
    await fetch("https://ntfy.sh/" + env.NTFY_TOPIC, {
      method: "POST",
      headers: { Title: `Nový byt ${l.disposition} · ${l.price.toLocaleString("cs-CZ")} Kč`, Click: env.APP_URL ? `${env.APP_URL}/go/${encodeURIComponent(l.id)}` : l.url, Tags: "house" },
      body: `${l.locality} · ${l.km} km od práce${l.area ? " · " + l.area + " m²" : ""} · ${l.source}`,
    });
  }
}

// ---------- HTTP ----------
// ---------- aktivita (anonymní denní počty, žádné IP ani identifikátory) ----------
const HIT_KINDS = new Set(["open", "open_app", "click", "fav", "ntfy"]);
function deviceOf(req) {
  const ua = req.headers.get("user-agent") || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh|Windows|Linux|CrOS/i.test(ua)) return "počítač";
  return "jiné";
}
async function logHit(env, req, kind, owner) {
  const now = Date.now();
  const day = new Date(now + 3600e3).toISOString().slice(0, 10); // přibližně český den
  const who = owner ? "ja" : deviceOf(req);
  const stmts = [env.DB.prepare("INSERT INTO activity (day, kind, who, n) VALUES (?,?,?,1) ON CONFLICT(day, kind, who) DO UPDATE SET n = n + 1").bind(day, kind, who)];
  if (!owner) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('last_activity', ?), ('last_activity_kind', ?)").bind(String(now), kind + " · " + who));
  await env.DB.batch(stmts);
}
async function readMeta(env, keys) {
  const { results } = await env.DB.prepare(`SELECT k, v FROM meta WHERE k IN (${keys.map(() => "?").join(",")})`).bind(...keys).all();
  return Object.fromEntries(results.map((r) => [r.k, r.v]));
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MODE_TXT = { active: "Aktivní · kontrola každých 20 min", slow: "Úsporný · kontrola jednou za 2 h", paused: "Pozastaveno · probudí se otevřením appky" };

async function statsPage(env) {
  const m = await readMeta(env, ["last_activity", "last_activity_kind", "last_run", "last_stats"]);
  const since = new Date(Date.now() - 30 * DAY + 3600e3).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare("SELECT day, kind, who, n FROM activity WHERE day >= ? ORDER BY day DESC").bind(since).all();
  const KIND = { open: "Otevření v prohlížeči", open_app: "Otevření z plochy", click: "Klik na inzerát", fav: "Uložení do oblíbených", ntfy: "Klik z upozornění" };
  const days = [...new Set(results.map((r) => r.day))];
  const fmt = (t) => t ? new Date(Number(t)).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "zatím nikdy";
  const mode = modeFor(Number(m.last_activity || 0));
  let st = {}; try { st = JSON.parse(m.last_stats || "{}"); } catch {}
  const rows = days.map((d) => {
    const items = results.filter((r) => r.day === d);
    const others = items.filter((r) => r.who !== "ja");
    const mine = items.filter((r) => r.who === "ja").reduce((a, r) => a + r.n, 0);
    return `<tr><td>${esc(new Date(d + "T12:00:00").toLocaleDateString("cs-CZ", { weekday: "short", day: "numeric", month: "numeric" }))}</td>
      <td>${others.length ? others.map((r) => `${esc(KIND[r.kind] || r.kind)} <b>${r.n}×</b> <span>${esc(r.who)}</span>`).join("<br>") : "<span>nic</span>"}</td>
      <td class="r">${mine ? mine + "×" : "–"}</td></tr>`;
  }).join("");
  const html = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Byty Lískovec · aktivita</title>
<style>:root{--ink:#0f1115;--mute:#80868f;--line:#e8eaee;--surface:#f5f6f8;--green:#18a058;--amber:#c27a00;--grey:#80868f}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--ink);background:#fff}
main{max-width:720px;margin:0 auto;padding:28px max(20px,env(safe-area-inset-left)) 60px}
h1{font-size:24px;letter-spacing:-.02em;margin:0 0 4px}p{margin:0;color:var(--mute)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:22px 0}
.c{background:var(--surface);border-radius:14px;padding:14px 16px}.c small{color:var(--mute);display:block;font-size:12.5px}.c b{font-size:16px;font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:var(--mute);font-weight:500;font-size:12.5px;padding:8px 6px;border-bottom:1px solid var(--line)}
td{padding:10px 6px;border-bottom:1px solid var(--line);vertical-align:top}td span{color:var(--mute)}.r{text-align:right;white-space:nowrap}
a{color:#2563eb}</style></head><body><main>
<h1>Aktivita v aplikaci</h1><p>Anonymní počty za posledních 30 dní. Tvoje zařízení (otevřená přes <a href="/?ja=1">/?ja=1</a>) se počítají zvlášť.</p>
<div class="cards">
<div class="c"><small>Naposledy použila teta</small><b>${esc(fmt(m.last_activity))}</b>${m.last_activity_kind ? `<small>${esc(m.last_activity_kind)}</small>` : ""}</div>
<div class="c"><small>Režim stahování</small><b><span class="dot" style="background:var(--${mode === "active" ? "green" : mode === "slow" ? "amber" : "grey"})"></span>${esc(MODE_TXT[mode])}</b></div>
<div class="c"><small>Poslední kontrola webů</small><b>${esc(fmt(m.last_run))}</b><small>${st.subrequests ? st.subrequests + " dotazů na weby" : ""}</small></div>
</div>
<table><thead><tr><th>Den</th><th>Teta a ostatní</th><th class="r">Ty</th></tr></thead><tbody>${rows || `<tr><td colspan="3"><span>Zatím žádná aktivita.</span></td></tr>`}</tbody></table>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function runScheduled(env) {
  const now = Date.now();
  const m = await readMeta(env, ["last_activity", "last_run"]);
  let la = Number(m.last_activity || 0);
  if (!la) { // první spuštění s počítadlem: začneme v plném režimu
    la = now;
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('last_activity', ?)").bind(String(la)).run();
  }
  const mode = modeFor(la, now);
  if (mode === "paused") return;
  if (mode === "slow" && now - Number(m.last_run || 0) < SLOW_EVERY - 5 * 60 * 1000) return;
  await collect(env);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/status") {
      const m = await readMeta(env, ["last_run", "last_activity"]);
      return Response.json({ lastRun: m.last_run ? Number(m.last_run) : null, mode: modeFor(Number(m.last_activity || 0)) }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/hit" && req.method === "POST") {
      let b = {}; try { b = await req.json(); } catch {}
      if (HIT_KINDS.has(b.k)) await logHit(env, req, b.k, b.who === "ja");
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/go/")) {
      const id = decodeURIComponent(url.pathname.slice(4));
      const row = await env.DB.prepare("SELECT url FROM listings WHERE id = ?").bind(id).first();
      try { await logHit(env, req, "ntfy", url.searchParams.get("who") === "ja"); } catch {}
      return Response.redirect(row?.url && /^https:\/\//.test(row.url) ? row.url : new URL("/", url).href, 302);
    }
    if (url.pathname === "/stats") return statsPage(env);
    if (url.pathname === "/api/listings") {
      const metaRows = (await env.DB.prepare("SELECT k, v FROM meta").all()).results;
      const meta = Object.fromEntries(metaRows.map((r) => [r.k, r.v]));
      const since = Date.now() - 14 * 24 * 3600 * 1000;
      const { results } = await env.DB.prepare(
        "SELECT id,source,title,price,disposition,area,locality,lat,lon,km,url,image,first_seen,last_seen,posted_at,posted_kind,approx FROM listings WHERE last_seen > ? AND lat IS NOT NULL ORDER BY first_seen DESC"
      ).bind(since).all();
      const firstRun = {};
      for (const l of results) {
        // aktivní = byl vidět při posledním úspěšném stažení svého zdroje
        const ok = Number(meta["ok_" + l.source] || 0);
        l.active = !ok || l.last_seen >= ok - SEEN_REFRESH - 90 * 60 * 1000;
        if (!l.posted_at) delete l.posted_at;
        firstRun[l.source] = Number(meta["first_" + l.source] || 0);
      }
      return Response.json({ listings: results, lastRun: meta.last_run ? Number(meta.last_run) : null, firstRun, mode: modeFor(Number(meta.last_activity || 0)) });
    }
    if (url.pathname === "/api/refresh" && req.method === "POST") {
      const last = await env.DB.prepare("SELECT v FROM meta WHERE k='last_run'").first();
      if (last && Date.now() - Number(last.v) < 3 * 60 * 1000) return Response.json({ skipped: true });
      return Response.json(await collect(env));
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_e, env, ctx) { ctx.waitUntil(runScheduled(env)); },
};
