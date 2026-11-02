import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ACCOUNT, EMAIL, fixture, TOKEN } from './fixtures/jira.js';

test('Манифест, локальный контракт и возможности версии 0.1.1', async () => {
  const { driver } = fixture();
  const manifest = JSON.parse(await readFile(new URL('../driver.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(manifest.id, driver.id);
  assert.equal(manifest.name, 'Jira Cloud');
  assert.equal(manifest.contract, 1);
  assert.equal(manifest.version, '0.1.1');
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.settings.email.label.key, 'core.trackerEmail');
  assert.equal(manifest.settings.apiToken.secret, true);
  assert.deepEqual(Object.keys(driver.capabilities).filter((key) => driver.capabilities[key]).sort(),
    ['comments', 'complete', 'create', 'editing', 'projects', 'renew', 'tags', 'users']);

  for (const name of ['timer', 'deleteTask', 'approveTask', 'disapproveTask', 'addChecklistItem']) {
    assert.equal(driver[name], undefined);
  }

  assert.equal(pkg.dependencies, undefined);
});

test('Basic myself: testAuth не возвращает userId, идентичность кешируется по реквизитам', async () => {
  const { driver, calls, change } = fixture();

  assert.equal(driver.isConfigured(), true);
  assert.deepEqual(await driver.testAuth(), { ok: true });
  assert.deepEqual(await driver.accountIdentity(), { baseUrl: 'https://jira.fixture', userId: ACCOUNT });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].path, '/rest/api/3/myself');

  for (const changes of [{ apiToken: 'new-token' }, { email: 'new@fixture.example' },
    { baseUrl: 'other.fixture' }]) {
    change(changes);
    await driver.accountIdentity();
  }

  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).url, 'https://other.fixture/rest/api/3/myself');
});

for (const status of [404, 410]) {
  test(`myself ${status}: один fallback v2`, async () => {
    const { driver, calls } = fixture({ respond: ({ path }) => {
      if (path === '/rest/api/3/myself') {
        return new Response(null, { status });
      }
    } });

    assert.deepEqual(await driver.testAuth(), { ok: true });
    assert.deepEqual(calls.map((call) => call.path), ['/rest/api/3/myself', '/rest/api/2/myself']);
  });
}

test('Отказ fallback myself не повторяется третий раз', async () => {
  const { driver, calls } = fixture({ respond: () => new Response(null, { status: 404 }) });

  assert.equal((await driver.testAuth()).ok, false);
  assert.equal(calls.length, 2);
});

for (const baseUrl of ['', 'http://jira.fixture', 'https://user:pass@jira.fixture',
  'https://jira.fixture/rest/', 'https://jira.fixture?query=1', 'https://jira.fixture#hash',
  'https://jira.fixture?', 'https://jira.fixture/#', 'https://jira.fixture/a/..',
  'https://@jira.fixture', 'https://jira.fixture\n.evil']) {
  test(`Невалидный origin не вызывает сеть: ${baseUrl}`, async () => {
    const { driver, calls } = fixture({ credentials: { baseUrl } });

    assert.equal(driver.isConfigured(), false);
    assert.equal((await driver.testAuth()).ok, false);
    await assert.rejects(driver.listTasks(), { code: 'b24_bad_request' });
    assert.equal(calls.length, 0);
  });
}

for (const credentials of [{ email: '' }, { apiToken: '' }, { email: null }]) {
  test(`Пустые реквизиты отклоняются до сети: ${JSON.stringify(credentials)}`, async () => {
    const { driver, calls } = fixture({ credentials });

    assert.equal(driver.isConfigured(), false);
    assert.equal((await driver.testAuth()).ok, false);
    assert.equal(calls.length, 0);
  });
}

test('HTTPS подставляется, одиночный завершающий слеш допустим', async () => {
  const { driver, calls } = fixture({ credentials: { baseUrl: ' jira.fixture/ ' } });

  assert.deepEqual(await driver.testAuth(), { ok: true });
  assert.equal(calls[0].url, 'https://jira.fixture/rest/api/3/myself');
});

test('Ошибки Jira редактируют email, токен, Basic, URL- и JSON-варианты', async () => {
  const pair = `${EMAIL}:${TOKEN}`;
  const variants = [EMAIL, TOKEN, pair, Buffer.from(pair).toString('base64')].flatMap((value) => [
    value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1),
  ]);
  const { driver, logs, calls } = fixture({ respond: () => Response.json({
    errorMessages: [variants.join(' :: ')],
    errors: { permission: EMAIL },
  }, { status: 401 }) });
  const result = await driver.testAuth();

  assert.equal(result.ok, false);
  assert.match(result.error, /скрыто/u);

  for (const secret of variants) {
    assert.equal(result.error.includes(secret), false);
  }

  assert.deepEqual(logs, []);
  assert.equal(calls.length, 1);
});

test('Успешный HTTP без accountId не подтверждает авторизацию', async () => {
  const { driver } = fixture({ respond: () => Response.json({ displayName: 'Нет accountId' }) });

  assert.equal((await driver.testAuth()).ok, false);
});
