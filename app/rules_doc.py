"""« Comment ça marche ? »: each rule in plain French, built from the detectors' own constants.

The thresholds are read from the detector modules, so the explanation cannot drift
from what the code does.
"""

from __future__ import annotations

from app.catalog import SCENARIOS
from app.detectors import coherence, duplicates, early_claim, nomadism, price

NBSP = " "


def _x(v: float) -> str:
    return f"{v:g}".replace(".", ",") + " fois"


def _pct(v: float) -> str:
    return f"{v * 100:.0f}{NBSP}%"


def _eur(v: float) -> str:
    return f"{v:.0f}{NBSP}€"


def rules() -> list[dict]:
    lo, hi = duplicates.SPLIT_SUM_RANGE
    texts = {
        1: (
            f"Chaque ligne est comparée au prix habituel du même acte : la médiane des factures antérieures "
            f"(au moins {price.MIN_HISTORY}), sans jamais regarder les factures futures. "
            f"Alerte à partir de {_x(price.RATIO_FLAG)} ce prix.",
            f"Haute à partir de {_x(price.RATIO_HIGH)} ce prix, ou si le prestataire a déjà eu {price.PROVIDER_REPEAT} alertes de prix "
            f"en {price.PROVIDER_LOOKBACK_DAYS} jours : la décision devient alors un contrôle du prestataire.",
        ),
        2: (
            f"Même adhérent, même prestataire, même acte, à {duplicates.MAX_GAP_DAYS} jour d'écart au plus "
            f"(même jour et même montant pour les actes qui se répètent normalement, comme les médicaments). "
            f"C'est un fractionnement si chaque morceau vaut moins de {_pct(duplicates.SPLIT_PIECE_MAX)} du prix habituel "
            f"et si leur somme est proche d'un seul acte (entre {_x(lo)[:-5]} et {_x(hi)} ce prix).",
            "La décision suggérée est de demander la facture détaillée.",
        ),
        3: (
            f"Un adhérent qui consulte au moins {nomadism.MIN_NEW_PROVIDERS} nouveaux prestataires du même type "
            f"(généralistes, spécialistes ou pharmacies) en {nomadism.WINDOW_DAYS} jours.",
            f"Haute à partir de {nomadism.HIGH_NEW_PROVIDERS} nouveaux prestataires ; la décision suggérée est un contrôle médical de l'adhérent.",
        ),
        4: (
            "Une petite table indique les groupes de diagnostic qui vont normalement avec chaque acte ; "
            "une ligne dont le diagnostic n'y figure pas est signalée.",
            f"Haute à partir de {_eur(coherence.HIGH_AMOUNT)} ; sous {_eur(coherence.MIN_AMOUNT_FOR_ACTION)}, aucune action, "
            "car un contrôle coûterait plus que la ligne.",
        ),
        5: (
            f"Un acte coûteux, ou une ligne d'au moins {_eur(early_claim.MIN_AMOUNT)}, dans les "
            f"{early_claim.MAX_DAYS} jours qui suivent la date d'effet du contrat.",
            f"Haute dans les {early_claim.HIGH_DAYS} premiers jours ; la décision suggérée est de vérifier la date d'effet "
            "et la déclaration d'adhésion.",
        ),
    }
    return [{"scenario": k, "label": SCENARIOS[k]["label"], "how": how, "then": then} for k, (how, then) in texts.items()]
