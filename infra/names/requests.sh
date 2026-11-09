#!/usr/bin/env bash
# Lists the requests for an address, or answers one.
#
#   infra/names/requests.sh <aws-profile>                  what is waiting, oldest first
#   infra/names/requests.sh <aws-profile> approve <id>     writes its records. The server moves on its own.
#   infra/names/requests.sh <aws-profile> refuse <id>      the name is never issued, and the server is told
set -euo pipefail

readonly REGION="eu-west-1"
readonly STACK="opsifier-names"
readonly USAGE="Usage: requests.sh <aws-profile> [approve|refuse <id>]"

profile="${1:?$USAGE}"
action="${2:-requests}"
id="${3:-}"

case "$action" in
  requests) ;;
  approve | refuse) [ -n "$id" ] || { echo "$USAGE" >&2; exit 1; } ;;
  *) echo "$USAGE" >&2; exit 1 ;;
esac

aws_cli() { aws --profile "$profile" --region "$REGION" "$@"; }

function_name="$(aws_cli cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='MaintenanceFunctionName'].OutputValue" --output text)"

aws_cli lambda invoke --function-name "$function_name" --cli-binary-format raw-in-base64-out \
  --payload "{\"action\":\"${action}\",\"id\":\"${id}\"}" /dev/stdout
