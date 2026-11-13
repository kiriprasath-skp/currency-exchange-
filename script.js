(() => {
  "use strict";

  /* -------------------------------------------------------
     Config
  ------------------------------------------------------- */
  const API_BASE = "https://open.er-api.com/v6/latest/";
  const CACHE_KEY = "cx_rate_cache_v1";
  const PAIR_KEY = "cx_last_pair_v1";
  const FETCH_TIMEOUT_MS = 8000;
  const DEBOUNCE_MS = 200;

  const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "IDR", "HUF", "CLP", "ISK", "UGX"]);

  const CURRENCY_NAMES = {
    USD: "US Dollar", EUR: "Euro", GBP: "British Pound", INR: "Indian Rupee",
    JPY: "Japanese Yen", AUD: "Australian Dollar", CAD: "Canadian Dollar",
    CHF: "Swiss Franc", CNY: "Chinese Yuan", HKD: "Hong Kong Dollar",
    SGD: "Singapore Dollar", NZD: "New Zealand Dollar", SEK: "Swedish Krona",
    NOK: "Norwegian Krone", DKK: "Danish Krone", ZAR: "South African Rand",
    AED: "UAE Dirham", SAR: "Saudi Riyal", THB: "Thai Baht",
    MYR: "Malaysian Ringgit", IDR: "Indonesian Rupiah", PHP: "Philippine Peso",
    VND: "Vietnamese Dong", KRW: "South Korean Won", BRL: "Brazilian Real",
    MXN: "Mexican Peso", RUB: "Russian Ruble", TRY: "Turkish Lira",
    PLN: "Polish Zloty", EGP: "Egyptian Pound", NGN: "Nigerian Naira",
    PKR: "Pakistani Rupee", BDT: "Bangladeshi Taka", LKR: "Sri Lankan Rupee",
    NPR: "Nepalese Rupee", QAR: "Qatari Riyal", KWD: "Kuwaiti Dinar",
    ILS: "Israeli Shekel", CZK: "Czech Koruna", HUF: "Hungarian Forint",
    RON: "Romanian Leu",
  };

  const QUICK_PAIRS = [
    ["USD", "INR"], ["EUR", "INR"], ["GBP", "INR"],
    ["INR", "USD"], ["AED", "INR"], ["USD", "EUR"],
  ];

  /* -------------------------------------------------------
     DOM
  ------------------------------------------------------- */
  const form = document.getElementById("converter-form");
  const amountInput = document.getElementById("amount");
  const fromSelect = document.getElementById("from-currency");
  const toSelect = document.getElementById("to-currency");
  const swapBtn = document.getElementById("swap-btn");
  const flapDisplay = document.getElementById("flap-display");
  const rateLine = document.getElementById("rate-line");
  const quickPairsEl = document.getElementById("quick-pairs");
  const statusEl = document.getElementById("status");
  const copyBtn = document.getElementById("copy-btn");

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  /* -------------------------------------------------------
     State
  ------------------------------------------------------- */
  const state = { from: "USD", to: "INR" };
  let supportedCodes = new Set();
  let rateCache = loadCache();
  let lastFlapText = "";
  let activeController = null;

  /* -------------------------------------------------------
     Cache helpers (localStorage, keyed by base currency)
  ------------------------------------------------------- */
  function loadCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(rateCache));
    } catch {
      /* storage unavailable — app still works, just re-fetches each visit */
    }
  }

  function savePair() {
    try {
      localStorage.setItem(PAIR_KEY, JSON.stringify(state));
    } catch {
      /* non-fatal */
    }
  }

  function loadPair() {
    try {
      return JSON.parse(localStorage.getItem(PAIR_KEY));
    } catch {
      return null;
    }
  }

  /* -------------------------------------------------------
     Networking — one request per base currency, cached until
     the API's own next-update time has passed.
  ------------------------------------------------------- */
  async function getRatesForBase(base, { force = false } = {}) {
    const entry = rateCache[base];
    const fresh = entry && entry.nextUpdate && Date.now() < entry.nextUpdate;
    if (fresh && !force) return entry;

    setStatus(entry ? "Refreshing rates\u2026" : "Fetching latest rates\u2026", "muted");

    if (activeController) activeController.abort();
    activeController = new AbortController();
    const timeout = setTimeout(() => activeController.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(API_BASE + base, { signal: activeController.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (data.result !== "success") throw new Error("API reported an error");

      const newEntry = {
        rates: data.rates,
        base: data.base_code || base,
        lastUpdated: data.time_last_update_utc || null,
        nextUpdate: data.time_next_update_unix
          ? data.time_next_update_unix * 1000
          : Date.now() + 60 * 60 * 1000,
        fetchedAt: Date.now(),
      };
      rateCache[base] = newEntry;
      saveCache();
      setStatus("", "muted");
      return newEntry;
    } catch (err) {
      clearTimeout(timeout);
      if (entry) {
        setStatus("Live rates unavailable \u2014 showing last saved rates.", "error", true);
        return entry;
      }
      setStatus("Could not load rates. Check your connection.", "error", true);
      throw err;
    }
  }

  /* -------------------------------------------------------
     Status line
  ------------------------------------------------------- */
  function setStatus(message, tone = "muted", withRetry = false) {
    statusEl.textContent = "";
    statusEl.dataset.tone = tone;
    if (message) statusEl.append(message);
    if (withRetry) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "status__retry";
      btn.textContent = "Retry";
      btn.addEventListener("click", () => ensureRatesAndConvert(true));
      statusEl.appendChild(btn);
    }
  }

  /* -------------------------------------------------------
     Formatting
  ------------------------------------------------------- */
  function formatNumber(value, code) {
    const digits = ZERO_DECIMAL.has(code) ? 0 : 2;
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  }

  function formatInputAmount(value) {
    const hasDecimal = value % 1 !== 0;
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: hasDecimal ? 6 : 0,
    }).format(value);
  }

  function formatDate(raw) {
    if (!raw) return "";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function parseAmount(raw) {
    if (typeof raw !== "string") return NaN;
    const cleaned = raw.replace(/[^0-9.\-]/g, "");
    if (cleaned === "") return NaN;
    return parseFloat(cleaned);
  }

  /* -------------------------------------------------------
     Split-flap style digit display
  ------------------------------------------------------- */
  function renderFlap(text) {
    const prev = lastFlapText;
    lastFlapText = text;

    const canAnimate =
      !prefersReducedMotion && prev && prev.length === text.length;

    if (!canAnimate) {
      flapDisplay.innerHTML = "";
      for (const ch of text) {
        const flap = document.createElement("span");
        flap.className = "flap";
        const inner = document.createElement("span");
        inner.className = "flap__char";
        inner.textContent = ch;
        flap.appendChild(inner);
        flapDisplay.appendChild(flap);
      }
      return;
    }

    const chars = flapDisplay.querySelectorAll(".flap__char");
    text.split("").forEach((ch, i) => {
      const el = chars[i];
      if (!el || el.textContent === ch) return;
      el.classList.add("is-leaving");
      setTimeout(() => {
        el.textContent = ch;
        el.classList.remove("is-leaving");
        el.classList.add("is-entering");
        requestAnimationFrame(() => el.classList.remove("is-entering"));
      }, 180);
    });
  }

  /* -------------------------------------------------------
     Conversion
  ------------------------------------------------------- */
  function convert(entry) {
    const amount = parseAmount(amountInput.value);
    if (!entry || !entry.rates || !entry.rates[state.to] || isNaN(amount)) {
      renderFlap("\u2014");
      return;
    }
    const result = amount * entry.rates[state.to];
    renderFlap(formatNumber(result, state.to));
  }

  function renderRateLine(entry) {
    if (!entry || !entry.rates || !entry.rates[state.to]) {
      rateLine.textContent = "";
      return;
    }
    const rate = entry.rates[state.to];
    const dateStr = formatDate(entry.lastUpdated);
    rateLine.textContent =
      `1 ${state.from} = ${formatNumber(rate, state.to)} ${state.to}` +
      (dateStr ? `, as of ${dateStr}` : "");
  }

  function convertFromCache() {
    const entry = rateCache[state.from];
    if (entry) {
      renderRateLine(entry);
      convert(entry);
    }
  }

  async function ensureRatesAndConvert(force = false) {
    try {
      const entry = await getRatesForBase(state.from, { force });
      renderRateLine(entry);
      convert(entry);
    } catch {
      renderFlap("\u2014");
    }
  }

  /* -------------------------------------------------------
     Quick pairs
  ------------------------------------------------------- */
  function renderQuickPairs() {
    quickPairsEl.innerHTML = "";
    QUICK_PAIRS.forEach(([from, to]) => {
      if (!supportedCodes.has(from) || !supportedCodes.has(to)) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = `${from} \u2192 ${to}`;
      btn.dataset.from = from;
      btn.dataset.to = to;
      btn.addEventListener("click", () => {
        state.from = from;
        state.to = to;
        fromSelect.value = from;
        toSelect.value = to;
        savePair();
        updateChipPressedStates();
        ensureRatesAndConvert();
      });
      quickPairsEl.appendChild(btn);
    });
    updateChipPressedStates();
  }

  function updateChipPressedStates() {
    quickPairsEl.querySelectorAll(".chip").forEach((chip) => {
      const match = chip.dataset.from === state.from && chip.dataset.to === state.to;
      chip.setAttribute("aria-pressed", String(match));
    });
  }

  /* -------------------------------------------------------
     Select population
  ------------------------------------------------------- */
  function populateSelect(selectEl, codes) {
    selectEl.innerHTML = "";
    Array.from(codes)
      .sort()
      .forEach((code) => {
        const opt = document.createElement("option");
        opt.value = code;
        const name = CURRENCY_NAMES[code];
        opt.textContent = name ? `${code} \u2014 ${name}` : code;
        selectEl.appendChild(opt);
      });
  }

  /* -------------------------------------------------------
     Debounce
  ------------------------------------------------------- */
  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  /* -------------------------------------------------------
     Event wiring
  ------------------------------------------------------- */
  form.addEventListener("submit", (e) => e.preventDefault());

  amountInput.addEventListener(
    "input",
    debounce(() => convertFromCache(), DEBOUNCE_MS)
  );
  amountInput.addEventListener("focus", () => amountInput.select());
  amountInput.addEventListener("blur", () => {
    const val = parseAmount(amountInput.value);
    if (!isNaN(val)) amountInput.value = formatInputAmount(val);
  });

  fromSelect.addEventListener("change", () => {
    state.from = fromSelect.value;
    savePair();
    updateChipPressedStates();
    ensureRatesAndConvert();
  });

  toSelect.addEventListener("change", () => {
    state.to = toSelect.value;
    savePair();
    updateChipPressedStates();
    convertFromCache();
  });

  swapBtn.addEventListener("click", () => {
    [state.from, state.to] = [state.to, state.from];
    fromSelect.value = state.from;
    toSelect.value = state.to;
    savePair();
    updateChipPressedStates();
    if (!prefersReducedMotion) {
      swapBtn.classList.add("is-spinning");
      setTimeout(() => swapBtn.classList.remove("is-spinning"), 260);
    }
    ensureRatesAndConvert();
  });

  copyBtn.addEventListener("click", async () => {
    const text = flapDisplay.textContent.trim();
    if (!text || text === "\u2014") return;
    const payload = `${text} ${state.to}`;
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = payload;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* clipboard unsupported — silently ignore */
      }
      document.body.removeChild(ta);
    }
    copyBtn.textContent = "Copied";
    copyBtn.dataset.copied = "true";
    setTimeout(() => {
      copyBtn.textContent = "Copy result";
      copyBtn.dataset.copied = "false";
    }, 1500);
  });

  /* -------------------------------------------------------
     Init
  ------------------------------------------------------- */
  async function init() {
    renderFlap("\u2014");
    setStatus("Fetching currency list\u2026", "muted");

    try {
      const seedEntry = await getRatesForBase("USD");
      supportedCodes = new Set([seedEntry.base, ...Object.keys(seedEntry.rates)]);
      populateSelect(fromSelect, supportedCodes);
      populateSelect(toSelect, supportedCodes);

      const saved = loadPair();
      state.from = saved && supportedCodes.has(saved.from) ? saved.from : "USD";
      state.to = saved && supportedCodes.has(saved.to) ? saved.to : "INR";
      fromSelect.value = state.from;
      toSelect.value = state.to;

      renderQuickPairs();
      await ensureRatesAndConvert();
    } catch {
      setStatus("Could not load the currency list. Check your connection and retry.", "error", true);
    }
  }

  init();
})();
