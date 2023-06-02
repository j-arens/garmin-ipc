#!/usr/bin/env bash

set -e

deploy() {
  cd "$(pwd)/.."
  doctl serverless deploy garmin-ipc
}

watch() {
  cd "$(pwd)/.."
  doctl serverless watch garmin-ipc
}

print_function_url() {
  doctl serverless function get ipc/tracking-forwarder --url
}

print_help() {
  cat <<HELP
Usage: $(basename "$0") <command>

Commands:
  deploy    Deploy the tracking-forwarder function
  get-url   Get the deployed URL of the tracking-forwarder function
  watch     Watch for changes and automatically re-deploy functions on save
  help      Show this help text
HELP
}

case "$1" in
  deploy)
    deploy
    ;;

  watch)
    watch
    ;;

  get-url)
    print_function_url
    ;;

  help | *)
    print_help
    exit 1
    ;;
esac
