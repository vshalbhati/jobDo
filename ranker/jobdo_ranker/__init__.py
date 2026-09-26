"""jobDo job ranker: scores postings against a resume and decides which to apply to.

    from jobdo_ranker import rank_jobs
    results = rank_jobs(jobs, resume_text, profile, threshold=60)
"""
import json

from . import candidate as cand_mod
from . import jd
from . import skills as sk
from .cache import key as cache_key
from .candidate import build_candidate
from .jd import parse_job
from .scorer import score
from .text import content_terms, cosine, tfidf_vectors

# Part of every cache key: bump it whenever parsing or candidate building
# changes, so entries written by the old code are never read by the new.
__version__ = "1.1.0"
__all__ = ["rank_jobs", "__version__"]


def rank_jobs(jobs, resume_text, profile, threshold=60, cache=None):
    """Scores every job; results come back in the order the jobs went in.

    jobs: [{"id", "title", "company", "location", "description"}]
    cache: optional RankCache. Parsed postings and resume features are read
    from it and written to it; results are identical with or without it.
    """
    threshold = max(0.0, min(100.0, float(threshold)))
    resume_text = str(resume_text or "")
    profile = profile if isinstance(profile, dict) else {}
    custom = cand_mod.custom_skills(profile)

    cand_key = cache_key("cand", __version__, resume_text, json.dumps(profile, sort_keys=True, default=str))
    prepared = []
    for j in jobs:
        title = str(j.get("title") or "").strip()
        desc = str(j.get("description") or "")
        # The company's and the location's names are not products it asks for.
        where = (str(j.get("company") or ""), str(j.get("location") or ""))
        # A custom skill only changes how a posting is parsed if it appears in
        # it, so only those go into the key: postings stay shared between
        # people whose custom skills differ but do not occur there.
        extras = sk.present(custom, title + "\n" + jd.normalised(desc))
        prepared.append((title, desc, extras, where,
                         cache_key("job", __version__, title, desc, ",".join(extras), *where)))

    hits = cache.get_many([cand_key] + [p[4] for p in prepared]) if cache else {}
    fresh = {}

    cand = cand_mod.from_cache(hits.get(cand_key))
    if cand is None:
        cand = build_candidate(resume_text, profile)
        fresh[cand_key] = cand_mod.to_cache(cand)

    parsed = []
    for title, desc, extras, where, k in prepared:
        info = jd.from_cache(hits.get(k), desc)
        if info is None:
            info = parse_job(title, desc, extras, *where)
            fresh[k] = jd.to_cache(info)
        parsed.append(info)

    if cache and fresh:
        cache.set_many(fresh)

    # Similarity is computed over the batch, so IDF reflects this batch of
    # postings: what they all share counts for little.
    docs = [cand.terms] + [content_terms(p.title + " " + p.relevant_text) for p in parsed]
    vectors = tfidf_vectors(docs)
    resume_vec = vectors[0]
    vocab = set(cand.terms)

    results = []
    for job, info, vec in zip(jobs, parsed, vectors[1:]):
        cos = cosine(resume_vec, vec) if info.length >= 80 else None
        r = score(info, cand, cos, threshold, vocab)
        r["id"] = str(job.get("id", ""))
        r["summary"] = "%d %s: %s" % (r["score"], r["verdict"], "; ".join(r["reasons"][:4]))
        results.append(r)

    order = sorted(range(len(results)), key=lambda i: -results[i]["score"])
    for rank, i in enumerate(order, 1):
        results[i]["rank"] = rank
    parsed_fresh = sum(1 for p in prepared if p[4] in fresh)
    return {
        "threshold": threshold,
        "version": __version__,
        "candidate": {
            "years": cand.years,
            "level": roles_name(cand.level),
            "skills": len(cand.skills),
            "titles": cand.titles[:3],
        },
        "cache": {"postings_cached": len(prepared) - parsed_fresh, "postings_parsed": parsed_fresh},
        "results": results,
    }


def roles_name(level):
    from .roles import LEVEL_NAMES
    return LEVEL_NAMES[max(0, min(6, int(round(level))))]
