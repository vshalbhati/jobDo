"""Checks the ranker against your own ratings.

Rate jobs on the dashboard (the thumbs in "Every application"), press "Export
ratings", then:

    python evaluate.py jobdo-ratings.json
    python evaluate.py jobdo-ratings.json --threshold 65

Every rated job is scored again by the ranker in this folder, against the
resume on your account, and compared with what you said: a job you rated a
good match should clear the threshold, and a bad one should not. It prints
where the two disagree, how well the scores keep good jobs above bad ones, and
which threshold would have agreed with you most - both for the scores given at
the time and for the ranker as it is now. Run it before and after changing the
ranker to see whether a change helped on jobs you actually saw.

Standard library only, like the ranker.
"""
import argparse
import json
import sys

from jobdo_ranker import __version__, rank_jobs

# What the extension sends per request. Text similarity is weighed against
# the rest of the batch, so scoring in batches of the same size keeps the
# scores comparable with the ones a run gives.
BATCH = 15


def _pairs_separation(pairs):
    """Share of (good, bad) pairs where the good job scored higher; ties count half."""
    goods = [s for s, good in pairs if good]
    bads = [s for s, good in pairs if not good]
    if not goods or not bads:
        return None
    won = sum((g > b) + 0.5 * (g == b) for g in goods for b in bads)
    return won / (len(goods) * len(bads))


def _wrong_at(pairs, threshold):
    return sum(1 for s, good in pairs if (s >= threshold) != good)


def _best_threshold(pairs, current):
    """The threshold that disagrees with you least; the nearest to yours on a tie."""
    t = min(range(0, 101), key=lambda x: (_wrong_at(pairs, x), abs(x - current)))
    return t, _wrong_at(pairs, t)


def _summary(pairs, threshold):
    best, best_wrong = _best_threshold(pairs, threshold)
    return {
        "jobs": len(pairs),
        "wrong": _wrong_at(pairs, threshold),
        "missed": sum(1 for s, good in pairs if good and s < threshold),
        "wasted": sum(1 for s, good in pairs if not good and s >= threshold),
        "separation": _pairs_separation(pairs),
        "best_threshold": best,
        "best_wrong": best_wrong,
    }


def evaluate(export, threshold=None):
    """Scores the rated jobs again and compares them with the ratings.

    export: the dashboard's "Export ratings" file, as a dict.
    """
    resume = export.get("resume") or {}
    if threshold is None:
        threshold = export.get("threshold", 60)
    rated = [j for j in export.get("jobs") or [] if j.get("feedback") in ("good", "bad")]
    usable = [j for j in rated if str(j.get("description") or "").strip()]

    results = []
    for i in range(0, len(usable), BATCH):
        batch = usable[i:i + BATCH]
        out = rank_jobs(
            [{"id": str(n), "title": j.get("title"), "company": j.get("company"),
              "location": j.get("location"), "description": j.get("description")} for n, j in enumerate(batch)],
            resume.get("text") or "", resume.get("profile") or {}, threshold)
        results.extend(out["results"])

    now_pairs = [(r["score"], j["feedback"] == "good") for j, r in zip(usable, results)]
    then_pairs = [(j["score"], j["feedback"] == "good") for j in usable if isinstance(j.get("score"), (int, float))]
    # The verdict, not just the score: it is what a run would actually do,
    # knockouts and the margin for thin postings included.
    disagreements = [
        {"feedback": j["feedback"], "score": r["score"], "verdict": r["verdict"], "then": j.get("score"),
         "title": j.get("title") or "", "company": j.get("company") or "", "summary": r["summary"]}
        for j, r in zip(usable, results)
        if (r["verdict"] == "apply") != (j["feedback"] == "good")
    ]
    disagreements.sort(key=lambda d: -abs(d["score"] - threshold))

    return {
        "version": __version__,
        "threshold": threshold,
        "rated": len(rated),
        "good": sum(1 for j in rated if j["feedback"] == "good"),
        "bad": sum(1 for j in rated if j["feedback"] == "bad"),
        "no_description": len(rated) - len(usable),
        "has_resume": bool((resume.get("text") or "").strip() or resume.get("profile")),
        "then": _summary(then_pairs, threshold) if then_pairs else None,
        "now": _summary(now_pairs, threshold) if now_pairs else None,
        "disagreements": disagreements,
    }


def _fmt(v):
    return "-" if v is None else ("%.2f" % v if isinstance(v, float) else str(v))


def report(res, source=""):
    lines = ["Ranker %s against your ratings%s" % (res["version"], " (" + source + ")" if source else "")]
    lines.append("  %d rated jobs: %d good, %d bad. Threshold %g." % (res["rated"], res["good"], res["bad"], res["threshold"]))
    if res["no_description"]:
        lines.append("  %d of them have no saved posting (rated before postings were kept) and are left out."
                     % res["no_description"])
    if not res["has_resume"]:
        lines.append("  Warning: the export has no resume, so every job is scored against nothing.")
    if not res["now"]:
        lines.append("\nNothing to score yet: rate some jobs that were read by a run after this update.")
        return "\n".join(lines)

    then, now = res["then"] or {}, res["now"]
    rows = [
        ("disagrees with you", "wrong", lambda s: "%d of %d" % (s["wrong"], s["jobs"])),
        ("good jobs it would skip", "missed", None),
        ("bad jobs it would apply to", "wasted", None),
        ("good ranked above bad", "separation", None),
        ("best threshold", "best_threshold", lambda s: "%d (%d wrong)" % (s["best_threshold"], s["best_wrong"])),
    ]
    lines.append("")
    lines.append("  %-28s %-27s %s" % ("", "then (scores at the time)", "now (this ranker)"))
    for label, key, fmt in rows:
        cell = lambda s: (fmt(s) if fmt else _fmt(s.get(key))) if s else "-"  # noqa: E731
        lines.append("  %-28s %-27s %s" % (label, cell(then), cell(now)))
    lines.append("  Counts compare each score with the threshold. The list below uses the ranker's full verdict,")
    lines.append("  which also applies knockouts and the stricter bar for thin postings.")

    if res["disagreements"]:
        lines.append("\nWhere it disagrees with you now, furthest from the threshold first:")
        for d in res["disagreements"]:
            what = "good, but it skips" if d["feedback"] == "good" else "bad, but it applies"
            job = d["title"][:50] + (" @ " + d["company"][:30] if d["company"] else "")
            lines.append("  %-20s %3d  %s" % (what, d["score"], job))
            lines.append("  %-20s      %s" % ("", d["summary"][:140]))
    else:
        lines.append("\nIt agrees with every rating.")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check the ranker against your dashboard ratings.")
    parser.add_argument("export", help='the file from "Export ratings" on the dashboard')
    parser.add_argument("--threshold", type=float, help="score to test against (default: your account's)")
    args = parser.parse_args(argv)
    with open(args.export, encoding="utf-8") as f:
        export = json.load(f)
    print(report(evaluate(export, args.threshold), args.export))
    return 0


if __name__ == "__main__":
    sys.exit(main())
