import fengari from 'fengari';
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

// Execute production Lua, with an in-memory model of its Redis commands.
// This validates script branches/atomic ordering, not hosted Redis behavior.
export function luaRedis(start = Date.now()) {
  let now = start;
  const data = new Map();
  const read = (key) => {
    const value = data.get(key);
    if (value?.expiresAt <= now) { data.delete(key); return undefined; }
    return value;
  };
  const sorted = (key) => [...(read(key)?.value || new Map())].sort(([a, x], [b, y]) => x - y || (a < b ? -1 : a > b ? 1 : 0));
  function command(name, ...args) {
    const key = args[0];
    const current = read(key);
    if (name === 'GET') return current?.value ?? false;
    if (name === 'EXISTS') return current ? 1 : 0;
    if (name === 'DEL') return data.delete(key) ? 1 : 0;
    if (name === 'SET') {
      if (args.includes('NX') && current || args.includes('XX') && !current) return false;
      let expiresAt = args.includes('KEEPTTL') ? current?.expiresAt : undefined;
      const index = args.indexOf('EX');
      if (index >= 0) expiresAt = now + Number(args[index + 1]) * 1000;
      data.set(key, { value: args[1], expiresAt }); return 'OK';
    }
    if (name === 'EXPIRE' || name === 'EXPIREAT') {
      if (!current) return 0;
      current.expiresAt = name === 'EXPIRE' ? now + Number(args[1]) * 1000 : Number(args[1]) * 1000;
      read(key); return 1;
    }
    if (name === 'RENAME') {
      if (!current) throw new Error('Missing source');
      data.set(args[1], current); data.delete(key); return 'OK';
    }
    if (name === 'ZCARD') return current?.value.size || 0;
    if (name === 'ZADD') {
      const set = current || { value: new Map() };
      const score = Number(args[2]); const member = args[3];
      const previous = set.value.get(member);
      if (previous === undefined || args[1] !== 'LT' || score < previous) set.value.set(member, score);
      data.set(key, set); return previous === undefined ? 1 : 0;
    }
    if (name === 'ZREM') return current?.value.delete(args[1]) ? 1 : 0;
    if (name === 'ZRANK') { const rank = sorted(key).findIndex(([id]) => id === args[1]); return rank < 0 ? false : rank; }
    if (name === 'ZSCORE') { const score = current?.value.get(args[1]); return score === undefined ? false : String(score); }
    if (name === 'ZRANGE') return sorted(key).slice(Number(args[1]), Number(args[2]) + 1).flatMap(([id, score]) => [id, String(score)]);
    throw new Error(`Unsupported test command ${name}`);
  }
  function push(L, value) {
    if (value === null || value === undefined || value === false) lua.lua_pushboolean(L, false);
    else if (typeof value === 'number') lua.lua_pushnumber(L, value);
    else if (Array.isArray(value)) {
      lua.lua_newtable(L);
      value.forEach((item, index) => { push(L, item); lua.lua_rawseti(L, -2, index + 1); });
    } else lua.lua_pushstring(L, to_luastring(String(value)));
  }
  function value(L, index) {
    const type = lua.lua_type(L, index);
    if (type === lua.LUA_TBOOLEAN) return !!lua.lua_toboolean(L, index);
    if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index);
    if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tolstring(L, index));
    if (type === lua.LUA_TTABLE) {
      const absolute = lua.lua_absindex(L, index);
      const result = [];
      for (let i = 1; i <= lua.lua_rawlen(L, absolute); i++) {
        lua.lua_rawgeti(L, absolute, i); result.push(value(L, -1)); lua.lua_pop(L, 1);
      }
      return result;
    }
    return null;
  }
  function evaluate(script, keys, args) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    push(L, keys); lua.lua_setglobal(L, to_luastring('KEYS'));
    push(L, args); lua.lua_setglobal(L, to_luastring('ARGV'));
    lua.lua_newtable(L);
    lua.lua_pushjsfunction(L, (state) => {
      try {
        const params = [];
        for (let i = 1; i <= lua.lua_gettop(state); i++) params.push(String(value(state, i)));
        push(state, command(...params)); return 1;
      } catch (error) { lua.lua_pushstring(state, to_luastring(error.message)); return lua.lua_error(state); }
    });
    lua.lua_setfield(L, -2, to_luastring('call')); lua.lua_setglobal(L, to_luastring('redis'));
    try {
      if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK || lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
        throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
      }
      const result = value(L, -1);
      return result === false ? null : result;
    } finally { lua.lua_close(L); }
  }
  return {
    data, read, advance(ms) { now += ms; },
    transport: { enabled: true, async command([name, script, count, ...values]) {
      if (name !== 'EVAL') throw new Error('Expected script');
      return evaluate(script, values.slice(0, Number(count)), values.slice(Number(count)));
    } },
  };
}
