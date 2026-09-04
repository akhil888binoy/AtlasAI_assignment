from src.database.database import Base
from sqlalchemy import String, DateTime
from sqlalchemy import Column, Integer, ForeignKey


class ManualMatch(Base):
    __tablename__ = "manual_matches"

    id = Column(Integer, primary_key=True, nullable=False)
    our_transaction_id = Column(
        Integer,
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False
    )
    other_transaction_id = Column(
        Integer,
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False
    )
    resolved_by = Column(String, nullable=False)
    resolved_at = Column(DateTime, nullable=False)