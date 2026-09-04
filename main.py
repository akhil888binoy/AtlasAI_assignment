import os
from fastapi import FastAPI
from src.routers.reconciliation import router
from dotenv import load_dotenv

load_dotenv()
app = FastAPI(debug=os.getenv("DEBUG", "False").lower() == "true")
app.include_router(router=router)