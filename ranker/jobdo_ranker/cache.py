"""Caching for the ranker: parsed postings and resume features.

Reading a posting is most of the ranker's work, and the result does not
depend on who is asking: five hundred people searching "React developer" see
the same postings. So a parsed posting is cached under a hash of its text and
shared by everyone. A resume's features are cached the same way, per resume.

Keys are content hashes, never job ids. A job id would let one user send a
made-up description for a real job and poison everyone else's scores; a hash
only ever matches the exact text it was computed from.

Two layers, both optional:
  - a small in-process LRU: free, but lives only as long as the instance;
  - Upstash Redis over its REST API: shared by every instance, 7-day expiry.
A cache that is down, full or empty makes ranking slower, never different.
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import OrderedDict

TTL_SECONDS = 7 * 24 * 3600
BACKOFF_SECONDS = 60  # after a Redis failure, skip it this long instead of waiting on every batch


def _unquote(value):
    """Values copied from a .env snippet often keep their quotes ("https://...")."""
    v = str(value or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1].strip()
    return v


def key(kind, version, *parts):
    h = hashlib.sha256("\x1f".join(parts).encode("utf-8", "surrogatepass")).hexdigest()[:40]
    return "jobdo:rk:%s:%s:%s" % (version, kind, h)


class MemoryLRU:
    def __init__(self, size=2000):
        self.size = size
        self.data = OrderedDict()

    def get(self, k):
        v = self.data.get(k)
        if v is not None:
            self.data.move_to_end(k)
        return v

    def set(self, k, v):
        self.data[k] = v
        self.data.move_to_end(k)
        while len(self.data) > self.size:
            self.data.popitem(last=False)


class Upstash:
    """The four lines of Upstash's REST API this needs: POST /pipeline."""

    def __init__(self, url, token, timeout=1.5):
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def pipeline(self, commands):
        body = json.dumps([[str(a) for a in c] for c in commands]).encode()
        req = urllib.request.Request(self.url + "/pipeline", data=body, method="POST", headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as res:
            out = json.loads(res.read())
        if not isinstance(out, list):
            raise RuntimeError("unexpected reply from Redis")
        for r in out:
            if isinstance(r, dict) and r.get("error"):
                raise RuntimeError("Redis: " + str(r["error"]))
        return [r.get("result") for r in out]


class RankCache:
    def __init__(self, redis=None, l1_size=2000):
        self.l1 = MemoryLRU(l1_size)
        self.redis = redis
        self._down_until = 0.0

    @classmethod
    def from_env(cls):
        # UPSTASH_* from the Upstash console; KV_* from Vercel's Upstash integration.
        url = _unquote(os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL"))
        token = _unquote(os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN"))
        return cls(Upstash(url, token) if url and token else None)

    def _redis_usable(self):
        return self.redis is not None and time.monotonic() >= self._down_until

    def _failed(self, e):
        self._down_until = time.monotonic() + BACKOFF_SECONDS
        print("jobdo ranker: Redis unavailable, caching in memory only for %ds (%s)" % (BACKOFF_SECONDS, e),
              file=sys.stderr)

    def get_many(self, keys):
        """{key: value} for every key found, memory first, then Redis."""
        found = {}
        missing = []
        for k in keys:
            v = self.l1.get(k)
            if v is None:
                missing.append(k)
            else:
                found[k] = v
        if missing and self._redis_usable():
            try:
                values = self.redis.pipeline([["MGET"] + missing])[0] or []
                for k, v in zip(missing, values):
                    if v is not None:
                        found[k] = v
                        self.l1.set(k, v)
            except (urllib.error.URLError, OSError, ValueError, RuntimeError) as e:
                self._failed(e)
        return found

    def set_many(self, items):
        for k, v in items.items():
            self.l1.set(k, v)
        if items and self._redis_usable():
            try:
                self.redis.pipeline([["SET", k, v, "EX", TTL_SECONDS] for k, v in items.items()])
            except (urllib.error.URLError, OSError, ValueError, RuntimeError) as e:
                self._failed(e)

    def status(self):
        if self.redis is None:
            return "memory only (no UPSTASH_REDIS_REST_URL)"
        try:
            pong = self.redis.pipeline([["PING"]])[0]
            return "redis" if pong == "PONG" else "memory only (unexpected Redis reply)"
        except Exception as e:  # health check: report, never raise
            return "memory only (Redis unreachable: %s)" % e
