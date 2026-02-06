"""
将角色数据迁移到 Supabase role_data 表

使用 character_v2.json 作为来源，将角色信息批量 upsert 到 Supabase。
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

DEFAULT_ROLE_LIBRARY_FILENAME = "character_v2.json"
DEFAULT_TABLE_NAME = "role_data"
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
        description="Migrate character_v2.json data into Supabase."
    )
    parser.add_argument(
        "--file",
        type=Path,
        default=Path(__file__).with_name(DEFAULT_ROLE_LIBRARY_FILENAME),
        help="Path to the source character_v2 JSON file.",
    )
    parser.add_argument(
        "--table",
        default=os.environ.get("SUPABASE_TABLE", DEFAULT_TABLE_NAME),
        help="Supabase table name (default: role_data).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=int(os.environ.get("SUPABASE_BATCH_SIZE", DEFAULT_BATCH_SIZE)),
        help="Number of rows to upsert per request.",
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


def normalize_role(role_wrapper: Dict[str, Any]) -> Dict[str, Any]:
    """
    Flatten the nested chara_card_v2 structure into the flat Supabase schema.
    
    Structure expectation:
    {
      "spec": "chara_card_v2",
      "spec_version": "2.0",
      "data": {
        "name": "...",
        "extensions": { "role_id": "...", ... },
        ...
      }
    }
    """
    data = role_wrapper.get("data", {})
    if not isinstance(data, dict):
        # Fallback if data is malformed or missing
        data = {}
        
    extensions = data.get("extensions", {})
    if not isinstance(extensions, dict):
        extensions = {}

    # 1. Extract role_id (Primary Identifier)
    # Prefer extensions.role_id, fallback to data.role_id if present
    role_id_raw = extensions.get("role_id") or data.get("role_id")
    
    if not role_id_raw:
        # Without a role_id, we cannot reliably upsert or identify the character
        raise ValueError("role_id is missing in data.extensions or data")
    
    # Ensure role_id is a string (as per table definition: role_id text not null)
    role_id = str(role_id_raw).strip()

    # 2. Extract and Normalize other fields
    payload = {
        "role_id": role_id,
        
        # Spec fields
        "spec": ensure_optional_str(role_wrapper.get("spec")),
        "spec_version": ensure_optional_str(role_wrapper.get("spec_version")),
        
        # Data fields
        "name": ensure_optional_str(data.get("name")),
        "description": ensure_optional_str(data.get("description")),
        "personality": ensure_optional_str(data.get("personality")),
        "scenario": ensure_optional_str(data.get("scenario")),
        "first_mes": ensure_optional_str(data.get("first_mes")),
        "mes_example": ensure_optional_str(data.get("mes_example")),
        
        # Optional metadata fields (might be null)
        "creator": ensure_optional_str(data.get("creator")),
        "character_version": ensure_optional_str(data.get("character_version")),
        "creator_notes": ensure_optional_str(data.get("creator_notes")),
        
        # Instructions
        "system_prompt": ensure_optional_str(data.get("system_prompt")),
        "post_history_instructions": ensure_optional_str(data.get("post_history_instructions")),
        
        # JSONB fields
        # Supabase client handles Python list/dict -> JSONB conversion automatically
        "alternate_greetings": data.get("alternate_greetings"), 
        "character_book": data.get("character_book"),
        "tags": data.get("tags"),
        
        # Extension fields
        "title": ensure_optional_str(extensions.get("title")),
        "summary": ensure_optional_str(extensions.get("summary")),
        "deeplink": ensure_optional_str(extensions.get("deeplink")),
        
        # Other
        "avatar": ensure_optional_str(data.get("avatar")),
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


def load_roles(file_path: Path) -> List[Dict[str, Any]]:
    if not file_path.exists():
        raise FileNotFoundError(f"Role library file not found: {file_path}")
    with file_path.open("r", encoding="utf-8") as source:
        content = json.load(source)
        if isinstance(content, dict):
            # If the file contains a single character object, wrap it in a list
            return [content]
        elif isinstance(content, list):
            return content
        else:
            raise ValueError("JSON file must contain a list or a single object")


def upsert_roles(
    client: Client,
    table_name: str,
    roles: Sequence[Dict[str, Any]],
    batch_size: int,
) -> Tuple[int, List[Tuple[str, str]]]:
    total = len(roles)
    success_count = 0
    failures: List[Tuple[str, str]] = []

    for batch in chunked(roles, batch_size):
        try:
            # Note: on_conflict="role_id" assumes role_id has a unique constraint or index that allows inference.
            # If Supabase errors out, we might need to rely on 'id' if we had it, but we don't.
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
                role_id = role.get("role_id", "UNKNOWN")
                try:
                    client.table(table_name).upsert(
                        role,
                        on_conflict="role_id",
                        returning="minimal",
                    ).execute()
                    success_count += 1
                    print(f"  ↳ 单条写入成功：role_id={role_id}")
                except Exception as role_exc:
                    failures.append((role_id, str(role_exc)))
                    print(f"❌ 单条写入失败 role_id={role_id}: {role_exc}")

    return success_count, failures


def main() -> None:
    load_env_file()
    args = parse_args()

    if args.batch_size <= 0:
        raise ValueError("batch-size must be a positive integer")

    try:
        roles = load_roles(args.file)
    except Exception as e:
        print(f"❌ 无法加载文件 {args.file}: {e}")
        return

    print(f"📄 已加载 {len(roles)} 个角色")

    normalized_roles: List[Dict[str, Any]] = []
    skipped: List[Tuple[Any, str]] = []

    for index, role in enumerate(roles, start=1):
        try:
            normalized_roles.append(normalize_role(role))
        except ValueError as exc:
            # Try to get role_id for error message if possible
            role_id_hint = "UNKNOWN"
            if isinstance(role, dict):
                data = role.get("data", {})
                if isinstance(data, dict):
                    role_id_hint = data.get("extensions", {}).get("role_id") or data.get("role_id") or "UNKNOWN"
            
            skipped.append((role_id_hint, str(exc)))
            print(f"⚠️ 跳过角色 index={index} role_id={role_id_hint}: {exc}")

    print(f"🧹 可写入的角色数量: {len(normalized_roles)}，跳过 {len(skipped)} 个")
    if skipped:
        for role_id, reason in skipped:
            print(f"   - role_id={role_id}: {reason}")

    if args.dry_run:
        print("🛑 Dry-run 模式开启，未写入 Supabase。")
        # Print first normalized role as example
        if normalized_roles:
            print("🔍 示例数据 (第一条):")
            print(json.dumps(normalized_roles[0], indent=2, ensure_ascii=False))
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
