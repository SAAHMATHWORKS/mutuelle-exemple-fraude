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
  let lastQueueHash = "#/alertes";
  let meta = null; // scenarios + decisions labels, loaded once

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
    if (!window.Chart) return null;
    const c = new Chart(canvas, config);
    charts.push(c);
    return c;
  }
  function cleanup() {
    charts.forEach((c) => c.destroy());
    charts = [];
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  // -------------------------------------------------------------------- api
  async function api(path, options) {
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
    document.querySelectorAll(".tabs a").forEach((a) => {
      if (a.dataset.view === name) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  async function route() {
    cleanup();
    chartDefaults();
    const { parts, params } = parseHash();
    try {
      if (parts[0] === "alertes" && parts[1]) { setNav("alerts"); await renderDetail(decodeURIComponent(parts[1])); }
      else if (parts[0] === "alertes") { setNav("alerts"); lastQueueHash = location.hash; await renderQueue(params); }
      else if (parts[0] === "evaluation") { setNav("evaluation"); await renderEvaluation(); }
      else if (parts[0] === "exploration") { setNav("exploration"); await renderExploration(); }
      else { setNav("overview"); await renderOverview(); }
    } catch (e) {
      view.innerHTML = `<div class="card"><h1>Impossible de charger la page</h1><p class="error">${esc(e.message)}</p><p><a href="#/vue-ensemble">Revenir à la vue d'ensemble</a></p></div>`;
    }
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
    const o = await api("/api/overview");
    meta = { scenarios: o.scenarios, decisions: o.decisions };
    const d = o.dataset;
    const maxAlerts = Math.max(...o.per_scenario.map((s) => s.alerts), 1);
    view.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Vue d'ensemble</h1>
          <p>${nf.format(d.n_claims)} lignes de soins remboursées par ${esc(d.insurer)} en 2025, pour ${nf.format(d.n_members)} adhérents et ${nf.format(d.n_providers)} prestataires.
          Cinq règles cherchent chacune un scénario de fraude et expliquent leurs alertes en clair.</p>
        </div>
      </div>
      <section class="grid kpis" aria-label="Chiffres clés">
        <div class="kpi"><div class="label">Alertes sur l'année</div><div class="value">${nf.format(o.totals.alerts)}</div><div class="hint">toutes règles confondues</div></div>
        <div class="kpi"><div class="label">Alertes par jour</div><div class="value">${nf1.format(o.totals.alerts_per_day)}</div><div class="hint">en moyenne, à traiter par un gestionnaire</div></div>
        <div class="kpi"><div class="label">Sévérité haute</div><div class="value">${nf.format(o.totals.high_severity)}</div><div class="hint">${pct(o.totals.high_severity / Math.max(o.totals.alerts, 1))} des alertes</div></div>
        <div class="kpi"><div class="label">Montant signalé</div><div class="value">${eur0.format(o.totals.flagged_amount)}</div><div class="hint">sur ${eur0.format(d.total_billed)} facturés</div></div>
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
          <h2 id="t-scen">Par scénario</h2>
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
      <details class="settings card">
        <summary>Paramètres de la simulation</summary>
        <p class="sub" style="margin-top:8px">Graine ${d.seed}, ${nf.format(d.size)} lignes visées, bruit ${nf.format(d.noise_level)}. Données générées en ${nf1.format(d.generated_in_s)} s, règles appliquées en ${nf1.format(d.detected_in_s)} s.
        Vous pouvez régénérer un autre jeu de données ; les autres visiteurs verront aussi le nouveau jeu.</p>
        ${regenFormHtml(d)}
      </details>`;

    const keys = o.per_scenario.map((s) => `s${s.scenario}`);
    const labels = Object.fromEntries(o.per_scenario.map((s) => [`s${s.scenario}`, s.label]));
    const draw = (gran) => {
      charts.forEach((c) => c.destroy());
      charts = [];
      const rows = gran === "week" ? aggregateWeekly(o.per_day, keys) : o.per_day;
      document.getElementById("volume-sub").textContent = gran === "week"
        ? "Par semaine (semaine commençant le lundi), selon la date à laquelle l'alerte devient visible."
        : "Par jour, selon la date à laquelle l'alerte devient visible.";
      makeChart(document.getElementById("c-volume"), {
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
    view.querySelectorAll("[data-gran]").forEach((b) => b.addEventListener("click", () => {
      view.querySelectorAll("[data-gran]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      draw(b.dataset.gran);
    }));
    bindRegenForm();
  }

  function regenFormHtml(d, noiseOverride) {
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
    const m = await ensureMeta();
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
    const m = await ensureMeta();
    const a = await api(`/api/alerts/${encodeURIComponent(id)}`);
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
            <td data-label="Acte">${esc(r.act_label)} <span class="muted mono">${esc(r.act_code)}</span></td>
            <td data-label="Diagnostic">${esc(r.diagnosis_label)} <span class="muted mono">${esc(r.diagnosis_code)}</span></td>
            <td data-label="Prestataire"><span class="mono">${esc(r.provider_id)}</span> <span class="muted">${esc(r.provider_type)}</span></td>
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
  let refLineRegistered = false;

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
    if (window.Chart && !refLineRegistered) { Chart.register(refLinePlugin); refLineRegistered = true; }
    const x = await api("/api/exploration");
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

  // ============================================================= EVALUATION
  async function renderEvaluation() {
    const e = await api("/api/evaluation");
    const o = e.overall;
    const curve = e.noise_curve;
    const causes = Object.entries(e.false_alert_causes);
    const causeTotal = causes.reduce((a, [, n]) => a + n, 0) || 1;
    view.innerHTML = `
      <div class="page-head"><div><h1>Évaluation</h1>
        <p>Les fraudes ont été injectées par le générateur : on connaît donc la vérité pour chaque ligne. Ces chiffres mesurent la capacité des règles à retrouver ces motifs injectés, pas leur performance sur de vraies fraudes.</p></div></div>
      <section class="grid kpis" aria-label="Chiffres clés de l'évaluation">
        <div class="kpi"><div class="label">Rappel global</div><div class="value">${pct(o.recall_any)}</div><div class="hint">des ${nf.format(o.fraud_lines)} lignes frauduleuses sont signalées</div></div>
        <div class="kpi"><div class="label">Précision globale</div><div class="value">${pct(o.precision_any)}</div><div class="hint">des lignes signalées sont frauduleuses</div></div>
        <div class="kpi"><div class="label">Alertes par jour</div><div class="value">${nf1.format(o.alerts_per_day)}</div><div class="hint">charge de travail moyenne</div></div>
        <div class="kpi"><div class="label">Fausses alertes par jour</div><div class="value">${nf1.format(o.false_alerts_per_day)}</div><div class="hint">alertes sans aucune ligne frauduleuse</div></div>
        <div class="kpi"><div class="label">Montant frauduleux retrouvé</div><div class="value">${pct(o.caught_amount / Math.max(o.fraud_amount, 1))}</div><div class="hint">${eur0.format(o.caught_amount)} sur ${eur0.format(o.fraud_amount)}</div></div>
      </section>
      <section class="card" aria-labelledby="t-per">
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
      <div class="grid two-col section">
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
      <section class="callout section" aria-labelledby="t-ko">
        <h2 id="t-ko">Ce qui ne marche pas</h2>
        <ul>
          <li><strong>Prix gonflé.</strong> Le seuil « 2 fois le prix habituel » laisse passer les surfacturations modestes (+30 à +80 %) et signale les soins complexes légitimement plus chers. Le prix habituel est une médiane globale par acte : il ignore les écarts normaux entre régions ou cabinets. En janvier, les actes rares n'ont pas encore 20 factures antérieures : aucune référence, donc aucune alerte.</li>
          <li><strong>Doublon ou fractionnement.</strong> Deux soins identiques et légitimes le même jour (deux caries) ressemblent à un doublon. Un doublon facturé plus d'un jour après l'original passe inaperçu.</li>
          <li><strong>Multiplication des prestataires.</strong> « Nouveau prestataire » se juge sur l'historique disponible : en début d'année, tout le monde paraît nouveau. Un fraudeur qui étale ses visites sur plus de 14 jours, ou qui se limite à deux médecins, n'est pas vu.</li>
          <li><strong>Incohérence diagnostic / acte.</strong> La règle dépend de la qualité du codage : une erreur de saisie honnête déclenche une alerte, et un fraudeur qui choisit un diagnostic plausible passe.</li>
          <li><strong>Sinistre précoce.</strong> La règle ne distingue pas la fraude de l'anti-sélection légitime (adhérer parce qu'on a besoin de soins). Attendre 31 jours suffit pour passer sous le seuil.</li>
          <li><strong>En général.</strong> Les cinq règles sont indépendantes : pas de score combiné, pas d'analyse des liens entre adhérents et prestataires, pas d'apprentissage à partir des décisions des gestionnaires. Les seuils ont été choisis à la main sur ces données synthétiques.</li>
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

    if (curve.status === "ready") renderNoise(curve, e.dataset);
    else if (curve.status === "computing") pollTimer = setTimeout(() => { if (parseHash().parts[0] === "evaluation") route(); }, 2500);
    else document.getElementById("noise-body").innerHTML = `<p class="error">Le calcul de la courbe a échoué.</p>`;
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
      <p style="margin-top:12px"><button class="btn" type="button" id="noise-regen">Régénérer le jeu de données à ce niveau de bruit</button></p>
      <p class="status-line" id="noise-status" role="status"></p>`;

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
    document.getElementById("noise-regen").addEventListener("click", async (ev) => {
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

  route();
})();
