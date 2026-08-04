#!/usr/bin/env bash
# notify.sh <event> <task-id> <message> — notification hook for task milestones.
# No-op by default. Replace the body (e.g. call your mattermost-channel-cli) to get
# push notifications. Events: started, attempt, limit-wait, done, failed,
# merged, merge-conflict, cancelled. Called by run-task.sh / dispatch.sh /
# cancel-task.sh only when executable.
exit 0
