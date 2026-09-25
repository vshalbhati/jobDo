"""HTTP front for the ranker. Vercel serves the ASGI `app` in this file.

Only the jobDo backend is meant to call this: it authenticates the user,
attaches their resume and threshold, and signs the request with a shared
secret. Nothing here knows about users.

Local:  pip install -r requirements.txt uvicorn
        RANKER_SECRET=dev uvicorn api.index:app --port 8000
"""
import hmac
import os
import sys
from typing import List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import APIRouter, FastAPI, Header, HTTPException, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from jobdo_ranker import __version__, rank_jobs  # noqa: E402
from jobdo_ranker.cache import RankCache  # noqa: E402

MAX_JOBS = 50

# One per instance: its in-memory layer survives between requests for as long
# as the serverless instance stays warm; Redis is shared by all of them.
CACHE = RankCache.from_env()


class JobIn(BaseModel):
    id: str = Field(..., max_length=200)
    title: str = Field("", max_length=400)
    company: str = Field("", max_length=300)
    location: str = Field("", max_length=300)
    description: str = Field("", max_length=40000)


class CandidateIn(BaseModel):
    resume_text: str = Field("", max_length=100000)
    profile: dict = Field(default_factory=dict)


class RankIn(BaseModel):
    threshold: float = Field(60, ge=0, le=100)
    candidate: CandidateIn
    jobs: List[JobIn] = Field(..., max_length=MAX_JOBS)


def _check_secret(given):
    expected = os.environ.get("RANKER_SECRET", "")
    # Refuse to run open: an unset secret is a deployment mistake, not a mode.
    if not expected:
        raise HTTPException(status_code=503, detail="RANKER_SECRET is not set on the ranker.")
    if not given or not hmac.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Bad or missing ranker secret.")


router = APIRouter()


@router.get("/health")
def health():
    return {
        "ok": True,
        "version": __version__,
        "secretConfigured": bool(os.environ.get("RANKER_SECRET")),
        "cache": CACHE.status(),
    }


@router.post("/rank")
def rank(body: RankIn, x_ranker_secret: Optional[str] = Header(None)):
    _check_secret(x_ranker_secret)
    jobs = [j.model_dump() if hasattr(j, "model_dump") else j.dict() for j in body.jobs]
    return rank_jobs(jobs, body.candidate.resume_text, body.candidate.profile, body.threshold, cache=CACHE)


app = FastAPI(title="jobDo ranker", version=__version__, docs_url=None, redoc_url=None)
# Mounted twice so it answers whether or not the platform strips /api.
app.include_router(router)
app.include_router(router, prefix="/api")


# Says which path actually arrived: when a platform rewrites paths behind the
# app's back, this is the only way to see it from outside.
@app.exception_handler(404)
async def not_found(request: Request, _exc):
    return JSONResponse(status_code=404, content={
        "detail": "Not Found",
        "path": request.url.path,
        "routes": ["/health", "/rank", "/api/health", "/api/rank"],
    })
