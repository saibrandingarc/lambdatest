const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * Runs `playwright-single.js` and returns the parsed JSON result printed as:
 * `RESULT_JSON:{...}`
 *
 * @param {{ contactPageUrl?: string, verifyEmail?: boolean, useLambdaTest?: boolean }} overrides
 * @returns {Promise<any>}
 */
function runContactTest(overrides) {
  const scriptPath = path.join(__dirname, 'playwright-single.js');

  const env = {
    ...process.env,
    OUTPUT_JSON_RESULT: '1',
    // Prevent the repo's checked-in `.env` from overwriting Azure pipeline/env settings.
    SKIP_LOCAL_DOTENV_MERGE: '1',
  };

  if (overrides?.contactPageUrl) env.CONTACT_PAGE_URL = String(overrides.contactPageUrl);
  if (typeof overrides?.verifyEmail === 'boolean') env.VERIFY_EMAIL = overrides.verifyEmail ? '1' : '0';
  if (typeof overrides?.useLambdaTest === 'boolean') env.USE_LAMBDATEST = overrides.useLambdaTest ? '1' : '0';

  // Avoid sending the SMTP failure alert again from inside a web request unless you explicitly want it.
  // You can override this via environment variables if desired.
  if (!('ALERT_EMAIL_ON_FAILURE' in env)) env.ALERT_EMAIL_ON_FAILURE = '0';

  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let parsed = null;

    const onData = (chunk, isErr) => {
      const text = chunk.toString('utf8');
      if (isErr) stderr += text;
      else stdout += text;

      // Parse streaming lines like: RESULT_JSON:{...}
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.startsWith('RESULT_JSON:')) continue;
        const jsonText = line.slice('RESULT_JSON:'.length);
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          // ignore parse errors; we'll reject later with stdout/stderr
        }
      }
    };

    child.stdout.on('data', (c) => onData(c, false));
    child.stderr.on('data', (c) => onData(c, true));

    const timeoutMs = Number(process.env.RUN_TEST_TIMEOUT_MS || 10 * 60 * 1000);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out after ${timeoutMs}ms while running Playwright script.`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (parsed) return resolve(parsed);

      const output = [
        'No RESULT_JSON found from child process.',
        `Exit code: ${code}`,
        '--- stdout (tail) ---',
        stdout.split(/\r?\n/).slice(-80).join('\n'),
        '--- stderr (tail) ---',
        stderr.split(/\r?\n/).slice(-80).join('\n'),
      ].join('\n');

      reject(new Error(output));
    });
  });
}

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'Playwright Contact Form API', version: '1.0.0' },
  },
  apis: [__filename],
});

// Split mount (recommended for Express): static assets + GET handler — avoids "Cannot GET /docs" on some hosts.
app.use('/docs', swaggerUi.serve);
app.get('/docs', swaggerUi.setup(swaggerSpec));

app.get('/', (_req, res) => {
  res.redirect('/docs');
});

/**
 * @openapi
 * /api/run-contact-test:
 *   post:
 *     summary: Run the contact form test and return JSON result
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               contactPageUrl:
 *                 type: string
 *                 description: Override CONTACT_PAGE_URL for this run
 *               verifyEmail:
 *                 type: boolean
 *                 description: Override VERIFY_EMAIL for this run
 *               useLambdaTest:
 *                 type: boolean
 *                 description: Override USE_LAMBDATEST for this run
 *             additionalProperties: false
 *     responses:
 *       200:
 *         description: Run completed (ok=true)
 *       500:
 *         description: Run failed (ok=false in payload)
 */
app.post('/api/run-contact-test', async (req, res) => {
  try {
    const result = await runContactTest({
      contactPageUrl: req.body?.contactPageUrl,
      verifyEmail: typeof req.body?.verifyEmail === 'boolean' ? req.body.verifyEmail : undefined,
      useLambdaTest: typeof req.body?.useLambdaTest === 'boolean' ? req.body.useLambdaTest : undefined,
    });

    if (result.ok) return res.status(200).json(result);
    return res.status(500).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API server listening on port ${port}. Swagger: /docs`);
});

