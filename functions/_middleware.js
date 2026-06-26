/**
 * Phoenix 8200 Lab — vícejazyčný middleware (Cloudflare Pages Functions)
 * ----------------------------------------------------------------------
 * Soubor leží v `functions/_middleware.js`, takže ho Cloudflare Pages
 * automaticky zavolá před doservírováním JAKÉHOKOLI requestu na webu.
 *
 * Co dělá:
 *  1. Pro statické soubory (obrázky, CSS, JS, sitemap...) se vůbec nezapojuje
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
        ? "padding:8px 10px;border-radius:6px;text-decoration:none;color:#16140F;font-weight:600;background:#F2EFE6;display:block"
        : "padding:8px 10px;border-radius:6px;text-decoration:none;color:#4a463f;display:block";
      return `<a href="${langHref(code, originPath)}" style="${style}">${LANG_LABELS[code]}</a>`;
    })
    .join("");

  return `<div id="langSwitcher" style="display:flex;align-items:center;margin-left:6px"><details style="position:relative"><summary style="list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid #E7E4DC;border-radius:999px;color:#4a463f;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.04em;user-select:none">${currentLang.toUpperCase()}</summary><div style="position:absolute;right:0;top:calc(100% + 8px);background:#FAFAF8;border:1px solid #E7E4DC;border-radius:10px;box-shadow:0 16px 32px -12px rgba(0,0,0,0.18);padding:6px;display:flex;flex-direction:column;min-width:150px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.04em;z-index:60">${items}</div></details></div>`;
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
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function translateBatch(batchTexts, lang, ai) {
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
  } catch (err) {
    // Necháváme degradovat na originál — viz komentář níže.
  }
  // Fail-safe: když se překlad nepovede / model vrátí nečekaný formát,
  // raději vrátíme nepřeložený (český) text, než abychom stránku rozbili
  // nebo zobrazili odpadní výstup z modelu.
  return batchTexts;
}

// Rozdělí dlouhý seznam textů na menší dávky, ať se nenarazí na limity
// kontextu/výstupu modelu, a přeloží je paralelně (max. 4 dávky najednou).
async function translateAll(texts, lang, ai) {
  const BATCH_MAX_ITEMS = 25;
  const BATCH_MAX_CHARS = 2500;
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const t of texts) {
    if (current.length >= BATCH_MAX_ITEMS || currentChars + t.length > BATCH_MAX_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(t);
    currentChars += t.length;
  }
  if (current.length > 0) batches.push(current);

  const results = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    const translatedSlices = await Promise.all(slice.map((b) => translateBatch(b, lang, ai)));
    for (const s of translatedSlices) results.push(...s);
  }
  return results;
}

// ---------------------------------------------------------------------
// HTMLRewriter — extrakce textu/atributů do placeholderů a zpětné vložení
// ---------------------------------------------------------------------

async function translatePage(originResponse, lang, ai, { originPath }) {
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

  const translations = await translateAll(texts, lang, ai);

  let finalHtml = templated;
  for (let i = 0; i < translations.length; i++) {
    finalHtml = finalHtml.split(placeholder(i)).join(escapeHtml(translations[i]));
  }
  return finalHtml;
}

// ---------------------------------------------------------------------
// Pro CZ verzi nepřekládáme nic, jen doplníme přepínač + hreflang tagy
// ---------------------------------------------------------------------

function decoratePage(response, originPath) {
  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(buildHreflangTags(originPath, "cs"), { html: true });
      },
    })
    .on("nav#mainNav", {
      element(el) {
        el.append(buildSwitcherHtml(originPath, "cs"), { html: true });
      },
    })
    .transform(response);
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
  const isPageRequest = pathname === "/" || pathname.endsWith("/") || pathname.endsWith(".html");
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

  // 4) Cizí jazyk — zkusíme cache
  const contentVersion = env.CONTENT_VERSION || "v1";
  const cacheKey = `${contentVersion}:${lang}:${originPath}`;

  if (env.TRANSLATIONS_KV) {
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

  if (!env.AI) {
    // Workers AI binding chybí (nenastaveno v dashboardu) -> fail-safe na CZ originál
    return decoratePage(originResponse, originPath);
  }

  let translatedHtml;
  try {
    translatedHtml = await translatePage(originResponse, lang, env.AI, { originPath });
  } catch (err) {
    // Cokoliv se pokazí při překladu -> raději ukážeme český originál
    // s přepínačem, než rozbitou stránku.
    const fallbackResponse = await env.ASSETS.fetch(new Request(originUrl, request));
    return decoratePage(fallbackResponse, originPath);
  }

  if (env.TRANSLATIONS_KV) {
    context.waitUntil(
      env.TRANSLATIONS_KV.put(cacheKey, translatedHtml, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {})
    );
  }

  return new Response(translatedHtml, {
    headers: { "content-type": "text/html;charset=UTF-8" },
  });
}
