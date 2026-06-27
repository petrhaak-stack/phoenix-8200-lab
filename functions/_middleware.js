/**
 * Phoenix 8200 Lab — vícejazyčný middleware (Cloudflare Pages Functions)
 * ----------------------------------------------------------------------
 * Soubor leží v `functions/_middleware.js`, takže ho Cloudflare Pages
 * automaticky zavolá před doservírováním JAKÉHOKOLI requestu na webu.
 *
 * Co dělá:
 *  1. Pro statické soubory (obrázky, CSS, JS, sitemap...) se vůbec nezapojuje změna
 *     — necháme je obsloužit normálně, ať nezatěžujeme AI/KV.
 *  2. Pro HTML stránky rozhodne jazyk: prefix v URL (/en/, /de/, /fr/, /es/)
 *     > cookie "lang" > Accept-Language hlavička + cf.country > výchozí cs.
 *  3. Pokud je jazyk cs, jen doplní do originální stránky přepínač jazyků
 *     a hreflang tagy a vrátí ji (žádný překlad, žádné AI).
 *  4. Pokud je jazyk en/de/fr/es, zkusí ho najít v KV cache. Když tam není,
 *     vezme český originál (env.ASSETS.fetch), přeloží texty přes Workers AI
 *     a výsledek uloží do KV, aby se příště už jen četlo z cache.
 *
 * Než se to nahraje na GitHub, je potřeba v Cloudflare dashboardu (Workers
 * & Pages → phoenix-8200-lab → Settings → Bindings) nastavit:
 *   - KV namespace binding s názvem proměnné  TRANSLATIONS_KV
 *   - Workers AI binding s názvem proměnné    AI
 *   - (volitelně) Environment variable        CONTENT_VERSION = "v1"
 *     — když přepíšeš nějaký text na webu, zvyš na "v2" atd., aby se
 *     zahodila stará přeložená verze z cache.
 *
 * Bez těchto bindingů Function spadne na chybě (env.AI / env.TRANSLATIONS_KV
 * nebudou existovat) — kód na to reaguje fail-safe: když něco nejde,
 * vrátí raději český originál, než aby zobrazil rozbitou stránku.
 */

const SUPPORTED_LANGS = ["en", "de", "fr", "es"];

const LANG_NAMES = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
};

const LANG_LABELS = {
  cs: "CS — Čeština",
  en: "EN — English",
  de: "DE — Deutsch",
  fr: "FR — Français",
  es: "ES — Español",
};

// Geolokace (cf.country) jako dorovnání, pokud Accept-Language nic neřekne.
const COUNTRY_LANG_MAP = {
  GB: "en", IE: "en", US: "en", AU: "en", CA: "en", NZ: "en", ZA: "en",
  DE: "de", AT: "de", CH: "de", LI: "de",
  FR: "fr", BE: "fr", LU: "fr",
  ES: "es", MX: "es", AR: "es", CO: "es", CL: "es",
};

// Termíny, které se NIKDY nepřekládají — značky, modely, technické jednotky.
// Doplň sem cokoliv dalšího, co by se mohlo "přeložit" nesmyslně.
const GLOSSARY = [
  "Phoenix 8200 Lab", "Phoenix MIDI 8200 BML", "PHOENIX MIDI 8200 BML",
  "Lilie IQflow", "Oxygenics Fury", "BodySpa", "Marquart",
  "Stebel Nautilus Compact", "Stebel Nautilus", "HELLA Bi-LED",
  "Carawater", "Nespresso",
  "km", "km/h", "l/min", "bar", "GPM", "Hz", "dB", "V", "Ah", "W", "kWh",
];

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const SITE_ORIGIN = "https://phoenix7.vip";

// ---------------------------------------------------------------------
// Pomocné funkce — cookies, Accept-Language, detekce jazyka
// ---------------------------------------------------------------------

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function parseAcceptLanguage(header) {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [tagPart, qPart] = part.trim().split(";q=");
      const tag = tagPart.trim().toLowerCase().split("-")[0];
      const q = qPart ? parseFloat(qPart) : 1;
      return { tag, q: Number.isFinite(q) ? q : 1 };
    })
    .sort((a, b) => b.q - a.q);
}

function detectLanguage(request) {
  const preferences = parseAcceptLanguage(request.headers.get("Accept-Language"));
  for (const { tag } of preferences) {
    if (tag === "cs") return "cs";
    if (SUPPORTED_LANGS.includes(tag)) return tag;
  }
  const country = request.cf && request.cf.country;
  if (country && COUNTRY_LANG_MAP[country]) return COUNTRY_LANG_MAP[country];
  return "cs";
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function placeholder(idx) {
  return `§§T${idx}§§`; // §§T0§§ — nepravděpodobná kolize s reálným textem
}

function langHref(code, originPath) {
  return code === "cs" ? originPath : `/${code}${originPath}`;
}

function absoluteUrl(code, originPath) {
  return `${SITE_ORIGIN}${langHref(code, originPath)}`;
}

// ---------------------------------------------------------------------
// Injekce přepínače jazyků + hreflang/canonical tagů (čistý HTML, bez JS)
// ---------------------------------------------------------------------

function buildSwitcherHtml(originPath, currentLang) {
  const items = ["cs", ...SUPPORTED_LANGS]
    .map((code) => {
      const isActive = code === currentLang;
      const style = isActive
        ? "padding:8px 10px;border-radius:6px;text-decoration:none;color:#16140F;font-weight:600;background:#F2EFE6;display:block;white-space:nowrap"
        : "padding:8px 10px;border-radius:6px;text-decoration:none;color:#4a463f;display:block;white-space:nowrap";
      // Label rozdělíme na krátký kód ("CS") a celý název ("Čeština") do
      // dvou <span>. Na desktopu (v rozbalovacím panelu) se zobrazuje obojí,
      // na mobilu (viz CSS níž) skryjeme tu dlouhou část, ať se všechny
      // jazyky vejdou do jednoho řádku jako kompaktní zkratky.
      const label = LANG_LABELS[code]; // např. "CS — Čeština"
      const [shortCode, ...rest] = label.split(" — ");
      const longName = rest.join(" — ");
      return `<a href="${langHref(code, originPath)}" style="${style}"><span class="lsCode">${shortCode}</span><span class="lsName" style="margin-left:4px">— ${longName}</span></a>`;
    })
    .join("");

  // POZOR (mobil, historie oprav):
  // 1) Nejdřív vyčuhoval celý rozbalovací panel mimo obrazovku, protože byl
  //    "position:absolute;right:0" vázaný na úzký badge na levém okraji
  //    full-width mobilního menu.
  // 2) Po zarovnání badge doprava se panel sice vešel "pod" řádek, ale byl
  //    to znovu samostatný malý vyskakovací rámeček (position:absolute) —
  //    a uživatel chce přesně tohle NE: žádné další okno/rámeček.
  // Finální řešení: na mobilu se <details> obsah (seznam jazyků) vůbec
  // nechová jako vyskakovací panel. Přepneme ho na "position:static" a
  // "display:flex" (s !important, aby to přebilo i nativní skryté chování
  // zavřeného <details>, i inline styly), takže se jazyky vykreslí přímo
  // do toho samého řádku, kde svítí aktuální jazyk — žádné kliknutí na
  // rozbalení není potřeba, žádné samostatné okno se neotvírá. Dlouhý
  // název (".lsName") na mobilu skryjeme, zůstanou jen krátké zkratky
  // (CS/EN/DE/FR/ES), aby se vešly vedle sebe na šířku obrazovky.
  return `<style>
@media (max-width:900px){
  #langSwitcher{width:100% !important;margin:14px 0 0 !important;flex-wrap:wrap}
  #langSwitcher summary{display:none !important}
  #langSwitcher details{position:static !important;width:100%}
  #langSwitcher details>div{
    position:static !important;
    top:auto !important;
    right:auto !important;
    display:flex !important;
    flex-direction:row !important;
    flex-wrap:wrap !important;
    align-items:center !important;
    width:100% !important;
    min-width:0 !important;
    background:transparent !important;
    border:none !important;
    box-shadow:none !important;
    padding:0 !important;
    gap:8px !important;
  }
  #langSwitcher .lsName{display:none !important}
}
</style><div id="langSwitcher" style="display:flex;align-items:center;margin-left:6px"><details style="position:relative"><summary style="list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid #E7E4DC;border-radius:999px;color:#4a463f;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.04em;user-select:none">${currentLang.toUpperCase()}</summary><div style="position:absolute;right:0;top:calc(100% + 8px);background:#FAFAF8;border:1px solid #E7E4DC;border-radius:10px;box-shadow:0 16px 32px -12px rgba(0,0,0,0.18);padding:6px;display:flex;flex-direction:column;min-width:150px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.04em;z-index:60">${items}</div></details></div>`;
}

function buildHreflangTags(originPath, currentLang) {
  const tags = ["cs", ...SUPPORTED_LANGS].map(
    (code) => `<link rel="alternate" hreflang="${code}" href="${absoluteUrl(code, originPath)}">`
  );
  tags.push(`<link rel="alternate" hreflang="x-default" href="${absoluteUrl("cs", originPath)}">`);
  tags.push(`<link rel="canonical" href="${absoluteUrl(currentLang, originPath)}">`);
  return tags.join("");
}

// ---------------------------------------------------------------------
// Workers AI překlad — dávkový (batch) překlad seznamu textů
// ---------------------------------------------------------------------

function buildPrompt(batchTexts, lang) {
  return `You are a professional translator localizing a personal travel blog about a converted camper van (motorhome) for camper/RV enthusiasts. Translate the following JSON array of short text fragments from Czech into ${LANG_NAMES[lang]}.

Rules:
- Translate naturally and colloquially, the way a native ${LANG_NAMES[lang]} speaker writing a camper-travel blog would write it. Do NOT translate word-by-word or literally.
- Never translate these terms — keep them exactly as written, including capitalization: ${GLOSSARY.join(", ")}.
- Keep numbers, units and product codes unchanged.
- Preserve any leading/trailing whitespace style roughly as-is.
- Return ONLY a valid JSON array of strings, in the exact same order and exact same count as the input array. No explanations, no markdown, no extra text before or after the array.

Input JSON array (${batchTexts.length} items):
${JSON.stringify(batchTexts)}`;
}

function extractJsonArray(raw) {
  // POZOR: nelze jen brát první "[" a poslední "]" v celém textu —
  // přeložené texty samy můžou obsahovat hranaté závorky (např. popisky
  // typu "[ FOTO – 5 ]"), takže "poslední ]" v odpovědi modelu může být
  // uvnitř obsahu, ne konec JSON pole. Místo toho najdeme první "["
  // a od něj počítáme hloubku závorek, přičemž ignorujeme vše uvnitř
  // stringových literálů (tam se "[" / "]" nepočítají).
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function translateBatch(batchTexts, lang, ai, errors) {
  if (batchTexts.length === 0) return [];
  try {
    const result = await ai.run(MODEL, {
      prompt: buildPrompt(batchTexts, lang),
      max_tokens: 2048,
    });
    const raw = result && result.response ? result.response : "";
    const arr = extractJsonArray(raw);
    if (Array.isArray(arr) && arr.length === batchTexts.length) {
      return arr.map((t, i) => (typeof t === "string" && t.length > 0 ? t : batchTexts[i]));
    }
    if (errors) {
      errors.push({
        stage: "parse",
        message: "AI response nebyla validní JSON array se správnou délkou",
        rawPreview: typeof raw === "string" ? raw.slice(0, 300) : String(raw),
        expectedLength: batchTexts.length,
        gotLength: Array.isArray(arr) ? arr.length : null,
      });
    }
  } catch (err) {
    if (errors) {
      errors.push({
        stage: "ai.run",
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null,
      });
    }
  }
  // Fail-safe: když se překlad nepovede / model vrátí nečekaný formát,
  // raději vrátíme nepřeložený (český) text, než abychom stránku rozbili
  // nebo zobrazili odpadní výstup z modelu.
  return batchTexts;
}

// Rozdělí dlouhý seznam textů na menší dávky, ať se nenarazí na limity
// kontextu/výstupu modelu, a přeloží je paralelně (max. 4 dávky najednou).
async function translateAll(allTexts, lang, ai, errors) {
  // Deduplikace: web obsahuje hodně opakujících se textů (popisky, štítky,
  // nadpisy v menu...). Když je pošleme do jedné dávky vícekrát, model se
  // na nich občas "zacyklí" (vrátí degenerovaný výstup) nebo spočítá délku
  // špatně. Každý unikátní text proto přeložíme jen jednou a výsledek
  // pak namapujeme zpátky na všechny výskyty.
  const uniqueTexts = [...new Set(allTexts)];

  const BATCH_MAX_ITEMS = 15;
  const BATCH_MAX_CHARS = 2000;
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const t of uniqueTexts) {
    if (current.length >= BATCH_MAX_ITEMS || currentChars + t.length > BATCH_MAX_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(t);
    currentChars += t.length;
  }
  if (current.length > 0) batches.push(current);

  const uniqueResults = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    const translatedSlices = await Promise.all(slice.map((b) => translateBatch(b, lang, ai, errors)));
    for (const s of translatedSlices) uniqueResults.push(...s);
  }

  // Namapovat přeložené unikátní texty zpátky na původní (s duplicitami) pořadí.
  const translationByOriginal = new Map();
  uniqueTexts.forEach((t, i) => translationByOriginal.set(t, uniqueResults[i]));
  return allTexts.map((t) => translationByOriginal.get(t));
}

// ---------------------------------------------------------------------
// HTMLRewriter — extrakce textu/atributů do placeholderů a zpětné vložení
// ---------------------------------------------------------------------

async function translatePage(originResponse, lang, ai, { originPath, errors, debugInfo }) {
  const texts = [];
  let skipDepth = 0;

  class SkipTracker {
    element(el) {
      skipDepth++;
      el.onEndTag(() => {
        skipDepth--;
      });
    }
  }

  class TextCollector {
    constructor() {
      this.buffer = "";
    }
    text(chunk) {
      if (skipDepth > 0) return;
      this.buffer += chunk.text;
      if (chunk.lastInTextNode) {
        const original = this.buffer;
        this.buffer = "";
        if (original.trim().length > 0) {
          const idx = texts.length;
          texts.push(original);
          chunk.replace(placeholder(idx), { html: false });
        } else if (original.length > 0) {
          chunk.replace(original, { html: false });
        }
      } else {
        chunk.remove();
      }
    }
  }

  class AttrCollector {
    element(el) {
      for (const name of ["alt", "title", "placeholder"]) {
        const v = el.getAttribute(name);
        if (v && v.trim().length > 0) {
          const idx = texts.length;
          texts.push(v);
          el.setAttribute(name, placeholder(idx));
        }
      }
    }
  }

  class MetaContentCollector {
    element(el) {
      const v = el.getAttribute("content");
      if (v && v.trim().length > 0) {
        const idx = texts.length;
        texts.push(v);
        el.setAttribute("content", placeholder(idx));
      }
    }
  }

  class HtmlLangSetter {
    element(el) {
      el.setAttribute("lang", lang);
    }
  }

  class HeadInjector {
    element(el) {
      el.append(buildHreflangTags(originPath, lang), { html: true });
    }
  }

  class HeaderSwitcherInjector {
    element(el) {
      el.append(buildSwitcherHtml(originPath, lang), { html: true });
    }
  }

  const rewriter = new HTMLRewriter()
    .on("html", new HtmlLangSetter())
    .on("head", new HeadInjector())
    .on("nav#mainNav", new HeaderSwitcherInjector())
    .on("script, style, noscript, code, pre", new SkipTracker())
    .on('meta[name="description"]', new MetaContentCollector())
    .on('meta[property="og:title"]', new MetaContentCollector())
    .on('meta[property="og:description"]', new MetaContentCollector())
    .on('meta[name="twitter:title"]', new MetaContentCollector())
    .on('meta[name="twitter:description"]', new MetaContentCollector())
    .on("img, a, button, input", new AttrCollector())
    .on("*", new TextCollector());

  const templated = await rewriter.transform(originResponse).text();

  const translations = await translateAll(texts, lang, ai, errors);

  if (debugInfo) {
    debugInfo.textsCount = texts.length;
    debugInfo.samples = texts.slice(0, 5).map((t, i) => ({
      original: t,
      translated: translations[i],
      changed: translations[i] !== t,
    }));
  }

  let finalHtml = templated;
  for (let i = 0; i < translations.length; i++) {
    finalHtml = finalHtml.split(placeholder(i)).join(escapeHtml(translations[i]));
  }
  return finalHtml;
}

// ---------------------------------------------------------------------
// Pro CZ verzi nepřekládáme nic, jen doplníme přepínač + hreflang tagy
// ---------------------------------------------------------------------

function decoratePage(response, originPath, lang = "cs") {
  const transformed = new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(buildHreflangTags(originPath, lang), { html: true });
      },
    })
    .on("nav#mainNav", {
      element(el) {
        el.append(buildSwitcherHtml(originPath, lang), { html: true });
      },
    })
    .transform(response);
  // DOČASNÉ DEBUG: vypnout cache, ať nás při ladění nemate stará odpověď.
  const headers = new Headers(transformed.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(transformed.body, { status: transformed.status, headers });
}

// ---------------------------------------------------------------------
// onRequest — vstupní bod Pages Function
// ---------------------------------------------------------------------

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // 1) Statické soubory (obrázky, CSS, JS, sitemap.xml, robots.txt...)
  //    necháváme projít beze zásahu — žádné AI, žádná cache, žádný switcher.
  //    POZOR: cesty jako "/en" nebo "/de" (BEZ koncového lomítka a BEZ .html)
  //    musí být taky považované za stránku — jinak je tahle podmínka tiše
  //    pošle přes next() a celá jazyková logika se nikdy nespustí. Proto
  //    se díváme na to, jestli poslední segment cesty obsahuje příponu
  //    (".jpg", ".css", ".xml"...) — pokud ne, jde o stránku.
  const lastSegment = pathname.split("/").pop();
  const hasFileExtension = lastSegment.includes(".");
  const isPageRequest =
    pathname === "/" || pathname.endsWith("/") || pathname.endsWith(".html") || !hasFileExtension;
  if (!isPageRequest) {
    return next();
  }

  // 2) Jazyk podle prefixu v URL
  const langMatch = pathname.match(/^\/(en|de|fr|es)(\/.*)?$/);
  const prefixLang = langMatch ? langMatch[1] : null;
  const originPath = langMatch ? langMatch[2] || "/" : pathname;

  let lang = prefixLang;

  if (!lang) {
    const cookieLang = getCookie(request, "lang");

    if (cookieLang && SUPPORTED_LANGS.includes(cookieLang)) {
      // Uživatel si dřív zvolil jazyk, ale přišel na neprefixované URL
      // (např. naťukal phoenix7.vip přímo) -> přesměrujeme na jeho jazyk.
      const redirectUrl = `${url.origin}/${cookieLang}${pathname}${url.search}`;
      return new Response(null, {
        status: 302,
        headers: { Location: redirectUrl },
      });
    }

    if (!cookieLang) {
      // První návštěva bez cookie -> autodetekce podle Accept-Language / cf.country
      const detected = detectLanguage(request);
      if (detected !== "cs") {
        const redirectUrl = `${url.origin}/${detected}${pathname}${url.search}`;
        return new Response(null, {
          status: 302,
          headers: {
            Location: redirectUrl,
            "Set-Cookie": `lang=${detected}; Path=/; Max-Age=31536000; SameSite=Lax`,
          },
        });
      }
    }

    lang = "cs";
  }

  // 3) CZ verze — žádný překlad, jen vložíme přepínač a hreflang tagy
  if (lang === "cs") {
    const originResponse = await next();
    return decoratePage(originResponse, originPath);
  }

  // 3b) Cizí jazyk: pokud už pro danou stránku existuje hotový, ručně
  // přeložený statický soubor (např. /en/index.html, /de/blog/...), použijeme
  // ho přímo — žádné AI, žádný KV, žádný risk poškozených relativních cest
  // nebo nekvalitního/zkráceného překladu. Workers AI překlad "na počkání"
  // (níž) zůstává jen jako fallback pro stránky/jazyky, pro které statický
  // překlad (ještě) neexistuje — typicky nově přidaný obsah nebo jazyky
  // mimo en/de, které se zatím ručně nepřekládají.
  // POZOR: NEPŘIDÁVAT sem "index.html" natvrdo! Cloudflare Pages servíruje
  // adresářové URL ve "vyčištěné" podobě (např. "/en/") a explicitní dotaz
  // na ".../index.html" interně přesměruje (3xx) zpátky na vyčištěnou formu.
  // env.ASSETS.fetch ten redirect vrátí jako odpověď se status 3xx, takže
  // "staticResponse.ok" je false a celá tahle větev se tiše přeskočí — to
  // byl důvod, proč /en/ a /de/ na produkci dál ukazovaly český originál,
  // přestože /en/index.html i /de/index.html na GitHubu existovaly. Proto
  // necháváme adresářovou cestu beze změny a dovolíme i jeden redirect.
  let staticPath = pathname;
  if (!hasFileExtension && !staticPath.endsWith("/")) {
    staticPath = `${staticPath}/`;
  }
  const staticUrl = new URL(staticPath, url.origin);
  let staticResponse = await env.ASSETS.fetch(new Request(staticUrl, request));
  if (staticResponse.status >= 300 && staticResponse.status < 400) {
    const redirectLocation = staticResponse.headers.get("Location");
    if (redirectLocation) {
      const redirectUrl = new URL(redirectLocation, staticUrl);
      staticResponse = await env.ASSETS.fetch(new Request(redirectUrl, request));
    }
  }
  if (staticResponse.ok) {
    return decoratePage(staticResponse, originPath, lang);
  }

  // DOČASNÉ DEBUG: ?debug=1 obejde KV cache (mohla v sobě mít zacachovaný
  // "úspěšný", ale ve skutečnosti nepřeložený výsledek) a ukáže skutečné
  // chyby z AI volání místo tichého fallbacku. Po vyřešení smazat.
  const isDebug = url.searchParams.get("debug") === "1";

  // 4) Cizí jazyk — zkusíme cache
  const contentVersion = env.CONTENT_VERSION || "v1";
  const cacheKey = `${contentVersion}:${lang}:${originPath}`;

  if (env.TRANSLATIONS_KV && !isDebug) {
    try {
      const cached = await env.TRANSLATIONS_KV.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: { "content-type": "text/html;charset=UTF-8" },
        });
      }
    } catch {
      // KV nedostupné -> pokračujeme bez cache
    }
  }

  // 5) Cache miss -> vezmeme český originál a přeložíme
  const originUrl = new URL(originPath, url.origin);
  const originResponse = await env.ASSETS.fetch(new Request(originUrl, request));

  if (!originResponse.ok) {
    return originResponse; // 404 apod. — předáme beze změny
  }

  // DOČASNÉ DEBUG: souhrn stavu bindingů, vždy dostupný i bez volání AI.
  const debugBase = {
    timestamp: new Date().toISOString(),
    url: request.url,
    lang,
    originPath,
    cacheKey,
    envAI: typeof env.AI,
    envTRANSLATIONS_KV: typeof env.TRANSLATIONS_KV,
    envASSETS: typeof env.ASSETS,
  };

  if (!env.AI) {
    if (isDebug) {
      return new Response(
        "MIDDLEWARE DEBUG DUMP (env.AI chybí)\n\n" + JSON.stringify(debugBase, null, 2),
        { status: 200, headers: { "content-type": "text/plain;charset=UTF-8", "Cache-Control": "no-store" } }
      );
    }
    // Workers AI binding chybí (nenastaveno v dashboardu) -> fail-safe na CZ originál
    return decoratePage(originResponse, originPath, lang);
  }

  const translateErrors = [];
  const debugInfo = { textsCount: null, samples: [] };
  let translatedHtml;
  let caughtException = null;
  try {
    translatedHtml = await translatePage(originResponse, lang, env.AI, {
      originPath,
      errors: translateErrors,
      debugInfo,
    });
  } catch (err) {
    caughtException = err && err.stack ? err.stack : String(err);
  }

  if (isDebug) {
    return new Response(
      "MIDDLEWARE DEBUG DUMP\n\n" +
        JSON.stringify(
          {
            ...debugBase,
            caughtException,
            translateErrorsCount: translateErrors.length,
            translateErrors,
            textsCount: debugInfo.textsCount,
            samples: debugInfo.samples,
          },
          null,
          2
        ),
      { status: 200, headers: { "content-type": "text/plain;charset=UTF-8", "Cache-Control": "no-store" } }
    );
  }

  if (caughtException) {
    // Cokoliv se pokazí při překladu -> raději ukážeme český originál
    // s přepínačem, než rozbitou stránku.
    const fallbackResponse = await env.ASSETS.fetch(new Request(originUrl, request));
    return decoratePage(fallbackResponse, originPath, lang);
  }

  // Nikdy nezacachovávat výsledek, ve kterém se jedna nebo víc dávek
  // přeložit nepovedlo — jinak by se "nepřeložený" obsah natrvalo uložil
  // do KV jako kdyby šlo o platný překlad.
  if (env.TRANSLATIONS_KV && translateErrors.length === 0) {
    context.waitUntil(
      env.TRANSLATIONS_KV.put(cacheKey, translatedHtml, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {})
    );
  }

  return new Response(translatedHtml, {
    headers: { "content-type": "text/html;charset=UTF-8", "Cache-Control": "no-store" },
  });
}
