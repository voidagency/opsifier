#!/usr/bin/env bash
# Disables one address: its records are removed, and its ID is never issued again.
#
#   infra/names/disable.sh <aws-profile> <id>
set -euo pipefail

readonly REGION="eu-west-1"
readonly STACK="opsifier-names"

profile="${1:?Usage: disable.sh <aws-profile> <id>}"
id="${2:?Usage: disable.sh <aws-profile> <id>}"

aws_cli() { aws --profile "$profile" --region "$REGION" "$@"; }

function_name="$(aws_cli cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='MaintenanceFunctionName'].OutputValue" --output text)"

aws_cli lambda invoke --function-name "$function_name" --cli-binary-format raw-in-base64-out \
  --payload "{\"action\":\"disable\",\"id\":\"${id}\"}" /dev/stdout
