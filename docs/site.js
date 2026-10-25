// Общий скрипт сайта Mestia: темы, язык RU/EN, появление блоков, шапка.
// Словарь страницы — window.I18N = { key: { ru, en } }; элементы с data-i18n
// получают textContent, с data-i18n-html — innerHTML (только наш собственный текст).
(function () {
  const root = document.documentElement;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим — живём без памяти */ } },
  };

  // Знак Mestia (= LOGO_MARK в src/lib/appIcon.ts)
  const MARK_D = "M35.9 189.1 L79.0 79.9 Q90.0 52.0 103.1 79.0 L118.4 110.2 Q128.0 130.0 141.9 112.9 L155.6 96.2 Q172.0 76.0 182.1 100.0 L219.8 189.3 Q226.0 204.0 210.0 204.0 L46.0 204.0 Q30.0 204.0 35.9 189.1 Z M110.0 146.0 L110.0 178.0 Q110.0 186.0 116.9 182.0 L145.1 166.0 Q152.0 162.0 145.1 158.0 L116.9 142.0 Q110.0 138.0 110.0 146.0 Z";
  const MARK = `<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${MARK_D}"/></svg>`;
  document.querySelectorAll("[data-mark]").forEach((el) => (el.innerHTML = MARK));

  // ── Темы ──
  const THEMES = ["mono", "graphite", "lavender", "midnight", "matcha", "ember", "indigo", "forest"];
  function paintFavicon() {
    const accent = getComputedStyle(root).getPropertyValue("--accent").trim() || "#1a1a1a";
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><rect width='256' height='256' rx='56' fill='${accent}'/><g transform='translate(23 23) scale(0.8203)'><path fill='white' fill-rule='evenodd' d='${MARK_D}'/></g></svg>`;
    const fav = document.getElementById("favicon");
    if (fav) fav.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }
  function setTheme(t) {
    if (!THEMES.includes(t)) return;
    root.dataset.theme = t;
    store.set("mestia.site.theme", t);
    paintFavicon();
    document.dispatchEvent(new CustomEvent("mestia:theme", { detail: t }));
  }
  const savedTheme = store.get("mestia.site.theme");
  if (savedTheme && THEMES.includes(savedTheme)) root.dataset.theme = savedTheme;
  paintFavicon();

  // ── Язык ──
  const dict = window.I18N || {};
  function setLang(l) {
    const lang = l === "en" ? "en" : "ru";
    root.lang = lang;
    store.set("mestia.site.lang", lang);
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const v = dict[el.dataset.i18n];
      if (v) el.textContent = v[lang];
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const v = dict[el.dataset.i18nHtml];
      if (v) el.innerHTML = v[lang];
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      // формат: "attr:key;attr2:key2"
      el.dataset.i18nAttr.split(";").forEach((pair) => {
        const [attr, key] = pair.split(":");
        if (dict[key]) el.setAttribute(attr, dict[key][lang]);
      });
    });
    // Блоки только для одного языка (например, страница политики целиком)
    document.querySelectorAll("[data-lang]").forEach((el) => (el.hidden = el.dataset.lang !== lang));
    if (dict.title) document.title = dict.title[lang];
    document.querySelectorAll(".seg[data-lang-switch] button").forEach((b) => b.classList.toggle("on", b.dataset.set === lang));
    movePill(document.querySelector(".seg[data-lang-switch]"));
    document.dispatchEvent(new CustomEvent("mestia:lang", { detail: lang }));
  }
  function movePill(seg) {
    if (!seg) return;
    const on = seg.querySelector("button.on"), pill = seg.querySelector(".pill");
    if (on && pill) { pill.style.left = on.offsetLeft + "px"; pill.style.width = on.offsetWidth + "px"; }
  }
  document.querySelectorAll(".seg[data-lang-switch] button").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.set)));
  const urlLang = new URLSearchParams(location.search).get("lang");
  const initialLang = urlLang || store.get("mestia.site.lang") || (/^ru|^uk|^be|^kk/i.test(navigator.language || "") ? "ru" : "en");
  setLang(initialLang);
  addEventListener("load", () => movePill(document.querySelector(".seg[data-lang-switch]")));
  addEventListener("resize", () => movePill(document.querySelector(".seg[data-lang-switch]")));

  // ── Шапка: тонкая граница после прокрутки ──
  const top = document.querySelector(".top");
  const onScroll = () => top && top.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // ── Появление блоков (и детей с --i по очереди) ──
  const io = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  window.Mestia = { setTheme, setLang, THEMES, MARK_D, movePill, lang: () => root.lang };
})();
