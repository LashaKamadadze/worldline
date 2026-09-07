import { SenderError, schema, table, t } from 'spacetimedb/server';
import * as localfirst from 'stdb-localfirst/server';
import { installPurge, offlineReducer } from 'stdb-localfirst/server';

/**
 * Example consumer module. Note the two rules offline-capable reducers follow:
 *  - rows created offline carry a client-chosen key (`id: t.uuid()` as an arg),
 *  - "when it happened" is `ctx.clientTimestamp`, not `ctx.timestamp`.
 */
const todos = table(
  { name: 'todos', public: true },
  {
    id: t.uuid().primaryKey(),
    owner: t.identity(),
    title: t.string(),
    done: t.bool(),
    createdAt: t.timestamp(),
  }
);

const counters = table(
  { name: 'counters', public: true },
  {
    name: t.string().primaryKey(),
    value: t.i64(),
  }
);

const spacetimedb = schema({ todos, counters, lf: localfirst });
export default spacetimedb;

export const init = spacetimedb.init(ctx => {
  installPurge(ctx.as.lf, {});
});

export const createTodo = offlineReducer(
  spacetimedb,
  'lf',
  { id: t.uuid(), title: t.string() },
  (ctx, { id, title }) => {
    // Validation failures must be `SenderError`: the V8 host reports any other
    // exception (plain `Error`, or a host error such as a unique violation from
    // `insert`) to the client as "The instance encountered a fatal error." with
    // the message lost. Checking the key first keeps the error meaningful.
    if (title.trim().length === 0) throw new SenderError('title must not be empty');
    if (ctx.db.todos.id.find(id) !== null) throw new SenderError('todo already exists');
    ctx.db.todos.insert({ id, owner: ctx.sender, title, done: false, createdAt: ctx.clientTimestamp });
  }
);

export const toggleTodo = offlineReducer(spacetimedb, 'lf', { id: t.uuid() }, (ctx, { id }) => {
  const row = ctx.db.todos.id.find(id);
  if (!row) throw new SenderError('no such todo');
  ctx.db.todos.id.update({ ...row, done: !row.done });
});

export const deleteTodo = offlineReducer(spacetimedb, 'lf', { id: t.uuid() }, (ctx, { id }) => {
  if (!ctx.db.todos.id.delete(id)) throw new SenderError('no such todo');
});

export const bump = offlineReducer(
  spacetimedb,
  'lf',
  { name: t.string(), by: t.i64() },
  (ctx, { name, by }) => {
    const c = ctx.db.counters.name.find(name);
    if (c) ctx.db.counters.name.update({ ...c, value: c.value + by });
    else ctx.db.counters.insert({ name, value: by });
  }
);
