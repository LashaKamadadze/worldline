/**
 * A small consumer module used by the tests and the simulator. It is written
 * exactly the way a real app would write one: mounts the localfirst submodule
 * under `lf` and defines offline-capable reducers with client-chosen keys.
 */
import { schema, table, t } from 'spacetimedb/server';
import * as localfirst from '../server/index';
import { installPurge, offlineReducer } from '../server/index';

const todos = table(
  { name: 'todos', public: true },
  {
    id: t.uuid().primaryKey(),
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
    if (title.length === 0) throw new Error('title must not be empty');
    ctx.db.todos.insert({ id, title, done: false, createdAt: ctx.clientTimestamp });
  }
);

export const toggleTodo = offlineReducer(spacetimedb, 'lf', { id: t.uuid() }, (ctx, { id }) => {
  const row = ctx.db.todos.id.find(id);
  if (!row) throw new Error('no such todo');
  ctx.db.todos.id.update({ ...row, done: !row.done });
});

export const deleteTodo = offlineReducer(spacetimedb, 'lf', { id: t.uuid() }, (ctx, { id }) => {
  if (!ctx.db.todos.id.delete(id)) throw new Error('no such todo');
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
