from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List


SOURCE_PATH = Path(
    "/Users/qj/python_project/tg_bot_picture_v1/scripts/publisher/step_1/results_step3_first_sentence.json"
)
OUTPUT_PATH = Path(
    "/Users/qj/python_project/SillyTavern/scripts/publisher/step1/character_v2.json"
)


def build_v2_card(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "",
            "description": "",
            "personality": "",
            "scenario": "",
            "first_mes": raw.get("first_sentence") or "",
            "mes_example": "",
            "system_prompt": raw.get("module_1_result") or "",
            "post_history_instructions": "",
            "alternate_greetings": [],
            "character_book": None,
            "tags": raw.get("tag") or [],
            "extensions": {
                "title": raw.get("name") or "",
                "role_id": raw.get("role_id"),
                "summary": raw.get("summary") or "",
                "deeplink": raw.get("deeplink") or "",
            },
        },
    }


def main() -> None:
    if not SOURCE_PATH.exists():
        raise FileNotFoundError(f"Source file not found: {SOURCE_PATH}")

    with SOURCE_PATH.open("r", encoding="utf-8") as source:
        payload = json.load(source)

    if not isinstance(payload, list):
        raise ValueError("Expected the source JSON to be a list of roles.")

    output: List[Dict[str, Any]] = [build_v2_card(item) for item in payload]

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as target:
        json.dump(output, target, ensure_ascii=False, indent=2)

    print(f"Wrote {len(output)} roles to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
