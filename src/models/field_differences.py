from src.database.database import Base
from sqlalchemy import String, Float
from sqlalchemy import Column, Integer, ForeignKey


class FieldDifference(Base):
    __tablename__ = "field_differences"

    id = Column(Integer, primary_key=True, nullable=False)
    result_id = Column(
        Integer,
        ForeignKey("reconciliation_results.id", ondelete="CASCADE"),
        nullable=False
    )
    field_name = Column(String, nullable=False)
    our_value = Column(String, nullable=True)
    other_value = Column(String, nullable=True)
    difference = Column(Float, nullable=True)