#!/usr/bin/env bash
# Union every panel lens's verdict and gate on unanimous approval — the merge gate's
# decision. Fails CLOSED: exits non-zero if any lens rejected, produced a non-APPROVE or
# malformed verdict, is missing, or if a verdict ran for a lens OUTSIDE the gated set
# (matrix/aggregator drift). The lens set is FIXED — PANEL_LENSES overrides it for tests,
# else the default is used when it is UNSET. Extracted from the workflow so the gate's
# decision logic is unit-testable.
set -euo pipefail

dir="${1:?usage: aggregate.sh <verdicts-dir>}"
lenses="${PANEL_LENSES-correctness security testing docs resilience}"

if [ -z "${lenses//[[:space:]]/}" ]; then
  echo "::error title=No panel lenses::The lens set is empty — refusing to pass a gate that checked nothing. Failing closed."
  exit 1
fi
# Only bare [a-z0-9-] tokens, space-separated: blocks glob expansion, path traversal, and
# workflow-command injection via a crafted PANEL_LENSES before it is split and used in paths.
case "$lenses" in
  *[!a-z0-9\ -]*)
    echo "::error title=Invalid lens set::PANEL_LENSES may contain only [a-z0-9-] tokens. Failing closed."
    exit 1
    ;;
esac

# Neutralise a line-starting `::` in anything echoed from a verdict (which a
# prompt-injected panelist controls), so it cannot emit a GitHub Actions workflow command.
safe() { sed 's/^::/ ::/'; }

ok=1
echo "## Antagonistic panel — verdict by lens"
for lens in $lenses; do
  f="$dir/verdict-$lens/verdict.json"
  if [ ! -f "$f" ]; then
    echo "::error title=Missing verdict::Panelist '$lens' produced no verdict — it did not run to completion. Failing closed."
    ok=0
    continue
  fi
  # A verdict is a small JSON object; anything over 1MB is a model-written path gone wrong
  # (or an injection attempt). Refuse to parse untrusted bulk rather than risk OOM.
  if [ "$(wc -c <"$f")" -gt 1000000 ]; then
    echo "::error title=Oversize verdict::Panelist '$lens' produced a verdict over 1MB — refusing to parse. Failing closed."
    ok=0
    continue
  fi
  v="$(jq -r '.verdict // empty' "$f" 2>/dev/null || echo '')"
  {
    echo ""
    echo "### ${lens} — ${v:-none}"
    jq -r '.summary // ""' "$f" 2>/dev/null || true
    jq -r '.findings[]? | "  - " + .' "$f" 2>/dev/null || true
  } | safe
  [ "$v" = "APPROVE" ] || ok=0
done

# Drift guard: a verdict that ran for a lens OUTSIDE the gated set (e.g. a lens added to
# the workflow matrix but not here) must fail closed, not be silently ignored.
for d in "$dir"/verdict-*/; do
  [ -e "$d" ] || continue
  got="$(basename "$d")"
  got="${got#verdict-}"
  case " $lenses " in
    *" $got "*) : ;;
    *)
      echo "::error title=Unexpected lens::'$got' produced a verdict but is not in the gated set — matrix/aggregator drift. Failing closed."
      ok=0
      ;;
  esac
done

echo ""
if [ "$ok" -ne 1 ]; then
  echo "::error title=Change rejected::At least one lens rejected or failed to produce a verdict. The gate fails CLOSED."
  exit 1
fi
echo "Every lens APPROVED — the gate is green."
