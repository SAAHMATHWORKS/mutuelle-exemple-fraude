"""« Lecture IA »: a short commentary for each chart, built from the chart's own numbers.

Each commentary has three parts a claims manager can use: what the chart shows,
why it matters, and the limit to keep in mind. Every number in the text comes
from the data through the ``_Facts`` helpers, and is listed in ``facts``;
``tests/test_narratives.py`` fails if a text contains a number that is not one
of its facts, so a commentary can never quote a figure the chart does not hold.

Provider design. The texts here are static: written once by an AI assistant as
templates and filled with the data, so the public demo needs no API key. A
dynamic provider (an LLM called from the server, with the key in the server's
``.env`` and never in the browser, the repository or the image) can replace
``build`` later: it receives the same ``facts`` and must return the same shape,
and the same number check applies to its output before it is shown.
"""

from __future__ import annotations

from collections import Counter

from app.catalog import SCENARIOS
from app.generator import N_DAYS

SOURCE = {
    "kind": "static",
    "label": "Commentaire rédigé par IA à partir des données du graphique, puis relu (version statique, sans appel à un modèle en ligne).",
}
MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
NBSP = " "
THIN = " "


class _Facts:
    """Formats numbers the French way and records every formatted value it hands out."""

    def __init__(self) -> None:
        self.items: list[str] = []

    def _keep(self, text: str) -> str:
        self.items.append(text)
        return text

    def num(self, v: float, nd: int = 0) -> str:
        s = f"{v:,.{nd}f}".replace(",", THIN).replace(".", ",")
        return self._keep(s)

    def pct(self, v: float, nd: int = 0) -> str:
        return self._keep(f"{v * 100:.{nd}f}".replace(".", ",") + f"{NBSP}%")

    def eur(self, v: float) -> str:
        return self._keep(f"{v:,.0f}".replace(",", THIN) + f"{NBSP}€")

    def times(self, v: float) -> str:
        return self._keep(f"×{v:g}".replace(".", ","))

    def raw(self, text: str) -> str:
        """A label that contains digits (a scenario number, a threshold label) taken from the data."""
        return self._keep(text)


def _item(chart_id: str, title: str, f: _Facts, see: str, why: str, limit: str) -> dict:
    return {"id": chart_id, "title": title, "see": see, "why": why, "limit": limit, "facts": f.items}


# ------------------------------------------------------------------ overview
def _overview(r) -> list[dict]:
    out = []
    alerts = r.alerts
    per_month = Counter(_month(a["alert_day"]) for a in alerts)
    busiest, n_busiest = per_month.most_common(1)[0]
    quietest, n_quietest = min(per_month.items(), key=lambda kv: kv[1])
    f = _Facts()
    out.append(
        _item(
            "volume",
            "Alertes dans le temps",
            f,
            f"Le volume d'alertes varie de {f.num(n_quietest)} en {quietest} à {f.num(n_busiest)} en {busiest}, "
            f"soit {f.num(len(alerts) / N_DAYS, 1)} alertes par jour en moyenne.",
            "C'est la charge de travail du gestionnaire : elle suit la saisonnalité des soins et la montée en charge "
            "des adhérents arrivés en cours d'année.",
            "En janvier, les prix habituels manquent encore pour les actes rares : la règle de prix y est presque muette.",
        )
    )
    f = _Facts()
    high = sum(1 for a in alerts if a["severity"] == "haute")
    by_s = {s: [a for a in alerts if a["scenario"] == s] for s in SCENARIOS}
    top = max(by_s, key=lambda s: sum(a["severity"] == "haute" for a in by_s[s]) / max(len(by_s[s]), 1))
    top_share = sum(a["severity"] == "haute" for a in by_s[top]) / max(len(by_s[top]), 1)
    sev = r.advanced["severity"] if r.advanced and "severity" in r.advanced else None
    see = (
        f"{f.num(high)} alertes sur {f.num(len(alerts))} sont en sévérité haute ({f.pct(high / max(len(alerts), 1))}). "
        f"Le scénario « {SCENARIOS[top]['label'].lower()} » en a la plus forte part ({f.pct(top_share)})."
    )
    why = "La sévérité ordonne la file : un gestionnaire commence par les alertes hautes."
    if sev:
        why += f" Elle est fiable : {f.pct(sev[0]['share_true'])} des alertes hautes sont justes, contre {f.pct(sev[2]['share_true'])} des faibles."
    out.append(
        _item(
            "sev",
            "Gravité des alertes par scénario",
            f,
            see,
            why,
            "La sévérité ne tient pas compte du montant : une alerte haute peut porter sur quelques euros.",
        )
    )
    f = _Facts()
    dec = Counter(a["decision"] for a in alerts)
    simple = dec.get("demander_facture", 0) + dec.get("demander_justificatif", 0)
    heavy = dec.get("controle_prestataire", 0) + dec.get("controle_medical", 0)
    out.append(
        _item(
            "dec",
            "Ce que le gestionnaire doit faire",
            f,
            f"{f.pct(simple / max(len(alerts), 1))} des alertes demandent une simple pièce (facture ou justificatif) ; "
            f"{f.num(heavy)} appellent un contrôle du prestataire ou de l'adhérent.",
            "Chaque alerte arrive avec une action proportionnée : on ne lance pas un contrôle lourd sur un doute léger.",
            "Les décisions proposées sont des règles simples ; dans la démo, le choix du gestionnaire n'est enregistré "
            "que dans son navigateur et ne fait pas évoluer les règles.",
        )
    )
    return out


def _month(day: int) -> str:
    starts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    m = max(i for i, s in enumerate(starts) if day >= s)
    return MONTHS[m]


# --------------------------------------------------------------- exploration
def _exploration(r) -> list[dict]:
    x = r.get_exploration()
    p, sig = x["portfolio"], x["signals"]
    out = []
    am = p["amounts"]
    f = _Facts()
    out.append(
        _item(
            "amounts",
            "Distribution des montants",
            f,
            f"La plupart des soins sont bon marché : médiane {f.eur(am['median'])}, et {f.pct(am['share_below_50'])} des lignes "
            f"sous les {f.eur(50)}. Mais les {f.pct(0.05)} de lignes les plus chères pèsent {f.pct(am['amount_share_top5pct_lines'])} du total.",
            "Une règle en euros absolus ne marche pas : elle ignorerait la masse des petits soins et noierait le "
            "gestionnaire sous les actes chers mais normaux.",
            "La distribution mélange des actes très différents ; c'est acte par acte qu'il faut juger un prix.",
        )
    )
    mix = {m["type"]: m for m in p["provider_mix"]}
    f = _Facts()
    out.append(
        _item(
            "mix",
            "Lignes et montants par type de prestataire",
            f,
            f"Les pharmacies font {f.pct(mix['PHA']['line_share'])} des lignes mais {f.pct(mix['PHA']['amount_share'])} des montants ; "
            f"les cabinets dentaires, {f.pct(mix['DEN']['line_share'])} des lignes et {f.pct(mix['DEN']['amount_share'])} des montants.",
            "Le volume et l'enjeu financier ne sont pas au même endroit : un contrôle doit viser l'enjeu, pas le nombre de lignes.",
            "Ces parts décrivent un portefeuille synthétique ; un vrai portefeuille aura d'autres proportions.",
        )
    )
    spread = p["price_spread"]
    widest = max(spread, key=lambda s: s["iqr_ratio"] or 0)
    f = _Facts()
    out.append(
        _item(
            "spread",
            "Dispersion des prix par acte",
            f,
            f"Pour un même acte, le prix varie : pour « {widest['label'].lower()} », la moitié centrale des prix va de "
            f"{f.eur(widest['q1'])} à {f.eur(widest['q3'])}.",
            f"C'est pourquoi la règle de prix compare chaque ligne au prix habituel du même acte et ne réagit qu'à partir de "
            f"{f.raw(sig['price']['threshold_label'])} : en dessous, on signalerait des écarts normaux.",
            "La médiane est globale : elle ignore les écarts légitimes entre régions ou cabinets.",
        )
    )
    groups = p["seasonality"]["groups"]
    g1 = groups[0]
    resp = next(g for g in groups if g["group"] == "RSP")
    f = _Facts()
    out.append(
        _item(
            "season",
            "Saisonnalité par groupe de diagnostic",
            f,
            f"Le groupe le plus saisonnier est « {g1['label'].lower()} », avec un pic en {_full_month(g1['peak_month'])} à {f.pct((max(g1['index']) - 100) / 100)} au-dessus de sa moyenne mensuelle ; "
            f"les infections respiratoires culminent en {_full_month(resp['peak_month'])}.",
            "Un volume « anormal » se juge par rapport à la saison : le même nombre de consultations est banal en hiver "
            "et suspect en été.",
            "Les règles actuelles n'utilisent pas encore la saisonnalité ; c'est une piste pour une règle de volume.",
        )
    )
    d = p["daily"]
    f = _Facts()
    out.append(
        _item(
            "daily",
            "Lignes de soins par jour",
            f,
            f"En moyenne {f.num(d['mean'], 1)} lignes par jour, avec un coefficient de variation de {f.pct(d['cv'])}.",
            "La moyenne mobile sur une semaine sépare la tendance du bruit quotidien : la hausse vient des adhérents "
            "arrivés en cours d'année.",
            "Les jours de la semaine ne sont pas simulés : un vrai flux aurait des creux le week-end.",
        )
    )
    c = p["concentration"]
    f = _Facts()
    out.append(
        _item(
            "lorenz",
            "Concentration des montants",
            f,
            f"Les dix pour cent d'adhérents les plus coûteux concentrent {f.pct(c['members']['top10_share'])} des montants "
            f"(indice de Gini {f.num(c['members']['gini'], 2)}) ; chez les prestataires, l'indice est de {f.num(c['providers']['gini'], 2)}.",
            "La dépense est concentrée : quelques dossiers pèsent lourd, et un contrôle bien ciblé couvre une grande part de l'enjeu.",
            "La concentration n'est pas un signe de fraude : les malades chroniques coûtent légitimement plus.",
        )
    )
    a = p["age_spend"]
    b0, b1 = a["bands"][0], a["bands"][-1]
    f = _Facts()
    out.append(
        _item(
            "age",
            "Âge et dépense annuelle",
            f,
            f"La dépense médiane passe de {f.eur(b0['median'])} chez les {f.raw(b0['band'])} à {f.eur(b1['median'])} chez les {f.raw(b1['band'])}.",
            "L'âge explique une partie de la dépense, mais la dispersion à âge égal est bien plus forte : comparer un "
            "adhérent à sa tranche d'âge ne suffit pas à le juger.",
            "Le nuage montre un échantillon d'adhérents, pas tous.",
        )
    )
    sp = sig["price"]
    f = _Facts()
    out.append(
        _item(
            "sig-price",
            "Signal du scénario 1 : prix gonflé",
            f,
            f"À partir de {f.raw(sp['threshold_label'])} le prix habituel, on trouve {f.pct(sp['fraud_rule_share'])} des prix gonflés injectés "
            f"et seulement {f.pct(sp['legit_rule_share'], 1)} des lignes légitimes.",
            "Le signal sépare très bien les deux groupes : c'est ce qui rend la règle de prix précise.",
            f"Les surfacturations modestes passent sous le seuil, et {f.num(sp['lines_without_reference'])} lignes sans prix "
            "de référence échappent à la règle.",
        )
    )
    sd = sig["duplicates"]
    f = _Facts()
    out.append(
        _item(
            "sig-dup",
            "Signal du scénario 2 : doublon",
            f,
            f"Jusqu'à {f.num(sd['threshold'])} jour d'écart, on trouve {f.pct(sd['fraud_rule_share'])} des doublons injectés "
            f"et {f.pct(sd['legit_rule_share'], 1)} des répétitions légitimes.",
            "Un doublon frauduleux suit l'original de très près ; les vraies répétitions s'étalent dans le temps.",
            "Deux soins identiques et légitimes le même jour, comme deux caries, ressemblent à un doublon.",
        )
    )
    sv = sig["providers"]
    f = _Facts()
    out.append(
        _item(
            "sig-prov",
            "Signal du scénario 3 : multiplication des prestataires",
            f,
            f"À partir de {f.num(sv['threshold'])} nouveaux prestataires du même type en {f.num(sv['window_days'])} jours, on trouve "
            f"{f.pct(sv['fraud_rule_share'])} des adhérents nomades injectés et {f.pct(sv['legit_rule_share'], 1)} des adhérents légitimes.",
            "Le nomadisme médical laisse une trace nette : beaucoup de nouveaux médecins ou pharmacies en peu de temps.",
            "En début d'année, faute d'historique, tout prestataire paraît nouveau.",
        )
    )
    se = sig["early"]
    f = _Facts()
    out.append(
        _item(
            "sig-early",
            "Signal du scénario 5 : sinistre précoce",
            f,
            f"Jusqu'à {f.num(se['threshold'])} jours après la date d'effet, on trouve {f.pct(se['fraud_rule_share'])} des sinistres précoces "
            f"injectés, mais aussi {f.pct(se['legit_rule_share'])} des soins coûteux légitimes de nouveaux adhérents.",
            "C'est le scénario où la fraude ressemble le plus au comportement normal : on adhère souvent parce qu'on a besoin de soins.",
            "La règle ne distingue pas fraude et anti-sélection ; la décision proposée est donc une vérification, pas une sanction.",
        )
    )
    sc = sig["coherence"]
    f = _Facts()
    out.append(
        _item(
            "sig-coh",
            "Signal du scénario 4 : incohérence diagnostic / acte",
            f,
            f"Les erreurs de codage honnêtes touchent {f.pct(sc['legit_incoherent_rate'], 1)} des lignes légitimes ; "
            f"{f.num(sc['camouflaged_total'])} fraudes injectées portent un diagnostic plausible.",
            "Les incohérences légitimes produisent des fausses alertes, d'où la décision « demander un justificatif » plutôt qu'un rejet.",
            "Une fraude avec un diagnostic bien choisi est invisible pour cette règle : elle dépend de la qualité du codage.",
        )
    )
    return out


def _full_month(short: str) -> str:
    shorts = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
    return MONTHS[shorts.index(short)] if short in shorts else short


# ----------------------------------------------------------------- providers
def _leading(rows: list[dict]) -> int:
    """How many rows at the top of the ranking are injected accomplices, before the first other one."""
    n = 0
    for row in rows:
        if not row["complicit"]:
            break
        n += 1
    return n


def _providers(r) -> list[dict]:
    x = r.get_providers()
    h, sc, net = x["heatmap"], x["scorecard"], x["network"]["summary"]
    out = []
    top = h["rows"][0]
    f = _Facts()
    out.append(
        _item(
            "hm",
            "Alertes par prestataire et par semaine",
            f,
            f"{f.num(h['providers_with_alerts'])} prestataires ont au moins une alerte ; le plus signalé, {f.raw(top['provider_id'])}, "
            f"en cumule {f.num(top['total'])} sur l'année.",
            "Une ligne foncée toute l'année traduit un comportement durable : c'est un candidat au contrôle du prestataire, "
            "pas seulement à une demande de facture.",
            "Le scénario de multiplication des prestataires vise plusieurs prestataires à la fois et n'apparaît pas ici.",
        )
    )
    f = _Facts()
    out.append(
        _item(
            "sc",
            "Profil de facturation des prestataires",
            f,
            (
                f"Classés par part de prix élevés, les {f.num(sc['complicit_total'])} prestataires complices injectés occupent "
                f"les {f.num(sc['complicit_in_top'])} premières places du classement."
                if _leading(sc["rows"]) == sc["complicit_total"]
                else f"Classés par part de prix élevés, {f.num(sc['complicit_in_top'])} des {f.num(sc['complicit_total'])} "
                f"prestataires complices injectés figurent parmi les {f.num(len(sc['rows']))} premiers."
            ),
            "Agréger par prestataire révèle ce que la règle ligne à ligne ne voit pas : une surfacturation répétée. "
            "C'est la piste d'une règle au niveau du prestataire.",
            "Le classement s'appuie sur la vérité injectée pour être évalué ; sur de vraies données, il désigne des cibles de contrôle, pas des coupables.",
        )
    )
    f = _Facts()
    out.append(
        _item(
            "net",
            "Graphe adhérents – prestataires",
            f,
            f"Un adhérent signalé voit en moyenne {f.num(net['mean_providers_flagged'], 1)} prestataires, {f.num(net['mean_visits_per_provider_flagged'], 1)} fois "
            f"chacun ; un adhérent fidèle en voit {f.num(net['mean_providers_contrast'], 1)}, {f.num(net['mean_visits_per_provider_contrast'], 1)} fois chacun.",
            "La forme du graphe distingue le nomadisme (beaucoup de liens fins) de la fidélité (peu de liens épais).",
            "Aucun réseau organisé n'a été injecté : les prestataires partagés le sont par hasard.",
        )
    )
    return out


# ---------------------------------------------------------------- evaluation
def _evaluation(r) -> list[dict]:
    ev = r.evaluation
    o = ev["overall"]
    out = []
    worst = min(ev["per_scenario"], key=lambda p: p["recall"] or 0)
    f = _Facts()
    out.append(
        _item(
            "per",
            "Rappel et précision par scénario",
            f,
            f"Les règles retrouvent {f.pct(o['recall_any'])} des lignes frauduleuses avec une précision de {f.pct(o['precision_any'])}. "
            f"Le scénario le moins bien couvert est « {worst['label'].lower()} » ({f.pct(worst['recall'])} de rappel).",
            f"Pour le gestionnaire, cela représente {f.num(o['false_alerts_per_day'], 1)} fausse alerte par jour en moyenne.",
            "Les fraudes ont été injectées par le générateur : ces scores mesurent la capacité à retrouver ces motifs, pas une performance réelle.",
        )
    )
    causes = ev["false_alert_causes"]
    if causes:
        cause, n = next(iter(causes.items()))
        f = _Facts()
        out.append(
            _item(
                "causes",
                "D'où viennent les fausses alertes",
                f,
                f"Première cause de fausse alerte : « {cause} », avec {f.num(n)} alertes sur {f.num(o['false_alerts'])}.",
                "Connaître la cause d'une fausse alerte dit comment l'éviter : un justificatif suffit souvent à lever le doute.",
                "Une partie des fausses alertes n'a aucune particularité : c'est la règle elle-même qui se trompe.",
            )
        )
    adv = r.advanced if r.advanced and "error" not in r.advanced else None
    if adv:
        s1 = next(s for s in adv["sweeps"] if s["scenario"] == 1)
        cur = next(p for p in s1["points"] if p["is_current"])
        best = next(p for p in s1["points"] if p["threshold"] == s1["best_f1_threshold"])
        f = _Facts()
        out.append(
            _item(
                "pr",
                "Compromis précision-rappel selon le seuil",
                f,
                f"Pour le prix gonflé, passer de {f.times(cur['threshold'])} à {f.times(best['threshold'])} ferait passer le rappel de "
                f"{f.pct(cur['recall'])} à {f.pct(best['recall'])}, avec une précision de {f.pct(best['precision'])}.",
                "Chaque seuil est un arbitrage entre fraudes manquées et fausses alertes ; la courbe le rend visible.",
                "Choisir le seuil sur ces mêmes données serait du surapprentissage : il faudrait le valider sur une autre période.",
            )
        )
        cm = {x["scenario"]: x for x in adv["confusion"]["per_rule"]}
        total_missed = sum(row["none"] for row in adv["confusion"]["matrix"] if row["true_scenario"] != 0)
        f = _Facts()
        out.append(
            _item(
                "cm",
                "Quelle règle attrape quelle fraude",
                f,
                f"Chaque règle attrape surtout son propre scénario ; au total, {f.num(total_missed)} lignes frauduleuses ne sont vues par aucune règle. "
                f"La règle de sinistre précoce a un rappel de {f.pct(cm[5]['recall'])}.",
                "La matrice montre que les règles se complètent sans se marcher dessus : une fraude manquée par l'une n'est pas rattrapée par une autre.",
                "Les fraudes non vues sont souvent les plus discrètes ; c'est là qu'un modèle non supervisé peut aider à découvrir de nouveaux motifs.",
            )
        )
        g = adv["gain"]
        cap = min(g["alerts"], g["days"])

        def at(name: str) -> float:
            pts = g["curves"][name]["amount"]
            return next((p["y"] for p in pts if p["k"] >= cap), pts[-1]["y"])

        f = _Facts()
        out.append(
            _item(
                "gain",
                "Courbe de gain",
                f,
                f"Avec {f.num(cap)} alertes traitées dans l'année, trier par montant retrouve {f.pct(at('amount'))} des euros frauduleux, "
                f"contre {f.pct(at('severity_amount'))} par sévérité et {f.pct(at('chronological'))} dans l'ordre d'arrivée.",
                "L'ordre de la file compte autant que la qualité des règles quand le temps du gestionnaire est limité.",
                "Trier par montant fait traiter d'abord des alertes coûteuses mais moins sûres ; l'idéal combine fiabilité et montant.",
            )
        )
        sev = adv["severity"]
        f = _Facts()
        out.append(
            _item(
                "sevcal",
                "Justesse des alertes par sévérité",
                f,
                f"{f.pct(sev[0]['share_true'])} des alertes de sévérité haute sont justes, contre {f.pct(sev[1]['share_true'])} des moyennes "
                f"et {f.pct(sev[2]['share_true'])} des faibles.",
                "La sévérité est bien calibrée : elle annonce correctement la fiabilité de l'alerte.",
                "Elle ne dit rien du montant en jeu ; c'est pourquoi la courbe de gain préfère le tri par montant pour récupérer des euros.",
            )
        )
    return out


# --------------------------------------------------------------------- model
def _model(r) -> list[dict]:
    m = r.model if r.model and "error" not in r.model else None
    if not m:
        return []
    R, M, B, o = m["rules"], m["models"]["metier"]["at_budget"], m["models"]["brutes"]["at_budget"], m["overlap"]
    out = []
    f = _Facts()
    out.append(
        _item(
            "m-recall",
            "Rappel par scénario, à charge égale",
            f,
            f"Avec le même nombre de lignes signalées ({f.num(m['budget'])}), les règles retrouvent {f.pct(R['recall'])} des fraudes, "
            f"l'Isolation Forest {f.pct(M['recall'])} avec les variables métier et {f.pct(B['recall'])} avec les variables brutes.",
            "Le saut vient des variables, pas de l'algorithme : la connaissance du métier fait l'essentiel du travail.",
            "Le modèle est entraîné sur toute l'année d'un coup ; en production, on l'entraînerait sur le passé.",
        )
    )
    f = _Facts()
    out.append(
        _item(
            "m-pr",
            "Précision et rappel du modèle",
            f,
            f"Au niveau de rappel des règles, le modèle est bien moins précis : {f.pct(M['precision'])} contre {f.pct(R['precision'])}.",
            "Un score d'anomalie n'explique pas l'alerte ; une règle donne une raison et une décision, ce qu'un gestionnaire peut utiliser.",
            "Les deux approches ne sont comparables qu'à charge égale : c'est pourquoi le modèle signale exactement autant de lignes que les règles.",
        )
    )
    f = _Facts()
    out.append(
        _item(
            "m-overlap",
            "Qui trouve quoi",
            f,
            f"Règles et modèle s'accordent sur {f.num(o['fraud_both'])} lignes frauduleuses ; le modèle seul en voit {f.num(o['fraud_model_only'])}, "
            f"mais signale aussi {f.num(o['legit_model_only'])} lignes légitimes que les règles laissent de côté.",
            "Les fraudes vues par le modèle seul sont une piste : on les examine pour inventer de nouvelles règles explicables.",
            "Le modèle ne remplace pas les règles : il sert d'outil de découverte.",
        )
    )
    return out


def build(r) -> dict:
    """Commentaries for every chart that has data. Parts still computing are simply absent."""
    items = []
    for part in (_overview, _exploration, _providers, _evaluation, _model):
        items.extend(part(r))
    return {"source": SOURCE, "items": {it["id"]: it for it in items}}
