"""The ratings check (evaluate.py) on an export built from the fixtures."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from evaluate import evaluate, report  # noqa: E402
from fixtures import PROFILE, RESUME, STRONG, WRONG_FIELD  # noqa: E402


def export(jobs, threshold=60):
    return {"threshold": threshold, "resume": {"text": RESUME, "profile": PROFILE}, "jobs": jobs}


def rated(job, feedback, score=None):
    return {**job, "jobId": job["id"], "company": "Co", "location": "", "feedback": feedback, "score": score}


class Evaluate(unittest.TestCase):
    def test_agreement_is_measured_against_the_ratings(self):
        res = evaluate(export([rated(STRONG, "good", 70), rated(WRONG_FIELD, "bad", 30)]))
        self.assertEqual((res["good"], res["bad"]), (1, 1))
        self.assertEqual(res["now"]["wrong"], 0)
        self.assertEqual(res["now"]["separation"], 1.0)
        self.assertEqual(res["disagreements"], [])

    def test_a_rating_it_disagrees_with_is_listed(self):
        # Rated the other way round: now every verdict is wrong.
        res = evaluate(export([rated(STRONG, "bad"), rated(WRONG_FIELD, "good")]))
        self.assertEqual(res["now"]["wrong"], 2)
        self.assertEqual(res["now"]["separation"], 0.0)
        self.assertEqual({d["feedback"] for d in res["disagreements"]}, {"good", "bad"})
        self.assertIn("good, but it skips", report(res))

    def test_scores_at_the_time_are_compared_too(self):
        # At the time the bad job outscored the good one; the ranker now does not.
        res = evaluate(export([rated(STRONG, "good", 40), rated(WRONG_FIELD, "bad", 90)]))
        self.assertEqual(res["then"]["wrong"], 2)
        self.assertEqual(res["then"]["separation"], 0.0)
        self.assertEqual(res["now"]["wrong"], 0)

    def test_best_threshold_is_the_one_that_disagrees_least(self):
        res = evaluate(export([rated(STRONG, "good", 70), rated(WRONG_FIELD, "bad", 30)], threshold=95))
        self.assertGreater(res["now"]["wrong"], 0)
        self.assertEqual(res["now"]["best_wrong"], 0)
        self.assertLess(res["now"]["best_threshold"], 95)

    def test_ratings_without_a_posting_are_left_out_and_counted(self):
        old = {**rated(STRONG, "good"), "description": ""}
        res = evaluate(export([old, rated(WRONG_FIELD, "bad")]))
        self.assertEqual(res["no_description"], 1)
        self.assertEqual(res["now"]["jobs"], 1)
        self.assertIn("no saved posting", report(res))

    def test_an_empty_export_says_so(self):
        res = evaluate({"threshold": 60, "resume": None, "jobs": []})
        self.assertIsNone(res["now"])
        self.assertIn("Nothing to score yet", report(res))


if __name__ == "__main__":
    unittest.main()
