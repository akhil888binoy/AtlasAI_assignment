import csv
from datetime import datetime, timezone

# Each company uses its own column names for the same field.
# When a third company starts sending files, add its names here.
COLUMN_ALIASES = {
    "external_id": ("trade_id", "reference", "id"),
    "timestamp": ("traded_at", "executed_at", "time", "date"),
    "instrument": ("instrument", "symbol"),
    "side": ("side", "direction"),
    "quantity": ("quantity", "qty"),
    "price": ("price", "unit_price", "execution_price"),
    "amount": ("gross_amount", "total", "amount"),
    "status": ("state", "status"),
}

DATE_FORMATS = ("%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M:%S")


def get_value(row, field, required=True):
    for column in COLUMN_ALIASES[field]:
        value = row.get(column)
        if value not in (None, ""):
            return value.strip()

    if required:
        raise KeyError(
            f"Missing column for {field}: expected one of {', '.join(COLUMN_ALIASES[field])}"
        )

    return None


def normalize_instrument(value):
    value = value.upper()

    if "-" in value:
        return value

    if value.endswith("USD"):
        return f"{value[:-3]}-USD"

    return value


def normalize_side(value):
    value = value.upper()

    if value == "B":
        return "BUY"
    if value == "S":
        return "SELL"

    return value


def parse_timestamp(value):
    for date_format in DATE_FORMATS:
        try:
            return datetime.strptime(value, date_format)
        except ValueError:
            continue

    parsed = datetime.fromisoformat(value)

    # Everything is compared as naive UTC.
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)

    return parsed


def parse_row(row, source):
    quantity = float(get_value(row, "quantity"))
    price = float(get_value(row, "price"))
    amount = get_value(row, "amount", required=False)
    status = get_value(row, "status").upper()

    return {
        "source": source,
        "external_id": get_value(row, "external_id"),
        "timestamp": parse_timestamp(get_value(row, "timestamp")),
        "instrument": normalize_instrument(get_value(row, "instrument")),
        "side": normalize_side(get_value(row, "side")),
        "quantity": quantity,
        "price": price,
        # The file's own total is what that side actually booked, fees included.
        "amount": float(amount) if amount else quantity * price,
        "status": "CANCELLED" if status == "CANCELLED" else "ACTIVE",
    }


def parse_transactions(file_path, source):
    with open(file_path, newline="") as file:
        return [parse_row(row, source) for row in csv.DictReader(file)]
