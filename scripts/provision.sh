#!/usr/bin/env sh
# Creates the account resources this Worker needs before `wrangler deploy`.
# Idempotent: existing queues, the bucket and its lifecycle rule are left as they are.
# Per-agent inbound queues are not created here; the Worker creates them on the first email.
set -eu

WRANGLER=${WRANGLER:-"npx wrangler"}
BUCKET=email-agents
LIFECYCLE_RULE=expire-agent-mail
LIFECYCLE_DAYS=3

for queue in email-outbox email-outbox-dlq; do
	if $WRANGLER queues info "$queue" >/dev/null 2>&1; then
		echo "queue $queue exists"
	else
		$WRANGLER queues create "$queue"
	fi
done

if $WRANGLER r2 bucket info "$BUCKET" >/dev/null 2>&1; then
	echo "bucket $BUCKET exists"
else
	$WRANGLER r2 bucket create "$BUCKET"
fi

if $WRANGLER r2 bucket lifecycle list "$BUCKET" 2>/dev/null | grep -q "$LIFECYCLE_RULE"; then
	echo "lifecycle rule $LIFECYCLE_RULE exists"
else
	# Safety net for mail whose queue entry expired before an unwrapper pulled it.
	$WRANGLER r2 bucket lifecycle add "$BUCKET" "$LIFECYCLE_RULE" --expire-days "$LIFECYCLE_DAYS" --force
fi
