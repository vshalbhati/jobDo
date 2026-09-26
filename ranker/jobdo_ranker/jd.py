"""Reads a job posting.

What comes out: the skills it requires versus merely likes, how many years of
experience it asks for (overall and per skill), what degree, how senior the
role is, and anything that rules a candidate out regardless of fit.

Postings are written in every format imaginable, so everything here degrades
gracefully: no headings means sentence-level cues decide, no line breaks means
headings are found inline, and a posting that says nothing about experience
simply has no experience requirement rather than a guessed one.
"""
import bisect
import re
import json
from dataclasses import asdict, dataclass, field

from . import roles
from . import skills as sk
from .text import STOPWORDS

# How much a skill mention counts, by where in the posting it appears.
SECTION_WEIGHT = {"required": 1.0, "duties": 0.75, "general": 0.7, "preferred": 0.35, "other": 0.1}

# Checked in this order, so "preferred qualifications" is preferred and not
# swallowed by the "qualifications" of the required list.
_HEADINGS = [
    ("preferred", [
        r"(preferred|desired|desirable|additional|bonus|nice[\s-]to[\s-]have|good[\s-]to[\s-]have|optional)\b.*",
        r"(it'?s|would be) a (big )?plus.*", r"pluses", r"bonus points?", r"extra credit", r"brownie points",
        r"what (would|will) (make you stand out|set you apart).*", r"(you'?ll )?stand out if.*",
    ]),
    ("required", [
        r"(minimum|basic|required|key|essential|mandatory|must[\s-]have|core)\b.*(qualifications?|requirements?|skills|experience|competenc\w*)",
        r"(requirements?|qualifications?|eligibility( criteria)?|prerequisites)\b.*",
        r"what (you'?ll|you will|you) (need|bring|have)\b.*", r"what we'?re looking for", r"what we are looking for",
        r"who (you are|we'?re looking for|we are looking for)", r"about you", r"you (have|bring|are|should have)\b.*",
        r"must[\s-]haves?", r"(required|technical|key|mandatory|primary|desired) skills?\b.*",
        r"skills?( and| &) (experience|qualifications|requirements)", r"skills? required", r"experience required",
        r"desired candidate profile", r"candidate profile", r"your (profile|background|experience|skills)",
        r"what it takes", r"is this you\??", r"ideal candidate.*", r"skills?",
    ]),
    ("duties", [
        r"(key |main |primary )?(responsibilities|duties)\b.*", r"(roles?|job)( and| &) responsibilities",
        r"what (you'?ll|you will) (do|be doing|work on)\b.*", r"(the|your|this) (role|position|opportunity|impact|mission|day[\s-]to[\s-]day)\b.*",
        r"job (description|summary|overview|purpose)", r"role (overview|summary|description)", r"position (summary|overview)",
        r"in this role.*", r"day[\s-]to[\s-]day.*", r"what the job involves", r"overview", r"summary",
    ]),
    ("other", [
        r"about (us|the company|the team|our company|our team|the business|[a-z0-9&.\s]{2,30})",
        r"(company|team) (overview|description|culture|profile)", r"who we are", r"our (story|mission|values|culture|commitment|benefits)",
        r"(benefits|perks|compensation|salary|pay|rewards)\b.*", r"what we offer.*", r"why (join|work)\b.*", r"life at .*",
        r"(equal (employment )?opportunity|eeo|diversity|accommodation|disclaimer|privacy)\b.*",
        r"how to apply.*", r"(location|work location|job location|work mode|working hours|schedule)\b.*",
        r"(role|industry type|department|employment type|role category|functional area)\b.*",
    ]),
]
_HEADING_RE = [(sec, [re.compile(r"^(?:" + p + r")$", re.I) for p in pats]) for sec, pats in _HEADINGS]

# Headings run inline ("...great team. Requirements: 5+ years...") in text
# scraped without line breaks; these get a line of their own first.
_INLINE_HEADING = re.compile(
    r"(?<=[.!?:;)\s])\s*("
    r"(?:minimum |basic |preferred |desired |key |required |additional )?(?:qualifications|requirements)"
    r"|(?:key )?responsibilities|what you'?ll do|what you will do|what you'?ll need|what we'?re looking for"
    r"|nice to have|good to have|bonus points|must have|about (?:us|the role|you|the team)"
    r"|benefits|perks|what we offer|desired candidate profile|job description|role overview|key skills"
    r"|preferred skills|required skills|skills (?:and|&) experience"
    r")\s*:",
    re.I,
)

_PREF_CUE = re.compile(
    r"nice[\s-]to[\s-]have|good[\s-]to[\s-]have|\bpreferred\b|preferably|(is|are|as|would be) (a |an )?(big |huge |strong )?(plus|bonus|advantage)"
    r"|\ba plus\b|\bbonus\b|\bdesirable\b|\bideally\b|\badvantageous\b|not (required|mandatory|essential)|\boptional\b"
    r"|\bfamiliarity with\b|\bexposure to\b|\bbeneficial\b|would be (great|nice|helpful)|\bappreciated\b",
    re.I,
)
_REQ_CUE = re.compile(
    r"\bmust\b|\brequired\b|\bmandatory\b|\bessential\b|\bminimum\b|\bat least\b|\bstrong\b|\bsolid\b|\bproven\b"
    r"|\bexpert(ise)?\b|\bdeep (knowledge|understanding|experience|expertise)\b|\bproficien|\bhands[\s-]on\b|\bextensive\b"
    r"|\bin[\s-]depth\b|\badvanced\b|\bthorough\b",
    re.I,
)

# ---------------------------------------------------------------- experience

_WORDNUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
            "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15}
_N = r"(\d{1,2}(?:\.\d)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen)"
_YRS = r"\s*(?:\+|plus)?\s*(?:years?|yrs?)\b"
_YEAR_PATTERNS = [
    ("range", re.compile(_N + r"\s*\+?\s*(?:-|–|—|to)\s*" + _N + _YRS, re.I)),
    ("min", re.compile(r"(?:minimum(?: of)?|min\.?|at least|over|more than|no less than|upwards of)\s*" + _N + _YRS, re.I)),
    ("plus", re.compile(_N + r"\s*(?:\+|plus)\s*(?:years?|yrs?)\b", re.I)),
    ("bare", re.compile(_N + r"\s*(?:years?|yrs?)\b", re.I)),
]
_YEAR_CONTEXT = re.compile(r"experience|\bexp\b|background|track record|working (in|with|on)|hands[\s-]on|industry|professional|relevant", re.I)
_YEAR_NOISE = re.compile(
    r"founded|in business|established|since \d{4}|anniversary|years old|\bage\b|aged\b|warranty"
    r"|contract (length|duration|of)|duration|tenure of the|visa|retention|guarantee|\bpast\b|\blast\b|\bnext\b|\bwithin\b"
    r"|\bevery\b|per year|each year|annual|\bbond\b|probation|trusted by|over the years|customers? for",
    re.I,
)

# ----------------------------------------------------------------- education

_EDU = [
    (3, re.compile(r"ph\.?\s?d|doctorate|doctoral", re.I)),
    (2, re.compile(r"master'?s|masters|master of|\bm\.?\s?tech\b|\bm\.\s?e\.?(?=[\s/,])|\bm\.?\s?sc\b|\bmba\b|\bmca\b|\bm\.?\s?s\.?\b(?= in|\s*/|,)|post[\s-]?graduat|\bpg\b\s*[:\-]", re.I)),
    (1, re.compile(r"bachelor'?s|bachelors|bachelor of|\bb\.?\s?tech\b|\bb\.\s?e\.?(?=[\s/,])|\bb\.?\s?sc\b|\bb\.?\s?s\.?\b(?= in|\s*/|,)|\bb\.?\s?a\.?\b(?= in)|\bb\.?\s?com\b|\bbca\b|\bbba\b|undergraduate degree|\bug\b\s*[:\-]|any graduate|university degree|college degree|4[\s-]year degree", re.I)),
]
_EDU_FLEX = re.compile(r"or equivalent|equivalent (practical |work |professional )?experience|or related (field|experience)|or relevant experience|or comparable experience|in lieu of", re.I)

# ----------------------------------------------------------------- knockouts

_CLEARANCE = re.compile(
    r"(?<!police )(?<!background )\b(security|secret|top[\s-]secret|ts/sci|dod|public trust|dv|sc|nv1|nv2|baseline)\s+clearance"
    r"|clearance\s+(is\s+)?(required|needed|mandatory)|active\s+(secret\s+|ts\s+)?clearance|\bts/sci\b"
    r"|(hold|have|possess|obtain|maintain)\s+(an?\s+)?(active\s+|current\s+)?(\w+\s+){0,2}clearance",
    re.I,
)
_CITIZEN = re.compile(
    r"(u\.?s\.?|us|united states|american)\s+citizen(s|ship)?\s*(only|is required|required|is mandatory)"
    r"|must\s+(be\s+)?(an?\s+)?(u\.?s\.?|us|united states)\s+citizen|only\s+(u\.?s\.?|us)\s+citizens"
    r"|(u\.?s\.?|us)\s+citizenship\s+(is\s+)?(required|mandatory)|green card holders?\s+only|\b(usc|gc)\s+only\b"
    r"|citizens?\s+or\s+(permanent residents?|green card holders?)\s+only",
    re.I,
)
LANGUAGES = ["german", "french", "spanish", "italian", "portuguese", "dutch", "swedish", "danish", "norwegian",
             "finnish", "polish", "czech", "russian", "ukrainian", "turkish", "arabic", "hebrew", "japanese",
             "korean", "mandarin", "cantonese", "chinese", "thai", "vietnamese", "indonesian", "malay", "greek",
             "hungarian", "romanian"]
_LANG_RE = re.compile(r"\b(" + "|".join(LANGUAGES) + r")\b", re.I)
_LANG_REQ = re.compile(
    r"fluen(t|cy)|native|proficien|business[\s-]level|working knowledge|\bc1\b|\bc2\b|\bb2\b|spoken and written|written and spoken"
    r"|verbal and written|written and verbal|\brequired\b|\bmandatory\b|\bmust\b|\bessential\b|[\s-]speaking",
    re.I,
)


# ---------------------------------------------------------------- specialties
#
# Products and platforms the taxonomy does not know: Duck Creek, Guidewire,
# Pega, CyberArk. Skill matching cannot see them, so a posting built around
# one looks like a fit on the generic Java and SQL around it. They are found
# by how they are written - a name mid-sentence, CamelCase, a short acronym -
# by being repeated, and by being asked for ("experience in Duck Creek"),
# which is what tells a product from a city, a team or a client's name.

_WORD = re.compile(r"[A-Za-z][A-Za-z0-9]+")
_CAMEL = re.compile(r"[a-z][A-Z]")
_SENTENCE_START = set("\n.!?:;•·▪◦●*-–—>(|/,")

# Capitalised in postings without naming a product: roles, degrees, places,
# calendar words, and acronyms every posting uses.
_NOT_SPECIALTY = frozenset("""
engineer engineers engineering developer developers development software senior junior lead associate principal
staff intern trainee manager consultant analyst architect specialist executive officer administrator admin member
technical technology technologies tech solution solutions service services system systems platform platforms
application applications product products project projects program programme business enterprise company client
clients customer customers group department division office global international national domain industry
india indian usa uk europe emea apac asia america americas remote hybrid onsite home full part time permanent
contract contractual temporary internship fresher freshers immediate joiner joiners urgent hiring opening openings
vacancy vacancies career careers job jobs position positions role roles candidate candidates applicant applicants
bachelor bachelors master masters degree degrees graduate graduates graduation postgraduate undergraduate
university universities college institute school diploma certification certifications certified certificate
computer science information electronics electrical mechanical communication communications mathematics maths
statistics physics btech mtech mca bca bsc msc mba phd ug pg be me bs ms ba ma any specialization specialisation
english hindi monday tuesday wednesday thursday friday saturday sunday january february march april may june july
august september october november december am pm ist est pst gmt utc api apis ui ux it hr cs sdk ide json xml yaml
csv http https url os pc ms ci cd qa qc sla slas kpi kpis poc mvp saas paas iaas b2b b2c sdlc stlc oops dbms
rdbms nosql mvc crud etc eg ie faq ceo cto cfo coo vp svp inc ltd pvt llc llp corp co us
a1 a2 b1 b2 c1 c2
type employment category functional area
ii iii iv vi vii viii sde sse ase swe mts smts lmts pmts l1 l2 l3 l4 l5 l6 walk walkin drive interview
mern mean mevn lamp jamstack
mumbai delhi ncr bangalore bengaluru hyderabad pune chennai kolkata gurugram gurgaon noida ahmedabad jaipur kochi
cochin chandigarh indore coimbatore trivandrum thiruvananthapuram mysore mysuru nagpur lucknow bhubaneswar
vadodara surat visakhapatnam vizag goa london singapore dubai berlin amsterdam toronto seattle austin boston
chicago york san francisco
""".split())

# Share of the posting's own weight a specialty gets next to a known skill:
# the name is certain, whether it is a skill at all is less so.
SPECIALTY_DISCOUNT = 0.8

# What makes a name a skill rather than a place, a team or a client: being
# asked for. "Experience in Duck Creek", "Gosu programming" - never "our
# Thane office" or "the Atlas team". Looked for earlier in the same sentence,
# or just after the name.
_ASKED_BEFORE = re.compile(
    r"experience|expertise|knowledge|proficien|hands[\s-]on|skill|familiar|exposure|certifi|understanding of"
    r"|\byears? (of|with|in)\b|\b(strong|good|expert|skilled|well[\s-]versed) (in|with|at)\b"
    r"|\b(develop|configur|customi[sz]|implement|program|administ|integrat)\w*",
    re.I,
)
_ASKED_AFTER = re.compile(
    r"[\s,/()-]*(?:\w+[\s-]){0,2}?(developer|development|configuration|customi[sz]ation|programming|certification"
    r"|certified|consultant|implementation|modules?|products?|suite|expertise|experience|skills?|knowledge"
    r"|administration|integration)\b",
    re.I,
)


def _starts_sentence(text, pos):
    before = text[:pos].rstrip(" \t\"'“‘")
    return not before or before[-1] in _SENTENCE_START or before[-1].isdigit()


def _specialties(title, text, spans, starts, known, exclude):
    """({term: weight}, [terms named in the title]) for unrecognised products.

    known: (start, end) of every taxonomy match, which are not candidates.
    exclude: words that are the company's or the location's, not skills.
    """
    chars = list(text)
    for a, b in known:
        chars[a:b] = " " * (b - a)
    masked = "".join(chars)
    words = [(m.start(), m.group(0)) for m in _WORD.finditer(masked)]
    if not words:
        return {}, []
    # A posting In Title Case Throughout or IN CAPITALS says nothing by its
    # capitals; only the forms it cannot produce by accident still count.
    inner = [w for p, w in words if not _starts_sentence(masked, p)] or [w for _, w in words]
    allow_capital = sum(w[0].isupper() for w in inner) / len(inner) < 0.5
    allow_upper = sum(w.isupper() for _, w in words) / len(words) < 0.25
    lowercase = {w for _, w in words if w.islower()}
    title_words = {w.lower() for w in _WORD.findall(title)}

    seen = {}
    for pos, w in words:
        low = w.lower()
        if low in _NOT_SPECIALTY or low in STOPWORDS or low in exclude or len(low) < 2:
            continue
        span = _span_at(spans, starts, pos)
        if not span or span[2] == "other":
            continue
        strong = bool(_CAMEL.search(w)) or (allow_upper and w.isupper() and len(w) <= 6)
        capital = allow_capital and w[0].isupper() and not _starts_sentence(masked, pos)
        # A word also written in lower case is an ordinary word.
        if low in lowercase and not strong:
            continue
        s = seen.setdefault(low, {"n": 0, "strong": 0, "capital": 0, "asked": 0, "best": 0.0, "pos": []})
        s["n"] += 1
        s["strong"] += strong
        s["capital"] += capital
        end = pos + len(w)
        s["asked"] += bool(_ASKED_BEFORE.search(text, max(span[0], pos - 100), pos)
                           or _ASKED_AFTER.match(text, end, min(span[1], end + 40)))
        s["best"] = max(s["best"], span[3])
        s["pos"].append(pos)

    kept = {}
    for low, s in seen.items():
        in_title = low in title_words
        evidence = s["strong"] or s["capital"] >= 2 or (s["capital"] and in_title)
        mentions = s["n"] + in_title
        if evidence and s["asked"] and (mentions >= 2 or (s["strong"] and s["best"] >= 0.9)):
            kept[low] = s
    if not kept:
        return {}, []

    # "Duck Creek" is one product, not two missing skills: words that stand
    # next to each other in most of their mentions are joined.
    at = {p: low for low, s in kept.items() for p in s["pos"]}
    pairs = {}
    for low, s in kept.items():
        for p in s["pos"]:
            end = _WORD.match(masked, p).end()
            nxt = at.get(end + 1) if end < len(masked) and masked[end] in " -" else None
            if nxt and nxt != low:
                pairs[(low, nxt)] = pairs.get((low, nxt), 0) + 1
    parent = {low: low for low in kept}

    def root(x):
        while parent[x] != x:
            x = parent[x]
        return x

    for (a, b), n in pairs.items():
        if n * 2 > min(kept[a]["n"], kept[b]["n"]):
            parent[root(b)] = root(a)

    groups = {}
    for low in kept:
        groups.setdefault(root(low), []).append(low)

    out, in_title = {}, []
    for members in groups.values():
        members.sort(key=lambda m: kept[m]["pos"][0])
        term = " ".join(members)
        best = max(kept[m]["best"] + min(0.15, 0.05 * (kept[m]["n"] - 1)) for m in members)
        named = any(m in title_words for m in members)
        out[term] = 1.3 if named else round(best * SPECIALTY_DISCOUNT, 3)
        # Only a well-attested name in the title decides what the job is.
        if named and any(kept[m]["strong"] or kept[m]["n"] >= 2 for m in members):
            in_title.append(term)
    return out, in_title


@dataclass
class JobInfo:
    title: str
    length: int
    families: list = field(default_factory=list)
    level: object = None           # 0..6, see roles.LEVEL_NAMES
    level_inferred: bool = False
    required: dict = field(default_factory=dict)     # skill -> weight (>= 0.6)
    preferred: dict = field(default_factory=dict)    # skill -> weight (< 0.6)
    title_skills: list = field(default_factory=list)
    skill_years: dict = field(default_factory=dict)  # skill -> minimum years asked
    years_min: object = None
    years_max: object = None
    education: object = None       # 1 bachelor, 2 master, 3 doctorate
    education_flexible: bool = False
    knockouts: list = field(default_factory=list)
    languages: list = field(default_factory=list)
    needs_clearance: bool = False
    needs_citizenship: bool = False
    specialties: dict = field(default_factory=dict)       # unrecognised product -> weight
    title_specialties: list = field(default_factory=list)  # those the title is about
    relevant_text: str = ""        # the posting minus about-us and benefits, for similarity


# ------------------------------------------------------------------- parsing

def _normalise(text):
    text = str(text or "").replace("\r", "\n").replace(" ", " ")
    # Scraped without line breaks: give inline headings a line of their own.
    if text.count("\n") < 4 and len(text) > 300:
        text = _INLINE_HEADING.sub(lambda m: "\n" + m.group(1) + ":\n", text)
    return re.sub(r"[ \t]+", " ", text)


def _heading(line):
    clean = re.sub(r"^[\s#*•·▪\-–—>]+|[\s:：*#\-–—]+$", "", line).strip()
    if not clean or len(clean) > 60 or len(clean.split()) > 8:
        return None
    # A real heading either ends in a colon or stands alone as a short line.
    if not line.rstrip().endswith((":", "：")) and len(clean.split()) > 6:
        return None
    low = clean.lower().replace("’", "'")
    for sec, patterns in _HEADING_RE:
        if any(p.match(low) for p in patterns):
            return sec
    return None


def _spans(text):
    """[(start, end, section, weight)] for every sentence, in order."""
    spans = []
    section = "general"
    in_section = 0
    pos = 0
    for line in text.split("\n"):
        start = pos
        pos += len(line) + 1
        if not line.strip():
            continue
        sec = _heading(line)
        if sec:
            section = sec
            in_section = 0
            # "Requirements: 5+ years of Java" - the heading carries content too.
            rest = line.split(":", 1)[1] if ":" in line else ""
            if len(rest.strip()) < 3:
                continue
        # Ends at . ; ! ? followed by a space, so "node.js" and "3.5" stay whole.
        for m in re.finditer(r"(?:[^.;!?]|[.;!?](?!\s|$))+(?:[.;!?]+|$)", line):
            sentence = m.group(0)
            if not sentence.strip():
                continue
            in_section += 1
            # An "About us" heading followed by headings we don't recognise
            # would otherwise demote the whole posting to company blurb.
            if section == "other" and in_section > 8:
                section = "general"
            base = SECTION_WEIGHT[section]
            if _PREF_CUE.search(sentence):
                w = min(base, SECTION_WEIGHT["preferred"])
            elif section in ("general", "duties") and _REQ_CUE.search(sentence):
                w = max(base, 0.9)
            else:
                w = base
            spans.append((start + m.start(), start + m.end(), section, w))
    return spans


def _span_at(spans, starts, offset):
    i = bisect.bisect_right(starts, offset) - 1
    if i >= 0 and spans[i][0] <= offset < spans[i][1]:
        return spans[i]
    return None


def _num(s):
    s = s.lower()
    return float(_WORDNUM[s]) if s in _WORDNUM else float(s)


def _years(text, spans, starts, skill_hits):
    """(general_min, general_max, {skill: min_years})."""
    taken = []
    general = []  # (offset, min, max, weight)
    per_skill = {}
    for kind, rx in _YEAR_PATTERNS:
        for m in rx.finditer(text):
            if any(a <= m.start() < b or a < m.end() <= b for a, b in taken):
                continue
            window = text[max(0, m.start() - 60): m.end() + 80]
            is_abbrev_range = kind == "range" and re.search(r"yrs?\b", m.group(0), re.I)
            if not is_abbrev_range and not _YEAR_CONTEXT.search(window):
                continue
            if _YEAR_NOISE.search(text[max(0, m.start() - 40): m.end() + 40]):
                continue
            lo = _num(m.group(1))
            hi = _num(m.group(2)) if kind == "range" else None
            if lo > 25 or (hi is not None and (hi > 30 or hi < lo)):
                continue
            taken.append((m.start(), m.end()))
            span = _span_at(spans, starts, m.start())
            weight = span[3] if span else 0.7
            # Tie the requirement to a skill named just after it ("5+ years of
            # Java") or just before it ("Java - 3 years").
            sent_end = span[1] if span else m.end() + 80
            after = [s for s, offs in skill_hits.items() if any(m.end() <= o < min(m.end() + 70, sent_end) for o in offs)]
            before = [s for s, offs in skill_hits.items() if any(m.start() - 30 <= o < m.start() for o in offs)]
            tied = after or before
            if tied and weight >= 0.35:
                for s in tied:
                    per_skill[s] = max(per_skill.get(s, 0), lo)
            elif weight > SECTION_WEIGHT["preferred"]:
                general.append((m.start(), lo, hi, weight))
    if general:
        general.sort()
        _, lo, hi, _ = general[0]
        return lo, hi, per_skill
    if per_skill:
        return max(per_skill.values()), None, per_skill
    return None, None, per_skill


def _education(spans, text):
    required = None
    flexible = False
    for start, end, section, weight in spans:
        if section == "other":
            continue
        s = text[start:end]
        levels = education_levels(s)
        if not levels and re.search(r"\bdegree\b", s, re.I):
            levels = [1]  # "a degree in Computer Science"
        if not levels:
            continue
        if _EDU_FLEX.search(s):
            flexible = True
        if weight <= SECTION_WEIGHT["preferred"]:
            continue
        need = min(levels)  # "Bachelor's or Master's" asks for a bachelor's
        required = need if required is None else max(required, need)
    return required, flexible


def _knockouts(spans, text):
    langs = []
    clearance = citizenship = False
    for start, end, section, weight in spans:
        # Benefits and EEO blurbs mention citizenship and languages in
        # passing; only the posting proper counts.
        if section == "other":
            continue
        s = text[start:end]
        if _CLEARANCE.search(s) and not _PREF_CUE.search(s):
            clearance = True
        if _CITIZEN.search(s):
            citizenship = True
        for lm in _LANG_RE.finditer(s):
            if weight > SECTION_WEIGHT["preferred"] and _LANG_REQ.search(s) and not _PREF_CUE.search(s):
                lang = lm.group(1).lower()
                if lang not in langs:
                    langs.append(lang)
    return clearance, citizenship, langs


def parse_job(title, description, extra_skills=(), company="", location=""):
    title = str(title or "").strip()
    text = _normalise(description)
    spans = _spans(text)
    starts = [s[0] for s in spans]

    known = []
    hits = sk.find_skills(text, extra_skills, spans=known)
    weights = {}
    for name, offsets in hits.items():
        best = 0.0
        for o in offsets:
            span = _span_at(spans, starts, o)
            best = max(best, span[3] if span else SECTION_WEIGHT["general"])
        # Repetition is a signal: a skill named five times is central.
        best += min(0.15, 0.05 * (len(offsets) - 1))
        weights[name] = best

    title_hits = list(sk.find_skills(title, extra_skills))
    for name in title_hits:
        weights[name] = max(weights.get(name, 0), 1.3)

    info = JobInfo(title=title, length=len(text.strip()))
    info.title_skills = title_hits
    info.required = {s: round(w, 3) for s, w in weights.items() if w >= 0.6}
    info.preferred = {s: round(w, 3) for s, w in weights.items() if 0.15 <= w < 0.6}

    info.years_min, info.years_max, info.skill_years = _years(text, spans, starts, hits)
    info.education, info.education_flexible = _education(spans, text)
    info.needs_clearance, info.needs_citizenship, info.languages = _knockouts(spans, text)
    exclude = {w.lower() for w in _WORD.findall(str(company or "") + " " + str(location or ""))}
    info.specialties, info.title_specialties = _specialties(title, text, spans, starts, known, exclude)

    info.families = roles.families(title)
    info.level = roles.title_level(title)
    if info.level is None and info.years_min is not None:
        y = info.years_min
        info.level = 1 if y < 2 else 2 if y < 5 else 3 if y < 8 else 4
        info.level_inferred = True

    info.relevant_text = _relevant(text, spans)
    return info


def _relevant(text, spans):
    return " ".join(text[a:b] for a, b, sec, _ in spans if sec != "other")


def relevant_text(description):
    """The posting minus about-us and benefits. Cheap next to parse_job, so it
    is recomputed rather than cached (it is most of a posting's size)."""
    text = _normalise(description)
    return _relevant(text, _spans(text))


def normalised(description):
    return _normalise(description)


# ------------------------------------------------------------------- caching

def to_cache(info):
    d = asdict(info)
    d.pop("relevant_text", None)
    return json.dumps(d, separators=(",", ":"))


def from_cache(raw, description):
    """A JobInfo from its cached form, or None if it is missing or malformed."""
    if not raw:
        return None
    try:
        d = json.loads(raw)
        d["relevant_text"] = relevant_text(description)
        return JobInfo(**d)
    except (TypeError, ValueError):
        return None


def education_levels(text):
    """Degree levels named in text: 1 bachelor, 2 master, 3 doctorate."""
    t = re.sub(r"scrum master|master data|master class|masterclass|webmaster|quizmaster", "", str(text or ""), flags=re.I)
    return [lvl for lvl, rx in _EDU if rx.search(t)]
