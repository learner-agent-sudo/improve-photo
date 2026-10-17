#!/usr/bin/env bash
#
# Checks that the published site really works, then tells Healthchecks.io.
#
# Healthchecks.io never visits the site itself. It only waits for "pings", and
# emails you when one reports a problem or when they stop arriving. This script
# is the thing that visits; .github/workflows/healthcheck.yml runs it hourly.
#
# "Works" means more than "the address answers", because every realistic way
# this static site breaks still answers 200 on the front page:
#   1. Pages switched back to "Deploy from a branch", which serves the unbuilt
#      source index.html (it loads /src/main.tsx, which no browser can run);
#   2. a page from one deploy naming script files from another, which 404;
#   3. a script that loads but throws before the app starts.
# So the page is checked to be the built one, every script and stylesheet it
# names is fetched, and then a headless browser opens it to confirm the app
# actually started. index.html carries a fallback notice that main.tsx removes
# as its first act, so if that notice is still in the page, nothing ran.
#
# Environment:
#   SITE_URL     page to check (default: the live site)
#   HC_PING_URL  this check's ping URL from Healthchecks.io. Optional, so the
#                check can run before it is set up; without it the result is
#                only printed. Keep it secret: anyone holding it can send
#                pings that look like ours.
#   CHROME       browser to use for step 3 (default: the first of google-chrome,
#                chromium, chromium-browser found). With none, step 3 is skipped
#                and the report says so.
#   RETRY_AFTER  seconds to wait before re-checking a failure (default 60)
#
# Exit status: 0 when the result reached Healthchecks.io, which then does the
# alerting, or when nothing was wrong. 1 when a problem could not be reported,
# so this failed run is the only alarm left. A failure that WAS reported exits
# 0 on purpose: GitHub emails on every failed run, which during a day-long
# outage would be 24 emails, where Healthchecks.io sends one when the site goes
# down and one when it comes back.
#
# Requires: bash, curl, grep, sed (all present on GitHub's Ubuntu runners).

set -uo pipefail

SITE_URL="${SITE_URL:-https://learner-agent-sudo.github.io/improve-photo/}"
RETRY_AFTER="${RETRY_AFTER:-60}"
# Pasted secrets often carry a stray newline or trailing slash; either would
# break the URL built from it below.
HC_PING_URL="$(printf '%s' "${HC_PING_URL:-}" | tr -d '[:space:]')"
HC_PING_URL="${HC_PING_URL%/}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

report=""
say() {
  report+="$*"$'\n'
  printf '%s\n' "$*"
}

# Fetches $1 into $2 and prints the HTTP status ("000" when there was no
# answer at all). curl's own error, if any, is left in $work/err.
fetch() {
  curl -sS -L -m 20 --retry 2 -o "$2" -w '%{http_code}' "$1" 2>"$work/err" || true
}

# The reason a fetch got no answer, for the report.
why() {
  local e
  e="$(tail -n 1 "$work/err" 2>/dev/null)"
  [[ -n $e ]] && printf ' (%s)' "$e"
}

# Turns a src/href from the page into a full URL.
resolve() {
  local ref="$1" base="${SITE_URL%%[?#]*}"
  case "$ref" in
    http://* | https://*) printf '%s' "$ref" ;;
    //*) printf '%s%s' "${base%%//*}" "$ref" ;;
    /*) printf '%s%s' "$(printf '%s' "$base" | sed -E 's#^(https?://[^/]+).*#\1#')" "$ref" ;;
    *) printf '%s/%s' "${base%/*}" "${ref#./}" ;;
  esac
}

find_browser() {
  local b
  if [[ -n ${CHROME:-} ]]; then
    printf '%s' "$CHROME"
    return
  fi
  for b in google-chrome chromium chromium-browser; do
    if command -v "$b" >/dev/null 2>&1; then
      command -v "$b"
      return
    fi
  done
}

check() {
  local page="$work/index.html" code asset size n=0 browser
  : >"$work/err"

  # 1. The page itself, and that it is the built app.
  code="$(fetch "$SITE_URL" "$page")"
  if [[ $code != 200 ]]; then
    say "FAIL page answered HTTP $code$(why): $SITE_URL"
    return 1
  fi
  if grep -q '/src/main.tsx' "$page"; then
    say "FAIL the page is the unbuilt source. Settings -> Pages -> Source must be 'GitHub Actions' (see deploy.yml)"
    return 1
  fi
  if ! grep -q 'id="root"' "$page"; then
    say "FAIL the page has no app root, so it is not Darkroom"
    return 1
  fi
  say "ok   page, HTTP 200, $(wc -c <"$page" | tr -d ' ') bytes"

  # 2. Every script and stylesheet it names. Built file names carry a content
  # hash (index-DLvr9Yn0.js), so a page from one deploy naming files from
  # another fails here instead of in a visitor's browser.
  while read -r asset; do
    code="$(fetch "$(resolve "$asset")" "$work/asset")"
    size="$(wc -c <"$work/asset" 2>/dev/null | tr -d ' ')"
    if [[ $code != 200 || ${size:-0} -eq 0 ]]; then
      say "FAIL $asset answered HTTP $code$(why)"
      return 1
    fi
    say "ok   $asset, $size bytes"
    n=$((n + 1))
  done < <(grep -oE '(src|href)="[^"]*assets/[^"]+\.(js|css)"' "$page" |
    sed -E 's/^(src|href)="//; s/"$//' | sort -u)
  if ((n == 0)); then
    say "FAIL the page names no scripts or stylesheets"
    return 1
  fi

  # 3. That the app started. --dump-dom prints the page after its scripts have
  # run; --virtual-time-budget lets it settle first without real waiting.
  # --no-sandbox: Chrome's sandbox cannot start inside some CI containers, and
  # this is our own page in a throwaway machine.
  browser="$(find_browser)"
  if [[ -z $browser ]]; then
    say "skip app start-up check: no Chrome or Chromium on this machine"
    return 0
  fi
  timeout 90 "$browser" --headless=new --no-sandbox --disable-gpu \
    --virtual-time-budget=10000 --dump-dom "$SITE_URL" >"$work/dom.html" 2>/dev/null
  if grep -q 'id="boot-fallback"' "$work/dom.html"; then
    say "FAIL the app did not start: its scripts loaded but the start-up notice was never removed"
    return 1
  fi
  if ! grep -q '<div id="root"><' "$work/dom.html"; then
    say "FAIL the app did not start: the browser got no page, or the app drew nothing"
    return 1
  fi
  say "ok   app started in a headless browser"
}

say "Checking $SITE_URL at $(date -u '+%Y-%m-%d %H:%M UTC')"
if check; then
  status=ok
else
  # One re-check, so a passing blip (a CDN hiccup, a deploy landing mid-check)
  # does not wake anyone. A real outage is still there a minute later.
  say "... checking once more in ${RETRY_AFTER}s in case that was a blip"
  sleep "$RETRY_AFTER"
  if check; then status=ok; else status=fail; fi
fi
say "Result: $status"

# A summary on the run's page in GitHub, readable without opening the log.
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    if [[ $status == ok ]]; then echo "### ✅ Site is up"; else echo "### ❌ Site check failed"; fi
    echo
    echo '```'
    printf '%s' "$report"
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [[ -z $HC_PING_URL ]]; then
  echo "::warning::HC_PING_URL is not set, so nothing was sent to Healthchecks.io. See the README, 'Monitoring'."
  [[ $status == ok ]]
  exit
fi

# Success pings go to the URL as given, failures to URL/fail. The report rides
# along as the request body, and shows in the check's log on Healthchecks.io.
endpoint="$HC_PING_URL"
[[ $status == fail ]] && endpoint+="/fail"
curl -fsS -m 10 --retry 5 -o /dev/null --data-raw "$report" "$endpoint"
sent=$?
if ((sent == 0)); then
  echo "Reported '$status' to Healthchecks.io."
  [[ $status == fail ]] && echo "::error::The site check failed. Healthchecks.io has been told and will send the alert."
  exit 0
fi
# curl exits 22 when the server answered with an error, which for a ping URL
# almost always means it was mistyped or the check has been deleted.
if ((sent == 22)); then
  echo "::error::Healthchecks.io refused this result ($status). Check that the HC_PING_URL secret is the check's exact ping URL."
else
  echo "::error::Could not reach Healthchecks.io, so this result ($status) was not reported."
fi
exit 1
