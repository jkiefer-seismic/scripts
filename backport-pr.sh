#!/usr/bin/env bash
#
# backport-pr.sh - Backport a merged PR to a release branch
#
# Usage:
#   ./backport-pr.sh [--suffix SUFFIX] <PR_NUMBER> <RELEASE_BRANCH>
#
# Options:
#   --suffix SUFFIX - Custom suffix for the backport branch (default: -release)
#
# Arguments:
#   PR_NUMBER       - The number of the merged PR to backport
#   RELEASE_BRANCH  - The target release branch (e.g., release/v2.1)
#
# Description:
#   This script automates the process of backporting a merged pull request to a
#   release branch. It fetches the PR metadata, creates a new backport branch,
#   cherry-picks the merge commit, and optionally creates a new PR targeting
#   the release branch.
#
# Requirements:
#   - gh (GitHub CLI) must be installed and authenticated
#   - jq must be installed for JSON parsing
#   - Git repository must be properly configured
#
# Examples:
#   ./backport-pr.sh 1234 release/v2.1
#   ./backport-pr.sh --suffix -hotfix 1234 release/v2.1
#
# The script will:
#   1. Fetch PR metadata from GitHub (title, body, merge commit)
#   2. Extract Jira ticket from PR description if present
#   3. Create a new branch named <original-branch>-release
#   4. Cherry-pick the merge commit to the new branch
#   5. Push the branch and create a PR (with confirmation prompts)

set -euo pipefail

# Default suffix for backport branch
BRANCH_SUFFIX="-release"

# Parse optional flags
while [[ $# -gt 0 ]]; do
    case $1 in
        --suffix)
            BRANCH_SUFFIX="$2"
            shift 2
            ;;
        *)
            break
            ;;
    esac
done

# Parse required arguments
if [ $# -lt 2 ]; then
    echo "Usage: $0 [--suffix SUFFIX] <PR_NUMBER> <RELEASE_BRANCH>"
    exit 1
fi

PR_NUMBER=$1
RELEASE_BRANCH=$2

# Disable gh pager so scripting works
# Disable all pagers for GitHub CLI
export GH_PAGER=cat
export PAGER=cat

echo "🔎 Fetching PR metadata…"

# Single API call to get all metadata
PR_DATA=$(gh pr view "$PR_NUMBER" --json mergeCommit,title,headRefName,body)

# Extract fields from the JSON
MERGE_SHA=$(echo "$PR_DATA" | jq -r .mergeCommit.oid)
PR_TITLE=$(echo "$PR_DATA" | jq -r .title)
PR_BRANCH=$(echo "$PR_DATA" | jq -r .headRefName)
PR_BODY=$(echo "$PR_DATA" | jq -r .body)

if [ -z "$MERGE_SHA" ] || [ "$MERGE_SHA" = "null" ]; then
    echo "❌ No merge commit found for PR #$PR_NUMBER. Was it merged?"
    exit 1
fi

echo "✅ Fetched PR metadata successfully."

JIRA_TICKET=$(echo "$PR_BODY" | grep -Eo 'Resolves[[:space:]]+\[?([A-Z]+-[0-9]+)' | grep -Eo '[A-Z]+-[0-9]+' | head -1 || true)
if [ -z "$JIRA_TICKET" ]; then
    echo "⚠️  No Jira ticket found in PR description. Using UNKNOWN."
    JIRA_TICKET="UNKNOWN"
fi

BACKPORT_BRANCH="$PR_BRANCH$BRANCH_SUFFIX"

NEW_PR_TITLE="${PR_TITLE} (release)"
NEW_PR_BODY=$(cat <<EOF
Resolves [${JIRA_TICKET}](https://seismic.atlassian.net/browse/${JIRA_TICKET})

See #${PR_NUMBER} for more information.
EOF
)

# Calculate width for PR preview box (based on title and body)
calc_pr_width() {
    local max_len=${#NEW_PR_TITLE}
    local len
    
    while IFS= read -r line; do
        len=${#line}
        [ $len -gt $max_len ] && max_len=$len
    done <<< "$NEW_PR_BODY"
    
    max_len=$((max_len + 2))
    #[ $max_len -lt 60 ] && max_len=60
    
    echo $max_len
}

BOX_WIDTH=$(calc_pr_width)

echo
echo "📦 Ready to backport PR #$PR_NUMBER"
echo "🔧 Merge Commit:     $MERGE_SHA"
echo "📝 PR Title:         $PR_TITLE"
echo "🎫 Jira Ticket:      $JIRA_TICKET"
echo "🌿 Source Branch:    $PR_BRANCH"
echo "🌿 Backport Branch:  $BACKPORT_BRANCH"
echo "🎯 Target Release:   $RELEASE_BRANCH"
echo
printf "┌"; printf '%.0s─' $(seq 1 $BOX_WIDTH); printf "┐\n"
printf "│ %-$((BOX_WIDTH-2))s │\n" "$NEW_PR_TITLE"
printf "├"; printf '%.0s─' $(seq 1 $BOX_WIDTH); printf "┤\n"
while IFS= read -r line; do
    printf "│ %-$((BOX_WIDTH-2))s │\n" "$line"
done <<< "$NEW_PR_BODY"
printf "└"; printf '%.0s─' $(seq 1 $BOX_WIDTH); printf "┘\n"
echo

read -p "❓ Proceed with creating backport branch and cherry-pick? (y/n) " CONFIRM
if [[ "$CONFIRM" != "y" ]]; then
    echo "❌ Aborted."
    exit 1
fi


echo "🔀 Creating backport branch and cherry-picking…"
git fetch origin "$RELEASE_BRANCH"
git checkout -b "$BACKPORT_BRANCH" "origin/$RELEASE_BRANCH"

git cherry-pick -x "$MERGE_SHA" || {
    # Check if it's an empty cherry-pick
    if git status | grep -q "The previous cherry-pick is now empty"; then
        echo "⚠️  Cherry-pick resulted in an empty commit."
        echo "    This usually means the changes are already in $RELEASE_BRANCH"
        read -p "❓ Skip this commit and continue? (y/n) " CONFIRM_SKIP
        if [[ "$CONFIRM_SKIP" == "y" ]]; then
            git cherry-pick --skip
            echo "✅ Skipped empty commit."
        else
            git cherry-pick --abort
            echo "❌ Aborted cherry-pick."
            exit 1
        fi
    else
        echo "❌ Cherry-pick failed due to conflicts."
        echo "📝 Please resolve the conflicts manually:"
        echo "   1. Fix the conflicts in your editor"
        echo "   2. Stage the resolved files: git add <files>"
        echo "   3. Continue the cherry-pick: git cherry-pick --continue"
        echo
        read -p "❓ Press Enter once you've resolved conflicts and completed the cherry-pick... " WAIT_FOR_RESOLVE
        
        # Check if cherry-pick was completed successfully
        if git status | grep -q "cherry-pick"; then
            echo "❌ Cherry-pick still in progress. Please complete or abort it."
            exit 1
        fi
        
        echo "✅ Cherry-pick resolution confirmed."
    fi
}

echo
echo "✅ Cherry-pick completed."
echo

read -p "❓ Push branch? (y/n) " CONFIRM_PUSH
if [[ "$CONFIRM_PUSH" != "y" ]]; then
    echo "❌ Backport branch created locally only. Not pushing."
    exit 0
fi

echo "⬆️  Pushing branch to origin…"
git push -u origin "$BACKPORT_BRANCH"
echo

read -p "❓ Create pull request on GitHub? (y/n) " CONFIRM_PR
if [[ "$CONFIRM_PR" != "y" ]]; then
    echo "❌ Backport branch pushed only. Not creating PR."
    exit 0
fi

echo "🔗 Creating pull request…"
gh pr create \
  --title "$NEW_PR_TITLE" \
  --body "$NEW_PR_BODY" \
  --base "$RELEASE_BRANCH" \
  --head "$BACKPORT_BRANCH"

echo
echo "🎉 Backport PR created successfully!"
