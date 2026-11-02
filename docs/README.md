# Jira Cloud 0.1.0: устройство и ограничения

Драйвер контракта 1 использует только Node builtins и собственные модули.
`types/contract.ts` и `types/capabilities.ts` — дословный снимок пакета `grigdesk-b24`.
Точка входа `driver.ts` получает реквизиты и необязательный `host.fetch`.
Тесты эмулируют HTTP через этот транспорт, живой аккаунт не требуется.

## Подключение и транспорт

`baseUrl` — только HTTPS origin, `email` и `apiToken` обязательны. На каждом запросе передаётся
`Authorization: Basic base64(email:apiToken)`. Cookie, файлов сессии и `cookiePath` драйвер не использует.
Все запросы ограничены 30 секундами, включая чтение тела. `redirect: manual`: любой redirect — ошибка.
Сетевые исключения имеют общий безопасный текст. Ошибки API сохраняют сообщение после редации
email, токена и Basic-пары, включая URL-кодированные и JSON-экранированные формы. Логирования нет.

`testAuth()` возвращает `{ ok: true }` либо `{ ok: false, error }`, без числового userId.
`accountIdentity()` возвращает `{ baseUrl, userId: accountId }`, где accountId — строка.
Личность и типы задач кешируются в памяти для точной сигнатуры origin/email/apiToken.
Смена любого реквизита создаёт новый кеш; уже начатая операция сохраняет исходный аккаунт.

| Операция | REST |
|---|---|
| Личность | GET `/rest/api/3/myself`, при 404/410 один GET `/rest/api/2/myself` |
| Поиск | POST `/rest/api/3/search/jql`, курсор `nextPageToken` до конца |
| Запасной поиск | Только при 404/410: POST `/rest/api/2/search`, `startAt/maxResults/total` |
| Карточка | GET `/rest/api/2/issue/{id}`, включая labels и subtasks |
| Создание и правка | POST `/rest/api/2/issue`, PUT `/rest/api/2/issue/{id}` |
| Комментарии | GET/POST `/rest/api/2/issue/{id}/comment`, все страницы до total |
| Переходы | GET/POST `/rest/api/2/issue/{id}/transitions` |
| Пользователи | GET `/rest/api/3/users/search?query=…` |
| Проекты | GET `/rest/api/3/project/search`, все страницы до total/isLast |
| Тип при создании | GET `/rest/api/3/issue/createmeta?projectIds={id}` |
| Имена приоритетов | GET `/rest/api/2/priority` при заданном priority |

POST поиска является чтением. Единственный запасной вариант разрешён только для чтений
личности и поиска при HTTP 404/410. Остальные ошибки не запускают повторов, мутации не повторяются
никогда. При сбое последующей страницы v3 запасной поиск начинается заново с v2;
одинаковые id в страницах сворачиваются. Некорректная пагинация завершается ошибкой.

Тип создания — первый issuetype с `subtask: false` из createmeta выбранного проекта.
При недоступности или отсутствии подходящих метаданных отправляется `{ name: "Task" }`;
если такого типа в проекте нет или нужны обязательные custom fields, Jira отклонит создание.
Для создания нужны title и числовой groupId проекта. Проект и тип кешируются только до смены реквизитов.

REST-схемы: [поиск Jira Cloud][search], [задачи и переходы v2][issues].
Запасные legacy endpoints используются только по указанному правилу; их наличие зависит от сайта.

## Поля и статусы

Канонический id задачи — положительное безопасное целое Jira, а key хранится рядом.
Проекты также имеют числовые id, пользователи — строковые accountId.
Данные исполнителя и автора: `{ id: accountId, name: displayName }` либо null.
Списки сохраняют объекты responsible и group. `sourceUrl` читает актуальный key и строит
`baseUrl + '/browse/' + key`.

Описание и комментарии читаются и записываются через v2 как обычный текст.
На чтении описание экранируется для внешнего renderer GrigDesk: буквальные теги остаются текстом,
wiki-разметка и ADF не создаются. Ampersand экранируется числовой entity `&#38;`, чтобы последовательное
декодирование renderer сохраняло исходные буквальные entities. На запись уходит исходная строка.
Комментарии сохраняют обычный текст: интерфейс выводит их интерполяцией.
`mark`, `replicate`, участники и checklist не возвращаются.

`duedate` хранится как `YYYY-MM-DD`. Чтение добавляет `T00:00:00.000Z`, запись берёт первые
10 символов проверенной ISO-строки. **Время суток и часовой пояс Jira не сохраняет.**
`deadline: null` снимает срок. Просрочка — дата раньше сегодняшней даты UTC при категории не done;
задача на сегодня ещё не просрочена.

| Категория статуса | statusKind |
|---|---|
| new | todo |
| indeterminate | in_progress |
| done | done |
| Иная/неизвестная | other |

`status` содержит vendor-id, `statusText` и `statusLabel` — `status.name` без преобразований.
Завершение выбирает первый доступный переход в done. Возобновление предпочитает indeterminate,
затем to_do; также распознаётся стандартное имя категории Jira `new` для To Do.
Если перехода нет, возвращается TrackerError 400 «В Jira нет доступного перехода».

Чтение priority по имени: Lowest/Low → 0, Medium/Normal → 1, High/Highest/Critical → 2;
неизвестное имя → 1. При записи выбирается первый подходящий приоритет сайта по той же таблице.
Если соответствия нет, поле не отправляется. Если это единственное изменение, PUT пропускается.

`tags` соответствуют labels. `updateTaskTags` заменяет весь JSON-массив; `[]` очищает метки.
Частичная правка поддерживает title, description, deadline, responsibleId, groupId, priority.
Попытка передать accomplices/auditors, даже пустыми, отклоняется кодом `b24_bad_request`.
Входные ошибки используют тот же исторический код; отсутствие задачи — `task_not_found`, HTTP 404.
`probeTaskNumber`: успешное чтение → exists, 404 → absent, другая ошибка → unknown.

## Доска и карточка

| Список | JQL |
|---|---|
| tasks | `assignee = currentUser()` |
| toReview | `reporter = currentUser() AND assignee != currentUser() AND statusCategory != Done` |
| created | `reporter = currentUser()` |

Основной и созданный списки содержат все статусы, включая done.
В Jira нет общего статуса «на контроле»: toReview показывает ещё открытые задачи, поставленные
другим, и не обещает отдельной стадии приёмки. Роли accomplice/auditor отсутствуют, widgets пуст.

`taskDetail` содержит id, key, title, description, deadline, creator, responsible, priority,
статусные поля, parentId, tags, а также group и overdue для общего маппинга списка.
`taskPageData` содержит comments, attachments: [], tags, subtasks.
Подзадача: `{ id, title: summary, statusText: status.name }`.
Комментарий: id, authorId, author, time, text, isSystem: false, unread: false, attachments: [].
Состояние прочтения REST не сообщает, вложения отключены.

Capabilities create, complete, renew, users, projects, comments, editing, tags включены.
checklist, timer, attachments, widgets, delete, review выключены. Worklog-таймер отложен на будущую версию;
approve/disapprove не реализованы, так как workflow произволен.

## Проверка

Из папки пакета: `node --test tests/*.test.js`.
Фикстуры проверяют авторизацию, редацию, обе схемы поиска и их пагинацию, семантику списков,
карточку и обсуждение, создание и типы, частичную правку, метки, переходы, сетевые отказы,
404, redirect и отсутствие повторов мутаций. Проверка живого портала в этот набор не входит.

[search]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
[issues]: https://developer.atlassian.com/cloud/jira/platform/rest/v2/api-group-issues/
