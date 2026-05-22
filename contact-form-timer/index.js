const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * Azure Functions timer trigger (same pattern as SERPDataCollection/gen-serp).
 * Schedule: contact-form-timer/function.json → "schedule" (NCRONTAB).
 */
module.exports = async function (context, myTimer) {
  const timeStamp = new Date().toISOString();

  if (myTimer.IsPastDue || myTimer.isPastDue) {
    context.log('JavaScript is running late!');
  }
  context.log('Contact form timer trigger function ran!', timeStamp);

  const { runAllContactTests } = require('../playwright-single.js');

  try {
    await runAllContactTests();
    context.log('Contact form test completed successfully.');
  } catch (err) {
    context.log.error('Contact form test failed:', err.message);
  }
};
