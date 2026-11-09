#!/usr/bin/env bash
# Deploys the names service to AWS.
#
#   NOTIFICATION_EMAIL=you@example.com infra/names/deploy.sh <aws-profile> [hosted-zone-id]
#
# NOTIFICATION_EMAIL is told about each request for an address, once it has confirmed the message AWS
# sends it. Leave it out and the address already set stays. With none, infra/names/requests.sh lists them.
#
# The hosted zone must already exist and be delegated: the certificate is validated through it, and the
# stack waits for that. Without an ID the zone is found by name. A low SOA negative TTL on the zone helps
# a brand-new name resolve at once, since nobody has to wait out an earlier "no such name".
set -euo pipefail

readonly ZONE="opsifier.dev"
readonly REGION="eu-west-1"
readonly STACK="opsifier-names"

profile="${1:?Usage: deploy.sh <aws-profile> [hosted-zone-id]}"
zone_id="${2:-}"

aws_cli() { aws --profile "$profile" --region "$REGION" "$@"; }

cd "$(dirname "${BASH_SOURCE[0]}")"

if [ -z "$zone_id" ]; then
  zone_id="$(aws_cli route53 list-hosted-zones-by-name --dns-name "$ZONE" \
    --query "HostedZones[?Name=='${ZONE}.'].Id | [0]" --output text)"
  zone_id="${zone_id##*/}"
fi
[ -n "$zone_id" ] && [ "$zone_id" != "None" ] || { echo "No hosted zone for ${ZONE}." >&2; exit 1; }

# Only this script's artifacts live here, and nothing in it is public.
account="$(aws_cli sts get-caller-identity --query Account --output text)"
bucket="opsifier-names-artifacts-${account}"
if ! aws_cli s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
  aws_cli s3api create-bucket --bucket "$bucket" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  aws_cli s3api put-public-access-block --bucket "$bucket" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# The AWS SDK is left out on purpose: the Node 22 runtime provides it.
rm -rf dist
mkdir -p dist
../../node_modules/.bin/esbuild src/lambda.ts --bundle --platform=node --target=node22 --format=cjs \
  --external:@aws-sdk/* --outfile=dist/lambda.js
zip -j -q dist/names.zip dist/lambda.js

aws_cli cloudformation package --template-file template.yaml --s3-bucket "$bucket" \
  --s3-prefix "$STACK" --output-template-file dist/packaged.yaml >/dev/null
overrides=("HostedZoneId=${zone_id}")
[ -z "${NOTIFICATION_EMAIL:-}" ] || overrides+=("NotificationEmail=${NOTIFICATION_EMAIL}")
aws_cli cloudformation deploy --template-file dist/packaged.yaml --stack-name "$STACK" \
  --capabilities CAPABILITY_IAM --parameter-overrides "${overrides[@]}" \
  --no-fail-on-empty-changeset

# A brand-new address must resolve at once, so a "no such name" is only remembered for a minute.
soa="$(aws_cli route53 list-resource-record-sets --hosted-zone-id "$zone_id" \
  --query "ResourceRecordSets[?Type=='SOA'].ResourceRecords[0].Value | [0]" --output text)"
aws_cli route53 change-resource-record-sets --hosted-zone-id "$zone_id" --change-batch \
  "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"${ZONE}.\",\"Type\":\"SOA\",\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"${soa% *} 60\"}]}}]}" >/dev/null

aws_cli cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs" --output table
