#!/usr/bin/env bash
# Deploy playwright-sample to existing Azure Function App (CLI).
#
# Defaults match your app:
#   Resource group: webdeploymentresourcegroup
#   Function App:   LambdaTestFunction
#
# Usage:
#   cd /Users/saiporala/Documents/sai/playwright-sample
#   az login
#   az account set --subscription "BrandingArcProd"
#   ./azure/deploy.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RESOURCE_GROUP="${RESOURCE_GROUP:-webdeploymentresourcegroup}"
FUNCTION_APP="${FUNCTION_APP:-LambdaTestFunction}"

echo "==> Subscription"
az account show --query "{name:name, id:id}" -o table

echo "==> Function App: $FUNCTION_APP ($RESOURCE_GROUP)"
az functionapp show -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" --query "{name:name, state:state, defaultHostName:defaultHostName}" -o table

echo "==> Application settings (from .env + Azure overrides)"
if [[ ! -f .env ]]; then
  echo "Missing .env in project root"
  exit 1
fi

SETTINGS_FILE="$(mktemp /tmp/playwright-appsettings-XXXXXX.json)"
export SETTINGS_FILE RESOURCE_GROUP FUNCTION_APP
node <<'NODE'
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const allow = [
  'CONTACT_PAGE_URLS', 'CONTACT_PAGE_URL', 'USE_LAMBDATEST', 'LT_USERNAME', 'LT_ACCESS_KEY',
  'LT_GEO_LOCATION', 'LT_TIMEZONE', 'HEADLESS', 'CLOSE_BROWSER', 'VERIFY_EMAIL',
  'EMAIL_VERIFY_TIMEOUT_MS', 'EMAIL_VERIFY_POLL_MS', 'IMAP_HOST', 'IMAP_PORT', 'IMAP_SECURE',
  'IMAP_USER', 'IMAP_PASS', 'IMAP_MAILBOX', 'EMAIL_EXPECTED_SUBJECT', 'EMAIL_EXPECTED_FROM',
  'EMAIL_LOOKBACK_MINUTES', 'EMAIL_APP_NAME', 'EMAIL_APP_PSWD', 'ALERT_EMAIL_ON_FAILURE',
  'ALERT_SMTP_HOST', 'ALERT_SMTP_PORT', 'ALERT_SMTP_SECURE', 'ALERT_EMAIL_TO', 'ALERT_EMAIL_FROM',
  'ALERT_SMTP_USER', 'ALERT_SMTP_PASS', 'FORM_TEST_EMAIL', 'FORM_TEST_PHONE',
];

const settings = {
  FUNCTIONS_WORKER_RUNTIME: 'node',
  WEBSITE_NODE_DEFAULT_VERSION: '~20',
  USE_LAMBDATEST: '1',
  HEADLESS: 'true',
  CLOSE_BROWSER: '1',
};

for (const key of allow) {
  if (process.env[key] !== undefined && String(process.env[key]).trim() !== '') {
    settings[key] = String(process.env[key]).trim();
  }
}

const payload = Object.entries(settings).map(([name, value]) => ({
  name,
  value,
  slotSetting: false,
}));

const file = process.env.SETTINGS_FILE;
fs.writeFileSync(file, JSON.stringify(payload, null, 2));

const rg = process.env.RESOURCE_GROUP;
const app = process.env.FUNCTION_APP;
execSync(`az functionapp config appsettings set -g "${rg}" -n "${app}" --settings @"${file}"`, {
  stdio: 'inherit',
});
NODE
rm -f "$SETTINGS_FILE"

echo "==> Install dependencies"
npm ci

echo "==> Deploy (remote build on Azure)"
if command -v func >/dev/null 2>&1; then
  func azure functionapp publish "$FUNCTION_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --javascript \
    --build remote
else
  echo "Azure Functions Core Tools (func) not found. Using az zip deploy..."
  ZIP="$(mktemp /tmp/playwright-func-XXXXXX.zip)"
  zip -r "$ZIP" . \
    -x "*.git*" -x "local.settings.json" -x ".env" -x "__azurite*" -x "__blobstorage__/*" \
    -x ".azurite-data/*" -x "node_modules/.cache/*" >/dev/null
  az functionapp deployment source config-zip \
    -g "$RESOURCE_GROUP" \
    -n "$FUNCTION_APP" \
    --src "$ZIP" \
    --build-remote true
  rm -f "$ZIP"
fi

echo "==> Done"
echo "URL: https://$(az functionapp show -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" --query defaultHostName -o tsv)"
echo "Timer schedule: contact-form-timer/function.json → schedule (redeploy after changes)"
