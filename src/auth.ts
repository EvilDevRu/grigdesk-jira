import { TrackerError } from '../types/contract.ts';
import type { TaskData } from '../types/contract.ts';

export interface Credentials {
  origin: string;
  email: string;
  apiToken: string;
}

/**
 * Реквизиты проверяются до сети; адрес без схемы получает HTTPS автоматически.
 * Путь, учётные данные, query и hash никогда не становятся частью адреса REST.
 */
export function credentials(values: TaskData | null): Credentials {
  const typed = String(values?.baseUrl ?? '').trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(typed) ? typed : `https://${typed}`;
  let url: URL;

  try {
    url = new URL(withScheme);
  } catch {
    throw new TrackerError('b24_bad_request', 'Укажите HTTPS origin Jira');
  }

  if (!typed || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || !/^https:\/\/[^/?#\\@\s]+\/?$/iu.test(withScheme)) {
    throw new TrackerError('b24_bad_request', 'Укажите HTTPS origin Jira без пути и учётных данных');
  }

  if (typeof values?.email !== 'string' || !values.email.trim()
    || typeof values.apiToken !== 'string' || !values.apiToken.trim()) {
    throw new TrackerError('b24_bad_request', 'Укажите Email и API-токен Jira');
  }

  return {
    origin: url.origin,
    email: values.email.trim(),
    apiToken: values.apiToken,
  };
}
