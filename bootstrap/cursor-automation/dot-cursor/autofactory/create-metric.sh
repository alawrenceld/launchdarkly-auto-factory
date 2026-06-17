#!/usr/bin/env bash
#
# Create a LaunchDarkly guarded-release metric via the REST API.
#
# LaunchDarkly's MCP server has tools for flags and AI configs but NONE for
# metric creation, so the AutoFactory rule shells out to this script. It mirrors
# LdResourceWriter.createMetric (packages/shared/src/anthropic/ldWriter.ts):
# category -> metric shape, standard auto-factory tags, idempotent on 409.
#
# Requires LD_API_KEY in the environment (an api-... access token).
#
#   bash create-metric.sh --project autofactory-demo \
#     --key enable-x-error-rate --category error --event enable-x-error \
#     --randomization-unit user --flag enable-x
#
set -euo pipefail

PROJECT=""; KEY=""; CATEGORY=""; EVENT=""
RUNIT="user"; UNIT="ms"; FLAG=""; NAME=""
BASE_URL="${LD_BASE_URL:-https://app.launchdarkly.com}"

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --category) CATEGORY="$2"; shift 2;;
    --event) EVENT="$2"; shift 2;;
    --randomization-unit) RUNIT="$2"; shift 2;;
    --unit) UNIT="$2"; shift 2;;
    --flag) FLAG="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --base-url) BASE_URL="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

: "${LD_API_KEY:?LD_API_KEY must be set (an api-... access token)}"
if [ -z "$PROJECT" ] || [ -z "$KEY" ] || [ -z "$CATEGORY" ] || [ -z "$EVENT" ]; then
  echo "usage: create-metric.sh --project P --key K --category error|latency|business --event E [--randomization-unit user] [--unit ms] [--flag enable-x] [--name '...']" >&2
  exit 2
fi
[ -n "$NAME" ] || NAME="$KEY"

case "$CATEGORY" in
  error)    NUMERIC=false; SUCCESS="LowerThanBaseline";;
  latency)  NUMERIC=true;  SUCCESS="LowerThanBaseline";;
  business) NUMERIC=false; SUCCESS="HigherThanBaseline";;
  *) echo "category must be error|latency|business" >&2; exit 2;;
esac

# Standard tags + an optional flag-reference tag (LaunchDarkly tags cannot contain ':').
TAGS='"auto-factory","auto-generated"'
if [ -n "$FLAG" ]; then TAGS="$TAGS,\"flag-$FLAG\""; fi

# Numeric (latency) metrics carry a unit + aggregation; occurrence metrics don't.
NUMFIELDS=""
if [ "$NUMERIC" = true ]; then NUMFIELDS=",\"unit\":\"$UNIT\",\"unitAggregationType\":\"average\""; fi

BODY="{\"key\":\"$KEY\",\"name\":\"$NAME\",\"kind\":\"custom\",\"eventKey\":\"$EVENT\",\"isNumeric\":$NUMERIC,\"successCriteria\":\"$SUCCESS\",\"randomizationUnits\":[\"$RUNIT\"],\"tags\":[$TAGS]$NUMFIELDS}"

RESP_FILE="$(mktemp)"
HTTP="$(curl -s -o "$RESP_FILE" -w "%{http_code}" \
  -X POST "$BASE_URL/api/v2/metrics/$PROJECT" \
  -H "Authorization: $LD_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY")"

case "$HTTP" in
  2*)  echo "created $CATEGORY metric '$KEY' (event '$EVENT') in '$PROJECT'";;
  409) echo "metric '$KEY' already exists in '$PROJECT' (no change)";;
  *)   echo "metric create failed: HTTP $HTTP" >&2; cat "$RESP_FILE" >&2; rm -f "$RESP_FILE"; exit 1;;
esac
rm -f "$RESP_FILE"
