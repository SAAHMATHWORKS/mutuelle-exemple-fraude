/* Mutuelle Exemple — fraud demo front end (vanilla JS + Chart.js, no build step). */
"use strict";

(() => {
  // ------------------------------------------------------------ formatting
  const nf = new Intl.NumberFormat("fr-FR");
  const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
  const eur0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const pctf = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });
  const pct = (v) => (v === null || v === undefined ? "—" : pctf.format(v));
  const dateLong = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
  const dateShort = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const SEV = {
    haute: { icon: "!", label: "Haute" },
    moyenne: { icon: "=", label: "Moyenne" },
    faible: { icon: "i", label: "Faible" },
  };
  const sevHtml = (s) => `<span class="sev ${s}"><span class="ico" aria-hidden="true">${SEV[s].icon}</span>${SEV[s].label}</span>`;
  const scenarioHtml = (n, label) => `<span class="chip"><span class="swatch s${n}" aria-hidden="true"></span>${esc(label)}</span>`;

  const view = document.getElementById("view");
  let charts = [];
  let pollTimer = null;
  let advTimer = null;
  let lastQueueHash = "#/alertes";
  let meta = null; // scenarios + decisions labels, loaded once
  let currentView = "overview";
  let navGen = 0; // incremented by each route(): late answers of an older route are dropped
  let explainCache = null; // « Lecture IA » commentaries, reloaded after a regeneration

  // ---------------------------------------------------------------- storage
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: keep in memory only */ }
    },
  };
  const memoryDecisions = store.get("me-decisions", {});

  // ------------------------------------------------------------------ theme
  const THEMES = ["auto", "light", "dark"];
  const THEME_LABEL = { auto: "Auto", light: "Clair", dark: "Sombre" };
  let theme = store.get("me-theme", "auto");
  function applyTheme() {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    document.getElementById("theme-label").textContent = THEME_LABEL[theme];
    document.getElementById("theme-toggle").setAttribute("aria-label", `Thème : ${THEME_LABEL[theme].toLowerCase()} (changer)`);
  }
  document.getElementById("theme-toggle").addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set("me-theme", theme);
    applyTheme();
    route();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (theme === "auto") route(); });
  applyTheme();

  // ---------------------------------------------------------------- sidebar
  // Desktop: collapsible (remembered in this browser). Phone: off-canvas drawer.
  const mobileQuery = window.matchMedia("(max-width: 900px)");
  const collapseBtn = document.getElementById("sb-collapse");
  const openBtn = document.getElementById("sb-open");
  const backdrop = document.getElementById("sb-backdrop");
  function setCollapsed(on) {
    document.body.classList.toggle("sb-collapsed", on);
    collapseBtn.setAttribute("aria-expanded", String(!on));
    const label = on ? "Déplier le menu" : "Replier le menu";
    collapseBtn.title = label;
    collapseBtn.querySelector(".sb-label").textContent = label;
  }
  function setDrawer(open) {
    document.body.classList.toggle("sb-open", open);
    backdrop.hidden = !open;
    openBtn.setAttribute("aria-expanded", String(open));
    if (open) document.querySelector(".sb-nav a[aria-current='page'], .sb-nav a")?.focus();
  }
  setCollapsed(store.get("me-sidebar-collapsed", false));
  collapseBtn.addEventListener("click", () => {
    const on = !document.body.classList.contains("sb-collapsed");
    setCollapsed(on);
    store.set("me-sidebar-collapsed", on);
  });
  openBtn.addEventListener("click", () => setDrawer(true));
  backdrop.addEventListener("click", () => setDrawer(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("sb-open")) { setDrawer(false); openBtn.focus(); } });
  document.querySelectorAll(".sb-nav a").forEach((a) => a.addEventListener("click", () => { if (mobileQuery.matches) setDrawer(false); }));
  mobileQuery.addEventListener("change", () => setDrawer(false));

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const seriesColor = (n) => css(`--s${n}`);

  function chartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.locale = "fr-FR";
    Chart.defaults.font.family = css("--font");
    Chart.defaults.font.size = 12;
    Chart.defaults.color = css("--text-2");
    Chart.defaults.borderColor = css("--grid");
    Chart.defaults.animation = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 250 };
    Chart.defaults.plugins.legend.display = false; // HTML legends are used instead
    Chart.defaults.plugins.tooltip.backgroundColor = css("--surface");
    Chart.defaults.plugins.tooltip.titleColor = css("--text");
    Chart.defaults.plugins.tooltip.bodyColor = css("--text-2");
    Chart.defaults.plugins.tooltip.footerColor = css("--text");
    Chart.defaults.plugins.tooltip.borderColor = css("--border");
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.boxPadding = 4;
    Chart.defaults.maintainAspectRatio = false;
  }
  function makeChart(canvas, config) {
    if (!window.Chart) {
      // Never leave an empty frame: say why there is no chart (the table view still has the data).
      const wrap = canvas && canvas.parentElement;
      if (wrap) wrap.innerHTML = `<p class="loading chart-missing">Chargement du graphique… (les données sont aussi dans « Voir les données en tableau »)</p>`;
      return null;
    }
    const c = new Chart(canvas, config);
    charts.push(c);
    return c;
  }
  function cleanup() {
    charts.forEach((c) => c.destroy());
    charts = [];
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (advTimer) { clearTimeout(advTimer); advTimer = null; }
  }

  // -------------------------------------------------------------------- api
  async function api(path, options) {
    if (path === "/api/regenerate") explainCache = null;
    const res = await fetch(path, options);
    let body = null;
    try { body = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const detail = body && body.detail ? (typeof body.detail === "string" ? body.detail : "requête invalide") : `erreur ${res.status}`;
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return body;
  }
  async function ensureMeta() {
    if (!meta) {
      const o = await api("/api/overview");
      meta = { scenarios: o.scenarios, decisions: o.decisions };
    }
    return meta;
  }

  // ----------------------------------------------------------------- router
  function parseHash() {
    const h = location.hash || "#/vue-ensemble";
    const [path, query] = h.slice(1).split("?");
    const parts = path.split("/").filter(Boolean);
    return { parts, params: new URLSearchParams(query || "") };
  }
  function setNav(name) {
    currentView = name;
    closeExplain(false);
    document.querySelectorAll(".sb-nav a").forEach((a) => {
      if (a.dataset.view === name) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  async function route() {
    navGen += 1;
    cleanup();
    chartDefaults();
    const { parts, params } = parseHash();
    try {
      if (parts[0] === "alertes" && parts[1]) { setNav("alerts"); await renderDetail(decodeURIComponent(parts[1])); }
      else if (parts[0] === "alertes") { setNav("alerts"); lastQueueHash = location.hash; await renderQueue(params); }
      else if (parts[0] === "evaluation") { setNav("evaluation"); await renderEvaluation(); }
      else if (parts[0] === "exploration") { setNav("exploration"); await renderExploration(); }
      else if (parts[0] === "prestataires") { setNav("providers"); await renderProviders(); }
      else if (parts[0] === "modele") { setNav("model"); await renderModel(); }
      else { setNav("overview"); await renderOverview(); }
    } catch (e) {
      view.innerHTML = `<div class="card"><h1>Impossible de charger la page</h1><p class="error">${esc(e.message)}</p><p><a href="#/vue-ensemble">Revenir à la vue d'ensemble</a></p></div>`;
    }
    checkCharts();
  }
  window.addEventListener("hashchange", () => { route(); document.getElementById("main").focus({ preventScroll: true }); window.scrollTo(0, 0); });

  function legendHtml(items) {
    return `<ul class="legend">${items.map((i) => `<li><span class="swatch ${i.cls}" aria-hidden="true"></span>${esc(i.label)}</li>`).join("")}</ul>`;
  }
  function toLocalIso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function aggregateWeekly(rows, keys) {
    const out = new Map();
    for (const r of rows) {
      const d = new Date(r.date + "T00:00:00");
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const k = toLocalIso(d);
      if (!out.has(k)) out.set(k, Object.fromEntries([["date", k], ...keys.map((x) => [x, 0])]));
      const acc = out.get(k);
      keys.forEach((x) => { acc[x] += r[x]; });
    }
    return [...out.values()];
  }

  // =============================================================== OVERVIEW
  async function renderOverview() {
    const gen = navGen;
    const o = await api("/api/overview");
    if (gen !== navGen) return; // the visitor has moved on: never draw over the newer view
    meta = { scenarios: o.scenarios, decisions: o.decisions };
    const d = o.dataset;
    const h = o.highlights;
    const maxAlerts = Math.max(...o.per_scenario.map((s) => s.alerts), 1);
    const sevColor = { haute: css("--critical"), moyenne: css("--serious"), faible: css("--warning") };
    const findings = [
      { href: "#/exploration", title: "Exploration des données", text: h.price_signal ? `À partir de ${esc(h.price_signal.threshold)} le prix habituel, on trouve ${pct(h.price_signal.fraud)} des prix gonflés injectés et seulement ${pct1(h.price_signal.legit)} des lignes légitimes.` : "" },
      { href: "#/prestataires", title: "Prestataires et réseau", text: h.complicit ? `Agréger par prestataire place les ${h.complicit.total} complices injectés ${h.complicit.in_top === h.complicit.total ? "tous" : h.complicit.in_top} en tête du profil de facturation.` : "" },
      { href: "#/evaluation", title: "Évaluation", text: h.gain ? `Avec ${nf.format(h.gain.capacity)} alertes traitées sur l'année, trier par montant retrouve ${pct(h.gain.amount_order)} des euros frauduleux, contre ${pct(h.gain.severity_order)} par sévérité.` : `Rappel ${pct(h.recall)}, précision ${pct(h.precision)}, ${nf1.format(h.false_alerts_per_day)} fausse alerte par jour.` },
      { href: "#/modele", title: "Modèle non supervisé", text: h.model ? `À charge égale, les règles retrouvent ${pct(h.model.rules)} des fraudes, l'Isolation Forest ${pct(h.model.metier)} avec les variables métier et ${pct(h.model.brutes)} sans.` : "Comparaison en cours de calcul." },
    ];

    view.innerHTML = `
      <section class="hero" aria-labelledby="t-hero">
        <div>
          <h1 id="t-hero">Détecter la fraude santé, scénario par scénario</h1>
          <p>${esc(d.insurer)}, assureur fictif, rembourse ${nf.format(d.n_claims)} actes en 2025 à ${nf.format(d.n_members)} adhérents, chez ${nf.format(d.n_providers)} prestataires.
          Cinq fraudes typiques y ont été injectées. Cinq règles lisibles les cherchent : chaque alerte dit pourquoi elle existe, montre ses preuves et propose une décision au gestionnaire.</p>
        </div>
        <nav class="guide" aria-labelledby="t-guide">
        <h2 id="t-guide" class="guide-title">Guide de lecture en 3 étapes</h2>
        <ol class="steps">
          <li><a href="#/exploration"><span class="step-n">1</span><strong>Comprendre les données</strong><span>Distributions, saisonnalité, signal de chaque fraude.</span></a></li>
          <li><a href="#/alertes"><span class="step-n">2</span><strong>Traiter les alertes</strong><span>La file du gestionnaire, puis le détail d'une alerte.</span></a></li>
          <li><a href="#/evaluation"><span class="step-n">3</span><strong>Mesurer honnêtement</strong><span>Rappel, précision, seuils, courbe de gain, limites.</span></a></li>
        </ol>
        </nav>
      </section>

      <section class="grid kpis" aria-label="Chiffres clés">
        <div class="kpi"><div class="label">Alertes sur l'année</div><div class="value">${nf.format(o.totals.alerts)}</div><div class="hint">${nf1.format(o.totals.alerts_per_day)} par jour pour un gestionnaire</div></div>
        <div class="kpi"><div class="label">Fraudes retrouvées (rappel)</div><div class="value">${pct(h.recall)}</div><div class="hint">des lignes frauduleuses injectées</div></div>
        <div class="kpi"><div class="label">Alertes justes (précision)</div><div class="value">${pct(h.precision)}</div><div class="hint">des lignes signalées sont frauduleuses</div></div>
        <div class="kpi"><div class="label">Fausses alertes par jour</div><div class="value">${nf1.format(h.false_alerts_per_day)}</div><div class="hint">alertes sans aucune ligne frauduleuse</div></div>
        <div class="kpi"><div class="label">Montant signalé</div><div class="value">${eur0.format(o.totals.flagged_amount)}</div><div class="hint">${h.caught_amount_share !== null ? `${pct(h.caught_amount_share)} des euros frauduleux retrouvés` : `sur ${eur0.format(d.total_billed)} facturés`}</div></div>
      </section>

      <div class="grid two-col">
        <section class="card" aria-labelledby="t-volume">
          <div class="card-head">
            <div><h2 id="t-volume">Alertes dans le temps</h2><p class="sub" id="volume-sub">Par semaine, selon la date à laquelle l'alerte devient visible.</p></div>
            <div class="segmented" role="group" aria-label="Granularité">
              <button type="button" data-gran="week" aria-pressed="true">Semaine</button>
              <button type="button" data-gran="day" aria-pressed="false">Jour</button>
            </div>
          </div>
          ${legendHtml(o.per_scenario.map((s) => ({ cls: `s${s.scenario}`, label: s.label })))}
          <div class="chart-wrap"><canvas id="c-volume" role="img" aria-label="Histogramme empilé des alertes par scénario dans le temps"></canvas></div>
          <details class="data-table"><summary>Voir les données en tableau</summary><div class="table-scroll" id="volume-table"></div></details>
        </section>
        <section class="card" aria-labelledby="t-scen">
          <div class="card-head"><h2 id="t-scen">Par scénario</h2><button type="button" class="link-btn" id="go-how">Comment ça marche&nbsp;?</button></div>
          <p class="sub">Cliquez sur un scénario pour ouvrir ses alertes.</p>
          <ul class="scenario-list">
            ${o.per_scenario.map((s) => `
              <li>
                <span class="swatch s${s.scenario}" aria-hidden="true"></span>
                <a class="name" href="#/alertes?scenario=${s.scenario}">${s.scenario}. ${esc(s.label)}</a>
                <span class="count">${nf.format(s.alerts)}</span>
                <span class="bar-track" aria-hidden="true"><span class="bar-fill" style="display:block;width:${(100 * s.alerts) / maxAlerts}%;background:var(--s${s.scenario})"></span></span>
                <span class="meta">${nf.format(s.lines)} lignes · ${eur0.format(s.amount)} · ${nf.format(s.by_severity.haute)} en sévérité haute</span>
              </li>`).join("")}
          </ul>
        </section>
      </div>

      <section class="card section how" id="how" aria-labelledby="t-how" tabindex="-1">
        <h2 id="t-how">Comment ça marche&nbsp;? Les cinq règles en clair</h2>
        <p class="sub">Chaque règle est un petit module lisible. Les seuils cités ici sont lus dans le code des règles : ce texte ne peut pas les contredire.</p>
        <ol class="how-list">
          ${o.rules.map((r) => `
            <li style="--c:var(--s${r.scenario})">
              <div class="how-head"><span class="how-n" aria-hidden="true">${r.scenario}</span><h3>${esc(r.label)}</h3></div>
              <p>${esc(r.how)}</p>
              <p class="sub">${esc(r.then)}</p>
              <a href="#/alertes?scenario=${r.scenario}">Voir ses alertes<span class="visually-hidden"> : ${esc(r.label)}</span> →</a>
            </li>`).join("")}
        </ol>
      </section>

      <div class="grid halves section">
        ${chartCard({
          id: "sev", title: "Gravité des alertes par scénario",
          sub: (() => {
            const share = (s, k) => s.by_severity[k] / Math.max(s.alerts, 1);
            const top = [...o.per_scenario].sort((a, b) => share(b, "haute") - share(a, "haute"))[0];
            const low = [...o.per_scenario].sort((a, b) => share(b, "faible") - share(a, "faible"))[0];
            return `${nf.format(o.totals.high_severity)} alertes en sévérité haute (${pct(o.totals.high_severity / Math.max(o.totals.alerts, 1))}). La part la plus forte d'alertes graves revient au scénario « ${esc(top.label.toLowerCase())} » (${pct(share(top, "haute"))}) ; la plus forte part d'alertes faibles, au scénario « ${esc(low.label.toLowerCase())} » (${pct(share(low, "faible"))}).`;
          })(),
          legend: legendHtml([{ cls: "sev-h", label: "Haute" }, { cls: "sev-m", label: "Moyenne" }, { cls: "sev-f", label: "Faible" }]),
          height: 260, aria: "Barres empilées du nombre d'alertes par niveau de sévérité pour chaque scénario",
          table: dataTable(["Scénario", "Haute", "Moyenne", "Faible"], o.per_scenario.map((s) => [`${s.scenario}. ${s.label}`, nf.format(s.by_severity.haute), nf.format(s.by_severity.moyenne), nf.format(s.by_severity.faible)])),
        })}
        ${chartCard({
          id: "dec", title: "Ce que le gestionnaire doit faire",
          sub: "Décision suggérée par la règle pour chaque alerte. La plupart demandent une simple pièce justificative ; les contrôles plus lourds restent rares.",
          height: 260, aria: "Barres horizontales du nombre d'alertes par décision suggérée",
          table: dataTable(["Décision suggérée", "Alertes", "Montant"], o.by_decision.map((x) => [x.label, nf.format(x.alerts), eur0.format(x.amount)])),
        })}
      </div>

      <div class="grid halves section">
        <section class="card" aria-labelledby="t-recent">
          <h2 id="t-recent">Dernières alertes en sévérité haute</h2>
          <p class="sub">Les plus récentes de l'année. Ouvrez-en une pour voir la raison, les lignes de preuve et la décision proposée.</p>
          <ul class="alert-list">${o.recent_high.map((a) => `
            <li><a href="#/alertes/${encodeURIComponent(a.id)}">
              <span class="al-top"><span class="mono">${esc(a.id)}</span>${scenarioHtml(a.scenario, a.scenario_label)}<span class="muted">${dateLong(a.date)}</span><strong class="num">${eur.format(a.amount)}</strong></span>
              <span class="al-reason">${esc(a.reason)}</span>
            </a></li>`).join("")}</ul>
          <p style="margin:10px 0 0"><a href="#/alertes?severity=haute">Toutes les alertes en sévérité haute →</a></p>
        </section>
        <section class="card" aria-labelledby="t-prov">
          <h2 id="t-prov">Prestataires les plus signalés</h2>
          <p class="sub">Nombre d'alertes visant chaque prestataire (hors multiplication des prestataires, qui en vise plusieurs). Cliquez pour ouvrir ses alertes.</p>
          <div class="table-scroll"><table class="responsive">
            <thead><tr><th>Prestataire</th><th>Scénarios</th><th class="num">Alertes</th><th class="num">Montant</th></tr></thead>
            <tbody>${o.top_providers.map((p) => `<tr class="clickable" data-q="${esc(p.provider_id)}">
              <td data-label="Prestataire"><span class="cv"><a class="mono" href="#/alertes?q=${encodeURIComponent(p.provider_id)}">${esc(p.provider_id)}</a> <span class="muted">${esc(p.type)}</span></span></td>
              <td data-label="Scénarios"><span class="cv">${p.scenarios.map((s) => `<span class="swatch s${s}" title="${esc(o.scenarios[s])}" aria-label="${esc(o.scenarios[s])}"></span>`).join(" ")}</span></td>
              <td data-label="Alertes" class="num">${nf.format(p.alerts)}</td><td data-label="Montant" class="num">${eur0.format(p.amount)}</td></tr>`).join("")}</tbody>
          </table></div>
          <p style="margin:10px 0 0"><a href="#/prestataires">Profil de facturation et graphe adhérents–prestataires →</a></p>
        </section>
      </div>

      <section class="section" aria-labelledby="t-find">
        <h2 id="t-find" class="section-title" style="margin-top:8px">À retenir de chaque vue</h2>
        <div class="findings">${findings.map((f) => `
          <a class="finding card" href="${f.href}"><strong>${esc(f.title)}</strong><span>${f.text}</span><span class="go">Ouvrir →</span></a>`).join("")}</div>
      </section>

      <details class="settings card">
        <summary>Paramètres de la simulation</summary>
        <p class="sub" style="margin-top:8px">Graine ${d.seed}, ${nf.format(d.size)} lignes visées, bruit ${nf.format(d.noise_level)}. Données générées en ${nf1.format(d.generated_in_s)} s, règles appliquées en ${nf1.format(d.detected_in_s)} s.
        ${d.read_only ? "" : "Vous pouvez régénérer un autre jeu de données ; les autres visiteurs verront aussi le nouveau jeu."}</p>
        ${regenFormHtml(d)}
      </details>`;

    const keys = o.per_scenario.map((s) => `s${s.scenario}`);
    const labels = Object.fromEntries(o.per_scenario.map((s) => [`s${s.scenario}`, s.label]));
    let volumeChart = null;
    const draw = (gran) => {
      if (volumeChart) { volumeChart.destroy(); charts = charts.filter((c) => c !== volumeChart); }
      const rows = gran === "week" ? aggregateWeekly(o.per_day, keys) : o.per_day;
      document.getElementById("volume-sub").textContent = gran === "week"
        ? "Par semaine (semaine commençant le lundi), selon la date à laquelle l'alerte devient visible."
        : "Par jour, selon la date à laquelle l'alerte devient visible.";
      volumeChart = makeChart(document.getElementById("c-volume"), {
        type: "bar",
        data: {
          labels: rows.map((r) => r.date),
          datasets: keys.map((k, i) => ({
            label: labels[k], data: rows.map((r) => r[k]), backgroundColor: seriesColor(i + 1),
            borderColor: css("--surface"), borderWidth: gran === "week" ? { top: 1 } : 0, borderSkipped: false, stack: "a",
            barPercentage: gran === "week" ? 0.85 : 1, categoryPercentage: gran === "week" ? 0.9 : 1,
          })),
        },
        options: {
          interaction: { mode: "index", intersect: false },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback(v) { return dateShort(this.getLabelForValue(v)); } } },
            y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, border: { display: false } },
          },
          plugins: {
            tooltip: {
              callbacks: {
                title: (items) => (gran === "week" ? `Semaine du ${dateLong(items[0].label)}` : dateLong(items[0].label)),
                footer: (items) => `Total : ${nf.format(items.reduce((a, b) => a + b.parsed.y, 0))} alertes`,
              },
            },
          },
        },
      });
      document.getElementById("volume-table").innerHTML = `<table><thead><tr><th>${gran === "week" ? "Semaine du" : "Date"}</th>${keys.map((k) => `<th class="num">${esc(labels[k])}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${dateLong(r.date)}</td>${keys.map((k) => `<td class="num">${r[k]}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    };
    draw("week");
    document.getElementById("go-how").addEventListener("click", () => {
      const how = document.getElementById("how");
      how.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      how.focus({ preventScroll: true });
    });
    view.querySelectorAll("[data-gran]").forEach((b) => b.addEventListener("click", () => {
      view.querySelectorAll("[data-gran]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      draw(b.dataset.gran);
    }));

    makeChart(document.getElementById("c-sev"), {
      type: "bar",
      data: {
        labels: o.per_scenario.map((s) => SHORT_SCEN[s.scenario]),
        datasets: ["haute", "moyenne", "faible"].map((sev) => ({
          label: sev.charAt(0).toUpperCase() + sev.slice(1), data: o.per_scenario.map((s) => s.by_severity[sev]),
          backgroundColor: sevColor[sev], stack: "a", borderColor: css("--surface"), borderWidth: { right: 2 }, borderSkipped: false, maxBarThickness: 22,
        })),
      },
      options: {
        indexAxis: "y",
        interaction: { mode: "index", intersect: false, axis: "y" },
        scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, border: { display: false } }, y: { stacked: true, grid: { display: false } } },
        plugins: { tooltip: { callbacks: { title: (items) => `${o.per_scenario[items[0].dataIndex].scenario}. ${o.per_scenario[items[0].dataIndex].label}`, label: (it) => `${it.dataset.label} : ${nf.format(it.parsed.x)}` } } },
      },
    });

    makeChart(document.getElementById("c-dec"), {
      type: "bar",
      data: { labels: o.by_decision.map((x) => SHORT_DECISION[x.decision] || x.label), datasets: [{ label: "Alertes", data: o.by_decision.map((x) => x.alerts), backgroundColor: css("--accent"), borderRadius: 3, borderSkipped: "start", maxBarThickness: 22 }] },
      options: {
        indexAxis: "y",
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, border: { display: false } },
          y: { grid: { display: false } },
        },
        plugins: { tooltip: { callbacks: { title: (items) => o.by_decision[items[0].dataIndex].label, label: (it) => `${nf.format(it.parsed.x)} alertes, ${eur0.format(o.by_decision[it.dataIndex].amount)}` } } },
      },
    });

    view.querySelectorAll("tr.clickable[data-q]").forEach((tr) => tr.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      location.hash = `#/alertes?q=${encodeURIComponent(tr.dataset.q)}`;
    }));
    bindRegenForm();
  }

  const READ_ONLY_NOTE = `<p class="notice">Démo en ligne en mode vitrine : tous les résultats ont été calculés une fois, à la construction, pour que le site réponde instantanément. La régénération (autre graine, taille ou niveau de bruit) fonctionne en local : <code>uvicorn app.main:app</code>, voir le README.</p>`;
  function regenFormHtml(d, noiseOverride) {
    if (d.read_only) return READ_ONLY_NOTE;
    const noise = noiseOverride ?? d.noise_level;
    return `<form class="settings-form" id="regen-form">
        <label class="field">Graine<input name="seed" type="number" min="0" max="1000000" step="1" value="${d.seed}" required></label>
        <label class="field">Nombre de lignes<input name="size" type="number" min="2000" max="50000" step="1000" value="${d.size}" required></label>
        <label class="field">Niveau de bruit (0 à 1)<input name="noise_level" type="number" min="0" max="1" step="0.05" value="${noise}" required></label>
        <div><button class="btn primary" type="submit">Régénérer les données</button></div>
      </form>
      <p class="status-line" id="regen-status" role="status"></p>`;
  }
  function bindRegenForm(afterNav) {
    const form = document.getElementById("regen-form");
    if (!form) return;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const body = { seed: Number(fd.get("seed")), size: Number(fd.get("size")), noise_level: Number(fd.get("noise_level")) };
      const status = document.getElementById("regen-status");
      const btn = form.querySelector("button");
      btn.disabled = true;
      status.classList.remove("error");
      status.textContent = "Génération en cours…";
      try {
        const r = await api("/api/regenerate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        status.textContent = `Nouveau jeu de données : ${nf.format(r.dataset.n_claims)} lignes, ${nf.format(r.alerts)} alertes.`;
        setTimeout(() => (afterNav ? (location.hash = afterNav) : route()), 600);
      } catch (e) {
        status.classList.add("error");
        status.textContent = e.message;
        btn.disabled = false;
      }
    });
  }

  // ================================================================== QUEUE
  async function renderQueue(params) {
    const gen = navGen;
    const m = await ensureMeta();
    if (gen !== navGen) return; // the visitor has moved on: never draw over the newer view
    const p = (k, dflt = "") => params.get(k) ?? dflt;
    view.innerHTML = `
      <div class="page-head"><div><h1>File d'alertes</h1>
        <p>Chaque ligne est une alerte à examiner. Ouvrez-la pour voir pourquoi elle a été levée et la décision proposée.</p></div></div>
      <form class="filters card" id="filters" aria-label="Filtres">
        <label class="field">Scénario<select name="scenario"><option value="">Tous</option>
          ${Object.entries(m.scenarios).map(([k, v]) => `<option value="${k}" ${p("scenario") === k ? "selected" : ""}>${k}. ${esc(v)}</option>`).join("")}</select></label>
        <label class="field">Sévérité<select name="severity"><option value="">Toutes</option>
          ${Object.keys(SEV).map((k) => `<option value="${k}" ${p("severity") === k ? "selected" : ""}>${SEV[k].label}</option>`).join("")}</select></label>
        <label class="field">Décision suggérée<select name="decision"><option value="">Toutes</option>
          ${Object.entries(m.decisions).map(([k, v]) => `<option value="${k}" ${p("decision") === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
        <label class="field">Adhérent, prestataire ou n° d'alerte<input name="q" type="search" value="${esc(p("q"))}" placeholder="ex. M00012" autocomplete="off"></label>
        <label class="field">Du<input name="date_from" type="date" min="2025-01-01" max="2025-12-31" value="${esc(p("date_from"))}"></label>
        <label class="field">Au<input name="date_to" type="date" min="2025-01-01" max="2025-12-31" value="${esc(p("date_to"))}"></label>
        <label class="field">Trier par<select name="sort">
          ${[["date", "Date"], ["severity", "Sévérité"], ["amount", "Montant"], ["score", "Score de la règle"]].map(([k, v]) => `<option value="${k}" ${p("sort", "date") === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <div><button class="btn" type="reset" id="reset">Effacer les filtres</button></div>
      </form>
      <section class="card" aria-labelledby="t-results"><h2 id="t-results" class="visually-hidden" hidden>Résultats</h2><div id="results"><p class="loading">Chargement…</p></div></section>`;

    const form = document.getElementById("filters");
    const state = Object.fromEntries(params.entries());
    const apply = (resetPage = true) => {
      if (resetPage) delete state.page;
      const next = new URLSearchParams();
      for (const [k, v] of new FormData(form).entries()) if (v) next.set(k, v);
      if (state.page && state.page !== "1") next.set("page", state.page);
      const h = `#/alertes${next.toString() ? "?" + next.toString() : ""}`;
      history.replaceState(null, "", h);
      lastQueueHash = h;
      loadResults(next);
    };
    form.addEventListener("change", (e) => { if (e.target.name !== "q") apply(); });
    let t = null;
    form.querySelector("[name=q]").addEventListener("input", () => { clearTimeout(t); t = setTimeout(apply, 300); });
    form.addEventListener("submit", (e) => { e.preventDefault(); apply(); });
    form.addEventListener("reset", () => setTimeout(() => apply(), 0));

    async function loadResults(qs) {
      const results = document.getElementById("results");
      const query = new URLSearchParams(qs);
      if (!query.get("sort")) query.set("sort", "date");
      query.set("order", "desc");
      query.set("page_size", "20");
      let data;
      try { data = await api(`/api/alerts?${query}`); } catch (e) { results.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
      if (!document.contains(results)) return;
      if (!data.items.length) { results.innerHTML = `<p>Aucune alerte ne correspond à ces filtres.</p>`; return; }
      results.innerHTML = `
        <div class="table-scroll"><table class="responsive alerts-table">
          <caption>${nf.format(data.total)} alerte${data.total > 1 ? "s" : ""} · page ${data.page} sur ${data.pages}</caption>
          <thead><tr><th>Date</th><th>Alerte</th><th>Scénario</th><th>Sévérité</th><th>Adhérent</th><th>Prestataire</th><th class="num">Montant</th><th>Décision suggérée</th></tr></thead>
          <tbody>${data.items.map((a) => {
            const local = memoryDecisions[a.id];
            return `<tr class="clickable" data-id="${esc(a.id)}">
              <td data-label="Date">${dateLong(a.date)}</td>
              <td data-label="Alerte"><a class="mono" href="#/alertes/${encodeURIComponent(a.id)}">${esc(a.id)}</a></td>
              <td data-label="Scénario">${scenarioHtml(a.scenario, a.scenario_label)}</td>
              <td data-label="Sévérité">${sevHtml(a.severity)}</td>
              <td data-label="Adhérent" class="mono">${esc(a.member_id)}</td>
              <td data-label="Prestataire" class="mono">${esc(a.provider_id || "plusieurs")}</td>
              <td data-label="Montant" class="num">${eur.format(a.amount)}</td>
              <td data-label="Décision suggérée">${esc(a.decision_label)}${local ? `<div class="local-decision">Votre choix (démo) : ${esc(local.label)}</div>` : ""}</td>
            </tr>`;
          }).join("")}</tbody></table></div>
        <div class="pager"><span>${nf.format((data.page - 1) * data.page_size + 1)}–${nf.format(Math.min(data.page * data.page_size, data.total))} sur ${nf.format(data.total)}</span>
          <span class="btns"><button class="btn" type="button" id="prev" ${data.page <= 1 ? "disabled" : ""}>Précédent</button>
          <button class="btn" type="button" id="next" ${data.page >= data.pages ? "disabled" : ""}>Suivant</button></span></div>`;
      results.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        location.hash = `#/alertes/${encodeURIComponent(tr.dataset.id)}`;
      }));
      const go = (delta) => { state.page = String(data.page + delta); apply(false); document.getElementById("results").scrollIntoView({ block: "start" }); };
      document.getElementById("prev").addEventListener("click", () => go(-1));
      document.getElementById("next").addEventListener("click", () => go(1));
    }
    const initial = new URLSearchParams(params);
    loadResults(initial);
  }

  // ================================================================= DETAIL
  const FACT_LABELS = {
    ratio: ["Rapport au prix habituel", (v) => `× ${nf1.format(v)}`],
    reference_median: ["Prix habituel (médiane)", (v) => (v === null ? "—" : eur.format(v))],
    n_prior: ["Factures antérieures utilisées", (v) => nf.format(v)],
    provider_previous_price_alerts: ["Alertes de prix déjà levées chez ce prestataire (90 j)", (v) => nf.format(v)],
    kind: ["Type", (v) => (v === "fractionnement" ? "Facture fractionnée" : "Doublon")],
    n_lines: ["Lignes concernées", (v) => nf.format(v)],
    total: ["Total facturé", (v) => eur.format(v)],
    days_since_start: ["Jours depuis le début du contrat", (v) => nf.format(v)],
    policy_start: ["Date d'effet du contrat", (v) => esc(v)],
    first_day: null, last_day: null, new_providers_by_type: null, diagnosis_group: null, expected_groups: null,
  };

  async function renderDetail(id) {
    const gen = navGen;
    const m = await ensureMeta();
    const a = await api(`/api/alerts/${encodeURIComponent(id)}`);
    if (gen !== navGen) return; // the visitor has moved on: never draw over the newer view
    const facts = Object.entries(a.details).filter(([k]) => FACT_LABELS[k]).map(([k, v]) => `<div><dt>${FACT_LABELS[k][0]}</dt><dd>${FACT_LABELS[k][1](v)}</dd></div>`).join("");
    const local = memoryDecisions[a.id];
    const truth = a.ground_truth;
    const truthText = truth.is_fraud
      ? `Fraude injectée par le générateur : scénario ${truth.injected_scenarios.map((s) => `${s} (${esc(m.scenarios[s])})`).join(", ")}${truth.notes.length ? ` — ${truth.notes.map(esc).join(" ; ")}` : ""}.`
      : truth.legit_oddities.length
        ? `Fausse alerte : ces lignes sont légitimes, mais présentent une particularité qui ressemble à de la fraude — ${truth.legit_oddities.map(esc).join(" ; ")}.`
        : "Fausse alerte : ces lignes sont légitimes et sans particularité ; c'est la règle qui se trompe.";
    view.innerHTML = `
      <a class="back" href="${esc(lastQueueHash)}">← Retour à la file d'alertes</a>
      <h1>Alerte <span class="mono">${esc(a.id)}</span></h1>
      <div class="detail-head">
        ${scenarioHtml(a.scenario, a.scenario_label)} ${sevHtml(a.severity)}
        <span>Levée le ${dateLong(a.date)}</span>
        <span>Adhérent <span class="mono">${esc(a.member_id)}</span></span>
        <span>Prestataire <span class="mono">${esc(a.provider_id || "plusieurs")}</span></span>
        <span>Montant visé : <strong class="num">${eur.format(a.amount)}</strong></span>
      </div>
      <div class="grid two-col">
        <section class="card" aria-labelledby="t-why">
          <h2 id="t-why">Pourquoi cette alerte ?</h2>
          <p class="why">${esc(a.reason)}</p>
          ${facts ? `<dl class="facts">${facts}</dl>` : ""}
        </section>
        <section class="card decision-box" aria-labelledby="t-dec">
          <h2 id="t-dec">Décision</h2>
          <p class="sub" style="margin:4px 0 0">Suggestion de la règle :</p>
          <p class="suggested">${esc(a.decision_label)}</p>
          <div class="decision-actions">
            <button class="btn primary" type="button" data-choice="suggested">Appliquer la suggestion</button>
            <button class="btn" type="button" data-choice="classer">Classer sans suite</button>
            <button class="btn" type="button" data-choice="enquete">Transmettre à l'équipe enquête</button>
          </div>
          <p class="status-line" id="dec-status" role="status">${local ? `Votre choix (démo) : ${esc(local.label)}` : ""}</p>
          <p class="notice">Démo : votre choix est gardé uniquement dans ce navigateur. Rien n'est envoyé ni enregistré sur le serveur.</p>
        </section>
      </div>
      ${a.chart ? `
      <section class="card section" aria-labelledby="t-chart">
        <h2 id="t-chart">Prix facturé et factures antérieures du même acte</h2>
        <p class="sub">${esc(a.chart.act_label)} : chaque point gris est une facture des 120 jours précédents. Le prix habituel n'utilise que des factures datées avant celle-ci.</p>
        ${legendHtml([{ cls: "dot past", label: "Factures antérieures" }, { cls: "ref", label: `Prix habituel : ${eur.format(a.chart.reference_median)}` }, { cls: "dot s2", label: `Cette facture : ${eur.format(a.chart.claim.amount)}` }])}
        <div class="chart-wrap tall"><canvas id="c-price" role="img" aria-label="Nuage de points des prix antérieurs, ligne du prix habituel et point de la facture signalée"></canvas></div>
      </section>` : ""}
      <section class="card section" aria-labelledby="t-ev">
        <h2 id="t-ev">Lignes de soins concernées</h2>
        <p class="sub">« Signalée » : ligne visée par l'alerte. « Contexte » : autres lignes utiles pour juger, non visées.</p>
        <div class="table-scroll"><table class="responsive">
          <thead><tr><th>Date</th><th>Rôle</th><th>Acte</th><th>Diagnostic</th><th>Prestataire</th><th class="num">Montant</th></tr></thead>
          <tbody>${a.evidence.map((r) => `<tr>
            <td data-label="Date">${dateLong(r.date)}</td>
            <td data-label="Rôle"><span class="role ${r.role === "signalée" ? "flag" : ""}">${r.role === "signalée" ? "Signalée" : "Contexte"}</span></td>
            <td data-label="Acte"><span class="cv">${esc(r.act_label)} <span class="muted mono">${esc(r.act_code)}</span></span></td>
            <td data-label="Diagnostic"><span class="cv">${esc(r.diagnosis_label)} <span class="muted mono">${esc(r.diagnosis_code)}</span></span></td>
            <td data-label="Prestataire"><span class="cv"><span class="mono">${esc(r.provider_id)}</span> <span class="muted">${esc(r.provider_type)}</span></span></td>
            <td data-label="Montant" class="num">${eur.format(r.billed_amount)}</td></tr>`).join("")}</tbody></table></div>
        <details class="truth">
          <summary>Coulisses de la démo : que s'est-il vraiment passé ?</summary>
          <p>${truthText}</p>
          <p class="muted">Un gestionnaire n'aurait pas cette information. Elle est affichée ici parce que les fraudes ont été injectées volontairement dans des données synthétiques.</p>
        </details>
      </section>`;

    const choices = {
      suggested: a.decision_label,
      classer: "Classer sans suite",
      enquete: "Transmettre à l'équipe enquête",
    };
    view.querySelectorAll("[data-choice]").forEach((b) => b.addEventListener("click", () => {
      const label = choices[b.dataset.choice];
      memoryDecisions[a.id] = { label, at: new Date().toISOString() };
      store.set("me-decisions", memoryDecisions);
      document.getElementById("dec-status").textContent = `Votre choix (démo) : ${label}. Gardé dans ce navigateur seulement.`;
    }));

    if (a.chart) {
      const claimDay = new Date(a.chart.claim.date + "T00:00:00");
      const offset = (iso) => Math.round((new Date(iso + "T00:00:00") - claimDay) / 86400000);
      const muted = css("--text-3");
      const xs = a.chart.past.map((p) => offset(p.date));
      const minX = Math.min(-30, ...xs);
      makeChart(document.getElementById("c-price"), {
        type: "scatter",
        data: {
          datasets: [
            { label: "Factures antérieures", data: a.chart.past.map((p) => ({ x: offset(p.date), y: p.amount, date: p.date })),
              backgroundColor: muted + "99", borderColor: css("--surface"), borderWidth: 1, pointRadius: 4, pointHoverRadius: 6 },
            { label: "Prix habituel", type: "line", data: [{ x: minX, y: a.chart.reference_median }, { x: 0, y: a.chart.reference_median }],
              borderColor: css("--chart-ref"), borderWidth: 2, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0 },
            { label: "Cette facture", data: [{ x: 0, y: a.chart.claim.amount, date: a.chart.claim.date }],
              backgroundColor: seriesColor(2), borderColor: css("--surface"), borderWidth: 2, pointRadius: 8, pointHoverRadius: 10 },
          ],
        },
        options: {
          scales: {
            x: { type: "linear", min: minX, max: 3, title: { display: true, text: "Jours avant la facture signalée" }, grid: { display: false }, ticks: { callback: (v) => (v > 0 ? "" : nf.format(v)) } },
            y: { beginAtZero: true, title: { display: true, text: "Montant facturé" }, ticks: { callback: (v) => eur0.format(v) }, border: { display: false } },
          },
          plugins: {
            tooltip: {
              filter: (item) => item.datasetIndex !== 1,
              callbacks: {
                title: (items) => (items[0].raw.date ? dateLong(items[0].raw.date) : ""),
                label: (item) => `${item.dataset.label} : ${eur.format(item.parsed.y)}`,
              },
            },
          },
        },
      });
    }
  }

  // ============================================================ EXPLORATION
  const pct1f = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1 });
  const pct1 = (v) => (v === null || v === undefined ? "—" : pct1f.format(v));
  const nf2 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
  const alpha = (hex, a) => (/^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(a * 255).toString(16).padStart(2, "0") : hex);
  const factor = (log2) => `×${nf2.format(Math.round(Math.pow(2, log2) * 100) / 100)}`;

  // Vertical or horizontal reference line drawn on top of the data (rule thresholds, baselines).
  const refLinePlugin = {
    id: "refLine",
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts || !opts.lines || !opts.lines.length) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      for (const l of opts.lines) {
        ctx.strokeStyle = css("--chart-ref");
        ctx.lineWidth = 1.5;
        ctx.setLineDash(l.solid ? [] : [5, 4]);
        ctx.beginPath();
        if (l.y !== undefined) {
          const py = chart.scales.y.getPixelForValue(l.y);
          ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
          continue;
        }
        const sx = chart.scales.x;
        const px = l.index !== undefined
          ? sx.getPixelForValue(0) + l.index * (sx.getPixelForValue(1) - sx.getPixelForValue(0))
          : sx.getPixelForValue(l.value);
        ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke();
        if (l.label) {
          ctx.setLineDash([]);
          ctx.font = `600 12px ${css("--font")}`;
          const tw = ctx.measureText(l.label).width;
          const right = px + 8 + tw < chartArea.right;
          const tx = right ? px + 6 : px - 6 - tw;
          ctx.fillStyle = css("--surface");
          ctx.fillRect(tx - 3, chartArea.top + 1, tw + 6, 17);
          ctx.fillStyle = css("--text");
          ctx.textBaseline = "top";
          ctx.fillText(l.label, tx, chartArea.top + 3);
        }
      }
      ctx.restore();
    },
  };
  let pluginsRegistered = false;
  function registerPlugins() {
    if (window.Chart && !pluginsRegistered) { Chart.register(refLinePlugin, pointLabelPlugin, edgesPlugin); pluginsRegistered = true; }
  }

  function dataTable(headers, rows, caption = "") {
    return `<details class="data-table"><summary>Voir les données en tableau</summary><div class="table-scroll"><table>
      ${caption ? `<caption>${esc(caption)}</caption>` : ""}
      <thead><tr>${headers.map((h, i) => `<th${i ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
  }
  function chartCard({ id, title, sub, legend = "", height = 280, aria, table = "", head = "", cls = "" }) {
    return `<section class="card ${cls}" aria-labelledby="t-${id}">
      <div class="card-head"><div><h3 id="t-${id}">${esc(title)}</h3><p class="sub">${sub}</p></div>${head}</div>
      ${legend}
      <div class="chart-wrap" style="height:${height}px"><canvas id="c-${id}" role="img" aria-label="${esc(aria)}"></canvas></div>
      ${table}
    </section>`;
  }
  const binLabelTooltip = (edges, i, fmt, unitPlural) => {
    const last = edges.length - 2;
    if (i === last) return `${fmt(edges[i])} et plus`;
    if (i === 0 && unitPlural === "clip-low") return `moins de ${fmt(edges[1])}`;
    return `de ${fmt(edges[i])} à ${fmt(edges[i + 1])}`;
  };

  // Legitimate lines (neutral) versus injected fraud (scenario colour), each as a share of its own group.
  function twoGroupBars(id, sig, { labels, titles, xTitle, unit, threshold }) {
    const n = sig.scenario;
    makeChart(document.getElementById(`c-${id}`), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Légitime", data: sig.legit_share, counts: sig.legit_counts, backgroundColor: alpha(css("--text-3"), 0.6), borderRadius: 3, borderSkipped: "start", barPercentage: 0.9, categoryPercentage: 0.85, maxBarThickness: 24 },
          { label: "Fraude injectée", data: sig.fraud_share, counts: sig.fraud_counts, backgroundColor: seriesColor(n), borderRadius: 3, borderSkipped: "start", barPercentage: 0.9, categoryPercentage: 0.85, maxBarThickness: 24 },
        ],
      },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, title: { display: true, text: xTitle }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 8 } },
          y: { beginAtZero: true, border: { display: false }, title: { display: true, text: `Part des ${unit} du groupe` }, ticks: { callback: (v) => pct(v) } },
        },
        plugins: {
          refLine: { lines: threshold ? [threshold] : [] },
          tooltip: {
            callbacks: {
              title: (items) => titles[items[0].dataIndex],
              label: (it) => `${it.dataset.label} : ${pct1(it.parsed.y)} (${nf.format(it.dataset.counts[it.dataIndex])} ${unit})`,
            },
          },
        },
      },
    });
  }
  const twoGroupLegend = (n, sig, unit) => legendHtml([
    { cls: "past", label: `Légitime (${nf.format(sig.n_legit)} ${unit})` },
    { cls: `s${n}`, label: `Fraude injectée, scénario ${n} (${nf.format(sig.n_fraud)} ${unit})` },
  ]);
  const twoGroupTable = (titles, sig, unit) => dataTable(
    ["Classe", `Légitime (${unit})`, "Part", `Fraude (${unit})`, "Part"],
    titles.map((t, i) => [t, nf.format(sig.legit_counts[i]), pct1(sig.legit_share[i]), nf.format(sig.fraud_counts[i]), pct1(sig.fraud_share[i])]),
  );

  async function renderExploration() {
    registerPlugins();
    const gen = navGen;
    const x = await api("/api/exploration");
    if (gen !== navGen) return; // the visitor has moved on: never draw over the newer view
    const S = x.summary;
    const P = x.portfolio;
    const G = x.signals;
    const accent = css("--accent");
    const muted = css("--text-3");

    // ----- portfolio data prepared for text and tables
    const am = P.amounts;
    const amBins = am.counts.map((_, i) => i);
    const amTitles = amBins.map((i) => binLabelTooltip(am.edges, i, (v) => eur0.format(v)));
    const mix = P.provider_mix;
    const pharma = mix.find((m) => m.type === "PHA");
    const dental = mix.find((m) => m.type === "DEN");
    const season = P.seasonality;
    const conc = P.concentration;
    const ages = P.age_spend;
    const bandFirst = ages.bands[0];
    const bandLast = ages.bands[ages.bands.length - 1];

    // ----- signal data
    const sp = G.price;
    const spBins = sp.legit_share.map((_, i) => i);
    const spTitles = spBins.map((i) => (i === 0 ? `moins de ${factor(sp.edges_log2[1])}` : i === spBins.length - 1 ? `${factor(sp.edges_log2[i])} et plus` : `de ${factor(sp.edges_log2[i])} à ${factor(sp.edges_log2[i + 1])}`));
    const spThrIdx = (sp.threshold_log2 - sp.edges_log2[0]) / (sp.edges_log2[1] - sp.edges_log2[0]) - 0.5;
    const sd = G.duplicates;
    const sdTitles = sd.legit_share.map((_, i) => (i === sd.legit_share.length - 1 ? `${i} jours ou plus` : i === 0 ? "le même jour" : `${i} jour${i > 1 ? "s" : ""} plus tard`));
    const sdLabels = sd.legit_share.map((_, i) => (i === sd.legit_share.length - 1 ? `${i}+` : String(i)));
    const sv = G.providers;
    const svLabels = sv.legit_share.map((_, i) => (i === sv.legit_share.length - 1 ? `${sv.edges[i]}+` : String(sv.edges[i])));
    const svTitles = sv.legit_share.map((_, i) => (i === sv.legit_share.length - 1 ? `${sv.edges[i]} prestataires ou plus` : `${sv.edges[i]} prestataire${sv.edges[i] > 1 ? "s" : ""}`));
    const svFrom = sv.edges.indexOf(sv.threshold);
    const se = G.early;
    const seLabels = se.legit_share.map((_, i) => (i === se.legit_share.length - 1 ? `${se.edges[i]}+` : String(se.edges[i])));
    const seTitles = se.legit_share.map((_, i) => (i === se.legit_share.length - 1 ? `${se.edges[i]} jours ou plus après la date d'effet` : `${se.edges[i]} à ${se.edges[i + 1] - 1} jours après la date d'effet`));
    const seThrIdx = (se.threshold + 1) / (se.edges[1] - se.edges[0]) - 0.5;
    const sc = G.coherence;

    view.innerHTML = `
      <div class="page-head"><div><h1>Exploration des données</h1>
        <p>Ce qu'un data scientist regarde avant d'écrire la moindre règle : la forme des montants, la variabilité des prix, la saisonnalité, la concentration.
        La seconde partie montre, pour chaque scénario, la variable sur laquelle porte la règle.</p></div></div>
      <section class="grid kpis" aria-label="Chiffres clés du jeu de données">
        <div class="kpi"><div class="label">Lignes de soins</div><div class="value">${nf.format(S.n_claims)}</div><div class="hint">un acte facturé par ligne, année 2025</div></div>
        <div class="kpi"><div class="label">Adhérents</div><div class="value">${nf.format(S.n_members)}</div><div class="hint">dont ${nf.format(S.members_with_claims)} avec au moins un soin</div></div>
        <div class="kpi"><div class="label">Prestataires</div><div class="value">${nf.format(S.n_providers)}</div><div class="hint">9 types, du généraliste à la clinique</div></div>
        <div class="kpi"><div class="label">Montant facturé</div><div class="value">${eur0.format(S.total_billed)}</div><div class="hint">médiane ${eur.format(S.median_amount)} par ligne</div></div>
        <div class="kpi"><div class="label">Lignes sans prix de référence</div><div class="value">${pct1(S.lines_without_price_reference)}</div><div class="hint">moins de 20 factures antérieures du même acte</div></div>
      </section>

      <h2 class="section-title">1. Le portefeuille, sans regarder les fraudes</h2>
      <div class="grid halves">
        ${chartCard({
          id: "amounts", title: "Distribution des montants par ligne",
          sub: `Asymétrie forte : ${pct(am.share_below_50)} des lignes coûtent moins de 50 €, mais les 5 % de lignes les plus chères pèsent ${pct(am.amount_share_top5pct_lines)} du montant total. Médiane ${eur.format(am.median)}, 99e centile ${eur0.format(am.p99)}. Intervalles en échelle logarithmique.`,
          aria: "Histogramme des montants par ligne, intervalles en échelle logarithmique",
          table: dataTable(["Montant", "Lignes"], amTitles.map((t, i) => [t, nf.format(am.counts[i])])),
        })}
        ${chartCard({
          id: "mix", title: "Part des lignes et part des montants par type de prestataire",
          sub: `Les pharmacies font ${pct(pharma.line_share)} des lignes mais ${pct(pharma.amount_share)} des montants ; les cabinets dentaires, ${pct(dental.line_share)} des lignes et ${pct(dental.amount_share)} des montants. Un même seuil en euros n'a pas le même sens partout.`,
          legend: legendHtml([{ cls: "past", label: "Part des lignes" }, { cls: "acc", label: "Part des montants" }]),
          height: 330, aria: "Barres horizontales groupées : part des lignes et part des montants pour chaque type de prestataire",
          table: dataTable(["Type", "Lignes", "Part des lignes", "Montant", "Part des montants", "Montant moyen"], mix.map((m) => [m.label, nf.format(m.lines), pct1(m.line_share), eur0.format(m.amount), pct1(m.amount_share), eur.format(m.mean_amount)])),
        })}
      </div>

      ${chartCard({
        id: "spread", cls: "section", title: "Dispersion des prix par acte",
        sub: "Pour chaque acte : la barre épaisse couvre la moitié centrale des prix (du 1er au 3e quartile), le trait fin 90 % des prix, le repère foncé la médiane. Échelle logarithmique. C'est cette dispersion qui fixe le seuil du scénario 1 : il doit rester au-dessus des écarts normaux.",
        legend: legendHtml([{ cls: "acc", label: "50 % central (Q1–Q3)" }, { cls: "past", label: "90 % des prix (P5–P95)" }, { cls: "ref", label: "Médiane" }]),
        height: 70 + 26 * P.price_spread.length, aria: "Boîtes horizontales de la distribution des prix pour chaque acte, en échelle logarithmique",
        table: dataTable(["Acte", "Lignes", "P5", "Q1", "Médiane", "Q3", "P95"], P.price_spread.map((r) => [r.label, nf.format(r.n), eur.format(r.p5), eur.format(r.q1), eur.format(r.median), eur.format(r.q3), eur.format(r.p95)])),
      })}

      <section class="card section" aria-labelledby="t-season">
        <h3 id="t-season">Saisonnalité par groupe de diagnostic</h3>
        <p class="sub">Indice mensuel du nombre de lignes, 100 = mois moyen du groupe. Même échelle pour les huit panneaux, classés du plus au moins saisonnier.
        Les infections respiratoires culminent en hiver, les examens de la vue à la rentrée : un volume « anormal » se juge par rapport à la saison.</p>
        <div class="multiples">${season.groups.map((g, i) => `
          <figure class="mini">
            <figcaption><strong>${esc(g.label)}</strong><span class="muted">pic : ${esc(g.peak_month)}</span></figcaption>
            <div class="chart-wrap" style="height:120px"><canvas id="c-season-${i}" role="img" aria-label="Indice saisonnier mensuel, ${esc(g.label)}"></canvas></div>
          </figure>`).join("")}</div>
        ${dataTable(["Groupe", ...season.months], season.groups.map((g) => [g.label, ...g.counts.map((c) => nf.format(c))]), "Nombre de lignes par mois")}
      </section>

      <div class="grid halves section">
        ${chartCard({
          id: "daily", title: "Lignes de soins par jour",
          sub: `${nf1.format(P.daily.mean)} lignes par jour en moyenne ; coefficient de variation ${pct(P.daily.cv)}. La moyenne mobile sur 7 jours lisse le bruit quotidien : la hausse sur l'année vient des adhérents entrés en cours d'année, les creux et pics de la saisonnalité.`,
          legend: legendHtml([{ cls: "past", label: "Lignes du jour" }, { cls: "acc", label: "Moyenne mobile 7 jours" }]),
          aria: "Barres du nombre de lignes par jour et courbe de la moyenne mobile sur 7 jours",
          table: dataTable(["Date", "Lignes", "Moyenne 7 j"], P.daily.dates.map((d, i) => [dateLong(d), nf.format(P.daily.lines[i]), nf1.format(P.daily.moving_avg_7d[i])])),
        })}
        ${chartCard({
          id: "lorenz", title: "Concentration des montants (courbe de Lorenz)",
          sub: `<span id="lorenz-sub"></span>`,
          head: `<div class="segmented" role="group" aria-label="Population"><button type="button" data-pop="providers" aria-pressed="true">Prestataires</button><button type="button" data-pop="members" aria-pressed="false">Adhérents</button></div>`,
          legend: legendHtml([{ cls: "acc", label: "Courbe de Lorenz" }, { cls: "ref", label: "Égalité parfaite" }]),
          aria: "Courbe de Lorenz : part cumulée du montant selon la part cumulée de la population",
          table: `<div id="lorenz-table"></div>`,
        })}
      </div>

      ${chartCard({
        id: "age", cls: "section", title: "Âge et dépense annuelle par adhérent",
        sub: `Chaque point est un adhérent (échantillon de ${nf.format(ages.n_points)} sur ${nf.format(ages.n_members)}). La dépense médiane passe de ${eur0.format(bandFirst.median)} chez les ${bandFirst.band} à ${eur0.format(bandLast.median)} chez les ${bandLast.band}, mais la dispersion à âge égal reste bien plus forte que l'effet de l'âge. Échelle logarithmique.`,
        legend: legendHtml([{ cls: "acc dot", label: "Un adhérent" }, { cls: "ref", label: "Médiane par tranche d'âge" }]),
        height: 320, aria: "Nuage de points de la dépense annuelle selon l'âge, avec la médiane par tranche d'âge",
        table: dataTable(["Tranche d'âge", "Adhérents", "Q1", "Médiane", "Q3"], ages.bands.map((b) => [b.band, nf.format(b.n), eur0.format(b.q1), eur0.format(b.median), eur0.format(b.q3)])),
      })}

      <h2 class="section-title">2. Les signaux de chaque scénario</h2>
      <section class="callout honest" aria-label="Avertissement sur les labels">
        <p style="margin:0"><strong>Ces comparaisons utilisent la vérité injectée.</strong> Elles ne sont possibles que parce que les fraudes sont synthétiques et étiquetées par le générateur : ${pct1(S.fraud_line_share)} des lignes et ${pct1(S.fraud_amount_share)} des montants.
        Dans un vrai portefeuille, on ne verrait que la courbe grise, mélangée à une fraude inconnue et bien plus rare. Chaque groupe est ramené à 100 % pour que la fraude, minoritaire, reste visible. La ligne pointillée marque le seuil de la règle.</p>
      </section>
      <div class="grid halves section">
        ${chartCard({
          id: "sig-price", title: "Scénario 1 : montant rapporté au prix habituel",
          sub: `À partir de ${esc(sp.threshold_label)}, on trouve ${pct(sp.fraud_rule_share)} des prix gonflés injectés et ${pct1(sp.legit_rule_share)} des lignes légitimes. ${nf.format(sp.lines_without_reference)} lignes sans prix de référence ne sont pas comptées.`,
          legend: twoGroupLegend(1, sp, "lignes"), aria: "Histogrammes comparés du rapport au prix habituel, lignes légitimes et prix gonflés injectés",
          table: twoGroupTable(spTitles, sp, "lignes"),
        })}
        ${chartCard({
          id: "sig-dup", title: "Scénario 2 : écart avec la facture identique précédente",
          sub: `Même adhérent, même prestataire, même acte (hors pharmacie et kinésithérapie). Jusqu'à ${sd.threshold} jour d'écart : ${pct(sd.fraud_rule_share)} des doublons injectés, ${pct1(sd.legit_rule_share)} des répétitions légitimes.`,
          legend: twoGroupLegend(2, sd, "lignes"), aria: "Histogrammes comparés de l'écart en jours avec la facture identique précédente",
          table: twoGroupTable(sdTitles, sd, "lignes"),
        })}
        ${chartCard({
          id: "sig-prov", title: "Scénario 3 : nouveaux prestataires du même type en 14 jours",
          sub: `Maximum par adhérent (généralistes, spécialistes, pharmacies). À partir de ${sv.threshold} : ${pct(sv.fraud_rule_share)} des adhérents nomades injectés, ${pct1(sv.legit_rule_share)} des adhérents légitimes.`,
          legend: twoGroupLegend(3, sv, "adhérents"), aria: "Histogrammes comparés du nombre maximal de nouveaux prestataires en 14 jours par adhérent",
          table: twoGroupTable(svTitles, sv, "adhérents"),
        })}
        ${chartCard({
          id: "sig-early", title: "Scénario 5 : délai entre la date d'effet et un soin coûteux",
          sub: `Adhérents entrés en 2025, actes coûteux ou d'au moins 150 €, par semaine. Jusqu'à ${se.threshold} jours : ${pct(se.fraud_rule_share)} des sinistres précoces injectés, mais aussi ${pct(se.legit_rule_share)} des soins coûteux légitimes de nouveaux adhérents : l'anti-sélection ressemble à la fraude.`,
          legend: twoGroupLegend(5, se, "lignes"), aria: "Histogrammes comparés du délai entre la date d'effet du contrat et un soin coûteux",
          table: twoGroupTable(seTitles, se, "lignes"),
        })}
      </div>
      ${chartCard({
        id: "sig-coh", cls: "section", title: "Scénario 4 : lignes dont l'acte ne correspond pas au diagnostic",
        sub: `Nombre de lignes incohérentes par acte. Les erreurs de codage honnêtes (${pct1(sc.legit_incoherent_rate)} des lignes légitimes) produisent les fausses alertes ; les ${nf.format(sc.camouflaged_total)} fraudes injectées avec un diagnostic plausible n'apparaissent pas ici : la règle ne peut pas les voir.`,
        legend: legendHtml([{ cls: "past", label: "Légitime (erreur de codage)" }, { cls: "s4", label: "Fraude injectée, scénario 4" }]),
        height: 70 + 26 * sc.acts.length, aria: "Barres horizontales empilées du nombre de lignes incohérentes par acte",
        table: dataTable(["Acte", "Lignes", "Incohérentes légitimes", "Incohérentes frauduleuses", "Fraudes camouflées"], sc.acts.map((a) => [a.label, nf.format(a.lines), nf.format(a.incoherent_legit), nf.format(a.incoherent_fraud), nf.format(a.camouflaged_fraud)])),
      })}`;

    // ---------------------------------------------------------- portfolio charts
    makeChart(document.getElementById("c-amounts"), {
      type: "bar",
      data: { labels: amBins.map((i) => eur0.format(am.edges[i])), datasets: [{ label: "Lignes", data: am.counts, backgroundColor: accent, borderRadius: 3, borderSkipped: "start", barPercentage: 0.92, categoryPercentage: 1 }] },
      options: {
        scales: {
          x: { grid: { display: false }, title: { display: true, text: "Montant facturé (borne basse de l'intervalle)" }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 10 } },
          y: { beginAtZero: true, border: { display: false }, title: { display: true, text: "Lignes" }, ticks: { precision: 0 } },
        },
        plugins: {
          refLine: { lines: [{ index: (Math.log(am.median) - Math.log(am.edges[0])) / (Math.log(am.edges[1]) - Math.log(am.edges[0])) - 0.5, label: `Médiane ${eur0.format(am.median)}` }] },
          tooltip: { callbacks: { title: (items) => amTitles[items[0].dataIndex], label: (it) => `${nf.format(it.parsed.y)} lignes` } },
        },
      },
    });

    makeChart(document.getElementById("c-mix"), {
      type: "bar",
      data: {
        labels: mix.map((m) => m.label),
        datasets: [
          { label: "Part des lignes", data: mix.map((m) => m.line_share), backgroundColor: alpha(muted, 0.6), borderRadius: 3, borderSkipped: "start", maxBarThickness: 12, categoryPercentage: 0.8, barPercentage: 0.9 },
          { label: "Part des montants", data: mix.map((m) => m.amount_share), backgroundColor: accent, borderRadius: 3, borderSkipped: "start", maxBarThickness: 12, categoryPercentage: 0.8, barPercentage: 0.9 },
        ],
      },
      options: {
        indexAxis: "y",
        interaction: { mode: "index", intersect: false, axis: "y" },
        scales: { x: { beginAtZero: true, ticks: { callback: (v) => pct(v) }, border: { display: false } }, y: { grid: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (it) => `${it.dataset.label} : ${pct1(it.parsed.x)}` } } },
      },
    });

    const spread = P.price_spread;
    makeChart(document.getElementById("c-spread"), {
      type: "bar",
      data: {
        labels: spread.map((r) => r.label),
        datasets: [
          { label: "90 % des prix", data: spread.map((r) => [r.p5, r.p95]), backgroundColor: alpha(muted, 0.7), barThickness: 2, grouped: false, borderSkipped: false },
          { label: "50 % central", data: spread.map((r) => [r.q1, r.q3]), backgroundColor: accent, barThickness: 12, grouped: false, borderRadius: 3, borderSkipped: false },
          { label: "Médiane", data: spread.map((r) => [r.median / 1.012, r.median * 1.012]), backgroundColor: css("--chart-ref"), barThickness: 18, grouped: false, borderSkipped: false },
        ],
      },
      options: {
        indexAxis: "y",
        interaction: { mode: "index", intersect: false, axis: "y" },
        scales: {
          x: { type: "logarithmic", min: 4, max: 1000, border: { display: false }, title: { display: true, text: "Montant facturé (échelle logarithmique)" },
            ticks: { maxRotation: 0, autoSkip: false, callback(v) { return (this.chart.width < 560 ? [10, 100, 1000] : [5, 10, 20, 50, 100, 200, 500, 1000]).includes(v) ? eur0.format(v) : ""; } } },
          y: { grid: { display: false } },
        },
        plugins: {
          tooltip: {
            filter: (it) => it.datasetIndex === 1,
            callbacks: {
              label: (it) => {
                const r = spread[it.dataIndex];
                return [`Médiane : ${eur.format(r.median)}`, `Q1–Q3 : ${eur.format(r.q1)} – ${eur.format(r.q3)}`, `P5–P95 : ${eur.format(r.p5)} – ${eur.format(r.p95)}`, `${nf.format(r.n)} lignes`];
              },
            },
          },
        },
      },
    });

    const seasonMax = Math.ceil(Math.max(...season.groups.flatMap((g) => g.index)) / 50) * 50;
    const initials = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
    season.groups.forEach((g, i) => {
      makeChart(document.getElementById(`c-season-${i}`), {
        type: "line",
        data: { labels: initials, datasets: [{ label: g.label, data: g.index, borderColor: accent, backgroundColor: alpha(accent, 0.1), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: { value: 100 }, tension: 0.25 }] },
        options: {
          interaction: { mode: "index", intersect: false },
          scales: {
            x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: false, font: { size: 10 } } },
            y: { min: 0, max: seasonMax, ticks: { stepSize: 100, font: { size: 10 } }, border: { display: false } },
          },
          plugins: {
            refLine: { lines: [{ y: 100, solid: true }] },
            tooltip: { callbacks: { title: (items) => season.months[items[0].dataIndex], label: (it) => `Indice ${nf.format(it.parsed.y)} (${nf.format(g.counts[it.dataIndex])} lignes)` } },
          },
        },
      });
    });

    makeChart(document.getElementById("c-daily"), {
      type: "bar",
      data: {
        labels: P.daily.dates,
        datasets: [
          { type: "line", label: "Moyenne mobile 7 jours", data: P.daily.moving_avg_7d, borderColor: accent, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2, order: 0 },
          { label: "Lignes du jour", data: P.daily.lines, backgroundColor: alpha(muted, 0.35), barPercentage: 1, categoryPercentage: 1, order: 1 },
        ],
      },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7, callback(v) { return dateShort(this.getLabelForValue(v)); } } },
          y: { beginAtZero: true, border: { display: false }, ticks: { precision: 0 } },
        },
        plugins: { tooltip: { callbacks: { title: (items) => dateLong(items[0].label), label: (it) => `${it.dataset.label} : ${nf1.format(it.parsed.y)}` } } },
      },
    });

    let lorenzChart = null;
    const drawLorenz = (pop) => {
      const L = conc[pop];
      const who = pop === "providers" ? "prestataires" : "adhérents";
      document.getElementById("lorenz-sub").textContent = `Indice de Gini ${nf2.format(L.gini)} pour les ${who}. Les 10 % de ${who} les plus coûteux concentrent ${pct(L.top10_share)} du montant. Plus la courbe s'éloigne de la diagonale, plus la dépense est concentrée.`;
      document.getElementById("lorenz-table").innerHTML = dataTable(["Part des " + who, "Part cumulée du montant"], L.x.filter((_, i) => i % 10 === 0).map((v, j) => [pct(v), pct1(L.y[j * 10])]));
      if (lorenzChart) { lorenzChart.destroy(); charts = charts.filter((c) => c !== lorenzChart); }
      lorenzChart = makeChart(document.getElementById("c-lorenz"), {
        type: "line",
        data: {
          datasets: [
            { label: "Courbe de Lorenz", data: L.x.map((v, i) => ({ x: v, y: L.y[i] })), borderColor: accent, backgroundColor: alpha(accent, 0.1), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: 1 },
            { label: "Égalité parfaite", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], borderColor: css("--chart-ref"), borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0 },
          ],
        },
        options: {
          interaction: { mode: "nearest", axis: "x", intersect: false },
          scales: {
            x: { type: "linear", min: 0, max: 1, title: { display: true, text: `Part cumulée des ${who}, du moins au plus coûteux` }, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, grid: { display: false } },
            y: { min: 0, max: 1, title: { display: true, text: "Part cumulée du montant" }, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, border: { display: false } },
          },
          plugins: { tooltip: { filter: (it) => it.datasetIndex === 0, callbacks: { title: (items) => `${pct(items[0].parsed.x)} des ${who}`, label: (it) => `${pct1(it.parsed.y)} du montant` } } },
        },
      });
    };
    drawLorenz("providers");
    view.querySelectorAll("[data-pop]").forEach((b) => b.addEventListener("click", () => {
      view.querySelectorAll("[data-pop]").forEach((y) => y.setAttribute("aria-pressed", String(y === b)));
      drawLorenz(b.dataset.pop);
    }));

    makeChart(document.getElementById("c-age"), {
      type: "scatter",
      data: {
        datasets: [
          { type: "line", label: "Médiane par tranche d'âge", data: ages.bands.map((b) => ({ x: b.mid_age, y: b.median, band: b.band })), borderColor: css("--chart-ref"), backgroundColor: css("--chart-ref"), borderWidth: 2, pointRadius: 5, pointHoverRadius: 7, pointBorderColor: css("--surface"), pointBorderWidth: 2, order: 0 },
          { label: "Adhérent", data: ages.points.map((p) => ({ x: p.age, y: p.amount, lines: p.lines })), backgroundColor: alpha(accent, 0.3), borderWidth: 0, pointRadius: 3, pointHoverRadius: 6, order: 1 },
        ],
      },
      options: {
        interaction: { mode: "nearest", intersect: false },
        scales: {
          x: { type: "linear", min: 18, max: 90, title: { display: true, text: "Âge en 2025" }, grid: { display: false } },
          y: { type: "logarithmic", min: 10, title: { display: true, text: "Dépense annuelle (échelle logarithmique)" }, border: { display: false },
            ticks: { callback: (v) => ([10, 30, 100, 300, 1000, 3000, 10000].includes(v) ? eur0.format(v) : "") } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => (items[0].raw.band ? items[0].raw.band : `${items[0].raw.x} ans`),
              label: (it) => (it.raw.band ? `Médiane : ${eur0.format(it.raw.y)}` : `${eur0.format(it.raw.y)} sur ${nf.format(it.raw.lines)} lignes`),
            },
          },
        },
      },
    });

    // ------------------------------------------------------------- signal charts
    twoGroupBars("sig-price", sp, {
      labels: spBins.map((i) => factor(sp.edges_log2[i])), titles: spTitles, unit: "lignes",
      xTitle: "Montant ÷ prix habituel de l'acte (échelle logarithmique)", threshold: { index: spThrIdx, label: `Seuil ${sp.threshold_label}` },
    });
    twoGroupBars("sig-dup", sd, {
      labels: sdLabels, titles: sdTitles, unit: "lignes",
      xTitle: "Jours depuis la facture identique précédente", threshold: { index: sd.threshold + 0.5, label: `Seuil : ${sd.threshold} jour` },
    });
    twoGroupBars("sig-prov", sv, {
      labels: svLabels, titles: svTitles, unit: "adhérents",
      xTitle: `Nouveaux prestataires du même type en ${sv.window_days} jours (maximum par adhérent)`, threshold: { index: svFrom - 0.5, label: `Seuil : ${sv.threshold}` },
    });
    twoGroupBars("sig-early", se, {
      labels: seLabels, titles: seTitles, unit: "lignes",
      xTitle: "Jours entre la date d'effet et le soin (par semaine)", threshold: { index: seThrIdx, label: `Seuil : ${se.threshold} jours` },
    });

    makeChart(document.getElementById("c-sig-coh"), {
      type: "bar",
      data: {
        labels: sc.acts.map((a) => a.label),
        datasets: [
          { label: "Légitime (erreur de codage)", data: sc.acts.map((a) => a.incoherent_legit), backgroundColor: alpha(muted, 0.6), stack: "a", borderColor: css("--surface"), borderWidth: { right: 2 }, borderSkipped: false, maxBarThickness: 14 },
          { label: "Fraude injectée", data: sc.acts.map((a) => a.incoherent_fraud), backgroundColor: seriesColor(4), stack: "a", borderRadius: 3, borderSkipped: "start", maxBarThickness: 14 },
        ],
      },
      options: {
        indexAxis: "y",
        interaction: { mode: "index", intersect: false, axis: "y" },
        scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, border: { display: false }, title: { display: true, text: "Lignes incohérentes" } }, y: { stacked: true, grid: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (it) => `${it.dataset.label} : ${nf.format(it.parsed.x)}`, footer: (items) => `${nf.format(sc.acts[items[0].dataIndex].lines)} lignes de cet acte au total` } } },
      },
    });
  }

  // ========================================================== PROVIDERS VIEW
  const heatBg = (share, base = "var(--surface-2)") => `background:color-mix(in srgb, var(--accent) ${Math.round(Math.min(1, share) * 88)}%, ${base})`;
  const complicitTag = '<span class="tag" title="Vérité injectée par le générateur ; les règles ne connaissent pas cette liste">complice injecté</span>';
  const SHORT_DECISION = {
    demander_facture: "Demander la facture", demander_justificatif: "Demander un justificatif", verifier_contrat: "Vérifier le contrat",
    controle_prestataire: "Contrôle prestataire", controle_medical: "Contrôle médical", aucune_action: "Aucune action",
  };
  const SHORT_SCEN = { 1: "1. Prix", 2: "2. Doublon", 3: "3. Prestataires", 4: "4. Incohérence", 5: "5. Précoce" };
  const MONTH_START_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const MONTHS_SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

  const edgesPlugin = {
    id: "edges",
    beforeDatasetsDraw(chart, _args, opts) {
      if (!opts || !opts.links) return;
      const { ctx } = chart;
      const sx = chart.scales.x;
      const sy = chart.scales.y;
      ctx.save();
      ctx.lineCap = "round";
      for (const l of opts.links) {
        const a = opts.pos[l.source];
        const b = opts.pos[l.target];
        ctx.strokeStyle = l.in_alert ? alpha(opts.alertColor, 0.8) : alpha(opts.baseColor, 0.45);
        ctx.lineWidth = l.in_alert ? 1.8 : Math.min(1 + 0.6 * (l.visits - 1), 5);
        ctx.beginPath();
        ctx.moveTo(sx.getPixelForValue(a.x), sy.getPixelForValue(a.y));
        ctx.lineTo(sx.getPixelForValue(b.x), sy.getPixelForValue(b.y));
        ctx.stroke();
      }
      ctx.restore();
    },
  };

  async function renderProviders() {
    registerPlugins();
    const gen = navGen;
    const x = await api("/api/providers");
    if (gen !== navGen) return; // the visitor has moved on: never draw over the newer view
    const H = x.heatmap;
    const SC = x.scorecard;
    const N = x.network;
    const ns = N.summary;
    const weekStart = (w) => { const d = new Date(2025, 0, 1 + w * 7); return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); };
    const top10 = H.rows.slice(0, 10).reduce((a, r) => a + r.total, 0);
    const allProviderAlerts = H.rows.reduce((a, r) => a + r.total, 0);
    const colLabel = { lines: "Lignes", median_ratio: "Prix médian / prix habituel", share_above_1_5: "Part des lignes ≥ ×1,5", alerts_per_100: "Alertes pour 100 lignes" };
    const colFmt = { lines: (v) => nf.format(v), median_ratio: (v) => (v === null ? "—" : `×${nf2.format(v)}`), share_above_1_5: (v) => pct1(v), alerts_per_100: (v) => nf1.format(v) };
    const scen = (r) => Object.entries(r.by_scenario).filter(([, n]) => n).map(([s, n]) => `${n} × scénario ${s}`).join(", ");

    view.innerHTML = `
      <div class="page-head"><div><h1>Prestataires et réseau</h1>
        <p>Les règles jugent chaque ligne isolément. Ici, on agrège par prestataire et on regarde les liens entre adhérents et prestataires : deux angles que les règles n'exploitent pas encore.</p></div></div>
      <section class="grid kpis" aria-label="Chiffres clés">
        <div class="kpi"><div class="label">Prestataires avec au moins une alerte</div><div class="value">${nf.format(H.providers_with_alerts)}</div><div class="hint">sur ${nf.format(x.dataset.n_providers)} prestataires</div></div>
        <div class="kpi"><div class="label">Alertes des 10 prestataires les plus signalés</div><div class="value">${nf.format(top10)}</div><div class="hint">${pct(top10 / Math.max(allProviderAlerts, 1))} des alertes des ${H.rows.length} premiers</div></div>
        <div class="kpi"><div class="label">Complices injectés en tête du profil</div><div class="value">${SC.complicit_in_top} sur ${SC.complicit_total}</div><div class="hint">dans les ${SC.rows.length} premiers du tableau de profil</div></div>
        <div class="kpi"><div class="label">Prestataires par adhérent signalé</div><div class="value">${nf1.format(ns.mean_providers_flagged)}</div><div class="hint">contre ${nf1.format(ns.mean_providers_contrast)} pour les adhérents fidèles</div></div>
      </section>

      <section class="card" aria-labelledby="t-hm">
        <h2 id="t-hm">Alertes par prestataire et par semaine</h2>
        <p class="sub">Les ${H.rows.length} prestataires qui reçoivent le plus d'alertes (hors scénario 3, qui implique plusieurs prestataires). Plus la case est foncée, plus il y a d'alertes cette semaine-là (maximum ${H.max}).
        Les lignes régulièrement foncées toute l'année signalent un comportement durable, pas un accident.</p>
        <p class="scroll-hint" aria-hidden="true">Faites glisser horizontalement pour voir toute l'année →</p>
        <div class="hm-scroll"><div class="hm" style="--weeks:${H.weeks}" role="img" aria-label="Carte de chaleur des alertes par prestataire et par semaine">
          <div class="hm-label hm-head"></div>
          <div class="hm-months" aria-hidden="true">${MONTHS_SHORT.map((m, i) => `<span style="grid-column:${Math.floor(MONTH_START_DAYS[i] / 7) + 1}">${m}</span>`).join("")}</div>
          <div class="hm-total hm-head">Total</div>
          ${H.rows.map((r) => `
            <div class="hm-label"><span class="mono">${esc(r.provider_id)}</span> <span class="muted">${esc(r.type)}</span>${r.complicit ? complicitTag : ""}</div>
            <div class="hm-row">${r.counts.map((c, w) => `<span style="${c ? heatBg(c / Math.max(H.max, 1)) : ""}" title="${esc(r.provider_id)}, semaine du ${weekStart(w)} : ${c} alerte${c > 1 ? "s" : ""}"></span>`).join("")}</div>
            <div class="hm-total num">${nf.format(r.total)}</div>`).join("")}
        </div></div>
        ${legendHtml([{ cls: "hm-0", label: "Aucune alerte" }, { cls: "hm-1", label: "1 alerte" }, { cls: "hm-max", label: `${H.max} alertes` }])}
        ${dataTable(["Prestataire", "Type", "Complice injecté", "Alertes", "Détail par scénario"], H.rows.map((r) => [r.provider_id, r.type, r.complicit ? "oui" : "non", nf.format(r.total), scen(r)]))}
      </section>

      <section class="card section" aria-labelledby="t-sc">
        <h2 id="t-sc">Profil de facturation des prestataires</h2>
        <p class="sub">Classés par part de lignes facturées au moins 1,5 fois le prix habituel de l'acte. Chaque colonne a sa propre échelle : plus la case est foncée, plus le prestataire se classe haut parmi les ${nf.format(SC.eligible)} prestataires sur cet indicateur.
        Les ${SC.complicit_total} complices injectés occupent ${SC.complicit_in_top === SC.complicit_total && SC.rows.slice(0, SC.complicit_total).every((r) => r.complicit) ? "exactement les premières places" : `${SC.complicit_in_top} des ${SC.rows.length} premières places`} : agréger par prestataire les repère, alors que la règle ligne à ligne ne voit qu'une suite d'alertes isolées.</p>
        <div class="table-scroll"><table class="heat scorecard">
          <thead><tr><th>Prestataire</th>${SC.columns.map((c) => `<th class="num">${esc(colLabel[c])}</th>`).join("")}</tr></thead>
          <tbody>${SC.rows.map((r) => `<tr><th scope="row" class="rowh"><span class="mono">${esc(r.provider_id)}</span> <span class="muted">${esc(r.type)}</span>${r.complicit ? complicitTag : ""}</th>
            ${SC.columns.map((c) => { const rk = r.rank[c] ?? 0; return `<td class="cell" style="${heatBg(rk * rk * 0.5, "var(--surface)")}">${colFmt[c](r[c])}</td>`; }).join("")}</tr>`).join("")}</tbody>
        </table></div>
      </section>

      <section class="card section" aria-labelledby="t-net">
        <h2 id="t-net">Graphe adhérents – prestataires</h2>
        <p class="sub">${ns.shown_flagged} adhérents signalés par la règle de multiplication des prestataires (sur ${ns.flagged_members}) et ${ns.shown_contrast} adhérents fidèles très consommateurs, avec tous leurs généralistes, spécialistes et pharmacies de l'année.
        Un adhérent signalé voit en moyenne ${nf1.format(ns.mean_providers_flagged)} prestataires différents, ${nf1.format(ns.mean_visits_per_provider_flagged)} fois chacun ; un adhérent fidèle en voit ${nf1.format(ns.mean_providers_contrast)}, ${nf1.format(ns.mean_visits_per_provider_contrast)} fois chacun.</p>
        ${legendHtml([{ cls: "s3 dot", label: "Adhérent signalé (règle 3)" }, { cls: "dark dot", label: "Adhérent fidèle, non signalé" }, { cls: "past", label: "Prestataire (taille = nombre d'adhérents)" }, { cls: "s3 line", label: "Visite comprise dans l'alerte" }, { cls: "past line", label: "Autre visite (épaisseur = nombre de visites)" }])}
        <div class="chart-wrap net-wrap"><canvas id="c-net" role="img" aria-label="Graphe des liens entre adhérents et prestataires"></canvas></div>
        <p class="sub" style="margin-top:10px">Le générateur n'a pas injecté de réseau organisé : les ${nf.format(ns.shared_providers)} prestataires partagés par plusieurs adhérents le sont par hasard. Sur de vraies données, ce graphe servirait à chercher des communautés (un prestataire et un groupe d'adhérents qui se retrouvent toujours ensemble), ce que les règles actuelles ne font pas.</p>
      </section>`;

    // network
    const pos = Object.fromEntries(N.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const providerNodes = N.nodes.filter((n) => n.kind === "provider");
    const flagged = N.nodes.filter((n) => n.kind === "member" && n.group === "flagged");
    const contrast = N.nodes.filter((n) => n.kind === "member" && n.group === "contrast");
    const surf = css("--surface");
    makeChart(document.getElementById("c-net"), {
      type: "scatter",
      data: {
        datasets: [
          { label: "Prestataire", data: providerNodes.map((n) => ({ x: n.x, y: n.y, n })), pointStyle: "rect", backgroundColor: alpha(css("--text-3"), 0.85), borderColor: surf, borderWidth: 1, pointRadius: providerNodes.map((n) => 3 + 1.5 * n.degree), pointHoverRadius: providerNodes.map((n) => 5 + 1.5 * n.degree) },
          { label: "Adhérent fidèle", data: contrast.map((n) => ({ x: n.x, y: n.y, n })), backgroundColor: css("--text"), borderColor: surf, borderWidth: 2, pointRadius: 7, pointHoverRadius: 9 },
          { label: "Adhérent signalé", data: flagged.map((n) => ({ x: n.x, y: n.y, n })), backgroundColor: seriesColor(3), borderColor: surf, borderWidth: 2, pointRadius: 7, pointHoverRadius: 9 },
        ],
      },
      options: {
        layout: { padding: 14 },
        scales: { x: { display: false, min: -0.02, max: 1.02 }, y: { display: false, min: -0.02, max: 1.02 } },
        plugins: {
          edges: { links: N.links, pos, alertColor: seriesColor(3), baseColor: css("--text-3") },
          tooltip: {
            callbacks: {
              title: (items) => items[0].raw.n.id,
              label: (it) => {
                const n = it.raw.n;
                if (n.kind === "provider") return `${n.ptype}, ${n.degree} adhérent${n.degree > 1 ? "s" : ""} de ce graphe`;
                return `${n.group === "flagged" ? "Signalé par la règle 3" : "Fidèle, non signalé"} : ${n.degree} prestataires, ${n.visits} visites${n.injected ? " (fraude injectée)" : ""}`;
              },
            },
          },
        },
      },
    });
  }

  // ============================================================== MODEL VIEW
  async function renderModel() {
    registerPlugins();
    const gen = navGen;
    const m = await api("/api/model");
    if (gen !== navGen) return; // the visitor has moved on: never draw over the newer view
    if (m.status === "computing") {
      view.innerHTML = `<div class="page-head"><div><h1>Modèle non supervisé</h1></div></div><section class="card"><p class="loading">Entraînement de l'Isolation Forest en cours (quelques secondes après chaque génération)… la page s'affichera seule.</p></section>`;
      pollTimer = setTimeout(() => { if (parseHash().parts[0] === "modele") route(); }, 2000);
      return;
    }
    if (m.status !== "ready") { view.innerHTML = `<section class="card"><h1>Modèle non supervisé</h1><p class="error">Le calcul a échoué.</p></section>`; return; }
    const R = m.rules;
    const MT = m.models.metier;
    const BR = m.models.brutes;
    const o = m.overlap;
    const scenLabels = meta ? meta.scenarios : (await ensureMeta()).scenarios;
    if (gen !== navGen) return;
    const keys = ["1", "2", "3", "4", "5"];
    const series = [
      { label: "Règles (système actuel)", cls: "acc", color: css("--accent"), at: R },
      { label: "Isolation Forest, variables métier", cls: "alt", color: css("--alt"), at: MT.at_budget },
      { label: "Isolation Forest, variables brutes", cls: "past", color: alpha(css("--text-3"), 0.7), at: BR.at_budget },
    ];
    const chips = (fs) => fs.map((f) => `<span class="feat">${esc(f.label)}</span>`).join("");
    const truthLabel = (t) => (t ? `Fraude, scénario ${t}` : "Légitime");

    view.innerHTML = `
      <div class="page-head"><div><h1>Modèle non supervisé</h1>
        <p>Un Isolation Forest note chaque ligne selon sa facilité à être isolée des autres, sans jamais voir les étiquettes de fraude. Il est comparé aux règles <strong>à charge de travail égale</strong> : il signale autant de lignes (${nf.format(m.budget)}) que les cinq règles réunies.
        Il est présenté en comparaison seulement : les alertes de la démo restent celles des règles.</p></div></div>
      <section class="grid kpis" aria-label="Rappel à charge égale">
        ${series.map((s) => `<div class="kpi"><div class="label">${esc(s.label)}</div><div class="value">${pct(s.at.recall)}</div><div class="hint">des lignes frauduleuses retrouvées ; précision ${pct(s.at.precision)}</div></div>`).join("")}
        <div class="kpi"><div class="label">Fraudes vues par le modèle seul</div><div class="value">${nf.format(o.fraud_model_only)}</div><div class="hint">lignes frauduleuses qu'aucune règle ne signale</div></div>
      </section>

      <div class="grid halves">
        ${chartCard({
          id: "m-recall", title: "Rappel par scénario, à charge de travail égale",
          sub: "Part des lignes injectées de chaque scénario retrouvées par chaque approche, avec le même nombre de lignes signalées.",
          legend: legendHtml(series.map((s) => ({ cls: s.cls, label: s.label }))), height: 300,
          aria: "Barres groupées du rappel par scénario pour les règles et les deux variantes du modèle",
          table: dataTable(["Scénario", ...series.map((s) => s.label)], keys.map((k) => [`${k}. ${scenLabels[k]}`, ...series.map((s) => pct1(s.at.recall_by_scenario[k]))])),
        })}
        ${chartCard({
          id: "m-pr", title: "Précision et rappel selon le nombre de lignes signalées",
          sub: "Chaque courbe parcourt les lignes de la plus à la moins anormale. Le point bleu est le système de règles : à son niveau de rappel, le modèle est bien moins précis.",
          legend: legendHtml([{ cls: "acc dot", label: "Règles" }, { cls: "alt", label: "Variables métier" }, { cls: "past", label: "Variables brutes" }]), height: 300,
          aria: "Courbes précision-rappel des deux variantes du modèle et point des règles",
          table: dataTable(["Lignes signalées", "Métier : précision", "Métier : rappel", "Brutes : précision", "Brutes : rappel"], MT.pr.map((p, i) => [nf.format(p.k), pct1(p.precision), pct1(p.recall), pct1(BR.pr[i]?.precision), pct1(BR.pr[i]?.recall)])),
        })}
      </div>

      <section class="card section" aria-labelledby="t-feat">
        <h2 id="t-feat">Ce que le modèle voit</h2>
        <div class="grid halves">
          <div><h3>Variables brutes</h3><p class="sub">Disponibles sans aucune connaissance de la fraude.</p><p class="feats">${chips(BR.features)}</p></div>
          <div><h3>Variables métier</h3><p class="sub">Les signaux des règles, calculés sans les étiquettes.</p><p class="feats">${chips(MT.features)}</p></div>
        </div>
        <p class="sub" style="margin-top:12px">Le saut de ${pct(BR.at_budget.recall)} à ${pct(MT.at_budget.recall)} de rappel vient des variables, pas de l'algorithme : c'est la connaissance du métier, encodée en variables, qui fait le travail.</p>
      </section>

      <div class="grid halves section">
        <section class="card" aria-labelledby="t-ov">
          <h2 id="t-ov">Qui trouve quoi ?</h2>
          <p class="sub">Lignes frauduleuses et lignes légitimes signalées, selon qu'elles le sont par les règles, par le modèle (variables métier) ou par les deux.</p>
          <h3 class="mini-title">Lignes frauduleuses (${nf.format(m.n_fraud)})</h3>
          <div class="tiles">
            <div class="tile"><div class="label">Les deux</div><div class="value">${nf.format(o.fraud_both)}</div></div>
            <div class="tile"><div class="label">Règles seules</div><div class="value">${nf.format(o.fraud_rules_only)}</div></div>
            <div class="tile"><div class="label">Modèle seul</div><div class="value">${nf.format(o.fraud_model_only)}</div></div>
            <div class="tile"><div class="label">Personne</div><div class="value">${nf.format(o.fraud_neither)}</div></div>
          </div>
          <h3 class="mini-title">Lignes légitimes signalées à tort</h3>
          <div class="tiles three">
            <div class="tile"><div class="label">Les deux</div><div class="value">${nf.format(o.legit_both)}</div></div>
            <div class="tile"><div class="label">Règles seules</div><div class="value">${nf.format(o.legit_rules_only)}</div></div>
            <div class="tile"><div class="label">Modèle seul</div><div class="value">${nf.format(o.legit_model_only)}</div></div>
          </div>
        </section>
        ${chartCard({
          id: "m-hist", title: "Score d'anomalie : légitime contre fraude injectée",
          sub: `Variables métier. Chaque barre regroupe ${pct(1 / MT.score_hist.legit_share.length)} des lignes, des moins aux plus anormales, et chaque groupe est ramené à 100 %. ${pct(MT.score_hist.fraud_share.slice(-3).reduce((a, b) => a + b, 0))} des fraudes tombent dans les 10 % de scores les plus élevés, le reste se mêle aux lignes légitimes.`,
          legend: legendHtml([{ cls: "past", label: "Lignes légitimes" }, { cls: "ink", label: "Lignes frauduleuses" }]), height: 260,
          aria: "Histogrammes comparés du score d'anomalie",
          table: dataTable(["Score de", "à", "Légitime", "Fraude"], MT.score_hist.legit_share.map((v, i) => [nf2.format(MT.score_hist.edges[i]), nf2.format(MT.score_hist.edges[i + 1]), pct1(v), pct1(MT.score_hist.fraud_share[i])])),
        })}
      </div>

      <section class="card section" aria-labelledby="t-ex">
        <h2 id="t-ex">Les dix lignes les plus anormales selon le modèle</h2>
        <p class="sub">Le modèle donne un score, pas une raison. La colonne « le plus inhabituel » est une aide de lecture (la variable la plus éloignée de la médiane), pas une explication du modèle : c'est la limite principale pour un gestionnaire.</p>
        <div class="table-scroll"><table class="responsive">
          <thead><tr><th>Date</th><th>Acte</th><th class="num">Montant</th><th class="num">Score</th><th>Le plus inhabituel</th><th>Signalée par les règles</th><th>Vérité injectée</th></tr></thead>
          <tbody>${m.examples.map((e) => `<tr>
            <td data-label="Date">${dateLong(e.date)}</td><td data-label="Acte">${esc(e.act)}</td><td data-label="Montant" class="num">${eur.format(e.amount)}</td>
            <td data-label="Score" class="num">${nf2.format(e.score)}</td><td data-label="Le plus inhabituel">${esc(e.most_unusual)}</td>
            <td data-label="Signalée par les règles">${e.flagged_by_rules ? "oui" : "non"}</td><td data-label="Vérité injectée">${e.truth ? scenarioHtml(e.truth, truthLabel(e.truth)) : "Légitime"}</td></tr>`).join("")}</tbody></table></div>
      </section>

      <section class="callout honest section" aria-labelledby="t-why">
        <h2 id="t-why">Pourquoi les règles restent le système principal</h2>
        <ul>
          <li><strong>À charge égale, elles retrouvent plus.</strong> ${pct(R.recall)} des lignes frauduleuses contre ${pct(MT.at_budget.recall)} pour le meilleur modèle, avec une précision de ${pct(R.precision)} contre ${pct(MT.at_budget.precision)}.</li>
          <li><strong>Elles disent pourquoi.</strong> Chaque alerte a une raison, des lignes de preuve et une décision ; un score d'anomalie n'en a pas.</li>
          <li><strong>Le modèle dépend des variables.</strong> Sans variables métier, il retrouve surtout les soins chers et rares, pas la fraude.</li>
          <li><strong>Mais il a un rôle.</strong> Il voit ${nf.format(o.fraud_model_only)} fraudes qu'aucune règle ne voit : examiner ses lignes les plus anormales hors alertes est une bonne façon de découvrir de nouveaux scénarios, à transformer ensuite en règles.</li>
          <li><strong>Limite de cette comparaison.</strong> Le modèle est entraîné sur toute l'année d'un coup ; en production, on l'entraînerait sur le passé pour noter le présent. Les fraudes sont injectées : ces scores ne mesurent pas une performance réelle.</li>
        </ul>
      </section>`;

    makeChart(document.getElementById("c-m-recall"), {
      type: "bar",
      data: {
        labels: keys.map((k) => SHORT_SCEN[k]),
        datasets: series.map((s) => ({ label: s.label, data: keys.map((k) => s.at.recall_by_scenario[k]), backgroundColor: s.color, borderRadius: 3, borderSkipped: "start", maxBarThickness: 18, categoryPercentage: 0.8, barPercentage: 0.9 })),
      },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: false } },
          y: { min: 0, max: 1, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, border: { display: false } },
        },
        plugins: { tooltip: { callbacks: { title: (items) => `${keys[items[0].dataIndex]}. ${scenLabels[keys[items[0].dataIndex]]}`, label: (it) => `${it.dataset.label} : ${pct1(it.parsed.y)}` } } },
      },
    });

    makeChart(document.getElementById("c-m-pr"), {
      type: "scatter",
      data: {
        datasets: [
          { type: "line", label: "Variables métier", data: MT.pr.map((p) => ({ x: p.recall, y: p.precision, k: p.k })), borderColor: css("--alt"), backgroundColor: css("--alt"), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
          { type: "line", label: "Variables brutes", data: BR.pr.map((p) => ({ x: p.recall, y: p.precision, k: p.k })), borderColor: alpha(css("--text-3"), 0.9), backgroundColor: css("--text-3"), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
          { label: "Règles", data: [{ x: R.recall, y: R.precision, k: m.budget }], backgroundColor: css("--accent"), borderColor: css("--surface"), borderWidth: 2, pointRadius: 8, pointHoverRadius: 10 },
        ],
      },
      options: {
        interaction: { mode: "nearest", intersect: false },
        scales: {
          x: { min: 0, max: 1, title: { display: true, text: "Rappel" }, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, grid: { display: false } },
          y: { min: 0, max: 1, title: { display: true, text: "Précision" }, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, border: { display: false } },
        },
        plugins: {
          pointLabels: { items: [{ dataset: 2, index: 0, text: `Règles (${nf.format(m.budget)} lignes)` }] },
          tooltip: { callbacks: { title: (items) => `${nf.format(items[0].raw.k)} lignes signalées`, label: (it) => `${it.dataset.label} : précision ${pct1(it.parsed.y)}, rappel ${pct1(it.parsed.x)}` } },
        },
      },
    });

    const hist = MT.score_hist;
    makeChart(document.getElementById("c-m-hist"), {
      type: "bar",
      data: {
        labels: hist.legit_share.map((_, i) => `${Math.round((100 * i) / hist.legit_share.length)} %`),
        datasets: [
          { label: "Légitime", data: hist.legit_share, backgroundColor: alpha(css("--text-3"), 0.6), borderRadius: 2, borderSkipped: "start", categoryPercentage: 0.9, barPercentage: 0.9 },
          { label: "Fraude", data: hist.fraud_share, backgroundColor: css("--chart-ref"), borderRadius: 2, borderSkipped: "start", categoryPercentage: 0.9, barPercentage: 0.9 },
        ],
      },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, title: { display: true, text: "Centile du score d'anomalie, du plus normal au plus anormal" }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 10 } },
          y: { beginAtZero: true, ticks: { callback: (v) => pct(v) }, border: { display: false } },
        },
        plugins: { tooltip: { callbacks: { title: (items) => `Centiles ${Math.round((100 * items[0].dataIndex) / hist.legit_share.length)} à ${Math.round((100 * (items[0].dataIndex + 1)) / hist.legit_share.length)} (score ${nf2.format(hist.edges[items[0].dataIndex])} à ${nf2.format(hist.edges[items[0].dataIndex + 1])})`, label: (it) => `${it.dataset.label} : ${pct1(it.parsed.y)} du groupe` } } },
      },
    });
  }

  // ============================================================= EVALUATION
  async function renderEvaluation() {
    const gen = navGen;
    const e = await api("/api/evaluation");
    if (gen !== navGen) return; // the visitor has moved on: never draw over the newer view
    const o = e.overall;
    const curve = e.noise_curve;
    const causes = Object.entries(e.false_alert_causes);
    const causeTotal = causes.reduce((a, [, n]) => a + n, 0) || 1;
    view.innerHTML = `
      <div class="page-head"><div><h1>Évaluation</h1>
        <p>Les fraudes ont été injectées par le générateur : on connaît donc la vérité pour chaque ligne. Ces chiffres mesurent la capacité des règles à retrouver ces motifs injectés, pas leur performance sur de vraies fraudes.</p></div></div>
      <nav aria-label="Sections de la page"><ul class="toc">
        ${[["eval-synthese", "Synthèse"], ["eval-seuils", "Seuils et compromis"], ["eval-matrices", "Matrices de confusion"], ["eval-gain", "Courbe de gain"], ["eval-eco", "Bilan économique"], ["eval-bruit", "Robustesse au bruit"], ["eval-limites", "Ce qui ne marche pas"]]
          .map(([id, l]) => `<li><a href="#/evaluation" data-jump="${id}">${l}</a></li>`).join("")}
      </ul></nav>
      <section class="grid kpis" aria-label="Chiffres clés de l'évaluation">
        <div class="kpi"><div class="label">Rappel global</div><div class="value">${pct(o.recall_any)}</div><div class="hint">des ${nf.format(o.fraud_lines)} lignes frauduleuses sont signalées</div></div>
        <div class="kpi"><div class="label">Précision globale</div><div class="value">${pct(o.precision_any)}</div><div class="hint">des lignes signalées sont frauduleuses</div></div>
        <div class="kpi"><div class="label">Alertes par jour</div><div class="value">${nf1.format(o.alerts_per_day)}</div><div class="hint">charge de travail moyenne</div></div>
        <div class="kpi"><div class="label">Fausses alertes par jour</div><div class="value">${nf1.format(o.false_alerts_per_day)}</div><div class="hint">alertes sans aucune ligne frauduleuse</div></div>
        <div class="kpi"><div class="label">Montant frauduleux retrouvé</div><div class="value">${pct(o.caught_amount / Math.max(o.fraud_amount, 1))}</div><div class="hint">${eur0.format(o.caught_amount)} sur ${eur0.format(o.fraud_amount)}</div></div>
      </section>
      <section class="card" id="eval-synthese" aria-labelledby="t-per">
        <h2 id="t-per">Par scénario</h2>
        <p class="sub">Rappel : part des lignes injectées pour ce scénario que la règle signale. Précision : part des lignes signalées par la règle qui relèvent bien de ce scénario. Jeu actuel : bruit ${nf.format(e.dataset.noise_level)}.</p>
        <div class="table-scroll"><table class="responsive">
          <thead><tr><th>Scénario</th><th class="num">Lignes injectées</th><th class="num">Lignes signalées</th><th class="num">Rappel</th><th class="num">Précision</th><th class="num">Alertes / jour</th><th class="num">Fausses alertes / jour</th></tr></thead>
          <tbody>${e.per_scenario.map((s) => `<tr>
            <td data-label="Scénario">${scenarioHtml(s.scenario, `${s.scenario}. ${s.label}`)}</td>
            <td data-label="Lignes injectées" class="num">${nf.format(s.injected_lines)}</td>
            <td data-label="Lignes signalées" class="num">${nf.format(s.flagged_lines)}</td>
            <td data-label="Rappel" class="num">${pctCell(s.recall)}</td>
            <td data-label="Précision" class="num">${pctCell(s.precision)}</td>
            <td data-label="Alertes / jour" class="num">${nf1.format(s.alerts_per_day)}</td>
            <td data-label="Fausses alertes / jour" class="num">${nf1.format(s.false_alerts_per_day)}</td></tr>`).join("")}</tbody></table></div>
      </section>
      <div id="adv" class="section"><section class="card"><p class="loading">Chargement de l'évaluation détaillée…</p></section></div>
      <div class="grid two-col section" id="eval-bruit">
        <section class="card" aria-labelledby="t-noise">
          <h2 id="t-noise">Robustesse au bruit</h2>
          <p class="sub">Même graine, cinq niveaux de bruit : données légitimes plus irrégulières et fraudes plus discrètes. ${curve.status === "ready" ? `Calculé sur ${nf.format(curve.size)} lignes par niveau.` : ""}</p>
          <div id="noise-body">${curve.status === "ready" ? "" : `<p class="loading">Calcul des cinq niveaux en cours… la page se mettra à jour seule.</p>`}</div>
        </section>
        <section class="card" aria-labelledby="t-causes">
          <h2 id="t-causes">D'où viennent les fausses alertes ?</h2>
          <p class="sub">${nf.format(o.false_alerts)} alertes sans ligne frauduleuse, classées selon la particularité des lignes légitimes concernées.</p>
          <ul class="scenario-list">${causes.map(([k, n]) => `<li><span></span><span class="name" style="font-weight:500">${esc(k.charAt(0).toUpperCase() + k.slice(1))}</span><span class="count">${nf.format(n)}</span>
            <span class="bar-track" aria-hidden="true"><span class="bar-fill" style="display:block;width:${(100 * n) / causeTotal}%;background:var(--text-3)"></span></span></li>`).join("")}</ul>
        </section>
      </div>
      <section class="card section" aria-labelledby="t-fa">
        <h2 id="t-fa">Alertes justes et fausses alertes par semaine</h2>
        <p class="sub">Une alerte est « fausse » quand aucune des lignes qu'elle vise n'est frauduleuse.</p>
        ${legendHtml([{ cls: "s1", label: "Alertes justes" }, { cls: "s2", label: "Fausses alertes" }])}
        <div class="chart-wrap short"><canvas id="c-fa" role="img" aria-label="Histogramme empilé des alertes justes et fausses par semaine"></canvas></div>
      </section>
      <section class="callout section" id="eval-limites" aria-labelledby="t-ko">
        <h2 id="t-ko">Ce qui ne marche pas</h2>
        <ul>
          <li><strong>Prix gonflé.</strong> Le seuil « 2 fois le prix habituel » laisse passer les surfacturations modestes (+30 à +80 %) et signale les soins complexes légitimement plus chers. Le prix habituel est une médiane globale par acte : il ignore les écarts normaux entre régions ou cabinets. En janvier, les actes rares n'ont pas encore 20 factures antérieures : aucune référence, donc aucune alerte.</li>
          <li><strong>Doublon ou fractionnement.</strong> Deux soins identiques et légitimes le même jour (deux caries) ressemblent à un doublon. Un doublon facturé plus d'un jour après l'original passe inaperçu.</li>
          <li><strong>Multiplication des prestataires.</strong> « Nouveau prestataire » se juge sur l'historique disponible : en début d'année, tout le monde paraît nouveau. Un fraudeur qui étale ses visites sur plus de 14 jours, ou qui se limite à deux médecins, n'est pas vu.</li>
          <li><strong>Incohérence diagnostic / acte.</strong> La règle dépend de la qualité du codage : une erreur de saisie honnête déclenche une alerte, et un fraudeur qui choisit un diagnostic plausible passe.</li>
          <li><strong>Sinistre précoce.</strong> La règle ne distingue pas la fraude de l'anti-sélection légitime (adhérer parce qu'on a besoin de soins). Attendre 31 jours suffit pour passer sous le seuil.</li>
          <li><strong>Seuils.</strong> Ils ont été choisis à la main sur ces mêmes données. La courbe précision-rappel suggère par exemple ×1,8 plutôt que ×2 pour le prix, mais adopter ce seuil ici serait du surapprentissage : il faudrait le choisir sur une période et le valider sur la suivante.</li>
          <li><strong>Ordre de la file.</strong> La sévérité trie bien la justesse des alertes, mais pas les montants : trier par sévérité fait traiter d'abord des alertes justes mais peu coûteuses (voir la courbe de gain).</li>
          <li><strong>En général.</strong> Les cinq règles sont indépendantes : pas de score combiné, pas d'analyse des liens entre adhérents et prestataires, pas d'apprentissage à partir des décisions des gestionnaires.</li>
        </ul>
      </section>`;

    // false alerts per week
    const weekly = aggregateWeekly(e.per_day, ["alerts", "false_alerts"]).map((r) => ({ ...r, true_alerts: r.alerts - r.false_alerts }));
    makeChart(document.getElementById("c-fa"), {
      type: "bar",
      data: {
        labels: weekly.map((r) => r.date),
        datasets: [
          { label: "Alertes justes", data: weekly.map((r) => r.true_alerts), backgroundColor: seriesColor(1), borderColor: css("--surface"), borderWidth: { top: 1 }, borderSkipped: false, stack: "a", barPercentage: 0.85, categoryPercentage: 0.9 },
          { label: "Fausses alertes", data: weekly.map((r) => r.false_alerts), backgroundColor: seriesColor(2), borderColor: css("--surface"), borderWidth: { top: 1 }, borderSkipped: false, stack: "a", barPercentage: 0.85, categoryPercentage: 0.9 },
        ],
      },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, maxTicksLimit: 8, callback(v) { return dateShort(this.getLabelForValue(v)); } } },
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, border: { display: false } },
        },
        plugins: { tooltip: { callbacks: { title: (items) => `Semaine du ${dateLong(items[0].label)}` } } },
      },
    });

    view.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const target = document.getElementById(a.dataset.jump);
      if (target) { target.scrollIntoView({ behavior: "smooth", block: "start" }); target.setAttribute("tabindex", "-1"); target.focus({ preventScroll: true }); }
    }));
    loadAdvanced();
    if (curve.status === "ready") renderNoise(curve, e.dataset);
    else if (curve.status === "computing") pollTimer = setTimeout(() => { if (parseHash().parts[0] === "evaluation") route(); }, 2500);
    else document.getElementById("noise-body").innerHTML = `<p class="error">Le calcul de la courbe a échoué.</p>`;
  }

  // ----------------------------------------------------- advanced evaluation
  const pointLabelPlugin = {
    id: "pointLabels",
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts || !opts.items || !opts.items.length) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = `600 11px ${css("--font")}`;
      ctx.textBaseline = "middle";
      for (const it of opts.items) {
        const el = chart.getDatasetMeta(it.dataset ?? 0).data[it.index];
        if (!el) continue;
        const { x, y } = el.getProps(["x", "y"], true);
        const tw = ctx.measureText(it.text).width;
        let tx = x + 9;
        if (tx + tw > chartArea.right) tx = x - 9 - tw;
        let ty = y + (it.below ? 13 : -13);
        ty = Math.min(Math.max(ty, chartArea.top + 8), chartArea.bottom - 8);
        ctx.fillStyle = css("--surface");
        ctx.fillRect(tx - 2, ty - 8, tw + 4, 16);
        ctx.fillStyle = css(it.muted ? "--text-2" : "--text");
        ctx.fillText(it.text, tx, ty);
      }
      ctx.restore();
    },
  };

  const fmtThreshold = (sw, v) => (sw.unit === "×" ? `×${nf.format(v)}` : sw.unit === "€" ? eur0.format(v) : sw.unit === "j" ? `${nf.format(v)} j` : nf.format(v));

  async function loadAdvanced() {
    const box = document.getElementById("adv");
    if (!box) return;
    const gen = navGen;
    let adv;
    try { adv = await api("/api/evaluation/advanced"); } catch (e) {
      box.innerHTML = `<section class="card"><p class="error">${esc(e.message)}</p></section>`;
      return;
    }
    if (gen !== navGen || !document.contains(box)) return; // user left or the view was redrawn
    if (adv.status === "computing") {
      box.innerHTML = `<section class="card"><p class="loading">Calcul des courbes par seuil en cours (chaque règle est relancée avec plusieurs seuils)… la section s'affichera seule.</p></section>`;
      advTimer = setTimeout(loadAdvanced, 2000);
      return;
    }
    if (adv.status !== "ready") {
      box.innerHTML = `<section class="card"><p class="error">Le calcul de l'évaluation détaillée a échoué.</p></section>`;
      return;
    }
    renderAdvanced(adv);
    checkCharts();
  }

  function interpAt(points, k) {
    let prev = points[0];
    for (const p of points) {
      if (p.k === k) return p.y;
      if (p.k > k) return prev.y + ((p.y - prev.y) * (k - prev.k)) / Math.max(p.k - prev.k, 1);
      prev = p;
    }
    return prev.y;
  }

  function renderAdvanced(adv) {
    registerPlugins();
    const box = document.getElementById("adv");
    const sweeps = adv.sweeps;
    const cm = adv.confusion;
    const gain = adv.gain;
    const eco = adv.economics;
    const ecoOrders = [
      { key: "amount", label: "Montant décroissant", cls: "alt" },
      { key: "severity_amount", label: "Sévérité, puis montant", cls: "acc" },
      { key: "chronological", label: "Ordre d'arrivée", cls: "past" },
    ];
    const sevLabel = { haute: "Haute", moyenne: "Moyenne", faible: "Faible" };
    const ruleCols = cm.per_rule.map((r) => r.scenario);
    const cellStyle = (share) => {
      // Two bands keep every number readable (WCAG AA): light cells with dark text up to half,
      // then strong cells with light text. The jump marks "the rule catches most of this scenario".
      const v = Math.min(1, share);
      const pctv = Math.round(v <= 0.5 ? v * 120 : 88 + (v - 0.5) * 24);
      return `background:color-mix(in srgb, var(--accent) ${pctv}%, var(--surface));color:${share > 0.5 ? "var(--accent-ink)" : "var(--text)"}`;
    };
    const heatRows = cm.matrix.map((r) => {
      const cells = ruleCols.map((s) => {
        const n = r.by_rule[String(s)];
        const share = r.lines ? n / r.lines : 0;
        const diag = r.true_scenario === s;
        return `<td class="cell" style="${cellStyle(share)}${diag ? ";box-shadow:inset 0 0 0 2px var(--text)" : ""}">${nf.format(n)}<span>${pct1(share)}</span></td>`;
      }).join("");
      const noneShare = r.lines ? r.none / r.lines : 0;
      return `<tr><th scope="row" class="rowh">${r.true_scenario ? scenarioHtml(r.true_scenario, r.label) : esc(r.label)}</th><td class="num">${nf.format(r.lines)}</td>${cells}
        <td class="cell" style="${cellStyle(r.true_scenario === 0 ? 0 : noneShare)}">${nf.format(r.none)}<span>${pct1(noneShare)}</span></td></tr>`;
    }).join("");

    const capSteps = [0.25, 0.5, 1, 1.5, 2, 2.5];
    const strategies = [
      { key: "oracle", label: "Ordre idéal (borne haute)", cls: "ref-dash" },
      { key: "amount", label: "Montant décroissant", cls: "alt" },
      { key: "severity_amount", label: "Sévérité, puis montant", cls: "acc" },
      { key: "chronological", label: "Ordre d'arrivée", cls: "past" },
    ];

    box.innerHTML = `
      <section class="card" id="eval-seuils" aria-labelledby="t-pr">
        <h2 id="t-pr">Compromis précision-rappel selon le seuil</h2>
        <p class="sub">Chaque règle est relancée avec d'autres valeurs de son seuil principal. Chaque point est un seuil : à droite, on retrouve plus de fraudes ; en haut, les lignes signalées sont plus souvent frauduleuses. Le point cerclé est le seuil actuel.</p>
        <div class="panel-grid">${sweeps.map((sw) => {
          const cur = sw.points.find((p) => p.is_current);
          const best = sw.points.find((p) => p.threshold === sw.best_f1_threshold);
          return `<div class="panel">
            <h4>${scenarioHtml(sw.scenario, `${sw.scenario}. ${sw.label}`)}</h4>
            <p class="sub">${esc(sw.param_label)}. Actuel ${esc(fmtThreshold(sw, sw.current))} : précision ${pct(cur.precision)}, rappel ${pct(cur.recall)}, ${nf1.format(cur.alerts_per_day)} alerte/jour.
            ${best.threshold !== sw.current ? `Meilleur F1 à ${esc(fmtThreshold(sw, best.threshold))} (précision ${pct(best.precision)}, rappel ${pct(best.recall)}).` : "C'est aussi le meilleur F1 testé."}</p>
            <div class="chart-wrap" style="height:220px"><canvas id="c-pr-${sw.scenario}" role="img" aria-label="Courbe précision-rappel selon le seuil, scénario ${sw.scenario}"></canvas></div>
          </div>`;
        }).join("")}</div>
        ${dataTable(["Scénario", "Seuil", "Précision", "Rappel", "F1", "Alertes / jour", "Fausses alertes / jour"],
          sweeps.flatMap((sw) => sw.points.map((p) => [`${sw.scenario}. ${sw.label}${p.is_current ? " (actuel)" : ""}`, fmtThreshold(sw, p.threshold), pct1(p.precision), pct1(p.recall), pct1(p.f1), nf1.format(p.alerts_per_day), nf1.format(p.false_alerts_per_day)])))}
      </section>

      <section class="card section" id="eval-matrices" aria-labelledby="t-cm">
        <h2 id="t-cm">Quelle règle attrape quelle fraude ?</h2>
        <p class="sub">Lignes de chaque scénario injecté (en ligne) signalées par chaque règle (en colonne). Une ligne peut être signalée par plusieurs règles. Pourcentage de la ligne du tableau ; la diagonale encadrée est la règle prévue pour ce scénario.</p>
        <div class="table-scroll"><table class="heat">
          <thead><tr><th>Vérité injectée</th><th class="num">Lignes</th>${cm.per_rule.map((r) => `<th class="num">Règle ${r.scenario}</th>`).join("")}<th class="num">Aucune règle</th></tr></thead>
          <tbody>${heatRows}</tbody></table></div>
        <p class="sub" style="margin-top:10px">Ligne « Légitime » : lignes saines signalées à tort par chaque règle. Colonne « Aucune règle » : fraudes qui passent entre les mailles.</p>
      </section>

      <section class="card section" aria-labelledby="t-cm2">
        <h2 id="t-cm2">Matrice de confusion de chaque règle</h2>
        <p class="sub">Au niveau des lignes de soins. « Positif » : la ligne relève du scénario de la règle. Les faux positifs comprennent les fraudes d'un autre scénario.</p>
        <div class="panel-grid">${cm.per_rule.map((r) => `
          <div class="panel">
            <h4>${scenarioHtml(r.scenario, `Règle ${r.scenario}. ${r.label}`)}</h4>
            <div class="cm" role="table" aria-label="Matrice de confusion de la règle ${r.scenario}">
              <div class="h" role="columnheader"></div><div class="h" role="columnheader">Signalée</div><div class="h" role="columnheader">Non signalée</div>
              <div class="rh" role="rowheader">Fraude ${r.scenario}</div>
              <div class="v good" role="cell">Vrais positifs<strong>${nf.format(r.tp)}</strong></div>
              <div class="v bad" role="cell">Faux négatifs<strong>${nf.format(r.fn)}</strong></div>
              <div class="rh" role="rowheader">Autre ligne</div>
              <div class="v bad" role="cell">Faux positifs<strong>${nf.format(r.fp)}</strong></div>
              <div class="v" role="cell">Vrais négatifs<strong>${nf.format(r.tn)}</strong></div>
            </div>
            <p class="metrics"><span>Précision <b>${pct1(r.precision)}</b></span><span>Rappel <b>${pct1(r.recall)}</b></span><span>F1 <b>${pct1(r.f1)}</b></span><span>Spécificité <b>${pct1(r.specificity)}</b></span></p>
            ${r.fp_other_fraud ? `<p class="sub" style="margin:6px 0 0">Dont ${nf.format(r.fp_other_fraud)} faux positif${r.fp_other_fraud > 1 ? "s" : ""} qui ${r.fp_other_fraud > 1 ? "sont" : "est"} une fraude d'un autre scénario.</p>` : ""}
          </div>`).join("")}</div>
      </section>

      <div class="grid two-col section" id="eval-gain">
        <section class="card" aria-labelledby="t-gain">
          <div class="card-head">
            <div><h2 id="t-gain">Courbe de gain : combien de fraude pour N alertes traitées ?</h2>
            <p class="sub">Le gestionnaire traite les ${nf.format(gain.alerts)} alertes de l'année dans un certain ordre. La courbe donne la part de la fraude injectée retrouvée après N alertes. L'ordre idéal traite d'abord les alertes qui contiennent le plus de fraude : il suppose de connaître la vérité et sert de repère.</p></div>
            <div class="segmented" role="group" aria-label="Mesure"><button type="button" data-gm="amount" aria-pressed="true">Montant</button><button type="button" data-gm="lines" aria-pressed="false">Lignes</button></div>
          </div>
          <div class="capacity">
            <label for="cap">Capacité : <strong id="cap-val"></strong></label>
            <input id="cap" type="range" min="0" max="${capSteps.length - 1}" step="1" value="2">
          </div>
          ${legendHtml(strategies.map((x) => ({ cls: x.cls, label: x.label })))}
          <div class="chart-wrap" style="height:300px"><canvas id="c-gain" role="img" aria-label="Courbes de gain cumulé selon l'ordre de traitement des alertes"></canvas></div>
          <p id="gain-read" class="sub" style="margin-top:10px"></p>
          <div id="gain-table"></div>
        </section>
        <section class="card" aria-labelledby="t-sev">
          <h2 id="t-sev">Les alertes «&nbsp;haute&nbsp;» sont-elles plus souvent justes&nbsp;?</h2>
          <p class="sub">Part des alertes qui visent au moins une ligne frauduleuse, par niveau de sévérité.</p>
          <div class="chart-wrap" style="height:300px"><canvas id="c-sev" role="img" aria-label="Part des alertes justes par niveau de sévérité"></canvas></div>
          <p class="sub" style="margin-top:10px">${pct(adv.severity[0].share_true)} des alertes «&nbsp;haute&nbsp;» sont justes, contre ${pct(adv.severity[2].share_true)} des «&nbsp;faible&nbsp;»&nbsp;: la sévérité classe bien la fiabilité de l'alerte. Elle ne classe pas les montants, d'où l'écart sur la courbe de gain.</p>
          ${dataTable(["Sévérité", "Alertes", "Justes", "Part"], adv.severity.map((x) => [sevLabel[x.severity], nf.format(x.alerts), nf.format(x.true_alerts), pct1(x.share_true)]))}
        </section>
      </div>
      ${eco ? `<section class="card section" id="eval-eco" aria-labelledby="t-eco">
        <h2 id="t-eco">Bilan économique : combien d'alertes faut-il traiter ?</h2>
        <p class="sub">Gain net de l'enquête = montants frauduleux récupérés − coût de traitement des alertes, selon le nombre d'alertes traitées dans l'ordre choisi. Sur l'année, la fraude injectée pèse ${eur0.format(eco.fraud_total)}. Les deux hypothèses ci-dessous sont illustratives : réglez-les.</p>
        <div class="eco-controls">
          <div class="slider-block"><label for="eco-cost">Coût de traitement d'une alerte : <strong id="eco-cost-val"></strong></label>
            <input id="eco-cost" type="range" min="5" max="150" step="5" value="${eco.defaults.cost_per_alert}"></div>
          <div class="slider-block"><label for="eco-rate">Part des montants frauduleux récupérée : <strong id="eco-rate-val"></strong></label>
            <input id="eco-rate" type="range" min="0.3" max="1" step="0.05" value="${eco.defaults.recovery_rate}"></div>
        </div>
        <div class="tiles eco-tiles" id="eco-tiles"></div>
        ${legendHtml(ecoOrders.map((x) => ({ cls: x.cls, label: x.label })))}
        <div class="chart-wrap" style="height:320px"><canvas id="c-eco" role="img" aria-label="Gain net selon le nombre d'alertes traitées, pour chaque ordre de traitement"></canvas></div>
        <p id="eco-read" class="sub" style="margin-top:10px"></p>
        <div id="eco-table"></div>
      </section>` : ""}`;

    // precision-recall panels
    for (const sw of sweeps) {
      const color = seriesColor(sw.scenario);
      const pts = sw.points.filter((p) => p.precision !== null);
      const curIdx = pts.findIndex((p) => p.is_current);
      const bestIdx = pts.findIndex((p) => p.threshold === sw.best_f1_threshold);
      const labels = [{ index: curIdx, text: `actuel ${fmtThreshold(sw, sw.current)}` }];
      if (bestIdx !== curIdx && bestIdx >= 0) labels.push({ index: bestIdx, text: `F1 max ${fmtThreshold(sw, sw.best_f1_threshold)}`, below: true, muted: true });
      [0, pts.length - 1].forEach((i) => { if (i !== curIdx && i !== bestIdx) labels.push({ index: i, text: fmtThreshold(sw, pts[i].threshold), muted: true, below: i === 0 }); });
      makeChart(document.getElementById(`c-pr-${sw.scenario}`), {
        type: "scatter",
        data: {
          datasets: [{
            label: sw.label, data: pts.map((p) => ({ x: p.recall, y: p.precision, p })), showLine: true, clip: 12,
            borderColor: color, backgroundColor: color, borderWidth: 2,
            pointRadius: pts.map((_, i) => (i === curIdx ? 7 : 4)), pointHoverRadius: 8,
            pointBorderColor: pts.map((_, i) => (i === curIdx ? css("--text") : css("--surface"))), pointBorderWidth: pts.map((_, i) => (i === curIdx ? 2.5 : 2)),
          }],
        },
        options: {
          layout: { padding: { right: 10, top: 8 } },
          scales: {
            x: { min: 0, max: 1, title: { display: true, text: "Rappel" }, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, grid: { color: css("--grid") } },
            y: { min: 0, max: 1, title: { display: true, text: "Précision" }, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, border: { display: false } },
          },
          plugins: {
            pointLabels: { items: labels },
            tooltip: {
              callbacks: {
                title: (items) => `Seuil ${fmtThreshold(sw, items[0].raw.p.threshold)}${items[0].raw.p.is_current ? " (actuel)" : ""}`,
                label: (it) => {
                  const p = it.raw.p;
                  return [`Précision ${pct1(p.precision)}, rappel ${pct1(p.recall)}`, `F1 ${pct1(p.f1)}`, `${nf1.format(p.alerts_per_day)} alertes/jour, dont ${nf1.format(p.false_alerts_per_day)} fausses`];
                },
              },
            },
          },
        },
      });
    }

    // severity calibration
    makeChart(document.getElementById("c-sev"), {
      type: "bar",
      data: { labels: adv.severity.map((x) => sevLabel[x.severity]), datasets: [{ label: "Alertes justes", data: adv.severity.map((x) => x.share_true), backgroundColor: css("--accent"), borderRadius: 4, borderSkipped: "start", maxBarThickness: 48 }] },
      options: {
        scales: { x: { grid: { display: false } }, y: { min: 0, max: 1, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, border: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (it) => { const x = adv.severity[it.dataIndex]; return `${pct1(x.share_true)} justes (${nf.format(x.true_alerts)} sur ${nf.format(x.alerts)})`; } } } },
      },
    });

    // gain curve
    let metric = "amount";
    let capIdx = 2;
    let gainChart = null;
    const colorOf = { oracle: css("--chart-ref"), amount: css("--alt"), severity_amount: css("--accent"), chronological: css("--text-3") };
    const drawGain = () => {
      const capacity = Math.min(gain.alerts, Math.round(capSteps[capIdx] * gain.days));
      document.getElementById("cap-val").textContent = `${nf.format(capSteps[capIdx])} alerte${capSteps[capIdx] > 1 ? "s" : ""} par jour (${nf.format(capacity)} sur l'année)`;
      const at = Object.fromEntries(strategies.map((x) => [x.key, interpAt(gain.curves[x.key][metric], capacity)]));
      const unit = metric === "amount" ? "des euros frauduleux" : "des lignes frauduleuses";
      document.getElementById("gain-read").textContent = `Avec ${nf.format(capacity)} alertes traitées : tri par montant ${pct(at.amount)} ${unit}, sévérité puis montant ${pct(at.severity_amount)}, ordre d'arrivée ${pct(at.chronological)}. L'ordre idéal en retrouverait ${pct(at.oracle)}.`;
      document.getElementById("gain-table").innerHTML = dataTable(["Ordre de traitement", `Retrouvé à ${nf.format(capacity)} alertes`, `Retrouvé après les ${nf.format(gain.alerts)} alertes`],
        strategies.map((x) => [x.label, pct1(at[x.key]), pct1(gain.curves[x.key][metric].at(-1).y)]));
      if (gainChart) { gainChart.destroy(); charts = charts.filter((c) => c !== gainChart); }
      gainChart = makeChart(document.getElementById("c-gain"), {
        type: "line",
        data: {
          datasets: strategies.map((x) => ({
            label: x.label, data: gain.curves[x.key][metric].map((p) => ({ x: p.k, y: p.y })),
            borderColor: colorOf[x.key], backgroundColor: colorOf[x.key], borderWidth: x.key === "oracle" ? 1.5 : 2,
            borderDash: x.key === "oracle" ? [5, 4] : [], pointRadius: 0, pointHoverRadius: 4, tension: 0,
          })),
        },
        options: {
          interaction: { mode: "nearest", axis: "x", intersect: false },
          scales: {
            x: { type: "linear", min: 0, max: gain.alerts, title: { display: true, text: "Alertes traitées, dans l'ordre choisi" }, grid: { display: false }, ticks: { precision: 0 } },
            y: { min: 0, max: 1, title: { display: true, text: metric === "amount" ? "Part du montant frauduleux retrouvé" : "Part des lignes frauduleuses retrouvées" }, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, border: { display: false } },
          },
          plugins: {
            refLine: { lines: [{ value: capacity, label: `Capacité ${nf.format(capacity)}` }] },
            tooltip: { callbacks: { title: (items) => `${nf.format(Math.round(items[0].parsed.x))} alertes traitées`, label: (it) => `${it.dataset.label} : ${pct1(it.parsed.y)}` } },
          },
        },
      });
    };
    drawGain();
    document.getElementById("cap").addEventListener("input", (ev) => { capIdx = Number(ev.target.value); drawGain(); });

    // economic view: net value of handling the first k alerts, under two adjustable assumptions
    if (eco) {
      const ecoColor = { amount: css("--alt"), severity_amount: css("--accent"), chronological: css("--text-3") };
      let ecoChart = null;
      const drawEco = () => {
        const cost = Number(document.getElementById("eco-cost").value);
        const rate = Number(document.getElementById("eco-rate").value);
        document.getElementById("eco-cost-val").textContent = eur0.format(cost);
        document.getElementById("eco-rate-val").textContent = pct(rate);
        const res = Object.fromEntries(ecoOrders.map((o) => {
          const cum = eco.cum_fraud_eur[o.key];
          const net = cum.map((f, k) => rate * f - cost * k);
          let k = 0;
          net.forEach((v, i) => { if (v > net[k]) k = i; });
          return [o.key, { net, k, best: net[k], all: net[net.length - 1], missed: eco.fraud_total - cum[k], spent: cost * k }];
        }));
        const A = res.amount;
        document.getElementById("eco-tiles").innerHTML = [
          ["Gain net maximal", eur0.format(A.best), `en traitant les ${nf.format(A.k)} alertes les plus coûteuses`],
          ["Si l'on traite tout", eur0.format(A.all), `${nf.format(eco.alerts)} alertes, soit ${eur0.format(A.best - A.all)} de moins`],
          ["Coût des enquêtes", eur0.format(A.spent), `${nf.format(A.k)} alertes × ${eur0.format(cost)}`],
          ["Fraude restant à charge", eur0.format(A.missed), `${pct(A.missed / Math.max(eco.fraud_total, 1))} de la fraude injectée`],
        ].map(([l, v, h]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="hint">${h}</div></div>`).join("");
        document.getElementById("eco-read").textContent = A.k === 0
          ? "Avec ces hypothèses, aucune enquête ne rapporte plus qu'elle ne coûte."
          : `Au-delà de ${nf.format(A.k)} alertes (tri par montant), chaque alerte de plus coûte plus qu'elle ne rapporte. Par sévérité, l'optimum est à ${nf.format(res.severity_amount.k)} alertes pour ${eur0.format(res.severity_amount.best)} ; dans l'ordre d'arrivée, ${eur0.format(res.chronological.best)}.`;
        document.getElementById("eco-table").innerHTML = dataTable(["Ordre de traitement", "Alertes à traiter", "Gain net maximal", "Gain net si tout est traité"],
          ecoOrders.map((o) => [o.label, nf.format(res[o.key].k), eur0.format(res[o.key].best), eur0.format(res[o.key].all)]));
        const step = Math.max(1, Math.floor(eco.alerts / 300));
        if (ecoChart) { ecoChart.destroy(); charts = charts.filter((c) => c !== ecoChart); }
        ecoChart = makeChart(document.getElementById("c-eco"), {
          type: "line",
          data: {
            datasets: ecoOrders.map((o) => ({
              label: o.label,
              data: res[o.key].net.map((y, x) => ({ x, y })).filter((p) => p.x % step === 0 || p.x === res[o.key].k || p.x === eco.alerts),
              borderColor: ecoColor[o.key], backgroundColor: ecoColor[o.key], borderWidth: 2, tension: 0,
              pointRadius: (ctx) => (ctx.raw && ctx.raw.x === res[o.key].k ? 5 : 0), pointHoverRadius: 4,
            })),
          },
          options: {
            interaction: { mode: "nearest", axis: "x", intersect: false },
            scales: {
              x: { type: "linear", min: 0, max: eco.alerts, title: { display: true, text: "Alertes traitées, dans l'ordre choisi" }, grid: { display: false }, ticks: { precision: 0 } },
              y: { title: { display: true, text: "Gain net (€)" }, ticks: { callback: (v) => eur0.format(v) }, border: { display: false } },
            },
            plugins: {
              refLine: { lines: [{ value: A.k, label: `Optimum ${nf.format(A.k)}` }] },
              tooltip: { callbacks: { title: (items) => `${nf.format(items[0].parsed.x)} alertes traitées`, label: (it) => `${it.dataset.label} : ${eur0.format(it.parsed.y)}` } },
            },
          },
        });
      };
      drawEco();
      ["eco-cost", "eco-rate"].forEach((id) => document.getElementById(id).addEventListener("input", drawEco));
    }
    box.querySelectorAll("[data-gm]").forEach((b) => b.addEventListener("click", () => {
      metric = b.dataset.gm;
      box.querySelectorAll("[data-gm]").forEach((y) => y.setAttribute("aria-pressed", String(y === b)));
      drawGain();
    }));
  }

  function pctCell(v) {
    if (v === null || v === undefined) return "—";
    return `<span class="pct-cell"><span class="pct-bar" aria-hidden="true"><span style="width:${Math.round(v * 100)}%"></span></span>${pct(v)}</span>`;
  }

  function renderNoise(curve, dataset) {
    const levels = curve.levels;
    const body = document.getElementById("noise-body");
    const nearest = levels.reduce((best, l, i) => (Math.abs(l.noise_level - dataset.noise_level) < Math.abs(levels[best].noise_level - dataset.noise_level) ? i : best), 0);
    let metric = "recall";
    let idx = nearest;
    const scen = levels[0].per_scenario.map((s) => ({ n: s.scenario, label: s.label }));
    body.innerHTML = `
      <div class="slider-row">
        <div class="slider-block">
          <label for="noise">Niveau de bruit : <span class="slider-value" id="noise-val"></span></label>
          <input id="noise" type="range" min="0" max="${levels.length - 1}" step="1" value="${idx}" aria-describedby="noise-help">
          <div class="ticks" aria-hidden="true">${levels.map((l) => `<span>${nf.format(l.noise_level)}</span>`).join("")}</div>
        </div>
        <div class="segmented" role="group" aria-label="Mesure affichée">
          <button type="button" data-metric="recall" aria-pressed="true">Rappel</button>
          <button type="button" data-metric="precision" aria-pressed="false">Précision</button>
        </div>
      </div>
      <p class="sub" id="noise-help">Déplacez le curseur : le tableau montre les scores à ce niveau, la courbe les relie tous.</p>
      ${legendHtml(scen.map((s) => ({ cls: `s${s.n}`, label: s.label })))}
      <div class="chart-wrap short"><canvas id="c-noise" role="img" aria-label="Courbes du rappel ou de la précision de chaque scénario selon le niveau de bruit"></canvas></div>
      <div class="table-scroll section" id="noise-table"></div>
      ${dataset.read_only ? "" : `<p style="margin-top:12px"><button class="btn" type="button" id="noise-regen">Régénérer le jeu de données à ce niveau de bruit</button></p>
      <p class="status-line" id="noise-status" role="status"></p>`}`;

    const chart = makeChart(document.getElementById("c-noise"), {
      type: "line",
      data: { labels: levels.map((l) => nf.format(l.noise_level)), datasets: [] },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { title: { display: true, text: "Niveau de bruit" }, grid: { display: false } },
          y: { min: 0, max: 1, ticks: { callback: (v) => pct(v), stepSize: 0.25 }, border: { display: false } },
        },
        plugins: { tooltip: { callbacks: { title: (items) => `Bruit ${items[0].label}`, label: (it) => `${it.dataset.label} : ${pct(it.parsed.y)}` } } },
      },
    });
    const update = () => {
      document.getElementById("noise-val").textContent = nf.format(levels[idx].noise_level);
      if (chart) {
        chart.data.datasets = scen.map((s, i) => ({
          label: s.label,
          data: levels.map((l) => l.per_scenario[i][metric]),
          borderColor: seriesColor(s.n), backgroundColor: seriesColor(s.n), borderWidth: 2,
          pointRadius: levels.map((_, j) => (j === idx ? 7 : 3)), pointBorderColor: css("--surface"), pointBorderWidth: 2, tension: 0,
        }));
        chart.update();
      }
      const l = levels[idx];
      document.getElementById("noise-table").innerHTML = `<table class="responsive"><caption>Scores au niveau de bruit ${nf.format(l.noise_level)}</caption>
        <thead><tr><th>Scénario</th><th class="num">Rappel</th><th class="num">Précision</th><th class="num">Fausses alertes / jour</th></tr></thead>
        <tbody>${l.per_scenario.map((s) => `<tr><td data-label="Scénario">${scenarioHtml(s.scenario, s.label)}</td><td data-label="Rappel" class="num">${pctCell(s.recall)}</td><td data-label="Précision" class="num">${pctCell(s.precision)}</td><td data-label="Fausses alertes / jour" class="num">${nf1.format(s.false_alerts_per_day)}</td></tr>`).join("")}
        <tr><td data-label="Scénario"><strong>Toutes règles</strong></td><td data-label="Rappel" class="num">${pctCell(l.overall.recall_any)}</td><td data-label="Précision" class="num">${pctCell(l.overall.precision_any)}</td><td data-label="Fausses alertes / jour" class="num">${nf1.format(l.overall.false_alerts_per_day)}</td></tr></tbody></table>`;
    };
    document.getElementById("noise").addEventListener("input", (ev) => { idx = Number(ev.target.value); update(); });
    body.querySelectorAll("[data-metric]").forEach((b) => b.addEventListener("click", () => {
      metric = b.dataset.metric;
      body.querySelectorAll("[data-metric]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      update();
    }));
    document.getElementById("noise-regen")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      const status = document.getElementById("noise-status");
      btn.disabled = true;
      status.classList.remove("error");
      status.textContent = "Génération en cours…";
      try {
        await api("/api/regenerate", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seed: dataset.seed, size: dataset.size, noise_level: levels[idx].noise_level }) });
        route();
      } catch (e) {
        status.classList.add("error");
        status.textContent = e.message;
        btn.disabled = false;
      }
    });
    update();
  }


  // ---------------------------------------------------------- « Lecture IA »
  // Each chart that has a commentary gets a « Lecture IA » button next to its title. The text comes
  // from /api/explain: today a static provider (written from the chart's own numbers, then reviewed);
  // later, a server-side LLM. Either way every number shown is listed under « Chiffres utilisés ».
  const AI_VIEWS = new Set(["overview", "exploration", "providers", "evaluation", "model"]);
  const AI_ALIAS = { evaluation: { sev: "sevcal" }, model: { ov: "m-overlap" } };
  const aiPanel = document.getElementById("ai-panel");
  const aiTitle = document.getElementById("ai-title");
  const aiBody = document.getElementById("ai-body");
  let aiOpener = null;

  async function loadExplain(key) {
    if (!explainCache || (key && !explainCache.items[key])) explainCache = await api("/api/explain");
    return explainCache;
  }
  function aiKey(headingId) {
    const id = headingId.replace(/^t-/, "");
    return (AI_ALIAS[currentView] || {})[id] || id;
  }
  function highlightFacts(text, facts) {
    let html = esc(text);
    const list = [...new Set(facts.map(esc))].sort((a, b) => b.length - a.length);
    if (!list.length) return html;
    const rx = new RegExp(`(?<![\\d,.])(${list.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\d,])`, "g");
    return html.replace(rx, '<mark class="fact">$1</mark>');
  }
  async function openExplain(key, opener) {
    aiOpener = opener;
    aiTitle.textContent = opener?.dataset.title || "Lecture IA";
    aiBody.innerHTML = `<p class="ai-thinking"><span></span><span></span><span></span> Lecture du graphique…</p>`;
    closeChat(false);
    aiPanel.hidden = false;
    document.body.classList.add("ai-open");
    requestAnimationFrame(() => aiPanel.classList.add("show"));
    document.querySelectorAll(".ai-btn[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
    opener?.setAttribute("aria-expanded", "true");
    document.getElementById("ai-close").focus();
    try {
      const data = await loadExplain(key);
      const it = data.items[key];
      if (!it) { aiBody.innerHTML = `<p class="sub">Pas encore de commentaire pour ce graphique.</p>`; return; }
      aiTitle.textContent = it.title;
      const block = (cls, label, text) => `<section class="ai-sec ${cls}"><h3>${label}</h3><p>${highlightFacts(text, it.facts)}</p></section>`;
      aiBody.innerHTML = `
        ${block("ai-see", "Ce qu'on voit", it.see)}
        ${block("ai-why", "Pourquoi c'est important", it.why)}
        ${block("ai-limit", "Limite", it.limit)}
        <section class="ai-sec ai-facts"><h3>Chiffres utilisés</h3>
          <p class="sub">Tous viennent des données du graphique ; aucun n'est inventé.</p>
          <ul class="fact-list">${[...new Set(it.facts)].map((f) => `<li>${esc(f)}</li>`).join("")}</ul></section>
        ${data.chat ? `<button type="button" class="ask-btn" id="ai-ask"><svg class="ico" aria-hidden="true"><use href="#i-chat"/></svg>Poser une question sur ce graphique</button>` : ""}
        <p class="ai-source">${esc(data.source.label)}</p>`;
      document.getElementById("ai-ask")?.addEventListener("click", () => openChat({ id: key, title: it.title }));
    } catch (e) {
      aiBody.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }
  function closeExplain(restoreFocus = true) {
    if (aiPanel.hidden) return;
    aiPanel.classList.remove("show");
    document.body.classList.remove("ai-open");
    aiPanel.hidden = true;
    document.querySelectorAll(".ai-btn[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
    if (restoreFocus && aiOpener && document.contains(aiOpener)) aiOpener.focus();
  }
  // -------------------------------------------------------- « Une question ? »
  // A chat answered by a language model on the server, only when the server has one configured.
  // Each answer may only quote numbers found in the demo's data; the server checks it.
  const chatPanel = document.getElementById("chat-panel");
  const chatFab = document.getElementById("chat-fab");
  const chatLog = document.getElementById("chat-log");
  const chatInput = document.getElementById("chat-input");
  const chatCtx = document.getElementById("chat-context");
  const chatSuggest = document.getElementById("chat-suggest");
  const chatHistory = [];
  const SUGGESTIONS = [
    "Comment fonctionne la règle du prix gonflé ?",
    "Pourquoi trier les alertes par montant ?",
    "Que montre le bilan économique ?",
    "Pourquoi des règles plutôt qu'un modèle ?",
  ];
  let chatEnabled = false;
  let chatChart = null;
  let chatOpener = null;
  let chatBusy = false;

  function renderChatContext() {
    chatCtx.hidden = !chatChart;
    if (!chatChart) return;
    chatCtx.innerHTML = `À propos du graphique <strong>${esc(chatChart.title)}</strong> <button type="button" class="link-btn" id="chat-ctx-clear">retirer</button>`;
    document.getElementById("chat-ctx-clear").addEventListener("click", () => { chatChart = null; renderChatContext(); chatInput.focus(); });
  }
  function renderSuggestions() {
    chatSuggest.innerHTML = chatHistory.length ? "" : `<p class="chat-hello">Bonjour ! Je réponds aux questions sur cette démo : les règles, les chiffres, la méthode. Quelques idées :</p>`
      + SUGGESTIONS.map((q) => `<button type="button" class="chip">${esc(q)}</button>`).join("");
    chatSuggest.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => sendChat(b.textContent)));
  }
  function addChatMessage(role, text, facts = [], checked = true) {
    const el = document.createElement("div");
    el.className = `msg ${role}${checked ? "" : " unchecked"}`;
    const html = role === "assistant" ? highlightFacts(text, facts) : esc(text);
    el.innerHTML = html.replace(/\n/g, "<br>");
    chatLog.append(el);
    chatLog.scrollTop = chatLog.scrollHeight;
    return el;
  }
  function openChat(chart = null) {
    if (!chatEnabled) return;
    if (chart) chatChart = chart;
    chatOpener = document.activeElement;
    closeExplain(false);
    chatPanel.hidden = false;
    requestAnimationFrame(() => chatPanel.classList.add("show"));
    chatFab.hidden = true;
    chatFab.setAttribute("aria-expanded", "true");
    renderChatContext();
    renderSuggestions();
    chatInput.focus();
  }
  function closeChat(restoreFocus = true) {
    if (chatPanel.hidden) return;
    chatPanel.classList.remove("show");
    chatPanel.hidden = true;
    chatFab.hidden = !chatEnabled;
    chatFab.setAttribute("aria-expanded", "false");
    if (restoreFocus) (chatOpener && document.contains(chatOpener) ? chatOpener : chatFab).focus();
  }
  async function sendChat(question) {
    const q = question.trim();
    if (chatBusy || q.length < 2) return;
    chatBusy = true;
    document.getElementById("chat-send").disabled = true;
    chatInput.value = "";
    chatSuggest.innerHTML = "";
    addChatMessage("user", q);
    const typing = document.createElement("p");
    typing.className = "ai-thinking";
    typing.innerHTML = "<span></span><span></span><span></span> Réflexion…";
    chatLog.append(typing);
    chatLog.scrollTop = chatLog.scrollHeight;
    try {
      const res = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, chart_id: chatChart ? chatChart.id : null, history: chatHistory.slice(-6) }),
      });
      typing.remove();
      addChatMessage("assistant", res.answer, res.facts, res.checked);
      chatHistory.push({ role: "user", text: q }, { role: "assistant", text: res.answer });
    } catch (e) {
      typing.remove();
      addChatMessage("error", e.message);
    }
    chatBusy = false;
    document.getElementById("chat-send").disabled = false;
    chatInput.focus();
  }
  document.getElementById("chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendChat(chatInput.value); });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(chatInput.value); }
  });
  chatFab.addEventListener("click", () => openChat());
  document.getElementById("chat-close").addEventListener("click", () => closeChat());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !chatPanel.hidden) closeChat(); });
  loadExplain().then((d) => { chatEnabled = Boolean(d.chat); chatFab.hidden = !chatEnabled; }).catch(() => {});

  document.getElementById("ai-close").addEventListener("click", () => closeExplain());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !aiPanel.hidden) closeExplain(); });

  async function decorateCharts() {
    if (!AI_VIEWS.has(currentView)) return;
    const heads = [...view.querySelectorAll("h2[id^='t-'], h3[id^='t-']")].filter((h) => !h.dataset.ai);
    if (!heads.length) return;
    let data;
    try { data = await loadExplain(); } catch { return; }
    for (const h of heads) {
      if (h.dataset.ai || !document.contains(h)) continue;
      h.dataset.ai = "1";
      const key = aiKey(h.id);
      if (!data.items[key]) continue;
      const row = document.createElement("div");
      row.className = "ai-row";
      h.replaceWith(row);
      row.append(h);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-btn";
      btn.dataset.title = h.textContent;
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-controls", "ai-panel");
      btn.setAttribute("aria-label", `Lecture IA du graphique « ${h.textContent} »`);
      btn.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#i-spark"/></svg><span>Lecture IA</span>`;
      btn.addEventListener("click", () => openExplain(key, btn));
      row.append(btn);
    }
  }
  let decorateQueued = false;
  new MutationObserver(() => {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(() => { decorateQueued = false; decorateCharts(); });
  }).observe(view, { childList: true, subtree: true });

  // ------------------------------------------------------ self-repair
  // The visitor should never have to reload. Two things can go wrong on the way through a CDN:
  // Chart.js arrives broken or not at all, or a view ends up with charts that were not drawn.
  // The page repairs both by itself, and reports what happened to the server log
  // (docker logs mutuelle-exemple-fraude | grep client-log) so the cause can be fixed at the source.
  const chartTag = document.querySelector('script[src*="chart.umd.min.js"]');
  const chartSrc = chartTag ? chartTag.getAttribute("src") : "/static/vendor/chart.umd.min.js";
  let reports = 0;
  function report(event, detail = {}) {
    if (reports >= 8) return;
    reports += 1;
    const body = JSON.stringify({ event, view: currentView, t: Math.round(performance.now()), ua: navigator.userAgent.slice(0, 200), detail });
    try {
      const sent = navigator.sendBeacon && navigator.sendBeacon("/api/client-log", new Blob([body], { type: "application/json" }));
      if (!sent) fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
    } catch { /* reporting must never break the page */ }
  }
  function chartTiming() {
    const e = performance.getEntriesByType("resource").filter((r) => r.name.includes("chart.umd.min.js")).pop();
    return e ? { status: e.responseStatus ?? null, transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize, ms: Math.round(e.duration), proto: e.nextHopProtocol } : "no-entry";
  }
  async function probeChart() {
    try {
      const r = await fetch(chartSrc, { cache: "no-store" });
      const text = await r.text();
      return { status: r.status, type: r.headers.get("content-type"), length: text.length, head: text.slice(0, 30).replace(/\s+/g, " "), cache: r.headers.get("cf-cache-status") };
    } catch (e) { return { error: String(e).slice(0, 100) }; }
  }
  let chartAttempts = 0;
  function reloadChart() {
    if (window.Chart || chartAttempts >= 3) return;
    chartAttempts += 1;
    const tag = document.createElement("script");
    tag.src = `${chartSrc}${chartSrc.includes("?") ? "&" : "?"}retry=${chartAttempts}`; // a new URL skips a broken cached copy
    tag.setAttribute("data-cfasync", "false");
    tag.onload = () => {
      if (window.Chart) { report("chart-reloaded", { attempt: chartAttempts }); onChartReady(); }
      else setTimeout(reloadChart, 1000 * chartAttempts);
    };
    tag.onerror = () => setTimeout(reloadChart, 1000 * chartAttempts);
    document.head.append(tag);
  }

  // After each view: every canvas must hold a drawn chart. If not, resize, then redraw the view once.
  let checkTimer = null;
  let repairedHash = null;
  function checkCharts() {
    clearTimeout(checkTimer);
    const hash = location.hash;
    checkTimer = setTimeout(() => {
      if (hash !== location.hash || !window.Chart) return;
      const canvases = [...view.querySelectorAll("canvas")];
      canvases.forEach((c) => { const ch = Chart.getChart(c); if (ch && (ch.width < 10 || ch.height < 10)) ch.resize(); });
      const missing = canvases.filter((c) => !Chart.getChart(c)).length;
      const flat = canvases.filter((c) => { const ch = Chart.getChart(c); return ch && (ch.width < 10 || ch.height < 10); }).length;
      const placeholders = view.querySelectorAll(".chart-missing").length;
      if (!missing && !flat && !placeholders) return;
      report("charts-not-drawn", { canvases: canvases.length, missing, flat, placeholders, visible: document.visibilityState, repaired: repairedHash === hash });
      if (repairedHash !== hash) { repairedHash = hash; route(); }
    }, 2500);
  }
  // Chrome may discard the pixels of canvases while the tab is in the background (to save memory)
  // and give back empty canvases: Chart.js does not redraw them by itself. So: redraw every chart
  // when the tab comes back, redraw a canvas the moment its context is restored, and check each
  // canvas when it scrolls into view.
  let lostCanvases = 0;
  document.addEventListener("contextlost", () => { lostCanvases += 1; }, true);
  document.addEventListener("contextrestored", (e) => {
    const ch = window.Chart && Chart.getChart(e.target);
    if (ch) ch.render();
  }, true);
  function redrawAll() {
    if (!window.Chart) return;
    Object.values(Chart.instances).forEach((c) => { if (document.contains(c.canvas)) { c.resize(); c.render(); } });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    redrawAll();
    if (lostCanvases) { report("canvas-context-lost", { canvases: lostCanvases }); lostCanvases = 0; }
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) redrawAll(); }); // back/forward cache

  // A drawn chart always leaves ink on a few horizontal rows (axes, grid, bars, nodes).
  function looksBlank(canvas) {
    try {
      const ctx = canvas.getContext("2d");
      for (const f of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const row = ctx.getImageData(0, Math.floor(canvas.height * f), canvas.width, 1).data;
        for (let i = 3; i < row.length; i += 4) if (row[i] !== 0) return false;
      }
      return true;
    } catch { return false; }
  }
  const seen = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting || !window.Chart) continue;
      const canvas = en.target;
      requestAnimationFrame(() => setTimeout(() => {
        if (!document.contains(canvas)) return;
        const ch = Chart.getChart(canvas);
        if (!ch) { checkCharts(); return; }
        seen.unobserve(canvas); // one check per canvas; tab switches are handled by redrawAll()
        if (looksBlank(canvas)) {
          ch.resize(); ch.render();
          report("blank-canvas-redrawn", { id: canvas.id, w: canvas.width, h: canvas.height, visible: document.visibilityState });
        }
      }, 400)); // after the chart's own short animation
    }
  }, { threshold: 0.2 });
  function watchCanvases() { view.querySelectorAll("canvas:not([data-watched])").forEach((c) => { c.dataset.watched = "1"; seen.observe(c); }); }
  new MutationObserver(() => requestAnimationFrame(watchCanvases)).observe(view, { childList: true, subtree: true });

  // Any script error is reported too: a chart that throws while drawing would otherwise fail silently.
  window.addEventListener("error", (e) => report("js-error", { msg: String(e.message).slice(0, 160), src: `${String(e.filename).split("/").pop()}:${e.lineno}:${e.colno}` }));
  window.addEventListener("unhandledrejection", (e) => report("js-rejection", { msg: String(e.reason && (e.reason.stack || e.reason.message) || e.reason).slice(0, 300) }));

  let firstRender = false;
  const start = () => { if (!firstRender) { firstRender = true; route(); } };
  function onChartReady() {
    if (!firstRender) start();
    else if (document.querySelector("#view .chart-missing")) route(); // late arrival: draw the charts now
  }
  // Deferred scripts run in order, so Chart.js has normally run before this file. If it has not,
  // its download failed or was cut: show the text at once, report, and load it again.
  if (window.Chart) start();
  else {
    start();
    probeChart().then((probe) => report("chart-missing-at-start", { timing: chartTiming(), probe }));
    (function waitForChart(waited) {
      if (window.Chart) { onChartReady(); return; }
      if (waited === 1500) reloadChart();
      if (waited < 60000) setTimeout(() => waitForChart(waited + 100), 100);
    })(0);
  }
})();
