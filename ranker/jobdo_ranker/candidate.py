"""The candidate side: what the resume and the edited profile say about you.

The extension sends both. The profile wins wherever the two disagree, because
it is what you corrected by hand on the Settings page; the resume text fills
in everything the profile does not mention.
"""
import json
import re
from dataclasses import asdict, dataclass, field

from . import roles
from . import skills as sk
from .jd import LANGUAGES, education_levels
from .text import content_terms

_STATED_YEARS = re.compile(
    r"(\d{1,2})(?:\.\d)?\s*\+?\s*(?:years?|yrs?)\b[^.\n]{0,24}\bexperience\b"
    r"|\bexperience\b[^.\n]{0,24}?(\d{1,2})(?:\.\d)?\s*\+?\s*(?:years?|yrs?)\b",
    re.I,
)
_US_CITIZEN = re.compile(r"u\.?s\.?\s+citizen|us citizenship|united states citizen|green card|permanent resident", re.I)
_US_COUNTRY = {"us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"}


@dataclass
class Candidate:
    years: float
    skills: dict = field(default_factory=dict)    # canonical skill -> years
    custom_skills: list = field(default_factory=list)
    titles: list = field(default_factory=list)
    level: float = 2.0
    education: object = None
    languages: set = field(default_factory=set)
    has_clearance: bool = False
    us_work_ok: bool = False
    terms: list = field(default_factory=list)


def _num(v, default=None):
    try:
        n = float(v)
        return n if n == n and n >= 0 else default  # rejects NaN
    except (TypeError, ValueError):
        return default


def _raw_skills(profile):
    s = profile.get("skills") if isinstance(profile, dict) else None
    return s if isinstance(s, dict) else {}


def custom_skills(profile):
    """Profile skills the taxonomy does not know, matched literally in postings."""
    out = []
    for name in _raw_skills(profile):
        c = sk.canonical(name)
        if c and c not in sk.SKILLS and c not in out:
            out.append(c)
    return out


def to_cache(cand):
    d = asdict(cand)
    d["languages"] = sorted(cand.languages)
    return json.dumps(d, separators=(",", ":"))


def from_cache(raw):
    """A Candidate from its cached form, or None if it is missing or malformed."""
    if not raw:
        return None
    try:
        d = json.loads(raw)
        d["languages"] = set(d.get("languages") or ())
        return Candidate(**d)
    except (TypeError, ValueError):
        return None


def build_candidate(resume_text, profile):
    profile = profile if isinstance(profile, dict) else {}
    text = str(resume_text or "")

    years = _num(profile.get("defaultYears"))
    if not years:
        m = _STATED_YEARS.search(text)
        years = float(m.group(1) or m.group(2)) if m else 2.0

    skills = {}
    custom = custom_skills(profile)
    for name, yrs in _raw_skills(profile).items():
        c = sk.canonical(name)
        if c:
            skills[c] = max(skills.get(c, 0.0), _num(yrs, years) or years)
    # The resume usually names more than the profile's short dictionary knows.
    for name in sk.find_skills(text, custom):
        skills.setdefault(name, years)

    titles = []
    for t in [profile.get("currentTitle")] + list(profile.get("titles") or []):
        t = str(t or "").strip()
        if t and t.lower() not in (x.lower() for x in titles):
            titles.append(t)

    level = roles.level_from_years(years)
    named = roles.title_level(profile.get("currentTitle") or (titles[0] if titles else ""))
    # A "Senior Engineer" title after three years says more than the years do,
    # within reason.
    if named is not None and level is not None and level < named <= level + 1.5:
        level = float(named)

    edu = education_levels(str(profile.get("education") or "") + "\n" + text)

    lower = text.lower()
    languages = {"english"} | {l for l in LANGUAGES if re.search(r"\b" + l + r"\b", lower)}
    has_clearance = bool(re.search(r"(?<!police )clearance", lower))
    country = str(profile.get("country") or "").strip().lower()
    us_work_ok = country in _US_COUNTRY or bool(_US_CITIZEN.search(text))

    terms = content_terms(text)
    if len(terms) < 40:
        # No resume text to speak of: fall back to what the profile says.
        terms += content_terms(" ".join(titles) + " " + " ".join(skills))

    return Candidate(
        years=years, skills=skills, custom_skills=custom, titles=titles,
        level=level if level is not None else 2.0,
        education=max(edu) if edu else None,
        languages=languages, has_clearance=has_clearance, us_work_ok=us_work_ok,
        terms=terms,
    )
