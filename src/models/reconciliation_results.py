from src.database.database import Base
from sqlalchemy import String
from sqlalchemy import Column, Integer, ForeignKey
from sqlalchemy.orm import relationship


class ReconciliationResult(Base):
    __tablename__ = "reconciliation_results"

    id = Column(Integer, primary_key=True, nullable=False)
    run_id = Column(
        Integer,
        ForeignKey("reconciliation_runs.id", ondelete="CASCADE"),
        nullable=False
    )
    our_transaction_id = Column(
        Integer,
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=True
    )
    other_transaction_id = Column(
        Integer,
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=True
    )
    status = Column(String, nullable=False)

    our_transaction = relationship("Transaction", foreign_keys=[our_transaction_id])
    other_transaction = relationship("Transaction", foreign_keys=[other_transaction_id])
    differences = relationship("FieldDifference", cascade="all, delete-orphan")
