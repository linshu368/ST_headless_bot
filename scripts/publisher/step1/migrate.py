"""
将角色数据迁移到 Supabase role_library 表

使用 role_library(1).json 作为来源，将角色信息批量 upsert 到 Supabase。
脚本会从项目根目录的 .env 中读取 SUPABASE_URL 和 SUPABASE_KEY。
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

from dotenv import load_dotenv
from supabase import Client, create_client

DEFAULT_ROLE_LIBRARY_FILENAME = "role_library(1).json"
DEFAULT_TABLE_NAME = "role_library"
DEFAULT_BATCH_SIZE = 50


def load_env_file() -> None:
    """Load .env from the project root if it exists."""
    project_root = Path(__file__).resolve().parents[3]
    env_path = project_root / ".env"
    if env_path.exists():
        load_dotenv(env_path)
    else:
        load_dotenv()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrate role_library(1).json data into Supabase."
    )
    parser.add_argument(
        "--file",
        type=Path,
        default=Path(__file__).with_name(DEFAULT_ROLE_LIBRARY_FILENAME),
        help="Path to the source role_library JSON file.",
    )
    parser.add_argument(
        "--table",
        default=os.environ.get("SUPABASE_TABLE", DEFAULT_TABLE_NAME),
        help="Supabase table name (default: role_library).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=int(os.environ.get("SUPABASE_BATCH_SIZE", DEFAULT_BATCH_SIZE)),
        help="Number of rows to upsert per request.",
    )
    parser.add_argument(
        "--default-model",
        default=os.environ.get("ROLE_DEFAULT_MODEL"),
        help="Fallback model value when a role omits the model field.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate data without writing to Supabase.",
    )
    return parser.parse_args()


def ensure_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def ensure_optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_tags(raw_tags: Any) -> List[str]:
    if raw_tags is None:
        return []
    if isinstance(raw_tags, str):
        tag = raw_tags.strip()
        return [tag] if tag else []
    if isinstance(raw_tags, list):
        tags: List[str] = []
        for item in raw_tags:
            if item is None:
                continue
            tag = str(item).strip()
            if tag:
                tags.append(tag)
        return tags
    raise ValueError("tags must be a list or string")


def normalize_history(raw_history: Any) -> List[Dict[str, Any]]:
    if raw_history is None:
        return []
    if isinstance(raw_history, str):
        if not raw_history.strip():
            return []
        try:
            parsed = json.loads(raw_history)
        except json.JSONDecodeError as exc:
            raise ValueError("history string is not valid JSON") from exc
        return normalize_history(parsed)
    if isinstance(raw_history, list):
        for item in raw_history:
            if not isinstance(item, dict):
                raise ValueError("history entries must be objects")
        return raw_history
    raise ValueError("history must be a list or JSON string")


def load_roles(file_path: Path) -> List[Dict[str, Any]]:
    if not file_path.exists():
        raise FileNotFoundError(f"Role library file not found: {file_path}")
    with file_path.open("r", encoding="utf-8") as source:
        return json.load(source)


def normalize_role(
    role: Dict[str, Any],
    default_model: str | None = None,
) -> Dict[str, Any]:
    role_id_raw = role.get("role_id")
    if role_id_raw is None:
        raise ValueError("role_id is missing")
    try:
        role_id = int(str(role_id_raw))
    except ValueError as exc:
        raise ValueError(f"role_id '{role_id_raw}' is not a valid integer") from exc

    name = ensure_text(role.get("name")).strip()
    if not name:
        raise ValueError("name is missing")

    payload = {
        "role_id": role_id,
        "name": name,
        "avatar": ensure_optional_str(role.get("avatar")),
        "tags": normalize_tags(role.get("tags")),
        "summary": ensure_text(role.get("summary")),
        "system_prompt": ensure_text(role.get("system_prompt")),
        "history": normalize_history(role.get("history")),
        "model": ensure_optional_str(role.get("model")) or default_model,
        "deeplink": ensure_optional_str(role.get("deeplink")),
        "post_link": ensure_optional_str(role.get("post_link")),
    }
    return payload


def chunked(data: Sequence[Dict[str, Any]], size: int) -> Iterable[List[Dict[str, Any]]]:
    for idx in range(0, len(data), size):
        yield list(data[idx : idx + size])


def create_supabase_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_KEY must be set in environment variables")
    return create_client(url, key)


def upsert_roles(
    client: Client,
    table_name: str,
    roles: Sequence[Dict[str, Any]],
    batch_size: int,
) -> Tuple[int, List[Tuple[int, str]]]:
    total = len(roles)
    success_count = 0
    failures: List[Tuple[int, str]] = []

    for batch in chunked(roles, batch_size):
        try:
            client.table(table_name).upsert(
                batch,
                on_conflict="role_id",
                returning="minimal",
            ).execute()
            success_count += len(batch)
            print(f"✅ 已写入 {success_count}/{total} 个角色")
        except Exception as exc:
            print(f"⚠️ 批量写入 {len(batch)} 个角色失败，改为单条重试: {exc}")
            for role in batch:
                try:
                    client.table(table_name).upsert(
                        role,
                        on_conflict="role_id",
                        returning="minimal",
                    ).execute()
                    success_count += 1
                    print(f"  ↳ 单条写入成功：role_id={role['role_id']}")
                except Exception as role_exc:
                    failures.append((role.get("role_id"), str(role_exc)))
                    print(f"❌ 单条写入失败 role_id={role.get('role_id')}: {role_exc}")

    return success_count, failures


def main() -> None:
    load_env_file()
    args = parse_args()

    if args.batch_size <= 0:
        raise ValueError("batch-size must be a positive integer")

    roles = load_roles(args.file)
    print(f"📄 已加载 {len(roles)} 个角色")

    normalized_roles: List[Dict[str, Any]] = []
    skipped: List[Tuple[Any, str]] = []

    for index, role in enumerate(roles, start=1):
        try:
            normalized_roles.append(normalize_role(role, args.default_model))
        except ValueError as exc:
            skipped.append((role.get("role_id"), str(exc)))
            print(f"⚠️ 跳过角色 index={index} role_id={role.get('role_id')}: {exc}")

    print(f"🧹 可写入的角色数量: {len(normalized_roles)}，跳过 {len(skipped)} 个")
    if skipped:
        for role_id, reason in skipped:
            print(f"   - role_id={role_id}: {reason}")

    if args.dry_run:
        print("🛑 Dry-run 模式开启，未写入 Supabase。")
        return

    client = create_supabase_client()
    success_count, failures = upsert_roles(
        client,
        args.table,
        normalized_roles,
        args.batch_size,
    )

    print("📊 迁移完成")
    print(f"   ✅ 成功写入: {success_count}")
    print(f"   ⚠️ 写入失败: {len(failures)}")

    if failures:
        print("   失败详情：")
        for role_id, error in failures:
            print(f"     - role_id={role_id}: {error}")


if __name__ == "__main__":
    main()