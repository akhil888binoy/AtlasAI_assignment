import csv
from datetime import datetime


def get_value(row, *keys):
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value

    raise KeyError(f"Missing one of these columns: {', '.join(keys)}")


def normalize_instrument(value):
    value = value.strip().upper()

    if "-" in value:
        return value

    if value.endswith("USD"):
        return f"{value[:-3]}-USD"

    return value


def normalize_side(value):
    value = value.strip().upper()

    if value == "B":
        return "BUY"
    if value == "S":
        return "SELL"

    return value


def parse_timestamp(value):
    value = value.strip()

    for date_format in ("%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M:%S"):
        try:
            return datetime.strptime(value, date_format)
        except ValueError:
            continue

    return datetime.fromisoformat(value)


def parse_our_ledger(file_path):
    transactions = []

    with open(file_path, "r") as file:
        reader = csv.DictReader(file)

        for row in reader:
            quantity = float(get_value(row, "qty", "quantity"))
            price = float(get_value(row, "price", "unit_price"))
            status = get_value(row, "status", "state").upper()

            transaction = {
                "source": "OUR_LEDGER",
                "external_id": get_value(row, "trade_id", "reference"),
                "timestamp": parse_timestamp(get_value(row, "time", "traded_at", "executed_at")),
                "instrument": normalize_instrument(get_value(row, "symbol", "instrument")),
                "side": normalize_side(get_value(row, "side", "direction")),
                "quantity": quantity,
                "price": price,
                "amount": quantity * price,
                "status": "CANCELLED" if status == "CANCELLED" else "ACTIVE"
            }

            transactions.append(transaction)

    return transactions


def parse_other_statement(file_path):
    transactions = []

    with open(file_path, "r") as file:
        reader = csv.DictReader(file)

        for row in reader:
            quantity = float(get_value(row, "quantity", "qty"))
            price = float(get_value(row, "execution_price", "unit_price", "price"))
            status = get_value(row, "status", "state").upper()

            transaction = {
                "source": "OTHER_STATEMENT",
                "external_id": get_value(row, "id", "reference"),
                "timestamp": parse_timestamp(get_value(row, "date", "executed_at", "traded_at")),
                "instrument": normalize_instrument(get_value(row, "instrument", "symbol")),
                "side": normalize_side(get_value(row, "direction", "side")),
                "quantity": quantity,
                "price": price,
                "amount": quantity * price,
                "status": "CANCELLED" if status == "CANCELLED" else "ACTIVE"
            }

            transactions.append(transaction)

    return transactions
