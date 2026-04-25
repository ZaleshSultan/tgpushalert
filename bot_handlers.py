"""Legacy aiogram handlers from the former Python Telegram runtime.

Telegram commands and callbacks now live in Supabase Edge Function
`supabase/functions/telegram-webhook`. This module is intentionally not used by
`main.py` and keeps no aiogram imports, so the Python worker can run without
Telegram dependencies.
"""


def setup_handlers(*_args, **_kwargs):
    raise RuntimeError(
        "Python Telegram polling has been retired. Use the Supabase "
        "telegram-webhook Edge Function as the only Telegram runtime.",
    )
