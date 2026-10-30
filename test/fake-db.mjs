// A local stand-in for the platform's `sdk/db`: the subset of its Drizzle-like
// API this project uses, backed by node:sqlite. Test-only; never deployed.
import { DatabaseSync } from 'node:sqlite';

const COLUMN = Symbol('column');
const META = Symbol('table');
const FRAGMENT = Symbol('sql');

const sqlite = new DatabaseSync(':memory:');
const tables = [];

function column(type, name, opts = {}) {
  const col = {
    [COLUMN]: true, type, name, mode: opts.mode, pk: false, autoInc: false, required: false, uniq: false, def: undefined,
    primaryKey(o = {}) { this.pk = true; this.autoInc = Boolean(o.autoIncrement); return this; },
    notNull() { this.required = true; return this; },
    unique() { this.uniq = true; return this; },
    default(v) { this.def = v; return this; },
    deprecated() { return this; },
    constraint() { return this; },
  };
  return col;
}

export const integer = (name, opts) => column('INTEGER', name, opts);
export const text = (name, opts) => column('TEXT', name, opts);
export const real = (name, opts) => column('REAL', name, opts);
export const json = (name) => column('TEXT', name, { mode: 'json' });
export const boolean = (name) => column('INTEGER', name, { mode: 'boolean' });

export function index(name) {
  return { on: (...cols) => ({ name, cols, unique: false }) };
}
export function uniqueIndex(name) {
  return { on: (...cols) => ({ name, cols, unique: true }) };
}

export function table(name, columns, extra) {
  const t = { [META]: { name, columns: {} } };
  for (const [key, col] of Object.entries(columns)) {
    col.name = col.name || key;
    col.key = key;
    col.tableName = name;
    t[key] = col;
    t[META].columns[key] = col;
  }
  t[META].indexes = extra ? Object.values(extra(t)) : [];
  tables.push(t);
  return t;
}

function frag(text, params = []) {
  return { [FRAGMENT]: true, text, params };
}

function ident(col) {
  return `"${col.name}"`;
}

function encode(col, value) {
  if (value && value[FRAGMENT]) return value;
  if (value === undefined) return null;
  if (col?.mode === 'json') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function operand(value, col) {
  if (value && value[COLUMN]) return frag(ident(value));
  if (value && value[FRAGMENT]) return value;
  return frag('?', [encode(col, value)]);
}

function join(parts, sep) {
  const list = parts.filter(Boolean);
  return frag(list.map((p) => p.text).join(sep), list.flatMap((p) => p.params));
}

function binary(op) {
  return (col, value) => {
    const right = operand(value, col);
    return frag(`${ident(col)} ${op} ${right.text}`, right.params);
  };
}

export const eq = binary('=');
export const ne = binary('<>');
export const lt = binary('<');
export const lte = binary('<=');
export const gt = binary('>');
export const gte = binary('>=');
export const like = binary('LIKE');
export const isNull = (col) => frag(`${ident(col)} IS NULL`);
export const isNotNull = (col) => frag(`${ident(col)} IS NOT NULL`);
export const inArray = (col, values) => (values.length
  ? frag(`${ident(col)} IN (${values.map(() => '?').join(', ')})`, values.map((v) => encode(col, v)))
  : frag('0'));
export const and = (...conds) => {
  const j = join(conds, ' AND ');
  return frag(`(${j.text})`, j.params);
};
export const or = (...conds) => {
  const j = join(conds, ' OR ');
  return frag(`(${j.text})`, j.params);
};
export const not = (cond) => frag(`NOT (${cond.text})`, cond.params);
export const asc = (col) => frag(`${ident(col)} ASC`);
export const desc = (col) => frag(`${ident(col)} DESC`);

export function sql(strings, ...values) {
  let textOut = strings[0];
  const params = [];
  values.forEach((value, i) => {
    const part = operand(value);
    textOut += part.text + strings[i + 1];
    params.push(...part.params);
  });
  return frag(textOut, params);
}
sql.raw = (s) => frag(s);

function decode(t, row, projection) {
  if (!row) return row;
  const out = {};
  if (projection) {
    for (const [alias, col] of Object.entries(projection)) {
      const value = row[alias];
      out[alias] = col && col[COLUMN] && col.mode === 'json' && value != null ? JSON.parse(value) : value;
    }
    return out;
  }
  for (const [key, col] of Object.entries(t[META].columns)) {
    const value = row[col.name];
    out[key] = col.mode === 'json' && value != null ? JSON.parse(value) : col.mode === 'boolean' ? Boolean(value) : value;
  }
  return out;
}

function projectionSql(projection) {
  if (!projection) return frag('*');
  return join(Object.entries(projection).map(([alias, col]) => {
    const part = operand(col);
    return frag(`${part.text} AS "${alias}"`, part.params);
  }), ', ');
}

function execAll(q) {
  return sqlite.prepare(q.text).all(...q.params);
}

function execRun(q) {
  const result = sqlite.prepare(q.text).run(...q.params);
  return { rowsAffected: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid), rows: [] };
}

function thenable(builder, runner) {
  builder.then = (resolve, reject) => Promise.resolve().then(runner).then(resolve, reject);
  return builder;
}

function select(projection) {
  return {
    from(t) {
      const state = { where: null, order: [], limit: null, offset: null };
      const build = () => {
        const proj = projectionSql(projection);
        let q = frag(`SELECT ${proj.text} FROM "${t[META].name}"`, proj.params);
        if (state.where) q = join([q, state.where], ' WHERE ');
        if (state.order.length) q = join([q, join(state.order, ', ')], ' ORDER BY ');
        if (state.limit != null) q = frag(`${q.text} LIMIT ${Number(state.limit)}`, q.params);
        if (state.offset != null) q = frag(`${q.text} OFFSET ${Number(state.offset)}`, q.params);
        return q;
      };
      const builder = {
        where(...conds) { state.where = conds.length > 1 ? and(...conds) : conds[0]; return builder; },
        orderBy(...parts) { state.order = parts.map((p) => (p[COLUMN] ? asc(p) : p)); return builder; },
        limit(n) { state.limit = n; return builder; },
        offset(n) { state.offset = n; return builder; },
        async all() { return execAll(build()).map((row) => decode(t, row, projection)); },
        async get() { state.limit = 1; const rows = execAll(build()); return rows.length ? decode(t, rows[0], projection) : null; },
      };
      return thenable(builder, () => builder.all());
    },
  };
}

function returningClause(t, projection) {
  if (projection === undefined) return null;
  return projection ? projectionSql(projection) : frag('*');
}

function finish(t, q, returning, projection) {
  if (returning) {
    const rows = execAll(join([q, returning], ' RETURNING '));
    return rows.map((row) => decode(t, row, projection || null));
  }
  return execRun(q);
}

function insert(t) {
  const state = { rows: [], conflict: null, returning: undefined };
  const builder = {
    values(v) { state.rows = Array.isArray(v) ? v : [v]; return builder; },
    onConflictDoNothing(o = {}) { state.conflict = { target: o.target, nothing: true }; return builder; },
    onConflictDoUpdate(o) { state.conflict = { target: o.target, set: o.set }; return builder; },
    returning(projection = null) { state.returning = projection; return builder; },
    async run() {
      const cols = Object.values(t[META].columns).filter((c) => state.rows.some((r) => r[c.key] !== undefined));
      const valueRows = state.rows.map((r) => {
        const parts = cols.map((c) => operand(r[c.key] === undefined ? null : r[c.key], c));
        return frag(`(${parts.map((p) => p.text).join(', ')})`, parts.flatMap((p) => p.params));
      });
      let q = frag(`INSERT INTO "${t[META].name}" (${cols.map(ident).join(', ')}) VALUES `);
      q = join([q, join(valueRows, ', ')], '');
      if (state.conflict) {
        const target = state.conflict.target ? `(${[].concat(state.conflict.target).map(ident).join(', ')})` : '';
        if (state.conflict.nothing) q = frag(`${q.text} ON CONFLICT ${target} DO NOTHING`, q.params);
        else q = join([frag(`${q.text} ON CONFLICT ${target} DO UPDATE SET `, q.params), setClause(t, state.conflict.set)], '');
      }
      return finish(t, q, returningClause(t, state.returning), state.returning);
    },
  };
  return thenable(builder, () => builder.run());
}

function setClause(t, values) {
  return join(Object.entries(values).filter(([, v]) => v !== undefined).map(([key, value]) => {
    const col = t[META].columns[key];
    const part = operand(value, col);
    return frag(`${ident(col)} = ${part.text}`, part.params);
  }), ', ');
}

function update(t) {
  const state = { set: null, where: null, returning: undefined };
  const builder = {
    set(v) { state.set = v; return builder; },
    where(...conds) { state.where = conds.length > 1 ? and(...conds) : conds[0]; return builder; },
    returning(projection = null) { state.returning = projection; return builder; },
    async run() {
      let q = join([frag(`UPDATE "${t[META].name}" SET `), setClause(t, state.set)], '');
      if (state.where) q = join([q, state.where], ' WHERE ');
      return finish(t, q, returningClause(t, state.returning), state.returning);
    },
  };
  return thenable(builder, () => builder.run());
}

function remove(t) {
  const state = { where: null };
  const builder = {
    where(...conds) { state.where = conds.length > 1 ? and(...conds) : conds[0]; return builder; },
    async run() {
      let q = frag(`DELETE FROM "${t[META].name}"`);
      if (state.where) q = join([q, state.where], ' WHERE ');
      return execRun(q);
    },
  };
  return thenable(builder, () => builder.run());
}

// Raw: a sql`` fragment, or a string with :named params and a params object.
function raw(query, params) {
  if (query && query[FRAGMENT]) return { text: query.text, params: query.params };
  return { text: query, params: params && Object.keys(params).length ? [params] : [] };
}

export const db = {
  select,
  insert,
  update,
  delete: remove,
  async $count(t, where) {
    const q = where ? join([frag(`SELECT count(*) AS n FROM "${t[META].name}"`), where], ' WHERE ') : frag(`SELECT count(*) AS n FROM "${t[META].name}"`);
    return Number(execAll(q)[0].n);
  },
  async run(query, params) { return execRun(raw(query, params)); },
  async all(query, params) { return execAll(raw(query, params)); },
  async get(query, params) { return execAll(raw(query, params))[0] ?? null; },
  async values(query, params) { const q = raw(query, params); return sqlite.prepare(q.text).raw ? sqlite.prepare(q.text).all(...q.params).map(Object.values) : []; },
};
export default db;

function ddlDefault(value) {
  if (value && value[FRAGMENT]) return value.text;
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value !== null && typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return String(value);
}

// Creates every table declared so far (call after importing schema.js).
export function migrate() {
  for (const t of tables) {
    const { name, columns, indexes } = t[META];
    const defs = Object.values(columns).map((c) => [
      `"${c.name}" ${c.type}`,
      c.pk ? 'PRIMARY KEY' : '',
      c.autoInc ? 'AUTOINCREMENT' : '',
      c.required ? 'NOT NULL' : '',
      c.uniq ? 'UNIQUE' : '',
      c.def !== undefined ? `DEFAULT ${ddlDefault(c.def)}` : '',
    ].filter(Boolean).join(' '));
    sqlite.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${defs.join(', ')})`);
    for (const idx of indexes) {
      sqlite.exec(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${idx.name}" ON "${name}" (${idx.cols.map(ident).join(', ')})`);
    }
  }
}

export function rawSqlite() {
  return sqlite;
}
