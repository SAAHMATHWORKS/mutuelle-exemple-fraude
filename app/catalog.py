"""Invented reference tables for the fictional insurer "Mutuelle Exemple".

Every code, label and price here is made up for the demo. The diagnosis
codes deliberately do not follow any real classification.
"""

from __future__ import annotations

from dataclasses import dataclass

INSURER_NAME = "Mutuelle Exemple"

# Provider types (invented labels, in French for the UI).
PROVIDER_TYPES: dict[str, str] = {
    "GEN": "Médecin généraliste",
    "SPE": "Médecin spécialiste",
    "DEN": "Cabinet dentaire",
    "PHA": "Pharmacie",
    "LAB": "Laboratoire",
    "RAD": "Centre d'imagerie",
    "KIN": "Kinésithérapeute",
    "OPT": "Opticien",
    "CLI": "Clinique",
}

# Share of providers of each type in the synthetic network.
PROVIDER_TYPE_WEIGHTS: dict[str, float] = {
    "GEN": 0.26,
    "SPE": 0.16,
    "DEN": 0.12,
    "PHA": 0.20,
    "LAB": 0.06,
    "RAD": 0.06,
    "KIN": 0.08,
    "OPT": 0.04,
    "CLI": 0.02,
}

# Diagnosis groups and invented diagnosis codes.
DIAGNOSIS_GROUPS: dict[str, str] = {
    "RSP": "Respiratoire",
    "DEN": "Dentaire",
    "MSK": "Musculo-squelettique",
    "CAR": "Cardio-vasculaire",
    "DIG": "Digestif",
    "OPH": "Vision",
    "DER": "Peau",
    "PRV": "Prévention",
}

DIAGNOSES: dict[str, str] = {
    "RSP-01": "Infection respiratoire aiguë",
    "RSP-02": "Bronchite",
    "DEN-01": "Carie",
    "DEN-02": "Dent fracturée",
    "MSK-01": "Lombalgie",
    "MSK-02": "Entorse",
    "CAR-01": "Hypertension suivie",
    "CAR-02": "Palpitations",
    "DIG-01": "Douleur abdominale",
    "DIG-02": "Reflux",
    "OPH-01": "Baisse de l'acuité visuelle",
    "DER-01": "Lésion cutanée",
    "PRV-01": "Bilan de prévention",
}


def diagnosis_group(code: str) -> str:
    return code.split("-", 1)[0]


@dataclass(frozen=True)
class Act:
    code: str
    label: str
    provider_type: str
    base_price: float
    allowed_groups: frozenset[str] | None  # None = compatible with every diagnosis
    repeatable: bool = False  # legitimately billed several times in a few days


ALL = None

ACTS: dict[str, Act] = {
    a.code: a
    for a in [
        Act("CONS-GEN", "Consultation généraliste", "GEN", 28.0, ALL),
        Act("CONS-SPE", "Consultation spécialiste", "SPE", 55.0, ALL),
        Act("DENT-DET", "Détartrage", "DEN", 45.0, frozenset({"DEN"})),
        Act("DENT-CAR", "Soin de carie", "DEN", 75.0, frozenset({"DEN"})),
        Act("DENT-COU", "Couronne dentaire", "DEN", 520.0, frozenset({"DEN"})),
        Act("RADIO-DEN", "Radio dentaire", "DEN", 28.0, frozenset({"DEN"})),
        Act("PHARM-ANTALG", "Antalgique", "PHA", 7.0, ALL, repeatable=True),
        Act("PHARM-ANTIB", "Antibiotique", "PHA", 14.0, frozenset({"RSP", "DEN", "DER"}), repeatable=True),
        Act("PHARM-CHRON", "Traitement de fond cardio", "PHA", 38.0, frozenset({"CAR"}), repeatable=True),
        Act("BIO-SANG", "Bilan sanguin", "LAB", 32.0, ALL),
        Act("RADIO-THX", "Radio du thorax", "RAD", 58.0, frozenset({"RSP", "CAR"})),
        Act("ECHO-ABD", "Échographie abdominale", "RAD", 85.0, frozenset({"DIG"})),
        Act("IRM", "IRM ostéo-articulaire", "RAD", 310.0, frozenset({"MSK"})),
        Act("ECG", "Électrocardiogramme", "SPE", 42.0, frozenset({"CAR", "PRV"})),
        Act("KINE-SEA", "Séance de kinésithérapie", "KIN", 24.0, frozenset({"MSK"}), repeatable=True),
        Act("OPT-EXAM", "Examen de la vue", "SPE", 50.0, frozenset({"OPH"})),
        Act("OPT-LUN", "Lunettes", "OPT", 240.0, frozenset({"OPH"})),
        Act("DERM-EXC", "Exérèse de lésion cutanée", "SPE", 130.0, frozenset({"DER"})),
        Act("ENDO-GAS", "Gastroscopie", "CLI", 230.0, frozenset({"DIG"})),
    ]
}

# Acts considered "costly" for the early-claim scenario.
COSTLY_ACTS: frozenset[str] = frozenset({"DENT-COU", "IRM", "OPT-LUN", "ENDO-GAS", "DERM-EXC"})


def is_coherent(act_code: str, diagnosis_code: str) -> bool:
    allowed = ACTS[act_code].allowed_groups
    return allowed is None or diagnosis_group(diagnosis_code) in allowed


SCENARIOS: dict[int, dict[str, str]] = {
    1: {"key": "prix_gonfle", "label": "Prix gonflé"},
    2: {"key": "doublon_fractionnement", "label": "Doublon ou fractionnement"},
    3: {"key": "multiplication_prestataires", "label": "Multiplication des prestataires"},
    4: {"key": "incoherence_diagnostic_acte", "label": "Incohérence diagnostic / acte"},
    5: {"key": "sinistre_precoce", "label": "Sinistre précoce"},
}

DECISIONS: dict[str, str] = {
    "demander_facture": "Demander la facture détaillée",
    "controle_prestataire": "Contrôle prestataire",
    "controle_medical": "Contrôle médical de l'adhérent",
    "demander_justificatif": "Demander le justificatif médical",
    "verifier_contrat": "Vérifier la date d'effet et la déclaration d'adhésion",
    "aucune_action": "Aucune action",
}
