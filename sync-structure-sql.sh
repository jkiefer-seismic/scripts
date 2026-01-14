#!/bin/bash
# Script to sync structure.sql from a branch and add missing migrations
# Usage: bin/sync-structure-sql <branch-name>
set -e

# Handle Ctrl+C gracefully
trap 'echo "
❌ Operation cancelled by user"; exit 130' INT

if [ $# -eq 0 ]; then
  echo "Usage: $0 <branch-name>"
  echo "Example: $0 main"
  exit 1
fi

BRANCH=$1
STRUCTURE_FILE="db/structure.sql"
MIGRATE_DIR="db/migrate"

echo "📥 Checking out ${STRUCTURE_FILE} from ${BRANCH}..."
git checkout "origin/${BRANCH}" -- "${STRUCTURE_FILE}"

echo

echo "🔍 Finding migrations on disk..."
# Extract timestamps from migration filenames (format: YYYYMMDDHHMMSS_*.rb)
DISK_MIGRATIONS=$(ls "${MIGRATE_DIR}"/*.rb 2>/dev/null | sed -n 's/.*\/\([0-9]\{14\}\)_.*/\1/p' | sort -u)
TOTAL_DISK=$(echo "$DISK_MIGRATIONS" | wc -l | tr -d ' ')
echo "  Found ${TOTAL_DISK} migration(s) on disk"

echo "📋 Reading migrations from structure.sql..."
# Extract all migrations from structure.sql at once (much faster than grepping individually)
STRUCTURE_MIGRATIONS=$(grep -o "('[0-9]\{14\}')" "${STRUCTURE_FILE}" | tr -d "'()" | sort -u)

echo "🔍 Comparing migrations..."

# Use comm to find differences - MUCH faster than looping with grep
# comm requires sorted input (which we already have)
MISSING_MIGRATIONS=$(comm -23 <(echo "$DISK_MIGRATIONS") <(echo "$STRUCTURE_MIGRATIONS"))
MISSING_COUNT=$(echo "$MISSING_MIGRATIONS" | grep -c '^' || true)

# Display missing migrations if any
if [ $MISSING_COUNT -gt 0 ]; then
  echo "$MISSING_MIGRATIONS" | while IFS= read -r migration; do
    [ -n "$migration" ] && echo "  ❌ Missing: ${migration}"
  done
fi

echo "  ✓ Checked ${TOTAL_DISK} migrations"

if [ $MISSING_COUNT -eq 0 ]; then
  echo "✅ No missing migrations found. Structure.sql is up to date!"
  exit 0
fi

echo ""
echo "📝 Found ${MISSING_COUNT} missing migration(s)"
echo "➕ Appending missing migrations to structure.sql..."

# Find the last migration line (the one ending with semicolon)
LAST_MIGRATION_LINE=$(grep -n "^('[0-9]\{14\}');" "${STRUCTURE_FILE}" | tail -1 | cut -d: -f1)

if [ -z "$LAST_MIGRATION_LINE" ]; then
  echo "❌ Error: Could not find migration list in structure.sql"
  exit 1
fi

# Create a temporary file
TEMP_FILE=$(mktemp)

# Copy everything up to and including the last migration
head -n "$LAST_MIGRATION_LINE" "${STRUCTURE_FILE}" > "$TEMP_FILE"

# Remove the semicolon from the last line and add a comma
sed -i.bak '$ s/);$/),/' "$TEMP_FILE" && rm -f "$TEMP_FILE.bak"

# Add missing migrations (already in correct format from comm)
echo "$MISSING_MIGRATIONS" | while IFS= read -r migration; do
  if [ -n "$migration" ]; then
    echo "('${migration}')," >> "$TEMP_FILE"
  fi
done

# Change the last comma to semicolon
sed -i.bak '$ s/,$/;/' "$TEMP_FILE" && rm -f "$TEMP_FILE.bak"

# Append the rest of the file
tail -n +$((LAST_MIGRATION_LINE + 1)) "${STRUCTURE_FILE}" >> "$TEMP_FILE"

# Replace the original file
mv "$TEMP_FILE" "${STRUCTURE_FILE}"

echo "✅ Successfully appended missing migrations to structure.sql"