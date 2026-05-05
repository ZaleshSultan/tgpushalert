from __future__ import annotations

from dataclasses import dataclass
import re


class ExpenseParseError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedExpense:
    amount: int
    currency_code: str
    category_guess: str
    category_normalized: str
    tags: list[str]
    confidence: float
    parse_version: str


CURRENCY_MARKERS = {
    "kzt": "KZT",
    "₸": "KZT",
    "тг": "KZT",
    "тенге": "KZT",
    "usd": "USD",
    "$": "USD",
    "eur": "EUR",
    "€": "EUR",
    "rub": "RUB",
    "₽": "RUB",
}

CATEGORY_KEYWORDS = {
    "food": {
        "coffee",
        "cafe",
        "lunch",
        "dinner",
        "breakfast",
        "restaurant",
        "еда",
        "кофе",
        "обед",
        "ужин",
        "завтрак",
        "кафе",
        "ресторан",
    },
    "groceries": {
        "groceries",
        "grocery",
        "supermarket",
        "products",
        "продукты",
        "магазин",
        "супермаркет",
    },
    "transport": {
        "taxi",
        "uber",
        "yandex",
        "bus",
        "metro",
        "fuel",
        "parking",
        "такси",
        "автобус",
        "метро",
        "бензин",
        "парковка",
    },
    "health": {
        "pharmacy",
        "doctor",
        "medicine",
        "аптека",
        "врач",
        "лекарства",
    },
    "shopping": {
        "shopping",
        "clothes",
        "gift",
        "покупки",
        "одежда",
        "подарок",
    },
    "entertainment": {
        "movie",
        "cinema",
        "steam",
        "game",
        "games",
        "кино",
        "игры",
        "игра",
    },
    "bills": {
        "rent",
        "internet",
        "utilities",
        "subscription",
        "аренда",
        "интернет",
        "коммуналка",
        "подписка",
    },
}


def parse_expense_text(raw_text: str, default_currency: str = "KZT") -> ParsedExpense:
    text = " ".join(raw_text.strip().split())
    if not text:
        raise ExpenseParseError("Expense text is empty")

    amount_match = re.search(r"\d(?:[\d\s.,]*\d)?|\d", text)
    if not amount_match:
        raise ExpenseParseError(f"Could not find amount in: {raw_text!r}")

    amount = _parse_amount_token(amount_match.group(0))
    currency_code = _detect_currency_code(text, default_currency)
    remaining_text = _strip_amount_and_currency(text, amount_match.start(), amount_match.end())

    tags = _extract_tags(remaining_text)
    category_text = _strip_tags(remaining_text).strip(" -,:;")
    category_text = " ".join(category_text.split())
    category_guess = category_text or "uncategorized"
    category_normalized, used_known_category = _normalize_category(category_guess, tags)
    confidence = _estimate_confidence(
        category_guess=category_guess,
        category_normalized=category_normalized,
        used_known_category=used_known_category,
        tags=tags,
    )

    return ParsedExpense(
        amount=amount,
        currency_code=currency_code,
        category_guess=category_guess,
        category_normalized=category_normalized,
        tags=tags,
        confidence=confidence,
        parse_version="v1",
    )


def _parse_amount_token(raw_amount: str) -> int:
    amount = raw_amount.strip()
    compact = amount.replace(" ", "")

    if compact.isdigit():
        return int(compact)

    if re.fullmatch(r"\d{1,3}([.,]\d{3})+", compact):
        return int(re.sub(r"[.,]", "", compact))

    if re.fullmatch(r"\d+[.,]0+", compact):
        return int(compact.split(".")[0].split(",")[0])

    if re.fullmatch(r"\d+[.,]\d{1,2}", compact):
        raise ExpenseParseError(
            f"Fractional amounts are not supported for integer storage: {raw_amount!r}",
        )

    digits_only = re.sub(r"[^\d]", "", compact)
    if digits_only:
        return int(digits_only)

    raise ExpenseParseError(f"Could not parse amount: {raw_amount!r}")


def _detect_currency_code(text: str, default_currency: str) -> str:
    lowered = text.lower()
    for marker, currency_code in CURRENCY_MARKERS.items():
        if marker in lowered:
            return currency_code
    return default_currency


def _strip_amount_and_currency(text: str, amount_start: int, amount_end: int) -> str:
    without_amount = f"{text[:amount_start]} {text[amount_end:]}"
    tokens = []
    for token in without_amount.split():
        normalized = token.lower().strip("()[]{}.,:;")
        if normalized in CURRENCY_MARKERS:
            continue
        if any(normalized.startswith(symbol) for symbol in ("$", "€", "₸", "₽")):
            normalized = normalized[1:]
            if not normalized:
                continue
        tokens.append(token)
    return " ".join(tokens)


def _extract_tags(text: str) -> list[str]:
    seen: set[str] = set()
    tags: list[str] = []
    for match in re.findall(r"#([\w-]+)", text, flags=re.UNICODE):
        tag = match.lower()
        if tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return tags


def _strip_tags(text: str) -> str:
    return re.sub(r"#([\w-]+)", "", text, flags=re.UNICODE)


def _normalize_category(category_guess: str, tags: list[str]) -> tuple[str, bool]:
    lowered = category_guess.lower()
    ordered_words = re.findall(r"[\w-]+", lowered, flags=re.UNICODE)
    words = set(ordered_words)
    words.update(tags)

    for normalized_category, keywords in CATEGORY_KEYWORDS.items():
        if words.intersection(keywords):
            return normalized_category, True

    if ordered_words:
        return ordered_words[0], False

    return "uncategorized", False


def _estimate_confidence(
    *,
    category_guess: str,
    category_normalized: str,
    used_known_category: bool,
    tags: list[str],
) -> float:
    score = 0.55

    if used_known_category:
        score += 0.3
    elif category_normalized == "uncategorized":
        score -= 0.2
    elif len(category_guess.split()) == 1:
        score -= 0.05
    else:
        score += 0.05

    if tags:
        score += 0.05

    if category_guess == "uncategorized":
        score -= 0.1

    return round(min(max(score, 0.0), 1.0), 3)
