"""DMX 灯具地址编排台 —— FastAPI 应用入口。"""
from __future__ import annotations

import os

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .routers import catalog, fixtures, lines, plans, reservations, verification
from .services import init_db


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="DMX 灯具地址编排台", version="1.0.0", lifespan=lifespan)

app.include_router(catalog.router)
app.include_router(fixtures.router)
app.include_router(lines.router)
app.include_router(reservations.router)
# 核验路由必须先于 plans 注册：其 GET /api/plans/published 是字面路径，
# 否则会被 plans 的 /api/plans/{plan_id} 以 plan_id="published" 抢先匹配。
app.include_router(verification.router)
app.include_router(plans.router)

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
