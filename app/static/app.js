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
