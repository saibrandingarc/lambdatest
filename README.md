# Playwright Contact Form Runner

This project runs a single Playwright script:

```sh
npm test
```

For LambdaTest (cloud browser):

```sh
npm run test:lambdatest
```

Local headed (browser stays open after submit):

```sh
npm run test:local
```

### Multiple contact URLs

In `.env`, set one or more URLs:

```env
# Comma-separated
CONTACT_PAGE_URLS=https://site-a.com/contact-us/,https://site-b.com/contact-us/

# Or JSON array
CONTACT_PAGE_URLS=["https://site-a.com/contact-us/","https://site-b.com/contact-us/"]
```

`CONTACT_PAGE_URL` still works for a single site. Every run tests all listed URLs in order.

### Scheduled runs (Azure Functions timer — same pattern as SERPDataCollection)

Uses an Azure **timer trigger** (`contact-form-timer/`), not `setInterval`.

1. Install [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local).
2. Copy `local.settings.example.json` → `local.settings.json` if needed.
3. Set cron in `contact-form-timer/function.json` → `"schedule"` (NCRONTAB: `{sec} {min} {hour} {day} {month} {dow}`). Default: every 15 minutes (`0 */15 * * * *`). Weekly example: `0 0 9 * * 0`.

4. Run locally (starts Azurite + `func start` in one step):

```sh
npm start
```

Same as `npm run timer`. Equivalent to `func start` with storage emulator started automatically.

Timer handler: `contact-form-timer/index.js` → `module.exports = async function (context, myTimer)`.

For local timer testing, set `"runOnStartup": true` in `contact-form-timer/function.json`.

### Deploy to Azure

Runs as an **Azure Function App** (timer → `playwright-single.js` → **LambdaTest** cloud browser). No local Chromium on Azure.

**1. Create resources (Portal or CLI)**

- **Function App**: Linux, **Node 20**, Functions **v4**
- **Storage account** (required for the timer trigger)
- Plan: **Consumption** or **Premium** (Premium recommended for long Playwright + IMAP runs)

**2. Application settings**

In Function App → **Configuration** → **Application settings**, add variables from `azure/app-settings.template.txt` (secrets from your `.env`). On Azure use `USE_LAMBDATEST=1`.

**3. Azure CLI deploy** (existing app `LambdaTestFunction` in `webdeploymentresourcegroup`):

```sh
az login
az account set --subscription "BrandingArcProd"
cd /Users/saiporala/Documents/sai/playwright-sample
npm run deploy:azure
```

Or run `./azure/deploy.sh` directly. Settings are loaded from `.env` (with `USE_LAMBDATEST=1` on Azure).

**4. GitHub Actions deploy** (optional)

1. Function App → **Get publish profile** → GitHub secret `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`.
2. Push to `main` or run workflow **Deploy Azure Functions**.

**5. Timer schedule in production**

Edit `contact-form-timer/function.json` → `"schedule"` and redeploy. `runOnStartup` is `false` on Azure (timer only on cron).

**6. Logs**

Function App → **Functions** → `contact-form-timer` → **Monitor** / **Log stream**.

## Main Files

- `playwright-single.js` - contact form Playwright test
- `contact-form-timer/` - Azure Functions timer trigger
- `azure/app-settings.template.txt` - App Settings checklist for Azure
- `.github/workflows/deploy-azure-functions.yml` - GitHub deploy to Function App
- `azure-pipelines.yml` - Azure DevOps run-test example
- `.github/workflows/main_lambdatest.yml` - GitHub Actions CI (syntax check)
- `test-imap-read.js` - helper for checking IMAP settings
- `test-smtp-alert.js` - helper for checking SMTP alert settings


az functionapp update \
  --resource-group webdeploymentresourcegroup \
  --name LambdaTestFunction \
  --set tags.Environment=Production tags.Project=ContactFormTest tags.Owner=BrandingArc

func azure functionapp publish LambdaTestFunction --resource-group webdeploymentresourcegroup --javascript --build remote 2>&1