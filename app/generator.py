"""Seeded, deterministic generator of synthetic health-insurance claims.

The generator builds four tables (members, providers, policies, claims) for
the fictional insurer "Mutuelle Exemple", then injects five fraud scenarios.
Each claim line keeps its ground-truth label in ``fraud_scenario`` (0 = none).

``noise_level`` (0 to 1) makes detection harder in two ways:
  * legitimate data gets noisier (price spread, legitimate oddities that look
    like fraud, members who change provider more often);
  * injected fraud gets subtler (smaller price inflation, duplicates spread
    over several days, fewer providers per burst, camouflaged codes, later
    claims after the policy starts).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np
import pandas as pd

from app.catalog import ACTS, COSTLY_ACTS, DIAGNOSES, PROVIDER_TYPE_WEIGHTS, diagnosis_group, is_coherent

PERIOD_START = date(2025, 1, 1)
PERIOD_END = date(2025, 12, 31)
N_DAYS = (PERIOD_END - PERIOD_START).days + 1

DEFAULT_SEED = 42
DEFAULT_SIZE = 20_000
MIN_SIZE = 2_000
MAX_SIZE = 50_000

REGIONS = ["Nord", "Centre", "Sud", "Est", "Ouest"]
FORMULAS = ["Essentiel", "Confort", "Intégral"]

# Base weight of each diagnosis group in an episode of care.
GROUP_WEIGHTS = {"RSP": 0.20, "DEN": 0.15, "MSK": 0.15, "CAR": 0.12, "DIG": 0.10, "OPH": 0.09, "DER": 0.08, "PRV": 0.11}
GROUP_CODES: dict[str, list[str]] = {}
for _code in DIAGNOSES:
    GROUP_CODES.setdefault(diagnosis_group(_code), []).append(_code)


@dataclass
class Dataset:
    seed: int
    size: int
    noise_level: float
    members: pd.DataFrame
    providers: pd.DataFrame
    policies: pd.DataFrame
    claims: pd.DataFrame
    generated_in_s: float = 0.0
    meta: dict = field(default_factory=dict)


def _seasonal_factor(group: str, month: int) -> float:
    if group == "RSP":
        return {12: 1.9, 1: 2.0, 2: 1.7, 3: 1.2, 6: 0.6, 7: 0.5, 8: 0.5}.get(month, 0.9)
    if group == "MSK" and month in (6, 7, 8):
        return 1.2
    if group == "OPH" and month == 9:
        return 1.5  # back-to-school eye tests
    return 1.0


class _Builder:
    def __init__(self, seed: int, size: int, noise: float):
        self.rng = np.random.default_rng(seed)
        self.seed = seed
        self.size = size
        self.noise = noise
        self.scale = size / DEFAULT_SIZE
        self.lines: list[dict] = []

    # ------------------------------------------------------------------ tables
    def build_providers(self) -> None:
        rng = self.rng
        n = max(60, int(160 * self.scale**0.5))
        types = list(PROVIDER_TYPE_WEIGHTS)
        weights = np.array(list(PROVIDER_TYPE_WEIGHTS.values()))
        drawn = rng.choice(types, size=n, p=weights / weights.sum())
        # Guarantee enough providers of each type for the scenarios.
        minimum = {"GEN": 12, "PHA": 10, "SPE": 6, "DEN": 5, "RAD": 3, "KIN": 3, "OPT": 2, "LAB": 2, "CLI": 2}
        extra = [t for t, m in minimum.items() for _ in range(max(0, m - int((drawn == t).sum())))]
        all_types = list(drawn) + extra
        rows = []
        for i, t in enumerate(all_types, start=1):
            rows.append(
                {
                    "provider_id": f"P{i:04d}",
                    "provider_type": t,
                    "region": REGIONS[int(rng.integers(0, len(REGIONS)))],
                    "price_factor": float(np.exp(rng.normal(0, 0.07))),
                }
            )
        self.providers = pd.DataFrame(rows)
        self.by_type: dict[str, list[str]] = {
            t: self.providers.loc[self.providers.provider_type == t, "provider_id"].tolist() for t in PROVIDER_TYPE_WEIGHTS
        }
        self.price_factor = dict(zip(self.providers.provider_id, self.providers.price_factor, strict=True))
        self.ptype = dict(zip(self.providers.provider_id, self.providers.provider_type, strict=True))

    def build_members_and_policies(self) -> None:
        rng = self.rng
        n = max(300, int(self.size / 7))
        members, policies = [], []
        for i in range(1, n + 1):
            mid = f"M{i:05d}"
            birth_year = int(rng.integers(1940, 2006))
            members.append(
                {
                    "member_id": mid,
                    "birth_year": birth_year,
                    "region": REGIONS[int(rng.integers(0, len(REGIONS)))],
                    "pref_GEN": self._pick("GEN"),
                    "pref_PHA": self._pick("PHA"),
                    "pref_DEN": self._pick("DEN"),
                }
            )
            if rng.random() < 0.22:  # joined during the observed year
                start = PERIOD_START + timedelta(days=int(rng.integers(0, 320)))
            else:
                start = date(2019, 1, 1) + timedelta(days=int(rng.integers(0, (PERIOD_START - date(2019, 1, 1)).days)))
            policies.append(
                {
                    "policy_id": f"C{i:05d}",
                    "member_id": mid,
                    "start_date": start,
                    "formula": FORMULAS[int(rng.integers(0, 3))],
                }
            )
        self.members = pd.DataFrame(members)
        self.policies = pd.DataFrame(policies)
        self.member_rows = self.members.to_dict("records")
        self.policy_of = {p["member_id"]: p for p in policies}
        self.start_day = {p["member_id"]: (p["start_date"] - PERIOD_START).days for p in policies}
        age = 2025 - self.members.birth_year.to_numpy()
        active = np.array([N_DAYS - max(0, self.start_day[m]) for m in self.members.member_id]) / N_DAYS
        w = (0.6 + age / 60.0) * active
        self.member_weights = w / w.sum()

    # ----------------------------------------------------------------- helpers
    def _pick(self, ptype: str) -> str:
        options = self.by_type[ptype]
        return options[int(self.rng.integers(0, len(options)))]

    def _provider_for(self, member: dict, ptype: str) -> str:
        pref = member.get(f"pref_{ptype}")
        p_pref = 0.85 - 0.25 * self.noise
        if pref is not None and self.rng.random() < p_pref:
            return pref
        return self._pick(ptype)

    def _price(self, act_code: str, provider_id: str) -> float:
        sigma = 0.08 + 0.22 * self.noise
        return ACTS[act_code].base_price * self.price_factor[provider_id] * float(np.exp(self.rng.normal(0, sigma)))

    def _line(
        self,
        member: dict,
        day: int,
        provider_id: str,
        act: str,
        diag: str,
        amount: float | None = None,
        scenario: int = 0,
        note: str = "",
        oddity: str = "",
    ) -> dict:
        if amount is None:
            amount = self._price(act, provider_id)
        return {
            "member_id": member["member_id"],
            "provider_id": provider_id,
            "day": int(day),
            "diagnosis_code": diag,
            "act_code": act,
            "billed_amount": round(float(amount), 2),
            "fraud_scenario": scenario,
            "fraud_note": note,
            "legit_oddity": oddity,
        }

    def _random_member(self) -> dict:
        return self.member_rows[int(self.rng.choice(len(self.member_rows), p=self.member_weights))]

    def _random_day_for(self, member: dict, earliest: int = 0, latest: int = N_DAYS - 1) -> int | None:
        lo = max(earliest, self.start_day[member["member_id"]], 0)
        if lo > latest:
            return None
        return int(self.rng.integers(lo, latest + 1))

    # ---------------------------------------------------------- legit episodes
    def episode(self, member: dict, day: int, group: str | None = None, force_costly: bool = False) -> list[dict]:
        rng = self.rng
        month = (PERIOD_START + timedelta(days=day)).month
        if group is None:
            groups = list(GROUP_WEIGHTS)
            w = np.array([GROUP_WEIGHTS[g] * _seasonal_factor(g, month) for g in groups])
            group = groups[int(rng.choice(len(groups), p=w / w.sum()))]
        codes = GROUP_CODES[group]
        diag = codes[int(rng.integers(0, len(codes)))]
        out: list[dict] = []

        def add(act: str, delay: int = 0, ptype: str | None = None, oddity: str = "") -> str | None:
            d = day + delay
            if d >= N_DAYS:
                return None
            prov = self._provider_for(member, ptype or ACTS[act].provider_type)
            amount = self._price(act, prov)
            if not oddity and rng.random() < 0.004 + 0.02 * self.noise:
                amount *= rng.uniform(1.8, 3.0)
                oddity = "cas complexe facturé plus cher"
            out.append(self._line(member, d, prov, act, diag, amount, oddity=oddity))
            return prov

        def chance(p: float) -> bool:
            return force_costly or rng.random() < p

        if group == "DEN":
            dentist = self._provider_for(member, "DEN")
            for act, p in (("DENT-DET", 0.4), ("DENT-CAR", 0.5), ("RADIO-DEN", 0.3)):
                if rng.random() < p:
                    out.append(self._line(member, day, dentist, act, diag))
            if not out:
                out.append(self._line(member, day, dentist, "DENT-CAR", diag))
            if out[-1]["act_code"] == "DENT-CAR" and rng.random() < 0.04 + 0.12 * self.noise:
                out.append(self._line(member, day, dentist, "DENT-CAR", diag, oddity="deux dents soignées le même jour"))
            if chance(0.12):
                out.append(self._line(member, min(day + int(rng.integers(7, 30)), N_DAYS - 1), dentist, "DENT-COU", diag))
            if rng.random() < 0.3:
                add("PHARM-ANTALG")
            if rng.random() < 0.2:
                add("PHARM-ANTIB")
        elif group == "OPH":
            add("OPT-EXAM")
            if chance(0.45):
                add("OPT-LUN", delay=int(rng.integers(2, 20)))
        else:
            add("CONS-SPE" if group in ("CAR", "DER") and rng.random() < 0.6 else "CONS-GEN")
            if group == "RSP":
                if rng.random() < 0.6:
                    add("PHARM-ANTIB")
                if rng.random() < 0.5:
                    add("PHARM-ANTALG")
                if rng.random() < 0.15:
                    add("RADIO-THX", delay=int(rng.integers(0, 5)))
            elif group == "MSK":
                if rng.random() < 0.6:
                    add("PHARM-ANTALG")
                if chance(0.12):
                    add("IRM", delay=int(rng.integers(3, 25)))
                if rng.random() < 0.35:
                    kine = self._provider_for(member, "KIN")
                    d = day + int(rng.integers(3, 10))
                    for _ in range(int(rng.integers(3, 9))):
                        if d >= N_DAYS:
                            break
                        out.append(self._line(member, d, kine, "KINE-SEA", diag))
                        d += int(rng.integers(2 - round(self.noise), 5))
            elif group == "CAR":
                if rng.random() < 0.5:
                    add("ECG")
                if rng.random() < 0.7:
                    add("PHARM-CHRON")
                if rng.random() < 0.5:
                    add("BIO-SANG", delay=int(rng.integers(0, 4)))
                if rng.random() < 0.1:
                    add("RADIO-THX", delay=int(rng.integers(1, 10)))
            elif group == "DIG":
                if rng.random() < 0.3:
                    add("ECHO-ABD", delay=int(rng.integers(1, 12)))
                if chance(0.08):
                    add("ENDO-GAS", delay=int(rng.integers(5, 30)))
                if rng.random() < 0.4:
                    add("BIO-SANG", delay=int(rng.integers(0, 4)))
                if rng.random() < 0.3:
                    add("PHARM-ANTALG")
            elif group == "DER":
                if chance(0.25):
                    add("DERM-EXC", delay=int(rng.integers(0, 20)))
                if rng.random() < 0.2:
                    add("PHARM-ANTIB")
            elif group == "PRV":
                if rng.random() < 0.7:
                    add("BIO-SANG", delay=int(rng.integers(0, 4)))
                if rng.random() < 0.2:
                    add("ECG")
        return out

    def build_legit(self, n_target: int) -> None:
        rng = self.rng
        while len(self.lines) < n_target:
            member = self._random_member()
            day = self._random_day_for(member)
            if day is None:
                continue
            self.lines.extend(self.episode(member, day))
        # Legitimate coding errors: a random diagnosis code that may not match the act.
        p_err = 0.002 + 0.015 * self.noise
        codes = list(DIAGNOSES)
        for line in self.lines:
            if rng.random() < p_err:
                line["diagnosis_code"] = codes[int(rng.integers(0, len(codes)))]
                line["legit_oddity"] = "erreur de codage du diagnostic"
        # Anti-selection: people who join because they need care soon (legitimate).
        newcomers = [m for m in self.member_rows if self.start_day[m["member_id"]] >= 0]
        for _ in range(round((12 + 60 * self.noise) * self.scale)):
            if not newcomers:
                break
            m = newcomers[int(rng.integers(0, len(newcomers)))]
            d = self.start_day[m["member_id"]] + int(rng.integers(0, 25))
            if d >= N_DAYS:
                continue
            group = ["DEN", "OPH", "MSK", "DIG", "DER"][int(rng.integers(0, 5))]
            for line in self.episode(m, d, group=group, force_costly=True):
                if line["act_code"] in COSTLY_ACTS:
                    line["legit_oddity"] = line["legit_oddity"] or "besoin de soins dès l'adhésion"
                self.lines.append(line)

    # --------------------------------------------------------------- scenarios
    def inject_s1_inflated_price(self) -> None:
        rng = self.rng
        n = round(300 * self.scale)
        complicit = set(rng.choice([p for t in ("GEN", "SPE", "DEN", "RAD", "OPT") for p in self.by_type[t]], 6, replace=False))
        self.complicit_providers = sorted(complicit)
        candidates = [
            i
            for i, ln in enumerate(self.lines)
            if ln["fraud_scenario"] == 0 and ln["day"] >= 45 and ACTS[ln["act_code"]].base_price >= 20 and not ln["legit_oddity"]
        ]
        from_complicit = [i for i in candidates if self.lines[i]["provider_id"] in complicit]
        others = [i for i in candidates if self.lines[i]["provider_id"] not in complicit]
        k1 = min(len(from_complicit), n // 2)
        chosen = list(rng.choice(from_complicit, k1, replace=False)) if k1 else []
        chosen += list(rng.choice(others, min(len(others), n - k1), replace=False))
        for i in chosen:
            ln = self.lines[int(i)]
            factor = 1 + rng.uniform(1.0, 3.0) * (1 - 0.75 * self.noise)
            ln["billed_amount"] = round(ln["billed_amount"] * factor, 2)
            ln["fraud_scenario"] = 1
            ln["fraud_note"] = f"montant multiplié par {factor:.1f}"

    def inject_s2_double_or_split(self) -> None:
        rng = self.rng
        n = round(110 * self.scale)
        pool = [
            i
            for i, ln in enumerate(self.lines)
            if ln["fraud_scenario"] == 0
            and not ACTS[ln["act_code"]].repeatable
            and not ln["legit_oddity"]
            and ln["day"] < N_DAYS - 6
        ]
        costly_pool = [i for i in pool if self.lines[i]["billed_amount"] >= 90]
        new_lines, removed, used = [], set(), set()
        max_shift = round(4 * self.noise)
        for k in range(n):
            if k % 5 < 3:  # 60 % duplicates
                i = int(rng.choice(pool))
                if i in used:
                    continue
                used.add(i)
                src = self.lines[i]
                dup = dict(src)
                dup["day"] = src["day"] + int(rng.integers(0, max_shift + 1))
                if rng.random() < 0.5 * self.noise:
                    dup["billed_amount"] = round(src["billed_amount"] * rng.uniform(0.93, 1.07), 2)
                dup.update(fraud_scenario=2, fraud_note="doublon d'une facture déjà payée", legit_oddity="")
                new_lines.append(dup)
            else:  # 40 % split billing
                i = int(rng.choice(costly_pool))
                if i in used:
                    continue
                used.add(i)
                removed.add(i)
                src = self.lines[i]
                pieces = int(rng.integers(2, 4))
                shares = rng.dirichlet(np.full(pieces, 6.0))
                for s in shares:
                    piece = dict(src)
                    piece["day"] = src["day"] + int(rng.integers(0, max_shift + 1))
                    piece["billed_amount"] = round(src["billed_amount"] * float(s), 2)
                    piece.update(fraud_scenario=2, fraud_note=f"facture coupée en {pieces} morceaux", legit_oddity="")
                    new_lines.append(piece)
        self.lines = [ln for i, ln in enumerate(self.lines) if i not in removed] + new_lines

    def inject_s3_provider_multiplication(self) -> None:
        rng = self.rng
        n = round(30 * self.scale)
        eligible = [m for m in self.member_rows if self.start_day[m["member_id"]] < 20]
        idx = rng.choice(len(eligible), min(n, len(eligible)), replace=False)
        for j in idx:
            m = eligible[int(j)]
            visits = int(rng.integers(3, 5))
            if rng.random() < 0.6 * self.noise:
                visits -= 1
            span = 4 + int(rng.integers(0, 6 + round(26 * self.noise)))
            d0 = int(rng.integers(40, N_DAYS - span - 1))
            gens = [g for g in self.by_type["GEN"] if g != m["pref_GEN"]]
            phas = [p for p in self.by_type["PHA"] if p != m["pref_PHA"]]
            gsel = rng.choice(gens, visits, replace=False)
            psel = rng.choice(phas, visits, replace=False)
            days = sorted(int(x) for x in rng.integers(d0, d0 + span + 1, size=visits))
            diag = "MSK-01" if rng.random() < 0.6 else "RSP-02"
            drug = "PHARM-ANTALG" if diag == "MSK-01" else "PHARM-ANTIB"
            for g, p, d in zip(gsel, psel, days, strict=True):
                note = f"{visits} médecins différents en {span} jours"
                self.lines.append(self._line(m, d, str(g), "CONS-GEN", diag, scenario=3, note=note))
                self.lines.append(self._line(m, d, str(p), drug, diag, scenario=3, note=note))

    def inject_s4_incoherence(self) -> None:
        rng = self.rng
        n = round(170 * self.scale)
        acts = [a for a in ACTS.values() if a.allowed_groups is not None]
        weights = np.array([a.base_price for a in acts]) ** 0.5
        codes = list(DIAGNOSES)
        for _ in range(n):
            m = self._random_member()
            day = self._random_day_for(m)
            if day is None:
                continue
            act = acts[int(rng.choice(len(acts), p=weights / weights.sum()))]
            camouflaged = rng.random() < 0.7 * self.noise
            options = [c for c in codes if is_coherent(act.code, c) == camouflaged]
            diag = options[int(rng.integers(0, len(options)))]
            prov = self._pick(act.provider_type)
            note = "diagnostic plausible choisi pour masquer l'acte" if camouflaged else "acte sans rapport avec le diagnostic"
            self.lines.append(self._line(m, day, prov, act.code, diag, scenario=4, note=note))

    def inject_s5_early_claim(self) -> None:
        rng = self.rng
        n = round(110 * self.scale)
        newcomers = [m for m in self.member_rows if 0 <= self.start_day[m["member_id"]] < N_DAYS - 20]
        costly = sorted(COSTLY_ACTS)
        for _ in range(n):
            m = newcomers[int(rng.integers(0, len(newcomers)))]
            delay = int(rng.integers(0, 15 + round(60 * self.noise)))
            day = self.start_day[m["member_id"]] + delay
            if day >= N_DAYS:
                continue
            act = ACTS[costly[int(rng.integers(0, len(costly)))]]
            diag_options = [c for c in DIAGNOSES if is_coherent(act.code, c)]
            diag = diag_options[int(rng.integers(0, len(diag_options)))]
            prov = self._pick(act.provider_type)
            amount = self._price(act.code, prov) * rng.uniform(1.0, 1.3)
            self.lines.append(
                self._line(m, day, prov, act.code, diag, amount, scenario=5, note=f"soin coûteux {delay} jours après l'adhésion")
            )

    # ----------------------------------------------------------------- output
    def claims_frame(self) -> pd.DataFrame:
        df = pd.DataFrame(self.lines)
        df["seq"] = np.arange(len(df))
        df = df[df.day.between(0, N_DAYS - 1)]
        start = df.member_id.map(self.start_day)
        df = df[df.day >= start].sort_values(["day", "member_id", "provider_id", "act_code", "seq"], kind="stable")
        df = df.drop(columns="seq").reset_index(drop=True)
        df.insert(0, "line_id", np.arange(1, len(df) + 1))
        df["provider_type"] = df.provider_id.map(self.ptype)
        df["policy_id"] = df.member_id.map(lambda m: self.policy_of[m]["policy_id"])
        df["policy_start_day"] = df.member_id.map(self.start_day).astype(int)
        df["service_date"] = pd.Timestamp(PERIOD_START) + pd.to_timedelta(df.day, unit="D")
        df["fraud_scenario"] = df.fraud_scenario.astype(int)
        return df


def generate(seed: int = DEFAULT_SEED, size: int = DEFAULT_SIZE, noise_level: float = 0.2) -> Dataset:
    """Build a full synthetic dataset. Same arguments always give the same data."""
    if not MIN_SIZE <= size <= MAX_SIZE:
        raise ValueError(f"size must be between {MIN_SIZE} and {MAX_SIZE}")
    if not 0.0 <= noise_level <= 1.0:
        raise ValueError("noise_level must be between 0 and 1")
    t0 = time.perf_counter()
    b = _Builder(seed, size, noise_level)
    b.build_providers()
    b.build_members_and_policies()
    expected_fraud = round((300 + 2.2 * 110 + 7 * 30 + 170 + 110) * b.scale)
    b.build_legit(size - expected_fraud)
    b.inject_s1_inflated_price()
    b.inject_s2_double_or_split()
    b.inject_s3_provider_multiplication()
    b.inject_s4_incoherence()
    b.inject_s5_early_claim()
    claims = b.claims_frame()
    policies = b.policies.copy()
    policies["start_date"] = pd.to_datetime(policies.start_date)
    members = b.members.drop(columns=["pref_GEN", "pref_PHA", "pref_DEN"])
    return Dataset(
        seed=seed,
        size=size,
        noise_level=noise_level,
        members=members,
        providers=b.providers.drop(columns="price_factor"),
        policies=policies,
        claims=claims,
        generated_in_s=time.perf_counter() - t0,
        meta={"complicit_providers": b.complicit_providers},
    )
