# Playwright Contact Form Runner

This project runs a single Playwright script:

```sh
npm test
```

For LambdaTest runs:

```sh
npm run test:lambdatest
```

The Azure Web App entrypoint is:

```sh
npm start
```

That starts `api-server.js`, which exposes:

- `GET /health`
- `GET /docs`
- `POST /api/run-contact-test`

## Main Files

- `playwright-single.js` - contact form Playwright test
- `api-server.js` - Express API wrapper for Azure Web App
- `azure-pipelines.yml` - Azure DevOps pipeline example
- `.github/workflows/main_lambdatest.yml` - GitHub Actions deployment to Azure Web App
- `test-imap-read.js` - helper for checking IMAP settings
- `test-smtp-alert.js` - helper for checking SMTP alert settings
