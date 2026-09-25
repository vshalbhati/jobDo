"""Behavioural tests for the ranker. Standard library only:

    python -m unittest discover -s tests
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from fixtures import (ALL, CLEARANCE, EMPTY, LANGUAGE, NAUKRI_INLINE, PROFILE, RESUME,  # noqa: E402
                      STRETCH, STRONG, THIN, WRONG_FIELD)
from jobdo_ranker import rank_jobs  # noqa: E402
from jobdo_ranker import skills as sk  # noqa: E402
from jobdo_ranker.jd import parse_job  # noqa: E402


def rank_one(job, threshold=60, resume=RESUME, profile=PROFILE):
    return rank_jobs([job], resume, profile, threshold)["results"][0]


class SkillMatching(unittest.TestCase):
    def test_aliases_map_to_one_skill(self):
        self.assertEqual(sk.canonical("ReactJS"), "react")
        self.assertEqual(sk.canonical("k8s"), "kubernetes")
        self.assertEqual(sk.canonical("Golang"), "go")
        self.assertEqual(sk.canonical("Postgres"), "postgresql")

    def test_english_words_are_not_skills(self):
        found = sk.find_skills("Go to market fast. R&D team. Series C startup. You excel at teamwork. Less is more.")
        for word in ("go", "r", "c", "excel", "sass"):
            self.assertNotIn(word, found)

    def test_languages_that_are_words_still_match_in_context(self):
        found = sk.find_skills("Backend in Go and Python; analysis in R; firmware in C.")
        for word in ("go", "python", "r", "c"):
            self.assertIn(word, found)

    def test_java_is_not_javascript(self):
        self.assertNotIn("java", sk.find_skills("Modern JavaScript and TypeScript"))

    def test_related_skills_earn_partial_credit(self):
        self.assertEqual(sk.related("react", "react"), 1.0)
        self.assertEqual(sk.related("react", "vue"), 0.5)
        self.assertEqual(sk.related("react", "kafka"), 0.0)


class PostingParser(unittest.TestCase):
    def test_sections_decide_required_versus_preferred(self):
        info = parse_job(STRONG["title"], STRONG["description"])
        self.assertIn("typescript", info.required)
        self.assertIn("jest", info.required)
        self.assertIn("next.js", info.preferred)
        self.assertIn("aws", info.preferred)

    def test_year_ranges(self):
        info = parse_job(STRONG["title"], STRONG["description"])
        self.assertEqual((info.years_min, info.years_max), (3, 6))

    def test_naukri_style_text_without_line_breaks(self):
        info = parse_job(NAUKRI_INLINE["title"], NAUKRI_INLINE["description"])
        self.assertEqual((info.years_min, info.years_max), (2, 5))
        self.assertIn("node.js", info.required)
        self.assertIn("docker", info.preferred)

    def test_years_tied_to_a_skill(self):
        info = parse_job("Python Developer", "Requirements: 5+ years of experience with Python. 2+ years with AWS.")
        self.assertEqual(info.skill_years.get("python"), 5)
        self.assertEqual(info.skill_years.get("aws"), 2)

    def test_company_age_is_not_an_experience_requirement(self):
        info = parse_job("Engineer", "About us: Founded 25 years ago, we have been in business for 25 years. Requirements: React.")
        self.assertIsNone(info.years_min)

    def test_education_or_equivalent_is_flexible(self):
        info = parse_job("Engineer", "Requirements\n- Bachelor's degree in CS or equivalent practical experience.")
        self.assertEqual(info.education, 1)
        self.assertTrue(info.education_flexible)

    def test_either_degree_asks_for_the_lower(self):
        info = parse_job("Engineer", "Requirements\n- Bachelor's or Master's degree in Computer Science.")
        self.assertEqual(info.education, 1)

    def test_a_plain_degree_counts_as_a_bachelors(self):
        info = parse_job("Engineer", "Requirements\n- A degree in Computer Science.")
        self.assertEqual(info.education, 1)

    def test_preferred_degree_is_not_required(self):
        info = parse_job("Engineer", "Requirements\n- 3+ years of experience.\nNice to have\n- A Master's degree.")
        self.assertIsNone(info.education)

    def test_police_clearance_is_not_a_security_clearance(self):
        info = parse_job("Engineer", "Requirements\n- Police clearance certificate at joining.")
        self.assertFalse(info.needs_clearance)


class Ranking(unittest.TestCase):
    def test_strong_match_is_applied_to(self):
        r = rank_one(STRONG)
        self.assertEqual(r["verdict"], "apply")
        self.assertGreaterEqual(r["score"], 80)

    def test_naukri_posting_is_understood(self):
        r = rank_one(NAUKRI_INLINE)
        self.assertEqual(r["verdict"], "apply")
        self.assertGreaterEqual(r["score"], 75)

    def test_far_more_senior_role_is_skipped(self):
        r = rank_one(STRETCH)
        self.assertEqual(r["verdict"], "skip")
        self.assertTrue(any("10+" in x for x in r["reasons"]))

    def test_different_line_of_work_is_skipped(self):
        r = rank_one(WRONG_FIELD)
        self.assertEqual(r["verdict"], "skip")
        self.assertLess(r["score"], 50)

    def test_knockouts_override_a_good_fit(self):
        r = rank_one(CLEARANCE)
        self.assertEqual(r["verdict"], "skip")
        self.assertIn("needs a security clearance", r["knockouts"])
        self.assertIn("US citizens only", r["knockouts"])
        r = rank_one(LANGUAGE)
        self.assertEqual(r["verdict"], "skip")
        self.assertIn("needs fluent German", r["knockouts"])

    def test_german_speaker_is_not_knocked_out(self):
        r = rank_one(LANGUAGE, resume=RESUME + "\nLanguages: English, German (C1)")
        self.assertNotIn("needs fluent German", r["knockouts"])

    def test_empty_postings_are_judged_cautiously(self):
        thin = rank_one(THIN)
        self.assertEqual(thin["confidence"], "low")
        self.assertEqual(thin["verdict"], "skip")
        self.assertLess(thin["score"], 70)
        self.assertEqual(rank_one(EMPTY)["confidence"], "low")

    def test_threshold_decides_the_verdict(self):
        r = rank_one(STRONG, threshold=99)
        self.assertEqual(r["verdict"], "skip")
        r = rank_one(WRONG_FIELD, threshold=10)
        self.assertEqual(r["verdict"], "apply")

    def test_batch_keeps_input_order_and_ranks(self):
        out = rank_jobs(ALL, RESUME, PROFILE, 60)
        self.assertEqual([r["id"] for r in out["results"]], [j["id"] for j in ALL])
        ranks = sorted(r["rank"] for r in out["results"])
        self.assertEqual(ranks, list(range(1, len(ALL) + 1)))
        best = min(out["results"], key=lambda r: r["rank"])
        self.assertEqual(best["id"], "strong")

    def test_works_without_a_profile_or_without_resume_text(self):
        self.assertEqual(rank_one(STRONG, profile={})["verdict"], "apply")
        self.assertEqual(rank_one(STRONG, resume="")["verdict"], "apply")

    def test_garbage_input_does_not_crash(self):
        out = rank_jobs([{"id": 1}, {"title": None, "description": None}], None, {"skills": "nope", "defaultYears": "x"}, 60)
        self.assertEqual(len(out["results"]), 2)

    def test_scores_are_bounded_integers(self):
        for r in rank_jobs(ALL, RESUME, PROFILE, 60)["results"]:
            self.assertIsInstance(r["score"], int)
            self.assertTrue(0 <= r["score"] <= 100)


if __name__ == "__main__":
    unittest.main()
