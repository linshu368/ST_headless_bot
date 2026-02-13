#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/model_class_original.png"
OUT="${SCRIPT_DIR}/model_class.png"
ENV_FILE="${SCRIPT_DIR}/../.env"

if [[ ! -f "${SRC}" ]]; then
  echo "Source image not found: ${SRC}" >&2
  exit 1
fi

# Resize longest edge to 1152px (90% of 1280), keep aspect ratio.
# Requires macOS built-in sips.
sips -Z 1152 "${SRC}" --out "${OUT}" >/dev/null

echo "Preprocessed image saved to: ${OUT}"

# Upload to Supabase Storage (bucket: model_photo, object: model_class.png)
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_KEY:-}"

if [[ -z "${SUPABASE_URL}" || -z "${SUPABASE_KEY}" ]]; then
  if [[ -f "${ENV_FILE}" ]]; then
    while IFS= read -r line; do
      case "${line}" in
        SUPABASE_URL=*) SUPABASE_URL="${line#SUPABASE_URL=}" ;;
        SUPABASE_KEY=*) SUPABASE_KEY="${line#SUPABASE_KEY=}" ;;
      esac
    done < "${ENV_FILE}"
  fi
fi

if [[ -z "${SUPABASE_URL}" || -z "${SUPABASE_KEY}" ]]; then
  echo "SUPABASE_URL or SUPABASE_KEY not set. Skipping upload." >&2
  exit 1
fi

UPLOAD_URL="${SUPABASE_URL}/storage/v1/object/model_photo/model_class.png"
curl -sS --fail -X POST "${UPLOAD_URL}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Content-Type: image/png" \
  -H "x-upsert: true" \
  --data-binary @"${OUT}" >/dev/null

echo "Uploaded to Supabase: model_photo/model_class.png"
