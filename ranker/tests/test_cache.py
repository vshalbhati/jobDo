"""The cache must make ranking faster and never different.

    python -m unittest discover -s tests
"""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import jobdo_ranker  # noqa: E402
from fixtures import ALL, PROFILE, RESUME, STRONG  # noqa: E402
from jobdo_ranker import candidate as cand_mod  # noqa: E402
from jobdo_ranker import jd, rank_jobs  # noqa: E402
from jobdo_ranker.cache import RankCache, Upstash  # noqa: E402


def comparable(out):
    """Everything that matters in a ranking, minus the cache counters."""
    return [(r["id"], r["score"], r["verdict"], r["reasons"], r["rank"]) for r in out["results"]]


class CountingParse:
    """Counts calls to parse_job, to prove a cache hit skips the work."""

    def __enter__(self):
        self.calls = 0
        self.orig = jobdo_ranker.parse_job

        def counted(*a, **k):
            self.calls += 1
            return self.orig(*a, **k)
        jobdo_ranker.parse_job = counted
        return self

    def __exit__(self, *exc):
        jobdo_ranker.parse_job = self.orig


# ------------------------------------------------------------ fake Upstash

class FakeUpstash(BaseHTTPRequestHandler):
    store = {}
    requests = []
    fail = False

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeUpstash.requests.append((self.path, self.headers.get("Authorization"), body))
        if FakeUpstash.fail:
            self.send_response(503)
            self.end_headers()
            return
        if self.path != "/pipeline" or self.headers.get("Authorization") != "Bearer tok":
            self.send_response(401)
            self.end_headers()
            return
        out = []
        for cmd, *args in body:
            cmd = cmd.upper()
            if cmd == "PING":
                out.append({"result": "PONG"})
            elif cmd == "MGET":
                out.append({"result": [FakeUpstash.store.get(k) for k in args]})
            elif cmd == "SET":
                assert args[2] == "EX" and int(args[3]) > 0, "every entry must expire"
                FakeUpstash.store[args[0]] = args[1]
                out.append({"result": "OK"})
            else:
                out.append({"error": "ERR unknown command"})
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class CacheBehaviour(unittest.TestCase):
    def test_results_are_identical_with_and_without_a_cache(self):
        plain = rank_jobs(ALL, RESUME, PROFILE, 60)
        cache = RankCache()
        first = rank_jobs(ALL, RESUME, PROFILE, 60, cache=cache)
        second = rank_jobs(ALL, RESUME, PROFILE, 60, cache=cache)
        self.assertEqual(comparable(plain), comparable(first))
        self.assertEqual(comparable(plain), comparable(second))

    def test_a_cached_posting_is_not_parsed_again(self):
        cache = RankCache()
        with CountingParse() as c:
            out = rank_jobs(ALL, RESUME, PROFILE, 60, cache=cache)
            self.assertEqual(c.calls, len(ALL))
            self.assertEqual(out["cache"]["postings_parsed"], len(ALL))
        with CountingParse() as c:
            out = rank_jobs(ALL, RESUME, PROFILE, 60, cache=cache)
            self.assertEqual(c.calls, 0)
            self.assertEqual(out["cache"]["postings_cached"], len(ALL))

    def test_postings_are_shared_between_different_people(self):
        cache = RankCache()
        rank_jobs([STRONG], RESUME, PROFILE, 60, cache=cache)
        someone_else = dict(PROFILE, defaultYears=9, titles=["Data Engineer"])
        with CountingParse() as c:
            out = rank_jobs([STRONG], "A different resume entirely", someone_else, 60, cache=cache)
        self.assertEqual(c.calls, 0)
        # ...but scored against their own resume, not the first person's.
        self.assertNotEqual(out["results"][0]["score"], rank_jobs([STRONG], RESUME, PROFILE, 60)["results"][0]["score"])

    def test_a_changed_description_is_parsed_afresh(self):
        cache = RankCache()
        rank_jobs([STRONG], RESUME, PROFILE, 60, cache=cache)
        edited = dict(STRONG, description=STRONG["description"] + "\n- Kubernetes required.")
        with CountingParse() as c:
            rank_jobs([edited], RESUME, PROFILE, 60, cache=cache)
        self.assertEqual(c.calls, 1)

    def test_same_job_id_with_other_text_cannot_poison_the_cache(self):
        cache = RankCache()
        fake = dict(STRONG, description="Requirements\n- 20+ years of COBOL. Security clearance required.")
        rank_jobs([fake], RESUME, PROFILE, 60, cache=cache)
        honest = rank_jobs([STRONG], RESUME, PROFILE, 60, cache=cache)["results"][0]
        self.assertEqual(honest["verdict"], "apply")
        self.assertEqual(honest["score"], rank_jobs([STRONG], RESUME, PROFILE, 60)["results"][0]["score"])

    def test_custom_skills_only_split_the_cache_where_they_appear(self):
        profile = dict(PROFILE, skills=dict(PROFILE["skills"], zyxframe=3))
        mentions = dict(STRONG, id="m", description=STRONG["description"].replace(
            "- Comfortable with Git", "- Experience with Zyxframe.\n- Comfortable with Git"))
        cache = RankCache()
        rank_jobs([STRONG, mentions], RESUME, PROFILE, 60, cache=cache)
        with CountingParse() as c:
            out = rank_jobs([STRONG, mentions], RESUME, profile, 60, cache=cache)
        self.assertEqual(c.calls, 1, "only the posting that mentions the custom skill is parsed again")
        self.assertIn("zyxframe", out["results"][1]["matched_skills"])

    def test_serialisation_round_trips(self):
        info = jd.parse_job(STRONG["title"], STRONG["description"])
        again = jd.from_cache(jd.to_cache(info), STRONG["description"])
        self.assertEqual(again, info)
        cand = cand_mod.build_candidate(RESUME, PROFILE)
        self.assertEqual(cand_mod.from_cache(cand_mod.to_cache(cand)), cand)

    def test_corrupt_entries_are_treated_as_misses(self):
        self.assertIsNone(jd.from_cache('{"nope": 1}', ""))
        self.assertIsNone(jd.from_cache("not json", ""))
        self.assertIsNone(cand_mod.from_cache('{"years": 1, "surprise": 2}'))

    def test_memory_layer_is_bounded(self):
        cache = RankCache(l1_size=3)
        cache.set_many({str(i): "v" for i in range(10)})
        self.assertEqual(len(cache.l1.data), 3)


class UpstashClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstash)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeUpstash.store.clear()
        FakeUpstash.requests.clear()
        FakeUpstash.fail = False

    def test_speaks_the_rest_protocol(self):
        cache = RankCache(Upstash(self.url, "tok"))
        rank_jobs(ALL, RESUME, PROFILE, 60, cache=cache)
        path, auth, body = FakeUpstash.requests[0]
        self.assertEqual((path, auth), ("/pipeline", "Bearer tok"))
        self.assertEqual(body[0][0], "MGET")
        self.assertEqual(len(FakeUpstash.store), len(ALL) + 1)  # every posting plus the resume
        self.assertTrue(all(k.startswith("jobdo:rk:") for k in FakeUpstash.store))

    def test_a_fresh_instance_reads_what_another_wrote(self):
        rank_jobs(ALL, RESUME, PROFILE, 60, cache=RankCache(Upstash(self.url, "tok")))
        other_instance = RankCache(Upstash(self.url, "tok"))
        with CountingParse() as c:
            out = rank_jobs(ALL, RESUME, PROFILE, 60, cache=other_instance)
        self.assertEqual(c.calls, 0)
        self.assertEqual(comparable(out), comparable(rank_jobs(ALL, RESUME, PROFILE, 60)))

    def test_a_warm_instance_does_not_ask_redis_again(self):
        cache = RankCache(Upstash(self.url, "tok"))
        rank_jobs(ALL, RESUME, PROFILE, 60, cache=cache)
        FakeUpstash.requests.clear()
        rank_jobs(ALL, RESUME, PROFILE, 60, cache=cache)
        self.assertEqual(FakeUpstash.requests, [])

    def test_redis_down_changes_nothing_but_speed(self):
        FakeUpstash.fail = True
        cache = RankCache(Upstash(self.url, "tok"))
        out = rank_jobs(ALL, RESUME, PROFILE, 60, cache=cache)
        self.assertEqual(comparable(out), comparable(rank_jobs(ALL, RESUME, PROFILE, 60)))
        # After one failure it stops waiting on Redis for a while.
        FakeUpstash.requests.clear()
        rank_jobs([dict(STRONG, id="new", description=STRONG["description"] + " x")], RESUME, PROFILE, 60, cache=cache)
        self.assertEqual(FakeUpstash.requests, [])

    def test_health_status(self):
        self.assertEqual(RankCache(Upstash(self.url, "tok")).status(), "redis")
        self.assertTrue(RankCache(Upstash(self.url, "wrong")).status().startswith("memory only (Redis unreachable"))
        self.assertTrue(RankCache().status().startswith("memory only"))

    def test_reads_vercel_integration_variable_names(self):
        os.environ["KV_REST_API_URL"], os.environ["KV_REST_API_TOKEN"] = self.url, "tok"
        try:
            self.assertEqual(RankCache.from_env().status(), "redis")
        finally:
            del os.environ["KV_REST_API_URL"], os.environ["KV_REST_API_TOKEN"]


if __name__ == "__main__":
    unittest.main()
