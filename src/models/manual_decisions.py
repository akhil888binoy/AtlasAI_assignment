from src.database.database import Base
from sqlalchemy import String, DateTime
from sqlalchemy import Column, Integer


class ManualDecision(Base):
    """A decision an operator made by hand. It is keyed by trade reference,
    not by row id, so it still applies when tomorrow's files arrive.

    Both ids set: these two trades are the same (manual match).
    Only one id set: that trade genuinely has no pair (accepted unpaired).
    """
    __tablename__ = "manual_decisions"

    id = Column(Integer, primary_key=True, nullable=False)
    our_external_id = Column(String, nullable=True)
    other_external_id = Column(String, nullable=True)
    resolved_by = Column(String, nullable=False)
    resolved_at = Column(DateTime, nullable=False)
