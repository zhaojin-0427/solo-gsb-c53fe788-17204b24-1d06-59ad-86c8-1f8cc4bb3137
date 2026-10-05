"""现场地址核验：选择已发布方案，上传现场 CSV 进行只读落点比对。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .. import verification
from ..database import get_db

router = APIRouter(prefix="/api/plans", tags=["verification"])


@router.get("/published")
def list_published(db: Session = Depends(get_db)):
    """已发布方案列表（新到旧），供现场核验选择基准版本。"""
    return verification.list_published_plans(db)


@router.post("/{plan_id}/verify")
async def verify_site(
    plan_id: int,
    file: UploadFile = File(..., description="现场 CSV：灯具ID,线路,起始地址,通道数"),
    mode: str = Form("isolate", description="strict=整表拒收；isolate=隔离异常行继续核对"),
    db: Session = Depends(get_db),
):
    raw = await file.read()
    if not raw.strip():
        # 空文件同样是结构问题：明确拒收，绝不报告一致
        raise HTTPException(status_code=422, detail="上传的现场 CSV 为空，整表拒收。")
    result = verification.verify_site_csv(db, plan_id, raw, mode)
    # 整表拒收属于“数据不可用”的语义化 422：仍携带完整异常清单供页面展示，
    # 前端据此渲染拒收面板；其他核对结果（含不一致）一律 200。
    if result["verdict"] == "rejected":
        return JSONResponse(status_code=422, content=jsonable_encoder(result))
    return jsonable_encoder(result)
