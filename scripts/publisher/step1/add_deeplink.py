import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv


ROLE_LIBRARY_FILENAME = "character_v2.json"


def load_roles(file_path: Path) -> List[Dict[str, Any]]:
    with file_path.open("r", encoding="utf-8") as source:
        return json.load(source)


def save_roles(file_path: Path, roles: List[Dict[str, Any]]) -> None:
    with file_path.open("w", encoding="utf-8") as target:
        json.dump(roles, target, ensure_ascii=False, indent=2)


def extract_role_id_and_extensions(role: Dict[str, Any]) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    data = role.get("data")
    if isinstance(data, dict):
        extensions = data.get("extensions")
        if isinstance(extensions, dict):
            role_id = extensions.get("role_id")
            if role_id is not None:
                return str(role_id), extensions
            return None, extensions
    return None, None


def count_roles_without_deeplink(roles: List[Dict[str, Any]]) -> int:
    missing_count = 0

    for role in roles:
        role_id, extensions = extract_role_id_and_extensions(role)
        if role_id is not None:
            if not extensions or not extensions.get("deeplink"):
                missing_count += 1
            continue

        if "deeplink" not in role:
            missing_count += 1

    return missing_count


def ensure_deeplink_field(roles: List[Dict[str, Any]], bot_username: str) -> int:
    updated_count = 0

    for role in roles:
        role_id, extensions = extract_role_id_and_extensions(role)
        if role_id is not None and extensions is not None:
            deeplink = f"https://t.me/{bot_username}?start=role_{role_id}"
            if extensions.get("deeplink") != deeplink:
                extensions["deeplink"] = deeplink
                updated_count += 1
            continue

        role_id = role.get("role_id")
        if not role_id:
            continue

        deeplink = f"https://t.me/{bot_username}?start=role_{role_id}"
        if role.get("deeplink") != deeplink:
            role["deeplink"] = deeplink
            updated_count += 1

    return updated_count


def load_env_file() -> None:
    """
    Load .env starting from project root (tg_bot_picture_v1) and fallback to defaults.
    """
    project_root = Path(__file__).resolve().parents[3]
    env_path = project_root / ".env"

    # load_dotenv returns True if something was loaded; still call default to capture shell env
    if env_path.exists():
        load_dotenv(dotenv_path=env_path)
    else:
        load_dotenv()


def main() -> None:
    load_env_file()

    bot_username = os.environ.get("TELEGRAM_BOT_USERNAME")
    if not bot_username:
        raise EnvironmentError("BOT_TELEGRAM_BOT_USERNAMEUSERNAME environment variable is not set.")

    file_path = Path(__file__).with_name(ROLE_LIBRARY_FILENAME)

    roles = load_roles(file_path)
    missing_deeplink_count = count_roles_without_deeplink(roles)
    print(f"🔍 本次共有 {missing_deeplink_count} 个角色缺少 deeplink 字段")

    updated_count = ensure_deeplink_field(roles, bot_username)
    save_roles(file_path, roles)

    print(f"✅ 本次已为 {updated_count} 个角色成功添加了 deeplink 字段")


if __name__ == "__main__":
    main()


