#!/usr/bin/env bash
# Deploys the public site.
#
#   infra/site/deploy.sh <aws-profile> [stack-only]
#
# The hosted zone must already exist and be delegated: the certificate is validated through it.
set -euo pipefail

readonly DOMAIN="opsifier.com"
readonly REGION="us-east-1"
readonly STACK="opsifier-site"

profile="${1:?Usage: deploy.sh <aws-profile> [stack-only]}"
mode="${2:-}"

aws_cli() { aws --profile "$profile" --region "$REGION" "$@"; }
output() { aws_cli cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text; }

cd "$(dirname "${BASH_SOURCE[0]}")"

zone_id="$(aws_cli route53 list-hosted-zones-by-name --dns-name "$DOMAIN" --query "HostedZones[?Name=='${DOMAIN}.'].Id | [0]" --output text)"
zone_id="${zone_id##*/}"
[ -n "$zone_id" ] && [ "$zone_id" != "None" ] || { echo "No hosted zone for ${DOMAIN}." >&2; exit 1; }

aws_cli cloudformation deploy --template-file template.yaml --stack-name "$STACK" \
  --parameter-overrides "HostedZoneId=${zone_id}" "DomainName=${DOMAIN}" --no-fail-on-empty-changeset
[ "$mode" != "stack-only" ] || exit 0

cd ../../site
bun install --frozen-lockfile
bun run build

bucket="$(output BucketName)"
# Files in _astro are named by their content, so they can be cached for good. Everything else has to be asked for again.
aws_cli s3 sync dist/_astro "s3://${bucket}/_astro" --delete --cache-control "public, max-age=31536000, immutable"
aws_cli s3 sync dist "s3://${bucket}" --delete --exclude "_astro/*" --cache-control "public, max-age=300, must-revalidate"
aws_cli cloudfront create-invalidation --distribution-id "$(output DistributionId)" --paths "/*" --query "Invalidation.Status" --output text
