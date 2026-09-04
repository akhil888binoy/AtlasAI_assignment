from src.database.database import Base
from sqlalchemy import String, DateTime
from sqlalchemy import Column, Integer


class ReconciliationRun(Base):
    __tablename__ = "reconciliation_runs"

    id = Column(Integer, primary_key=True, nullable=False)
    created_at = Column(DateTime, nullable=False)
    our_file = Column(String, nullable=False)
    other_file = Column(String, nullable=False)
    # Content hashes, used to spot the same pair of files being sent twice.
    our_file_hash = Column(String, nullable=True)
    other_file_hash = Column(String, nullable=True)
    status = Column(String, nullable=False)
