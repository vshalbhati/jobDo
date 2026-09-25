"""Turns a parsed posting and a candidate into a 0-100 score and a verdict.

The score is a weighted average of independent components, each 0..1. A
component the posting gives no information about (no years mentioned, no
degree asked for) is left out and the rest are re-weighted, rather than being
guessed at: a missing signal should not drag a good match down, or prop a bad
one up.

On top of the average sit two kinds of rule:
  - caps, for a match that averages well but fails badly on one axis
    (knowing none of the required skills is not offset by a nice title);
  - knockouts, for postings you cannot get whatever the score says
    (a security clearance, a language you do not speak).
"""
from . import roles
from . import skills as sk
from .text import clamp

WEIGHTS = {
    "skills": 35,       # required skills covered
    "experience": 20,   # years asked for vs years you have
    "title": 15,        # same line of work, same kind of title
    "seniority": 10,    # level of the role vs your level
    "similarity": 10,   # overall text similarity, resume vs posting
    "preferred": 5,     # nice-to-have skills covered
    "education": 5,     # degree asked for vs degree held
}

LOW_CONFIDENCE_MARGIN = 10  # a thin posting must clear the bar by this much
EVIDENCE_FULL = 70         # component weight needed before a score can use the full range


def _credit(skill, cand):
    """1.0 for a skill you have; partial for a close relative; 0 otherwise."""
    if skill in cand.skills:
        return 1.0, None
    best, via = 0.0, None
    for have in cand.skills:
        r = sk.related(have, skill)
        if r > best:
            best, via = r, have
    return best, via


def _coverage(wanted, cand, skill_years, smoothing):
    """Weighted share of the wanted skills covered, plus what was matched and missed."""
    num = den = 0.0
    matched, missing, partial, short = [], [], [], []
    for skill, weight in sorted(wanted.items(), key=lambda kv: -kv[1]):
        credit, via = _credit(skill, cand)
        need = skill_years.get(skill)
        if credit >= 1.0 and need:
            have = cand.skills.get(skill, cand.years)
            if have + 1 < need:
                credit = 0.6 if have + 3 >= need else 0.35
                short.append((skill, need, have))
        if credit >= 1.0 or (credit >= 0.6 and not via):
            matched.append(skill)
        elif credit > 0:
            partial.append((skill, via))
        else:
            missing.append(skill)
        num += weight * credit
        den += weight
    if den == 0:
        return None, None, matched, missing, partial, short
    raw = num / den
    # Smoothing pulls postings that name only one or two skills toward the
    # middle: matching the only skill named is weak evidence of a great fit.
    smoothed = (num + 0.5 * smoothing) / (den + smoothing)
    return smoothed, raw, matched, missing, partial, short


def _experience(job, cand):
    lo, hi, have = job.years_min, job.years_max, cand.years
    if lo is None:
        return None
    if have + 0.5 >= lo:
        if hi is not None and have > hi + 2:
            return 0.85 if have - hi <= 4 else 0.6
        return 1.0
    gap = lo - have
    if gap <= 1:
        return 0.75
    if gap <= 2:
        return 0.5
    if gap <= 3:
        return 0.25
    return 0.05


def _seniority(job, cand):
    if job.level is None:
        return None
    diff = job.level - cand.level  # positive: the role is more senior than you
    if diff <= -2.5:
        return 0.35
    if diff <= -1.5:
        return 0.65
    if diff <= 0.75:
        return 1.0
    if diff <= 1.5:
        return 0.55
    if diff <= 2.5:
        return 0.2
    return 0.0


def _title(job, cand):
    fam = roles.family_fit(job.title, cand.titles)
    overlap = roles.title_overlap(job.title, cand.titles) if cand.titles else None
    tech = None
    if job.title_skills:
        tech = sum(_credit(s, cand)[0] for s in job.title_skills) / len(job.title_skills)
    parts = [(fam, 0.55), (overlap, 0.25), (tech, 0.2)]
    have = [(v, w) for v, w in parts if v is not None]
    if not have:
        return None, fam
    return sum(v * w for v, w in have) / sum(w for _, w in have), fam


def _education(job, cand):
    if job.education is None or job.education_flexible:
        return None
    if cand.education is None:
        return 0.7
    gap = job.education - cand.education
    if gap <= 0:
        return 1.0
    return 0.45 if gap == 1 else 0.15


def _similarity(cos):
    if cos is None:
        return None
    # TF-IDF cosine between a resume and a posting in the same field lands
    # around 0.15-0.35; unrelated ones sit below 0.05.
    return clamp((cos - 0.03) / 0.25)


def score(job, cand, cos, threshold):
    comps = {
        "skills": None, "experience": _experience(job, cand), "title": None,
        "seniority": _seniority(job, cand), "similarity": _similarity(cos),
        "preferred": None, "education": _education(job, cand),
    }
    req_s, req_raw, matched, missing, partial, short = _coverage(job.required, cand, job.skill_years, 1.0)
    comps["skills"] = req_s
    pref_s, _, pref_matched, _, _, _ = _coverage(job.preferred, cand, {}, 0.5)
    comps["preferred"] = pref_s
    comps["title"], fam = _title(job, cand)

    present = {k: v for k, v in comps.items() if v is not None}
    total_w = sum(WEIGHTS[k] for k in present)
    value = 100.0 * sum(WEIGHTS[k] * v for k, v in present.items()) / total_w if total_w else 50.0
    # Little evidence, little movement: a posting that only has a title can
    # score a perfect title match, which says almost nothing. Scores built on
    # under EVIDENCE_FULL points of weight are pulled toward 50.
    value = 50.0 + (value - 50.0) * min(1.0, total_w / EVIDENCE_FULL)

    # ---- caps --------------------------------------------------------------
    caps = []
    if req_raw is not None and len(job.required) >= 4 and req_raw < 0.35:
        caps.append((50, "covers few of the key skills"))
    if job.years_min is not None and job.years_min - cand.years >= 3:
        caps.append((50, "well short of the experience asked for"))
    if fam is not None and fam <= 0.1:
        caps.append((45, "a different line of work"))
    for cap, _ in caps:
        value = min(value, cap)

    # ---- knockouts ---------------------------------------------------------
    knockouts = []
    if job.needs_clearance and not cand.has_clearance:
        knockouts.append("needs a security clearance")
    if job.needs_citizenship and not cand.us_work_ok:
        knockouts.append("US citizens only")
    for lang in job.languages:
        if lang not in cand.languages:
            knockouts.append("needs fluent " + lang.capitalize())
    if job.years_min is not None and job.years_min - cand.years >= 5:
        knockouts.append("asks for %g+ years, you have %g" % (job.years_min, cand.years))
    if job.level == 0 and cand.years >= 3:
        knockouts.append("an internship")
    if knockouts:
        value = min(value, 15.0)

    # ---- confidence --------------------------------------------------------
    named = len(job.required) + len(job.preferred)
    if job.length < 250:
        confidence = "low"
    elif job.length >= 800 and named >= 3:
        confidence = "high"
    else:
        confidence = "medium"

    final = int(round(clamp(value, 0, 100)))
    bar = threshold + (LOW_CONFIDENCE_MARGIN if confidence == "low" else 0)
    verdict = "apply" if not knockouts and final >= bar else "skip"

    reasons = _reasons(job, cand, comps, matched, missing, partial, short, fam, knockouts, caps, confidence)
    return {
        "score": final,
        "verdict": verdict,
        "confidence": confidence,
        "reasons": reasons,
        "breakdown": {k: (None if v is None else int(round(v * 100))) for k, v in comps.items()},
        "matched_skills": matched + [s for s in pref_matched if s not in matched],
        "missing_skills": missing,
        "knockouts": knockouts,
        "years_asked": None if job.years_min is None else [job.years_min, job.years_max],
    }


def _fmt_years(lo, hi):
    if hi is not None:
        return "%g-%gy" % (lo, hi)
    return "%g+y" % lo


def _reasons(job, cand, comps, matched, missing, partial, short, fam, knockouts, caps, confidence):
    out = list(knockouts)
    n_req = len(job.required)
    if n_req:
        s = "%d/%d key skills" % (len(matched), n_req)
        if missing:
            s += " (missing " + ", ".join(missing[:3]) + ("..." if len(missing) > 3 else "") + ")"
        out.append(s)
    elif comps["skills"] is None:
        out.append("no recognisable skills in the posting")
    for skill, need, have in short[:2]:
        out.append("%s: asks %g+y, you have %g" % (skill, need, have))
    if job.years_min is not None:
        out.append("asks %s, you have %gy" % (_fmt_years(job.years_min, job.years_max), cand.years))
    if fam is not None and fam < 0.5 and job.families:
        out.append("title is %s work" % job.families[0])
    if comps["seniority"] is not None and comps["seniority"] < 0.6:
        out.append("%s role vs your level" % roles.LEVEL_NAMES[min(6, int(job.level))])
    if comps["education"] is not None and comps["education"] < 0.6:
        out.append("asks for a " + {1: "bachelor's", 2: "master's", 3: "doctorate"}[job.education])
    for _, why in caps:
        if why not in out:
            out.append(why)
    if confidence == "low":
        out.append("thin description, judged cautiously")
    return out
