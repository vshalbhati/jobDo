"""Job titles: which line of work a title belongs to, and how senior it is."""
import re

from .text import tokens

# Order matters: the first family whose pattern matches is the primary one,
# so narrow families sit above broad ones ("data engineer" before "engineer").
_FAMILIES = [
    ("security", r"security|cyber|appsec|soc analyst|penetration|pentest|infosec|threat"),
    ("qa", r"\bqa\b|quality assurance|\btest(ing|er)?\b|sdet|automation engineer|\bqe\b|quality engineer"),
    ("mobile", r"android|\bios\b|mobile|flutter|react native"),
    ("data-science", r"data scien|machine learning|\bml\b|\bai\b|deep learning|\bnlp\b|computer vision|applied scien|research scien|\bllm\b|genai|generative"),
    ("data-eng", r"data engineer|big data|etl|analytics engineer|data platform|data warehouse|\bdwh\b|databricks|spark"),
    ("data-analyst", r"data analyst|business analyst|\bbi\b|business intelligence|analytics|reporting analyst|insights analyst|mis\b"),
    ("devops", r"devops|dev ops|site reliability|\bsre\b|platform engineer|cloud engineer|infrastructure|systems engineer|build engineer|release engineer|kubernetes"),
    ("embedded", r"embedded|firmware|hardware|fpga|vlsi|iot"),
    ("software", r"software|developer|programmer|\bsde\b|\bswe\b|engineer|frontend|front end|front-end|backend|back end|back-end|full ?stack|full-stack|web dev|application dev|\bjava\b|python|\.net|golang|node|react|angular"),
    ("product", r"product manager|product owner|\bpm\b|product lead|head of product"),
    ("project", r"project manager|program manager|delivery manager|scrum master|pmo"),
    ("design", r"designer|\bux\b|\bui\b|user experience|product design|visual design|graphic"),
    ("sales", r"sales|business development|account executive|\bbde\b|\bsdr\b|\bbdr\b|inside sales"),
    ("customer", r"customer success|account manager|customer support|customer service|client servic|support engineer|technical support|helpdesk|help desk"),
    ("marketing", r"marketing|\bseo\b|content|growth|brand|social media|copywriter|communications"),
    ("finance", r"financ|accountant|accounting|audit|tax|\bfp&a\b|treasury|controller|credit analyst|investment"),
    ("hr", r"\bhr\b|human resources|recruit|talent acquisition|people partner|people operations|payroll"),
    ("operations", r"operations|supply chain|logistics|procurement|purchase|warehouse|inventory"),
    ("consulting", r"consultant|consulting|advisory"),
]
_FAMILY_RE = [(name, re.compile(pat, re.I)) for name, pat in _FAMILIES]

# How much experience in one family transfers to another (symmetric).
_ADJACENT = {
    frozenset(("software", "mobile")): 0.6,
    frozenset(("software", "devops")): 0.5,
    frozenset(("software", "qa")): 0.4,
    frozenset(("software", "data-eng")): 0.5,
    frozenset(("software", "embedded")): 0.4,
    frozenset(("software", "data-science")): 0.3,
    frozenset(("data-science", "data-eng")): 0.6,
    frozenset(("data-science", "data-analyst")): 0.5,
    frozenset(("data-eng", "data-analyst")): 0.5,
    frozenset(("data-eng", "devops")): 0.3,
    frozenset(("devops", "security")): 0.4,
    frozenset(("qa", "devops")): 0.2,
    frozenset(("product", "project")): 0.5,
    frozenset(("product", "design")): 0.3,
    frozenset(("product", "data-analyst")): 0.3,
    frozenset(("sales", "customer")): 0.5,
    frozenset(("sales", "marketing")): 0.4,
    frozenset(("marketing", "design")): 0.3,
    frozenset(("finance", "data-analyst")): 0.3,
    frozenset(("consulting", "project")): 0.3,
    frozenset(("consulting", "data-analyst")): 0.3,
    frozenset(("operations", "project")): 0.3,
}


def families(title):
    """Every family a title belongs to, most specific first."""
    t = str(title or "")
    return [name for name, rx in _FAMILY_RE if rx.search(t)]


def family_fit(job_title, candidate_titles):
    """0..1 for how well the candidate's line of work fits the posting.

    None when the posting's family is unknowable from its title.
    """
    job = families(job_title)
    if not job:
        return None
    mine = []
    for t in candidate_titles:
        mine.extend(f for f in families(t) if f not in mine)
    if not mine:
        return None
    primary = job[0]
    if primary in mine:
        return 1.0
    # Matching a secondary family (a "Python Data Engineer" for a software
    # engineer) is close to a full match.
    if any(f in mine for f in job[1:]):
        return 0.8
    return max((_ADJACENT.get(frozenset((primary, m)), 0.1) for m in mine), default=0.1)


# ------------------------------------------------------------------ seniority

# 0 intern, 1 junior, 2 mid, 3 senior, 4 lead/staff, 5 principal/manager of managers, 6 director+
_LEVELS = [
    (6, r"\b(director|vp|vice president|head of|chief|cto|ceo|cfo|coo)\b"),
    (5, r"\b(principal|distinguished|senior manager|sr\.? manager|engineering manager|group manager)\b"),
    # Not "manager": a Product or Account Manager is a mid-level role.
    (4, r"\b(staff|lead|architect|tech lead|team lead)\b"),
    (3, r"\b(senior|sr\.?|iii|sde[\s-]?(3|iii)|level 3|l5)\b"),
    (1, r"\b(junior|jr\.?|entry[\s-]level|graduate|grad|associate|trainee|fresher|apprentice|sde[\s-]?(1|i)|level 1|i)\b"),
    (0, r"\b(intern|internship|co-?op|summer student)\b"),
    (2, r"\b(ii|sde[\s-]?(2|ii)|level 2|mid[\s-]?level|intermediate)\b"),
]
_LEVEL_RE = [(lvl, re.compile(pat, re.I)) for lvl, pat in _LEVELS]

LEVEL_NAMES = ["intern", "junior", "mid-level", "senior", "lead", "principal", "director"]


def title_level(title):
    """Seniority named in a title, or None if the title does not say."""
    t = str(title or "")
    for lvl, rx in _LEVEL_RE:
        if rx.search(t):
            # "Associate Director" is a director; "Associate Engineer" is junior.
            return lvl
    return None


def level_from_years(years):
    if years is None:
        return None
    if years < 1:
        return 1
    if years < 3:
        return 1.5
    if years < 5:
        return 2.5
    if years < 8:
        return 3
    if years < 12:
        return 4
    return 4.5


def years_for_level(level):
    """The experience a posting of this level usually expects, as (min, max)."""
    return {0: (0, 1), 1: (0, 2), 2: (2, 5), 3: (5, 9), 4: (7, 12), 5: (10, 20), 6: (12, 30)}.get(level)


# --------------------------------------------------------------- title words

_TITLE_SYNONYMS = {
    "developer": "engineer", "programmer": "engineer", "dev": "engineer", "swe": "engineer",
    "sde": "engineer", "frontend": "front", "front-end": "front", "backend": "back",
    "back-end": "back", "fullstack": "full", "full-stack": "full", "reactjs": "react",
    "react.js": "react", "nodejs": "node", "node.js": "node", "golang": "go",
    "ml": "machine", "ai": "machine", "k8s": "kubernetes", "qa": "quality", "sdet": "quality",
    "ui": "design", "ux": "design", "mgr": "manager",
}
_TITLE_NOISE = frozenset("""
senior sr jr junior lead staff principal i ii iii iv level associate intern trainee
remote hybrid onsite contract full time part permanent temporary urgent hiring immediate joiner joiners
and or of the for in at with to a an
""".split())


def title_terms(title):
    out = set()
    for t in tokens(title):
        t = _TITLE_SYNONYMS.get(t, t)
        if t in _TITLE_NOISE or len(t) < 2 or t.isdigit():
            continue
        out.add(t)
    return out


def title_overlap(job_title, candidate_titles):
    """Best share of the posting's title words found in one of the candidate's titles."""
    job = title_terms(job_title)
    if not job:
        return None
    best = 0.0
    for t in candidate_titles:
        mine = title_terms(t)
        if mine:
            best = max(best, len(job & mine) / len(job))
    return best
