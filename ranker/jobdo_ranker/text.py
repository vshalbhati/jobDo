"""Tokenising, sentence splitting and TF-IDF similarity. Standard library only."""
import math
import re
from collections import Counter

# Common English plus the words every job posting uses. Leaving "experience",
# "team" and "role" in would make every posting look similar to every resume.
STOPWORDS = frozenset("""
a about above after again against all also am an and any are as at be because been before being below
between both but by can could did do does doing down during each either etc few for from further had has
have having he her here hers him his how i if in including into is it its itself just less may me might
more most must my no nor not now of off on once only or other our ours out over own per same shall she
should so some such than that the their theirs them then there these they this those through to too
under until up upon very via was we were what when where which while who whom why will with within
would you your yours
ability able across based best better candidate candidates closely company day deliver etc every
excellent experience experienced familiarity good great hands help ideal ideally including join
knowledge like looking make new opportunity plus position preferred proficiency proficient required
requirement requirements responsibilities responsibility role skill skills strong team teams
understanding use used using well work working world year years yrs
""".split())

_TOKEN = re.compile(r"[a-z0-9][a-z0-9+#.]*[a-z0-9+#]|[a-z0-9]")


def tokens(text):
    """Lower-cased word tokens, keeping c++, c#, node.js intact."""
    return _TOKEN.findall(str(text or "").lower())


def stem(word):
    """A deliberately light stemmer: enough to join 'services'/'service'."""
    if len(word) > 5 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 6 and word.endswith("ing"):
        return word[:-3]
    if len(word) > 5 and word.endswith("ed") and not word.endswith("eed"):
        return word[:-2]
    if len(word) > 4 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    return word


def content_terms(text):
    return [stem(t) for t in tokens(text) if t not in STOPWORDS and not t.isdigit() and len(t) > 1]


_BULLET = re.compile(r"^[\s•·▪◦●○■□➢➤►▶✓✔\-–—*]+")
_SENT_END = re.compile(r"(?<=[a-z0-9)\]])[.;!?]\s+(?=[A-Z(])")


def sentences(text):
    """Splits on line breaks, bullets and sentence ends."""
    out = []
    for line in str(text or "").split("\n"):
        line = _BULLET.sub("", line).strip()
        if not line:
            continue
        for part in _SENT_END.split(line):
            part = part.strip()
            if part:
                out.append(part)
    return out


def tfidf_vectors(docs):
    """TF-IDF vectors for a small batch of documents (lists of terms).

    IDF is computed over the batch itself: when ranking thirty postings for
    one resume, a term every posting shares ("software") says little and a
    term only a few share says a lot. Sublinear TF stops one repeated word
    from dominating a long posting.
    """
    n = len(docs)
    df = Counter()
    for d in docs:
        df.update(set(d))
    vectors = []
    for d in docs:
        tf = Counter(d)
        vec = {}
        for term, count in tf.items():
            idf = math.log((n + 1) / (df[term] + 1)) + 1.0
            vec[term] = (1.0 + math.log(count)) * idf
        vectors.append(vec)
    return vectors


def cosine(a, b):
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    dot = sum(v * b.get(k, 0.0) for k, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))
