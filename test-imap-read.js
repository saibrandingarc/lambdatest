/**
 * Verifies IMAP login and prints recent message headers (same settings as playwright-single waitForEmailReceipt).
 * Password: IMAP_PASS, or falls back to EMAIL_APP_PSWD (Gmail app password).
 * Run: npm run test:imap-read
 */
require('dotenv').config();
const { ImapFlow } = require('imapflow');

function getRequiredEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required env: ${name}`);
  return String(v).trim();
}

(async () => {
  const imapHost = getRequiredEnv('IMAP_HOST');
  const imapPort = Number(process.env.IMAP_PORT || 993);
  const imapSecure = !/^0|false|no$/i.test(String(process.env.IMAP_SECURE ?? 'true').trim());
  const imapUser = getRequiredEnv('IMAP_USER');
  const imapPass = String(process.env.EMAIL_APP_PSWD || process.env.IMAP_PASS || '').trim();
  if (!imapPass) throw new Error('Set IMAP_PASS or EMAIL_APP_PSWD (Gmail: use an app password).');
  const imapMailbox = String(process.env.IMAP_MAILBOX || 'INBOX').trim();

  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapSecure,
    auth: { user: imapUser, pass: imapPass },
    logger: false,
  });

  await client.connect();
  await client.mailboxOpen(imapMailbox, { readOnly: true });

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const uids = await client.search({ since });
  const slice = uids.slice(-15);

  console.log(`Mailbox: ${imapMailbox} | Recent UID search (since ${since.toISOString().slice(0, 10)}): ${uids.length} messages, showing last ${slice.length}:\n`);

  for (const uid of slice) {
    const message = await client.fetchOne(uid, { envelope: true, internalDate: true });
    if (!message?.envelope) continue;
    const subj = message.envelope.subject || '';
    const from = message.envelope.from?.[0]?.address || '';
    console.log(`- uid=${uid} | ${message.internalDate?.toISOString?.() || message.internalDate} | from=${from}`);
    console.log(`  subject: ${subj}`);
  }

  const expectedSubject = String(process.env.EMAIL_EXPECTED_SUBJECT || '').trim().toLowerCase();
  const expectedFrom = String(process.env.EMAIL_EXPECTED_FROM || '').trim().toLowerCase();
  if (expectedSubject) {
    let found = false;
    for (const uid of uids.slice(-50)) {
      const message = await client.fetchOne(uid, { envelope: true });
      if (!message?.envelope) continue;
      const subject = (message.envelope.subject || '').toLowerCase();
      const fromAddress = (message.envelope.from?.[0]?.address || '').toLowerCase();
      const subOk = subject.includes(expectedSubject);
      const fromOk = expectedFrom ? fromAddress.includes(expectedFrom) : true;
      if (subOk && fromOk) {
        found = true;
        console.log(
          `\nEMAIL_EXPECTED_* match: subject includes "${expectedSubject}"` +
            (expectedFrom ? ` and from includes "${expectedFrom}"` : '') +
            ` (uid=${uid}).`
        );
        break;
      }
    }
    if (!found) {
      console.log(
        `\nNo message in last 50 UIDs of search window matches EMAIL_EXPECTED_SUBJECT="${process.env.EMAIL_EXPECTED_SUBJECT}"` +
          (expectedFrom ? ` + EMAIL_EXPECTED_FROM` : '') +
          '.'
      );
    }
  }

  await client.logout();
  console.log('\nOK — IMAP read test finished.');
})().catch((err) => {
  console.error('FAILED:', err.message || err);
  if (err.authenticationFailed) console.error('Hint: IMAP auth failed — for Gmail use an app password in IMAP_PASS or EMAIL_APP_PSWD.');
  if (err.response) console.error('Server:', err.response);
  process.exit(1);
});
