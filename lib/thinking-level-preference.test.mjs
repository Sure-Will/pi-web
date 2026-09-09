import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const {getPreferredThinkingLevel:get, setPreferredThinkingLevel:set, resolveThinkingPreference:resolve} = await createJiti(import.meta.url).import("./thinking-level-preference.ts");
test("explicit high and auto persist immediately without creating a session", () => {
  const values=new Map();
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  assert.equal(get(storage),null);
  for(const level of ["high","auto","off","max"]) { set(level,storage); assert.equal(get(storage),level); }
  values.set("pi-thinking-level","invalid"); assert.equal(get(storage),null);
});
test("unavailable storage remains safe", () => {
  const blocked={getItem(){throw Error("blocked")},setItem(){throw Error("blocked")}};
  assert.equal(get(blocked),null); assert.equal(get(null),null);
  assert.doesNotThrow(()=>set("high",blocked)); assert.doesNotThrow(()=>set("high",null));
});
test("new sessions respect explicit choices, scope pins, remembered levels and Pi defaults", () => {
  const base={explicit:null,preferred:"high",supported:["off","low","medium","high"],defaultLevel:"medium"};
  assert.deepEqual(resolve(base),{level:"high",override:"high"});
  assert.deepEqual(resolve({...base,preferred:null,defaultLevel:"high"}),{level:"high",override:null});
  assert.deepEqual(resolve({...base,pinned:"low"}),{level:"low",override:null});
  assert.deepEqual(resolve({...base,pinned:"low",explicit:"high"}),{level:"high",override:"high"});
  assert.deepEqual(resolve({...base,pinned:"low",explicit:"auto"}),{level:"auto",override:null});
  assert.deepEqual(resolve({...base,preferred:"auto",pinned:"low"}),{level:"auto",override:null});
});
test("unsupported memory falls back without destroying the original preference", () => {
  const base={explicit:null,preferred:"high"};
  assert.deepEqual(resolve({...base,supported:["off"],defaultLevel:"off"}),{level:"off",override:null});
  assert.deepEqual(resolve({...base,supported:["low"]}),{level:"auto",override:null});
  assert.deepEqual(resolve({...base,supported:["high"]}),{level:"high",override:"high"});
});
