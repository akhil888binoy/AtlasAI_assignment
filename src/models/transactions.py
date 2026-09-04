from src.database.database import Base
from sqlalchemy import String, DateTime, Float
from sqlalchemy import Column, Integer, ForeignKey


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, nullable=False)
    run_id = Column(
        Integer,
        ForeignKey("reconciliation_runs.id", ondelete="CASCADE"),
        nullable=False
    )
    source = Column(String, nullable=False)
    external_id = Column(String, nullable=False)
    timestamp = Column(DateTime, nullable=False)
    instrument = Column(String, nullable=False)
    side = Column(String, nullable=False)
    quantity = Column(Float, nullable=False)
    price = Column(Float, nullable=False)
    amount = Column(Float, nullable=False)
    status = Column(String, nullable=False)