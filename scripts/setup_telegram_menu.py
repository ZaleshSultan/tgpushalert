import argparse
import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from dotenv import load_dotenv


COMMANDS = [
    {"command": "today", "description": "События и дедлайны на сегодня"},
    {"command": "wishlist", "description": "Активные скидки из Steam Wishlist"},
    {"command": "deals", "description": "Все активные игровые предложения"},
    {"command": "free", "description": "Только бесплатные раздачи"},
    {"command": "status", "description": "Состояние системы и синхронизация"},
    {"command": "spend", "description": "Записать трату"},
    {"command": "report", "description": "Финансовый отчет от ИИ"},
    {"command": "addtask", "description": "Добавить личную задачу"},
    {"command": "cancel", "description": "Отменить текущий диалог"},
    {"command": "help", "description": "Показать справку"},
]


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(
        description="Configure Telegram bot commands and the commands menu button.",
    )
    parser.add_argument(
        "--chat-id",
        help="Optional private chat id. If omitted, configures default private chat commands menu.",
    )
    args = parser.parse_args()

    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError("Missing TELEGRAM_BOT_TOKEN")

    command_scope = {"type": "chat", "chat_id": args.chat_id} if args.chat_id else {
        "type": "all_private_chats",
    }
    telegram_api(token, "setMyCommands", {
        "commands": COMMANDS,
        "scope": command_scope,
    })

    menu_payload = {"menu_button": {"type": "commands"}}
    if args.chat_id:
        menu_payload["chat_id"] = args.chat_id
    telegram_api(token, "setChatMenuButton", menu_payload)

    target = f"chat {args.chat_id}" if args.chat_id else "default private chats"
    print(f"Telegram commands menu configured for {target}.")


def telegram_api(token: str, method: str, payload: dict) -> dict:
    request = Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"ERROR {method}: HTTP {error.code}: {detail}")
        raise RuntimeError(f"Telegram {method} failed: HTTP {error.code}: {detail}") from error

    if not body.get("ok"):
        print(f"ERROR {method}: {body.get('description', body)}")
        raise RuntimeError(f"Telegram {method} failed: {body.get('description', body)}")
    print(f"OK {method}")
    return body


if __name__ == "__main__":
    main()
