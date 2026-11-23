// ==UserScript==
// @name         Poke'Catch 配队助手（简体中文版）
// @name:zh-CN   Poke'Catch 配队助手（简体中文版）
// @namespace    pokecatch-helper-zh-CN
// @version      1.11.0
// @description  简体中文配队助手，支持冒险实战配队、分段模板、传说与团体战配队、游荡传说追捕。基于 GrumpyOwl 原版。
// @author       GrumpyOwl (original); yuezhihuohua (Chinese improvements)
// @match        https://pokecatch-online.netlify.app/*
// @match        https://pokecatch-online.pages.dev/*
// @updateURL    none
// @downloadURL    none
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      pokemondb.net
// @connect      pokeapi.co
// @connect      pokecatch-online.pages.dev
// @run-at       document-idle
// @homepageURL  https://github.com/yuezhihuohua/pokecatch-helper-zh-cn
// @supportURL   https://github.com/yuezhihuohua/pokecatch-helper-zh-cn/issues
// ==/UserScript==

(() => {
  'use strict';
  // one instance per page load (a second injection would fight over the same panel)
  if (window.__pcopt) return;

  /* ------------------------------------------------------------------ *
   * 0. Small helpers
   * ------------------------------------------------------------------ */
  const SAVE_KEY = 'gachamon-save-v1';
  const VERSION = '1.11.0';
  const MOBILE_BUILD = false;
  const UPDATE_URL = 'https://raw.githubusercontent.com/yuezhihuohua/pokecatch-helper-zh-cn/main/pokecatch-team-optimizer.zh-CN.user.js';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => (Math.round(n * 10) / 10).toLocaleString('zh-CN');

  const store = {
    get(key, dflt) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, dflt);
        const raw = localStorage.getItem('pcopt:' + key);
        return raw == null ? dflt : JSON.parse(raw);
      } catch { return dflt; }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') return GM_setValue(key, val);
        localStorage.setItem('pcopt:' + key, JSON.stringify(val));
      } catch { /* quota: keep the cached copy in memory only */ }
    },
  };

  // Cross-origin GET (pokemondb does not send CORS headers).
  function httpGet(url) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 20000,
          onload: r => (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout'))
        });
      });
    }
    return fetch(url, { credentials: 'omit' }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }
  const httpGetJson = url => httpGet(url).then(t => JSON.parse(t));

  /* ------------------------------------------------------------------ *
   * 0b. Console log: every action goes through here, prefixed [pcopt],
   *     so a game update that breaks something is visible in the console
   *     (and in window.__pcopt.logs) instead of failing silently.
   * ------------------------------------------------------------------ */
  const LOG_MAX = 400;
  const logs = [];
  function log(level, action, detail) {
    const entry = { at: new Date().toISOString(), level, action, detail };
    logs.push(entry);
    if (logs.length > LOG_MAX) logs.shift();
    const line = '[pcopt] ' + action;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug : console.log;
    if (detail === undefined) fn(line); else fn(line, detail);
  }
  const logError = (action, e) => log('error', action, (e && e.message) || String(e));

  /* ------------------------------------------------------------------ *
   * 1. Game data: parsed from the bundle the page itself loaded
   * ------------------------------------------------------------------ */
  const UNOWN_IDS = [201, ...Array.from({ length: 27 }, (_, i) => 20101 + i)];

  function literalAt(src, start) {
    const open = src[start], close = open === '[' ? ']' : '}';
    let depth = 0, str = null, esc = false;
    for (let j = start; j < src.length; j++) {
      const c = src[j];
      if (str) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === str) str = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { str = c; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('unbalanced literal');
  }

  function literalAfter(src, marker, from = 0) {
    const i = src.indexOf(marker, from);
    if (i < 0) throw new Error('marker not found: ' + marker);
    let start = -1;
    if (marker.endsWith('[') || marker.endsWith('{')) start = i + marker.length - 1;
    else for (let j = i + marker.length; j < src.length; j++) {
      if (src[j] === '[' || src[j] === '{') { start = j; break; }
    }
    if (start < 0) throw new Error('no literal after ' + marker);
    return literalAt(src, start);
  }

  /** Every literal that follows a marker (the game extends some tables with Object.assign). */
  function literalsAfter(src, marker) {
    const out = [];
    let from = 0, at;
    while ((at = src.indexOf(marker, from)) >= 0) {
      from = at + marker.length;
      let start = -1;
      for (let j = from; j < src.length; j++) {
        if (src[j] === '[' || src[j] === '{') { start = j; break; }
      }
      if (start < 0) break;
      out.push(literalAt(src, start));
    }
    return out;
  }

  const evalLit = (lit, stub = {}) => Function('a', 'return (' + lit + ')')(stub);

  /**
   * Evaluate a data literal that reads minified variables of the bundle scope
   * (game helpers, cond constants). Unknown identifiers become door conditions.
   * Table names are rebuilt by the minifier on every game update, so the parser
   * never depends on them: it only looks at the shape of the data.
   */
  const JS_GLOBALS = new Set(['Infinity', 'NaN', 'undefined', 'Math', 'JSON', 'Object', 'Array',
    'String', 'Number', 'Boolean', 'Date', 'Symbol', 'parseInt', 'parseFloat', 'isNaN',
    'isFinite', 'RegExp', 'Map', 'Set', 'BigInt', 'Promise', 'Error', 'console']);
  function evalSandbox(lit, defaults = {}) {
    const scope = new Proxy(defaults, {
      has: (t, k) => typeof k === 'string' && !JS_GLOBALS.has(k) && !(k in t),
      get: (t, k) => {
        if (k === Symbol.unscopables) return undefined;
        if (k in t) return t[k];
        return (...args) => ({ cond: { kind: 'door', key: String(args[0] ?? k) } });
      }
    });
    return new Function('__scope', 'with (__scope) { return (' + lit + '); }')(scope);
  }

  function isNewerVersion(candidate, installed) {
    const candidateParts = candidate.split('.').map(Number);
    const installedParts = installed.split('.').map(Number);
    for (let i = 0; i < Math.max(candidateParts.length, installedParts.length); i++) {
      const difference = (candidateParts[i] ?? 0) - (installedParts[i] ?? 0);
      if (difference !== 0) return difference > 0;
    }
    return false;
  }

  /** Check this Chinese build's repository on load. Installation remains manual. */
  async function checkUpdate() {
    try {
      const code = await httpGet(UPDATE_URL + '?cb=' + Date.now());
      if (!code.startsWith('// ==UserScript==') || !code.includes('// ==/UserScript==')) return;
      const header = code.split('// ==/UserScript==', 1)[0];
      const repo = header.match(/^\/\/[ \t]+@version[ \t]+(\d+(?:\.\d+){1,3})[ \t]*\r?$/m)?.[1];
      if (!repo) return;
      state.update = isNewerVersion(repo, VERSION) ? { installed: VERSION, repo } : null;
      if (state.update) log('info', 'update: newer Chinese build', state.update);
      refreshUi();
    } catch (error) {
      log('debug', 'update: check failed', error.message);
    }
  }


  /** Every `name = <literal>` in the bundle (minified names are reused in several scopes). */
  function defLiterals(src, name, open) {
    const out = [];
    const re = new RegExp('(^|[^\\w$.])' + name + '\\s*=', 'g');
    let m;
    while ((m = re.exec(src))) {
      let at = m.index + m[0].length;
      while (/\s/.test(src[at])) at++;
      if (src[at] !== open) continue;
      try { out.push(literalAt(src, at)); } catch { /* not a plain literal */ }
    }
    return out;
  }

  /** The value the game publishes under `a.<module>` (public names survive minification). */
  function moduleNames(src, module) {
    const at = src.indexOf('a.' + module + '={');
    if (at < 0) return null;
    try {
      const table = literalAt(src, src.indexOf('{', at));
      const names = {};
      for (const m of table.matchAll(/([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*)/g)) names[m[1]] = m[2];
      return names;
    } catch { return null; }
  }

  function bundleUrl() {
    const candidates = [...$$('script[src]').map(el => el.src),
      ...$$('link[rel="preload"][as="script"][href]').map(el => el.href)];
    // boot.js loads the game after CSS; a userscript can start before its script tag exists.
    // Performance entries also cover a loader that later removes that tag.
    if (typeof performance !== 'undefined' && performance.getEntriesByType) {
      candidates.push(...performance.getEntriesByType('resource').map(entry => entry.name));
    }
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate, document.baseURI || location.href);
        if (/\/bundle\/app\.[0-9a-f]+\.js$/i.test(url.pathname)) { url.hash = ''; return url.href; }
      } catch { /* not a script URL */ }
    }
    return null;
  }

  /** Read only the form definitions, without executing the game's initialization. */
  function addBattleForms(source, species, moves, evolutions) {
    const start = /a\.FORMS\s*=\s*function\(\)\{\s*const\s+[\w$]+\s*=\s*\[/.exec(source);
    if (!start) return;
    const forms = evalLit(literalAt(source, start.index + start[0].length - 1));
    if (!Array.isArray(forms) || !forms.length || forms.some(form => !species[form.base] || !Number.isInteger(form.id))) {
      throw new Error('invalid form definitions');
    }
    for (const form of forms) {
      const base = species[form.base];
      if (form.single) base.singleBattleSpecies = form.base;
      const learn = (base.learn || []).map(([level, key]) => {
        if (form.techno && key === 'techno-blast' && moves[key]) {
          const variant = key + '-' + form.techno;
          moves[variant] = { ...moves[key], type: form.techno };
          return [level, variant];
        }
        return [level, key];
      });
      for (const key of [form.move, ...(form.moves || [])]) if (moves[key]) learn.push([50, key]);
      const name = form.full ? form.form : form.form ? `${base.name} (${form.form})` : base.name;
      species[form.id] = { ...base, id: form.id, name, formBase: form.base,
        types: form.types || base.types, stats: form.stats || base.stats, learn };
      if (form.evo) evolutions[form.id] = form.evo;
    }
    for (const form of forms) species[form.id].singleBattleSpecies = species[form.base].singleBattleSpecies;
  }

  const isLegendaryEntry = candidate => !!(candidate.species.legendary || candidate.species.mythical);
  const nativeRegion = region => region === 'kanto2' ? 'johto' : (region || 'kanto');
  const eventSpeciesKey = (candidate, elite = false) => candidate.species.singleBattleSpecies
    ? 'family:' + candidate.species.singleBattleSpecies
    : (elite ? 'species:' : candidate.proj.shiny ? 'shiny:' : 'normal:') + candidate.species.id;

  function incompatibleEventPair(a, b, data) {
    return (data.cfg.TEAM_APART || []).some(([id, others]) =>
      (a.mon.id === id && others.includes(b.mon.id)) || (b.mon.id === id && others.includes(a.mon.id)));
  }

  function canAddEventMember(team, candidate, tier, data) {
    if (tier && isLegendaryEntry(candidate) && team.filter(isLegendaryEntry).length >= (data.cfg.ELITE?.LEGENDS ?? 1)) return false;
    const key = eventSpeciesKey(candidate, !!tier);
    return team.every(member => member.mon.uid !== candidate.mon.uid
      && eventSpeciesKey(member, !!tier) !== key && !incompatibleEventPair(member, candidate, data));
  }

  function eventCandidates(save, cap, zoneRegion) {
    if (!save) return [];
    // Zone teams in a regional link follow the zone's region. Raid teams have no zone filter.
    const link = save.link;
    const allow = mon => !zoneRegion || !link || (nativeRegion(zoneRegion) === nativeRegion(link.to))
      === (nativeRegion(mon.reg) === nativeRegion(link.to));
    // The link's stored adventure team is still present in the event picker's allMons().
    return currentCandidates({ ...save, link: null }, true, cap, allow);
  }

  /** Extract the game's static tables from its own bundle. */
  async function parseBundle(url) {
    const t0 = Date.now();
    log('info', 'bundle: fetching', url);
    const src = await httpGet(url);
    log('debug', 'bundle: fetched', { bytes: src.length, ms: Date.now() - t0 });

    const table = (label, required, fn) => {
      try {
        const v = fn();
        if (v == null) throw new Error('not found');
        log('debug', 'bundle: table ok', { label, size: Array.isArray(v) ? v.length : Object.keys(v).length });
        return v;
      } catch (e) {
        log('error', 'bundle: table failed', { label, error: e.message });
        if (required) throw new Error('game update changed the bundle: ' + label + ' — ' + e.message);
        return null;
      }
    };
    const read = (marker, defaults) => () => {
      const lit = literalAfter(src, marker);
      try { return evalLit(lit, defaults); } catch { return evalSandbox(lit, defaults); }
    };

    const dex = table('POKEDEX', true, read('a.POKEDEX='));
    const moves = table('MOVES', true, read('a.MOVES='));
    const chart = table('TYPE_CHART', true, read('a.TYPE_CHART='));
    const evo = table('EVOLUTIONS', true, read('a.EVOLUTIONS='));
    const enc = table('ENCOUNTERS', true, read('a.ENCOUNTERS='));
    const habitats = table('HABITATS', true, read('a.HABITATS='));
    for (const lit of literalsAfter(src, 'Object.assign(a.ENCOUNTERS,')) Object.assign(enc, evalLit(lit));
    const regions = table('REGIONS', true, () => {
      const at = src.indexOf('REGIONS:[{key:');
      if (at < 0) throw new Error('marker not found');
      return evalSandbox(literalAt(src, at + 8));
    });
    const cfg = table('CONFIG', true, read('a.CONFIG='));
    const chapters = table('CHAPTERS', true, () => {
      const lit = literalAfter(src, 'CHAPTERS:[').replace(/a\.UNOWN\.ids/g, JSON.stringify(UNOWN_IDS));
      try { return evalLit(lit); } catch { return evalSandbox(lit); }
    });
    const leagueTeams = table('LEAGUE_TEAMS', false, read('a.LEAGUE_TEAMS=')) || {};
    const baseExp = table('BASE_EXP', false, read('a.BASE_EXP=')) || {};
    // the moves that can inflict a status: the learnset grading counts them as usable
    const statusMoves = table('STATUS.MOVES', false, () => {
      const anchor = /a\.STATUS\s*=\s*function\(\)\{const\s+[\w$]+\s*=\s*\{/.exec(src);
      if (!anchor) throw new Error('marker not found: STATUS.MOVES');
      const value = evalLit(literalAt(src, anchor.index + anchor[0].length - 1));
      const kinds = new Set(['burn', 'poison', 'freeze', 'sleep', 'paralysis', 'confusion', 'tri']);
      if (Object.keys(value).length < 30 || !Object.values(value).every(v => Array.isArray(v) && kinds.has(v[0]) && Number.isFinite(v[1]))) throw new Error('invalid STATUS.MOVES');
      return value;
    }) || {};
    const statusModule = src.slice(src.indexOf('a.STATUS='));
    const caps = statusModule.slice(0, 12000).match(/\{status:(\d+),damaging:(\d+),signature:(\d+)\}/);
    const statusCaps = caps ? { status: +caps[1], damaging: +caps[2], signature: +caps[3] } : null;
    // legend zones live in the same bundle: reading them here means one fetch, not two
    let legends = null;
    try { legends = parseLegends(src); } catch (e) { logError('bundle: legends', e); }

    // a half-read table would poison the cache and every result: refuse it
    const checks = [
      ['POKEDEX', dex.length > 500],
      ['MOVES', Object.keys(moves).length > 100],
      ['EVOLUTIONS', Object.keys(evo).length > 50],
      ['ENCOUNTERS', Object.keys(enc).length > 20],
      ['REGIONS', regions.length > 1],
      ['CHAPTERS', chapters.length > 10],
      ['CONFIG', cfg && cfg.MAX_LEVEL > 0],
    ];
    const bad = checks.filter(([, ok]) => !ok).map(([label]) => label);
    if (bad.length) throw new Error('game update changed the bundle: implausible ' + bad.join(', '));

    const species = {};
    for (const s of dex) species[s.id] = { id: s.id, name: s.name, types: s.types, stats: s.stats, learn: s.learn, captureRate: s.captureRate, legendary: s.legendary, mythical: s.mythical, baby: s.baby, unique: s.unique };

    try { addBattleForms(src, species, moves, evo); } catch (error) { logError('bundle: forms', error); }

    log('info', 'bundle: parsed', {
      url: url.split('/').pop(), dex: dex.length, moves: Object.keys(moves).length,
      chapters: chapters.length, regions: regions.length, ms: Date.now() - t0,
    });
    return {
      version: url,
      species,
      moves,
      chart,
      evo,
      enc,
      habitats,
      chapters,
      regions,
      leagueTeams,
      baseExp,
      statusMoves,
      statusCaps,
      legends,
      cfg: {
        LEVEL_GAP: cfg.LEVEL_GAP, CRIT_MULT: cfg.CRIT_MULT, CRIT_CHANCE: cfg.CRIT_CHANCE,
        ENEMY_DAMAGE: cfg.ENEMY_DAMAGE, GYM_DAMAGE: cfg.GYM_DAMAGE, GYM_HP_MULT: cfg.GYM_HP_MULT,
        GYM_TEAM_EXP: cfg.GYM_TEAM_EXP, ENEMY_HP_PER_ALLY: cfg.ENEMY_HP_PER_ALLY,
        HP_LEVEL_SCALE: cfg.HP_LEVEL_SCALE, HP_LEVEL_MAX: cfg.HP_LEVEL_MAX, HP_BOOST: cfg.HP_BOOST,
        SHINY_STAT_BONUS: cfg.SHINY_STAT_BONUS, TYPE_EFF_MAX: cfg.TYPE_EFF_MAX, TYPE_EFF_MIN: cfg.TYPE_EFF_MIN,
        MOVE_BLACKLIST: cfg.MOVE_BLACKLIST || [], MOVE_RECHARGE: cfg.MOVE_RECHARGE || [],
        MOVE_POWER_OVERRIDES: cfg.MOVE_POWER_OVERRIDES || {},
        MULTI_HIT: cfg.MULTI_HIT || {}, MULTI_HIT_ODDS: cfg.MULTI_HIT_ODDS || [],
        MOVE_LEVELS: cfg.MOVE_LEVELS || [], MOVE_FLOOR_FROM: cfg.MOVE_FLOOR_FROM ?? 100,
        MOVE_GAP_MAX: cfg.MOVE_GAP_MAX ?? 20, MOVE_STEP: cfg.MOVE_STEP || [4, 5],
        TIME_EVOLUTIONS: cfg.TIME_EVOLUTIONS || {}, TIER_MIN: cfg.TIER_MIN || {},
        STATUS_FX: cfg.STATUS_FX || { STAT: { burn: ['atk', .75], poison: ['spa', .75], sleep: ['def', .75], freeze: ['spd', .75] }, DOT_TURNS: 5, PARA_TURNS: 3 },
        STALL_ROUNDS: cfg.STALL_ROUNDS ?? 8, MAX_ROUNDS: cfg.MAX_ROUNDS ?? 200,
        STATUS_MOVE_CHANCE: cfg.STATUS_MOVE_CHANCE ?? .3, FULL_PARA_CHANCE: cfg.FULL_PARA_CHANCE ?? .25,
        THAW_CHANCE: cfg.THAW_CHANCE ?? .2, CONFUSION_SELF_HIT: cfg.CONFUSION_SELF_HIT ?? .33,
        WILD_EVOLVED_LEVELS: cfg.WILD_EVOLVED_LEVELS ?? 0,
        BERRY_HEAL: cfg.BERRY_HEAL ?? .25,
        NIGHT_SLEEP: cfg.NIGHT_SLEEP ?? .35, DOUBLE_CHANCE: cfg.DOUBLE_CHANCE ?? .3, TRIPLE: cfg.TRIPLE || null,
        TRAINER_LEVEL_BONUS: cfg.TRAINER_LEVEL_BONUS || [0, 1], TRAINER_EVOLVED_CHANCE: cfg.TRAINER_EVOLVED_CHANCE ?? .75,
        TRAINER_ITEM_EVO_LEVEL: cfg.TRAINER_ITEM_EVO_LEVEL ?? 40,
        TYPE_POWER: cfg.TYPE_POWER || { strong: 3, weak: -3, immune: -5, exposed: -2, resists: 2 },
        XP_WINS_PER_LEVEL: cfg.XP_WINS_PER_LEVEL ?? 15, XP_ACTIVE_BONUS: cfg.XP_ACTIVE_BONUS ?? 1.1,
        XP_SCALE: cfg.XP_SCALE ?? 3, XP_BASE_REF: cfg.XP_BASE_REF ?? 60,
        XP_GROWTH_FROM: cfg.XP_GROWTH_FROM ?? 10, XP_GROWTH_EXTRA: cfg.XP_GROWTH_EXTRA ?? 1,
        CHAPTER_TIME_RATIO: cfg.CHAPTER_TIME_RATIO ?? Math.pow(cfg.PACE?.lastMin / cfg.PACE?.firstMin ?? 40, 1 / ((cfg.PACE?.chapters ?? 14) - 1)),
        REGION_XP: cfg.REGION_XP || {}, baseExp: cfg.baseExp || null,
        TRADE_FEE: cfg.ONLINE_TRADE?.FEE || [30000, 120000, 450000],
        TRADE_SHINY_FEE: cfg.ONLINE_TRADE?.SHINY_FEE ?? 5,
        ACC_CURVE: cfg.ACC_CURVE || [40, 150, 80],
        TEAM_SIZE: cfg.TEAM_SIZE, MAX_LEVEL: cfg.MAX_LEVEL, LEAGUE_CAP_MARGIN: cfg.LEAGUE_CAP_MARGIN,
        LEAGUE_DONE_CAP: cfg.LEAGUE_DONE_CAP, LEVEL_CAP_MARGIN: cfg.LEVEL_CAP_MARGIN,
        LEAGUE_BELOW: cfg.LEAGUE_TRAINERS?.below || [6, 5, 4, 3],
        BOSS_STATUS: cfg.BOSS_STATUS || null, ROAMING: cfg.ROAMING || null, TEAM_APART: cfg.TEAM_APART || [],
        LEGEND_ZONE: cfg.LEGEND_ZONE, ELITE: cfg.ELITE, RANK_STAT: cfg.UNDERGROUND?.RANK_STAT ?? 1,
        CAPTURE_BONUS: cfg.CAPTURE_BONUS, CAPTURE_MAX: cfg.CAPTURE_MAX,
        LEGENDARY_CAPTURE_RATE: cfg.LEGENDARY_CAPTURE_RATE,
        RAID: cfg.RAID || null,
        RAID_PITY: cfg.RAID?.PITY ?? 150, RAID_CATCH: cfg.RAID?.CATCH ?? null,
        BUFF_BERRIES: cfg.BUFF_BERRIES, OFFLINE_MAX_LEVELS: cfg.OFFLINE_MAX_LEVELS
      }
    };
  }

  /* --- learnAll: the exact list the game's "moves panel" shows ------- */
  function buildLearnAll(data) {
    const { species, moves, evo, cfg } = data;
    const byId = species;

    const movePower = key => {
      if (cfg.MOVE_POWER_OVERRIDES[key] != null) return cfg.MOVE_POWER_OVERRIDES[key];
      const n = moves[key]?.power || 0;
      const o = cfg.MULTI_HIT[key];
      if (o == null) return n;
      if (Array.isArray(o)) return o.reduce((a, b) => a + b, 0);
      if (o === '2-5') return n * cfg.MULTI_HIT_ODDS.reduce((a, l, f) => a + l * (f + 2), 0);
      return n * o;
    };
    const moveAcc = key => {
      const n = movePower(key);
      if (n <= 0) return moves[key]?.acc || 100;
      const [o, r, l] = cfg.ACC_CURVE;
      return 100 - (100 - l) * Math.min(1, Math.max(0, (n - o) / (r - o)));
    };

    // Family links that are not evolutions (Porygon line).
    const Q = { 137: [233], 233: [474] };
    const evolutions = JSON.parse(JSON.stringify(evo));
    for (const [t, list] of Object.entries(Q)) {
      const rest = (evolutions[t] || []).filter(e => !list.includes(e.to));
      if (rest.length) evolutions[t] = rest; else delete evolutions[t];
    }
    const PREVO = {};
    for (const [t, list] of Object.entries(evolutions))
      for (const e of list) PREVO[e.to] ??= { from: +t, ...e };
    for (const [t, list] of Object.entries(Q))
      for (const e of list) PREVO[e] ??= { from: +t, family: true };

    const evoLevel = id => {
      const p = PREVO[id];
      if (!p) return 0;
      return p.level > 1 ? p.level : Math.max(20, evoLevel(p.from) + 10);
    };
    const isRealMove = key => movePower(key) > 0 && cfg.MOVE_POWER_OVERRIDES[key] == null && !cfg.MOVE_BLACKLIST.includes(key);
    const rootSpecies = id => (PREVO[id] && byId[PREVO[id].from]) ? rootSpecies(PREVO[id].from) : id;
    // Infinity does not survive the JSON cache: rebuild the level table.
    const moveLevels = (cfg.MOVE_LEVELS || []).map(([o, l]) => [o == null ? Infinity : o, l]);
    const levelFloor = key => {
      const n = movePower(key);
      if (n < cfg.MOVE_FLOOR_FROM) return 0;
      const hit = moveLevels.find(([o]) => n <= o);
      return hit ? hit[1] : moveLevels[moveLevels.length - 1][1];
    };

    // Which root species learn each move (used to drop redundant entries).
    const learners = {};
    for (const sp of Object.values(byId))
      for (const [, key] of sp.learn) (learners[key] ??= new Set()).add(rootSpecies(sp.id));

    const learnAll = {};
    for (const sp of Object.values(byId)) {
      const weight = key => movePower(key) * (moves[key].cat === 'phys' ? sp.stats.atk : sp.stats.spa);
      const list = sp.learn.map(l => [l[0], l[1], sp.id]);
      const seen = new Set(sp.learn.map(l => l[1]));
      for (let id = sp.id, p; (p = PREVO[id]) && byId[p.from]; id = p.from)
        for (const l of byId[p.from].learn)
          if (!seen.has(l[1])) { seen.add(l[1]); list.push([l[0], l[1], p.from]); }
    const orig = new Map(list.map(l => [l, l[0]]));   // level before any re-grading

      for (let i = list.length - 1; i >= 0; i--)
        if (cfg.MOVE_RECHARGE.includes(list[i][1])) list.splice(i, 1);
      for (const l of list) if (l[0] > 0) l[0] = Math.max(l[0], levelFloor(l[1]));

      // Per-type compression: keep the strongest move of each type, re-balancing levels.
      const byType = {}, dropped = new Set();
      for (const l of list) if (isRealMove(l[1])) (byType[moves[l[1]].type] ??= []).push(l);
      for (const group of Object.values(byType)) {
        const kept = [];
        let best = 0;
        for (const l of group.filter(x => x[0] > 0).sort((a, b) => a[0] - b[0] || weight(a[1]) - weight(b[1]))) {
          if (weight(l[1]) > best) { best = weight(l[1]); kept.push(l); }
          else if (learners[l[1]].size > 1) dropped.add(l[1]);
          else {
            const at = kept.findIndex(k => weight(k[1]) > weight(l[1]));
            const pair = [...kept.slice(at), l];
            const levels = pair.map(k => k[0]).sort((a, b) => a - b);
            const ids = [...pair].sort((a, b) => weight(a[1]) - weight(b[1])).map(k => [k[1], k[2]]);
            pair.forEach((k, i) => { k[0] = levels[i]; [k[1], k[2]] = ids[i]; });
            kept.push(l);
          }
        }
        for (const l of group.filter(x => x[0] === 0).sort((a, b) => weight(a[1]) - weight(b[1]))) {
          const w = weight(l[1]);
          const at = kept.findIndex(k => weight(k[1]) > w);
          const prev = kept[(at < 0 ? kept.length : at) - 1];
          const next = at < 0 ? null : kept[at];
          l[0] = prev && next ? Math.round((prev[0] + next[0]) / 2)
            : prev ? Math.min(100, prev[0] + 5)
            : next ? Math.max(1, next[0] - 5)
            : evoLevel(l[2]);
          kept.splice(at < 0 ? kept.length : at, 0, l);
        }
      }
      for (const l of list) if (l[0] === 0) l[0] = evoLevel(l[2]);
      for (const l of list) l[0] = Math.max(l[0], levelFloor(l[1]));

      // --- the 2026-11 grading, exactly as the game does it -----------------
      // (no damaging move GAP_MAX above the previous one, then the levels of
      // each type reassigned by weight order, then every usable move
      // spaced by a per-species 4-5 step, then the gap cap again)
      const statusMoves = data.statusMoves || {};
      const usable = key => !cfg.MOVE_BLACKLIST.includes(key) && (movePower(key) > 0 || !!statusMoves[key]);
      const kept = list.filter(l => !dropped.has(l[1]));
      const damaging = kept.filter(l => movePower(l[1]) > 0 && usable(l[1]));
      let prev = 0;
      for (const l of [...damaging].sort((a, b) => a[0] - b[0] || orig.get(a) - orig.get(b) || weight(a[1]) - weight(b[1]))) {
        if (prev) l[0] = Math.min(l[0], prev + cfg.MOVE_GAP_MAX);
        prev = l[0];
      }
      for (const type of new Set(damaging.map(l => moves[l[1]].type))) {
        const group = damaging.filter(l => moves[l[1]].type === type && isRealMove(l[1]));
        const levels = group.map(l => l[0]).sort((a, b) => a - b);
        [...group].sort((a, b) => weight(a[1]) - weight(b[1]) || a[0] - b[0]).forEach((l, i) => { l[0] = levels[i]; });
      }
      const spaced = kept.filter(l => usable(l[1]))
        .sort((a, b) => a[0] - b[0] || (movePower(b[1]) > 0) - (movePower(a[1]) > 0) || weight(a[1]) - weight(b[1]));
      const [stepLo, stepHi] = cfg.MOVE_STEP || [4, 5];
      const stepOf = i => stepLo + (Math.imul(sp.id * 64 + i, 2654435761) >>> 16) % (stepHi - stepLo + 1);
      const spread = stepFn => { let p = -Infinity; return spaced.map((l, i) => p = Math.max(l[0], p + stepFn(i))); };
      let graded = [];
      for (const stepFn of [stepOf, ...Array.from({ length: stepLo }, (_, i) => () => stepLo - i)])
        if (Math.max(0, ...graded = spread(stepFn)) <= 100) break;
      spaced.forEach((l, i) => { l[0] = graded[i]; });
      let last = 0;
      spaced.forEach((l, i) => {
        if (movePower(l[1]) > 0) {
          if (last && l[0] > last + cfg.MOVE_GAP_MAX)
            l[0] = Math.max(i ? spaced[i - 1][0] + Math.min(stepLo, l[0] - spaced[i - 1][0]) : 0, last + cfg.MOVE_GAP_MAX);
          last = l[0];
        }
      });
      learnAll[sp.id] = kept.sort((a, b) => a[0] - b[0]).map(l => [l[0], l[1]]);
    }
    return { learnAll, movePower, moveAcc, PREVO };
  }

  /* --- the roaming legendaries (legend zones) and their elite versions --- */
  /**
   * The game renames every minified variable on each update (Pe→Me, b→A…),
   * so the zone list is located by its data and the elite table through the
   * public LegendZones export, never by a minified name.
   */
  function parseLegends(src) {
    const looksLikeZones = v => Array.isArray(v) && v.length > 5 && v.every(z => z && typeof z.id === 'number' && z.region);
    const names = moduleNames(src, 'LegendZones');
    let zones = null, via = '';

    // the zones array starts with Zapdos (the only `[{id:145,...` literal)
    const at = src.indexOf('=[{id:145');
    if (at >= 0) {
      try {
        const v = evalSandbox(literalAt(src, at + 1));
        if (looksLikeZones(v)) { zones = v; via = 'data'; }
      } catch (e) { log('debug', 'legends: zone literal skipped', e.message); }
    }
    // the public export: a.LegendZones = { ZONES: <minified name>, … }
    if (!zones && names?.ZONES) {
      for (const lit of defLiterals(src, names.ZONES, '[')) {
        try {
          const v = evalSandbox(lit);
          if (looksLikeZones(v)) { zones = v; via = 'ZONES export'; break; }
        } catch (e) { log('debug', 'legends: ZONES candidate skipped', e.message); }
      }
    }
    if (!zones) {
      log('error', 'legends: zone list not found in the bundle');
      return null;
    }

    // the elite multipliers: { zoneId: { tier: [hp, power] } }
    const candidates = [];
    if (names?.ELITE_K) candidates.push(...defLiterals(src, names.ELITE_K, '{'));
    const ei = src.indexOf('ELITE_K:');
    if (ei > 0) {
      const name = (src.slice(ei, ei + 80).match(/ELITE_K:\s*([A-Za-z_$][\w$]*)/) || [])[1];
      if (name) candidates.push(...defLiterals(src, name, '{'));
      const bi = src.lastIndexOf('b={', ei);
      if (bi > 0) { try { candidates.push(literalAt(src, bi + 2)); } catch { /* old layout */ } }
    }
    let elite = {};
    for (const lit of candidates) {
      try {
        const v = evalSandbox(lit);
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 3) { elite = v; break; }
      } catch (e) { log('debug', 'legends: elite candidate skipped', e.message); }
    }
    log('info', 'legends: parsed', { zones: zones.length, elite: Object.keys(elite).length, via });
    let elitePower = null, elitePowerBounds = null;
    if (names?.ELITE_P) {
      for (const lit of defLiterals(src, names.ELITE_P, '{')) {
        const v = evalLit(lit);
        if (Object.keys(v).length > 3 && Object.values(v).every(n => Number.isFinite(n) && n > 0)) { elitePower = v; break; }
      }
      if (!elitePower) throw new Error('ELITE_P table not found');
      const clampRe = new RegExp('Math\\.min\\(([\\w$]+),Math\\.max\\(([\\w$]+),' + names.ELITE_P.replace(/[$]/g, '\\$') + '\\[');
      const at = clampRe.exec(src);
      if (!at) throw new Error('ELITE_P bounds not found');
      const numberBefore = name => {
        const re = new RegExp('(?:^|[,;])' + name.replace(/[$]/g, '\\$') + '=([0-9.eE+-]+)(?=[,;])', 'g');
        const nearby = src.slice(Math.max(0, at.index - 5000), at.index);
        const hits = [...nearby.matchAll(re)];
        return hits.length ? Number(hits[hits.length - 1][1]) : NaN;
      };
      elitePowerBounds = [numberBefore(at[2]), numberBefore(at[1])];
      if (!elitePowerBounds.every(Number.isFinite) || elitePowerBounds[0] <= 0 || elitePowerBounds[1] < elitePowerBounds[0]) throw new Error('invalid ELITE_P bounds');
      log('info', 'legends: elite power table', { size: Object.keys(elitePower).length, bounds: elitePowerBounds });
    }
    return { zones, elite, elitePower, elitePowerBounds };
  }

  /* ------------------------------------------------------------------ *
   * 2. Type chart (pokemondb.net/type, with PokeAPI + game fallbacks)
   * ------------------------------------------------------------------ */
  function parsePokemonDbChart(html) {
    const at = html.indexOf('<table class="type-table">');
    if (at < 0) throw new Error('type table not found');
    const table = html.slice(at, html.indexOf('</table>', at));
    const chart = {};
    const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    for (const row of rows) {
      const cells = row.match(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/g) || [];
      if (!cells.length) continue;
      const head = cells[0].match(/class="type-icon type-([a-z]+) type-cell"/);
      if (!head) continue;
      const line = {};
      for (const cell of cells.slice(1)) {
        const fx = cell.match(/type-fx-(\d+)/);
        const title = cell.match(/title="([^"]+)"/);
        if (!fx || !title) continue;
        const parts = title[1].split(' &#8594; ');
        if (parts.length !== 2) continue;
        const def = parts[1].split(' = ')[0].trim().toLowerCase();
        line[def] = { 100: 1, 200: 2, 50: 0.5, 0: 0 }[fx[1]];
      }
      chart[head[1]] = line;
    }
    if (Object.keys(chart).length < 18) throw new Error('incomplete type chart');
    return chart;
  }

  async function chartFromPokeApi() {
    const types = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
      'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
    const chart = {};
    for (const t of types) {
      const j = await httpGetJson('https://pokeapi.co/api/v2/type/' + t);
      const r = j.damage_relations, line = {};
      for (const d of types) line[d] = 1;
      for (const d of r.no_damage_to) line[d.name] = 0;
      for (const d of r.half_damage_to) line[d.name] = 0.5;
      for (const d of r.double_damage_to) line[d.name] = 2;
      chart[t] = line;
    }
    return chart;
  }

  /* ------------------------------------------------------------------ *
   * 3. Save access
   * ------------------------------------------------------------------ */
  let lastRaw = null, lastSave = null;

  function readSave() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch { return null; }
    if (!raw) return null;
    if (raw === lastRaw) return lastSave;
    let save;
    try { save = JSON.parse(raw); } catch { return null; }
    if (!save) return null;
    // packed export format: mons live in mz.m
    if (!Array.isArray(save.mons) && save.mz && Array.isArray(save.mz.m)) {
      save.mons = save.mz.m.map(m => {
        const mon = { uid: m[0], id: m[1], level: m[2], xp: m[3] };
        if (m[7]) Object.assign(mon, m[7]);
        return mon;
      });
    }
    if (!Array.isArray(save.mons)) save.mons = [];
    lastRaw = raw;
    lastSave = save;
    return save;
  }

  const monByUid = (save, uid) => save.mons.find(m => m.uid === uid) || null;

  /** Pokémon that are not in the PC (pension, underground, market, trades, other region). */
  function awayUids(save) {
    const out = new Set();
    for (const p of save.pension?.mons || []) if (p.mon) out.add(p.mon.uid);
    for (const slot of save.under?.slots || []) for (const m of slot.mons || []) out.add(m.uid);
    for (const m of save.mktOut || []) if (m) out.add(m.uid);
    if (save.tradeOut?.mon) out.add(save.tradeOut.mon.uid);
    if (save.tradeIn?.mon) out.add(save.tradeIn.mon.uid);
    if (save.link?.stash?.team) for (const u of save.link.stash.team) out.add(u);
    return out;
  }

  /** Region rule: while a region link is active, only some regions may join the team. */
  function canJoinTeam(save, mon) {
    const link = save.link;
    if (!link) return true;
    const reg = mon.reg || 'kanto';
    return link.side === 'from' ? reg !== link.to : reg === link.to;
  }

  /* ------------------------------------------------------------------ *
   * 4. Battle math (same formulas as the game)
   * ------------------------------------------------------------------ */
  function makeEngine(data, chart, learnAll) {
    const { species, moves, cfg } = data;
    const { movePower, moveAcc } = learnAll;

    const typeEff = (atkType, defTypes) => {
      let m = 1;
      for (const t of defTypes) m *= chart[atkType]?.[t] ?? 1;
      return clamp(m, cfg.TYPE_EFF_MIN, cfg.TYPE_EFF_MAX);
    };

    const statsOf = mon => {
      const sp = species[mon.id];
      if (!sp) return null;
      const lv = mon.level, b = sp.stats;
      const r = (mon.shiny ? 1 + cfg.SHINY_STAT_BONUS : 1) * (mon.statMult || 1) * Math.pow(cfg.RANK_STAT ?? 1, clamp(Math.floor(+mon.rank || 0), 0, 5));
      const f = k => Math.floor((Math.floor(2 * b[k] * lv / 100) + 5) * r);
      return {
        hp: Math.floor((Math.floor(2 * b.hp * lv / 100) + lv + 10) * r),
        atk: f('atk'), def: f('def'), spa: f('spa'), spd: f('spd'), spe: f('spe')
      };
    };
    const maxHp = mon => {
      const s = statsOf(mon);
      if (!s) return 0;
      const scale = Math.min(cfg.HP_LEVEL_MAX, 1 + cfg.HP_LEVEL_SCALE * mon.level / 100);
      return Math.floor(s.hp * scale * cfg.HP_BOOST * (mon.hpMult || 1));
    };

    const moveCache = new Map();

    /** Best move a mon can use against a target (the game picks it automatically). */
    const bestMove = (mon, defTypes) => {
      const key = mon.id + '|' + mon.level + '|' + (mon.shiny ? 1 : 0) + '|' + (mon.status || '') + '|' + (mon.rank || 0) + '|' + (mon.statMult || 1) + '|' + defTypes.join(',');
      if (moveCache.has(key)) return moveCache.get(key);
      const sp = species[mon.id];
      if (!sp) return null;
      const st = statsOf(mon);
      let best = null, bestVal = -1;
      for (const [lv, key] of learnAll.learnAll[mon.id] || []) {
        if (lv > mon.level) continue;
        if (cfg.MOVE_BLACKLIST.includes(key)) continue;
        const mv = moves[key];
        if (!mv) continue;
        const power = movePower(key);
        if (power <= 0) continue;
        const phys = mv.cat === 'phys';
        const atkStat = phys ? st.atk * (mon.status === 'burn' ? 0.5 : 1) : st.spa;
        const eff = typeEff(mv.type, defTypes);
        const val = power * (moveAcc(key) / 100) * (sp.types.includes(mv.type) ? 1.5 : 1) * eff * atkStat;
        if (val > bestVal) { bestVal = val; best = { key, name: mv.name, type: mv.type, cat: mv.cat, power, acc: moveAcc(key) }; }
      }
      moveCache.set(key, best);
      return best;
    };

    /** Expected damage (average roll 0.925), game formula. */
    const damage = (att, def, mv, eff) => {
      const A = statsOf(att), D = statsOf(def);
      if (!A || !D) return 0;
      const phys = mv.cat === 'phys';
      const atkStat = phys ? A.atk * (att.status === 'burn' ? 0.5 : 1) : A.spa;
      const defStat = phys ? D.def : D.spd;
      const sp = species[att.id];
      const stab = sp && sp.types.includes(mv.type) ? 1.5 : 1;
      const x = (2 * att.level / 5 + 2) * mv.power * atkStat / Math.max(1, defStat) / 50 + 2;
      const gap = Math.pow(cfg.LEVEL_GAP, att.level - def.level);
      return Math.max(1, Math.floor(x * stab * eff * gap * 0.925));
    };

    /** Damage of one specific move (the boss uses this for its burst / counter moves). */
    const moveDamage = (att, def, mv) => {
      const A = statsOf(att), D = statsOf(def);
      if (!A || !D) return 0;
      const phys = mv.cat === 'phys';
      const atkStat = phys ? A.atk * (att.status === 'burn' ? 0.5 : 1) : A.spa;
      const defStat = phys ? D.def : D.spd;
      const sp = species[att.id];
      const stab = sp && sp.types.includes(mv.type) ? 1.5 : 1;
      const x = (2 * att.level / 5 + 2) * mv.power * atkStat / Math.max(1, defStat) / 50 + 2;
      const gap = Math.pow(cfg.LEVEL_GAP, att.level - def.level);
      return x * stab * typeEff(mv.type, def.types) * gap * (mv.acc / 100) * 0.925;
    };

    /** Strongest move a mon has against a target (the boss picks the best one it knows). */
    const bestDamage = (att, def) => {
      let best = 0;
      for (const [lv, key] of learnAll.learnAll[att.id] || []) {
        if (lv > att.level) continue;
        if (cfg.MOVE_BLACKLIST.includes(key)) continue;
        const mv = moves[key];
        if (!mv) continue;
        const power = movePower(key);
        if (power <= 0) continue;
        const d = moveDamage(att, def, { key, type: mv.type, cat: mv.cat, power, acc: moveAcc(key) });
        if (d > best) best = d;
      }
      return best;
    };

    return { typeEff, statsOf, maxHp, bestMove, damage, movePower, moveAcc, moveDamage, bestDamage, learnset: mon => learnAll.learnAll[mon.id] || [] };
  }

  /* ------------------------------------------------------------------ *
   * 5. Chapter events
   * ------------------------------------------------------------------ */
  const regionOf = (data, ch) => data.regions.find(r => r.key === (data.chapters[ch]?.reg || 'kanto')) || null;
  const chaptersOf = (data, key) => data.chapters.map((c, i) => i).filter(i => (data.chapters[i].reg || 'kanto') === key);

  /** Level the region's champion is expected to have in this chapter (game formula). */
  function aceOf(data, ch) {
    const c = data.chapters[ch];
    if (!c) return null;
    const region = regionOf(data, ch);
    if (!region || !region.ace) return null;
    if (c.ace != null) return c.ace;
    const before = chaptersOf(data, region.key).filter(i => i < ch && data.chapters[i].ace == null).length;
    return region.ace[0] + region.ace[1] * before + (c.aceUp || 0);
  }

  function bandOf(data, ch) {
    const c = data.chapters[ch];
    if (c.lv) return c.lv;
    const h = aceOf(data, ch);
    if (h == null) return null;
    const region = regionOf(data, ch);
    const first = chaptersOf(data, region.key)[0];
    const m = ch > first ? aceOf(data, ch - 1) : null;
    return [m ?? (region.base || 0) + 2, h - 1];
  }

  /** Level range of the n-th route of a chapter (game formula). */
  function routeBand(data, ch, index, count) {
    const q = bandOf(data, ch);
    if (!q) return null;
    const [H, Sa] = q, z = (Sa - H) / count;
    const se = Math.round(H + z * index), ya = Math.round(H + z * (index + 1));
    return [se, Math.max(se + 1, ya)];
  }

  /** The level cap of a chapter (the game's capOf). */
  function capOf(data, ch) {
    const c = data.chapters[ch];
    if (!c) return data.cfg.MAX_LEVEL;
    const margin = c.capMargin != null ? c.capMargin : (c.league ? (data.cfg.LEAGUE_CAP_MARGIN ?? 3) : 0);
    let q = (aceOf(data, ch) ?? 0) + margin;
    if (c.league && !c.steps.some(st => st.champion)) {
      const region = regionOf(data, ch);
      const league = chaptersOf(data, region.key).filter(i => data.chapters[i].league);
      if (league.length) q = Math.min(q, Math.max(...league.map(i => aceOf(data, i) ?? 0)));
    }
    return q;
  }

  /** The next gym of a region the player still has to beat (the game's nextGymOf). */
  function nextGymOf(data, regionKey, adv) {
    const unlocked = adv?.unlocked || 0;
    const badges = adv?.badges || [];
    return chaptersOf(data, regionKey).find(i =>
      i >= unlocked &&
      data.chapters[i].steps.some(st => st.kind === 'gym') &&
      !data.chapters[i].steps.some(st => st.champion && badges.includes(st.badge))
    ) ?? null;
  }

  /** The level the player may reach right now (the game's levelCap).
   *  Open regions are the travel list, the region link destination and any
   *  region whose first chapter is already unlocked. */
  function levelCap(data, save) {
    const adv = save?.adv;
    const max = data.cfg.MAX_LEVEL;
    let m = 0;
    const open = new Set(['kanto', ...(adv?.travel?.to || []), save?.link?.to].filter(Boolean));
    const firstChapter = key => data.chapters.findIndex(c => (c.reg || 'kanto') === key);
    for (const region of data.regions) {
      if (!region || !region.ace || !region.key) continue;
      if (!open.has(region.key) && !(adv?.unlocked >= firstChapter(region.key))) continue;
      const next = nextGymOf(data, region.key, adv);
      if (next != null) return Math.min(max, capOf(data, next));
      for (const ch of chaptersOf(data, region.key)) if (aceOf(data, ch) != null) m = Math.max(m, capOf(data, ch));
    }
    return Math.min(max, m ? Math.max(m, data.cfg.LEAGUE_DONE_CAP ?? 100) : max);
  }

  function chapterInfo(data, chapterIndex, save) {
    const ch = data.chapters[chapterIndex];
    if (!ch) return null;
    return {
      index: chapterIndex, name: ch.name, region: ch.reg || 'kanto', ace: aceOf(data, chapterIndex), steps: ch.steps,
      cap: levelCap(data, save)
    };
  }

  /** The league of a region: the four Elite Four members plus the champion. */
  function leagueChapters(data, chapterIndex) {
    const c = data.chapters[chapterIndex];
    if (!c?.league) return [];
    const region = regionOf(data, chapterIndex);
    if (!region) return [];
    return chaptersOf(data, region.key).filter(i => data.chapters[i].league);
  }

  /** The foes of one league member: the trainers on the way plus the member itself. */
  function leagueEnemies(data, ch) {
    const cfg = data.cfg;
    const c = data.chapters[ch];
    const gym = c.steps.find(st => st.kind === 'gym');
    const teamLevel = capOf(data, ch);      // the level the team reaches by then
    const out = [];
    const region = regionOf(data, ch);
    const sets = data.leagueTeams?.[`${region?.key}:${gym?.leader}`] || [];
    sets.forEach((set, i) => {
      const level = (aceOf(data, ch) ?? 0) - (cfg.LEAGUE_BELOW[i] ?? 0);
      for (const id of set.team || []) {
        out.push({ id, level, weight: 2, kind: 'trainer', source: set.name || gym?.leader || '?', hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.trainer ?? 1, teamLevel, chapter: ch });
      }
    });
    if (gym?.team) {
      const maxLv = Math.max(...gym.team.map(t => t[1]));
      const q = gym.ace ?? aceOf(data, ch);
      const hpMult = cfg.GYM_HP_MULT * (gym.power || 1) * Math.pow(cfg.TEAM_SIZE / Math.max(1, gym.team.length), cfg.GYM_TEAM_EXP);
      for (const [id, lv] of gym.team) {
        out.push({
          id, level: q ? Math.round(lv * q / maxLv) : lv, weight: 3, kind: 'gym',
          source: gym.leader || gym.name, power: gym.power || 1, hpMult,
          damageMult: cfg.GYM_DAMAGE * (gym.power || 1), teamLevel, chapter: ch
        });
      }
    }
    return out;
  }

  /** Wild / trainer / gym foes of a chapter, with the levels the game uses. */
  function chapterEnemies(data, info, nodes) {
    const league = leagueChapters(data, info.index);
    if (league.length) {
      // the whole league: a wipe rewinds to the first member, so every one of them counts
      return league.flatMap(ch => leagueEnemies(data, ch));
    }
    if (nodes && nodes.length) return enemiesFromNodes(data, info, nodes);
    return enemiesFromChapter(data, info);
  }

  /** The foes of the nodes the game actually built (the live chapter). */
  function enemiesFromNodes(data, info, nodes) {
    const cfg = data.cfg;
    const out = [];
    for (const node of nodes) {
      if (node.type === 'gym' && node.gym?.team) {
        const gym = node.gym;
        const maxLv = Math.max(...gym.team.map(t => t[1]));
        const q = gym.ace ?? info.ace;
        const hpMult = cfg.GYM_HP_MULT * (gym.power || 1) * Math.pow(cfg.TEAM_SIZE / Math.max(1, gym.team.length), cfg.GYM_TEAM_EXP);
        for (const [id, lv] of gym.team) {
          out.push({
            id, level: q ? Math.round(lv * q / maxLv) : lv, weight: 3, kind: 'gym',
            source: gym.leader || gym.name, power: gym.power || 1, hpMult,
            damageMult: cfg.GYM_DAMAGE * (gym.power || 1)
          });
        }
      } else if (node.type === 'trainer' && node.team) {
        for (const [id, lv] of node.team) {
          out.push({ id, level: lv, weight: 2, kind: 'trainer', source: node.trainer || node.name, hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.trainer ?? 1 });
        }
      } else if ((node.type === 'wild' || node.type === 'trainer') && (node.pool?.length || node.areas)) {
        const pool = new Map();
        if (node.pool?.length) {
          for (const p of node.pool) {
            const cur = pool.get(p.id) || { id: p.id, w: 0 };
            cur.w += (p.w ?? 1);
            pool.set(p.id, cur);
          }
        } else for (const area of node.areas) {
          for (const e of data.enc[area] || []) {
            const [id, min, max, pct, method] = e;
            if (pct >= 100) continue;
            const how = String(method || '');
            if (!/walk|surf|rod|static|headbutt|rock-smash/.test(how)) continue;
            let w = pct;
            if (/rod/.test(how)) w *= 0.15;
            else if (/surf/.test(how)) w *= 0.5;
            else if (/headbutt|rock-smash/.test(how)) w *= 0.25;
            const cur = pool.get(id) || { id, w: 0 };
            cur.w += w;
            pool.set(id, cur);
          }
        }
        const band = node.lv;
        for (const p of pool.values()) {
          out.push({
            id: p.id, level: band ? Math.round((band[0] + band[1]) / 2) : 0,
            weight: Math.max(0.2, p.w / 10), kind: node.type === 'trainer' ? 'trainer' : 'wild', source: node.name,
            hpMult: 1, damageMult: cfg.ENEMY_DAMAGE[node.type] ?? 1
          });
        }
      } else if (node.type === 'static' && node.id != null) {
        out.push({
          id: node.id, level: node.level ?? 100, weight: 3, kind: 'static', source: node.name,
          hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.static ?? 1
        });
      }
    }
    return out;
  }

  /** The foes of a chapter, rebuilt from its static data (fallback). */
  function enemiesFromChapter(data, info) {
    const enemies = [];   // {id, level, weight, kind, source}
    const steps = info.steps;
    const cfg = data.cfg;

    for (const step of steps.filter(s => s.kind === 'gym' && s.team)) {
      const team = step.team;
      const maxLv = Math.max(...team.map(t => t[1]));
      const q = step.ace ?? info.ace;
      const hpMult = cfg.GYM_HP_MULT * (step.power || 1) * Math.pow(cfg.TEAM_SIZE / Math.max(1, team.length), cfg.GYM_TEAM_EXP);
      for (const [id, lv] of team.map(t => [t[0], q ? Math.round(t[1] * q / maxLv) : t[1]]))
        enemies.push({
          id, level: lv, weight: 3, kind: 'gym', source: step.name, power: step.power || 1,
          hpMult, damageMult: cfg.GYM_DAMAGE * (step.power || 1), teamSize: team.length
        });
    }
    for (const step of steps.filter(s => s.kind === 'trainer' && s.team)) {
      const team = step.team;
      const maxLv = Math.max(...team.map(t => t[1]));
      const q = info.ace;
      for (const [id, lv] of (step.scale ? team.map(t => [t[0], Math.round(t[1] * q / maxLv)]) : team))
        enemies.push({
          id, level: lv, weight: 2, kind: 'trainer', source: step.trainer || step.name,
          hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.trainer ?? 1
        });
    }
    const routes = steps.filter(s => s.kind === 'route');
    routes.forEach((step, index) => {
      if (!step.wild) return;
      const band = step.lv || routeBand(data, info.index, index, routes.length);
      const pool = new Map();
      for (const area of step.areas || []) {
        for (const e of data.enc[area] || []) {
          const [id, min, max, pct, method] = e;
          if (pct >= 100) continue;
          const how = String(method || '');
          if (!/walk|surf|rod|static|headbutt|rock-smash/.test(how)) continue;
          let w = pct;
          if (/rod/.test(how)) w *= 0.15;
          else if (/surf/.test(how)) w *= 0.5;
          else if (/headbutt|rock-smash/.test(how)) w *= 0.25;
          const cur = pool.get(id) || { id, w: 0 };
          cur.w += w;
          pool.set(id, cur);
        }
      }
      for (const p of pool.values()) {
        const level = band ? Math.round((band[0] + band[1]) / 2) : 0;
        enemies.push({
          id: p.id, level, weight: Math.max(0.2, p.w / 10), kind: 'wild', source: step.name,
          hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.wild ?? 1
        });
      }
    });
    return enemies;
  }

  /* ------------------------------------------------------------------ *
   * 6. Optimizer
   * ------------------------------------------------------------------ */
  const KIND_WEIGHT = { wild: 1, trainer: 4, gym: 8 };

  /** The game only evolves into a species whose region dex is open. */
  function regionHas(data, save, targetId) {
    const base = targetId > 10000 ? Math.floor(targetId / 100) : targetId;
    const unlocked = save?.adv?.unlocked ?? 0;
    return (data.regions || []).some(r => r.dex
      && unlocked >= data.chapters.findIndex(c => (c.reg || 'kanto') === r.key)
      && base >= r.dex[0] && base <= r.dex[1]);
  }

  /** The game's daytime phases: morning < 10h, day 10-20h, night >= 20h (a
   *  chapter flagged `day` stays day until it is fully unlocked). */
  function daytimeMatches(data, save, key) {
    if (!key) return true;
    const adv = save?.adv;
    const ch = adv?.chapter != null ? data.chapters[adv.chapter] : null;
    const dayLocked = !!ch?.day && !(adv.unlocked > adv.chapter);
    const hour = new Date().getHours();
    const idx = dayLocked ? 1 : (hour >= 20 || hour < 8 ? 2 : hour >= 10 ? 1 : 0);
    return key === 'night' ? idx === 2 : idx !== 2;
  }

  /** The game's trade tier (captureRate, evolution depth, BST, TIER_MIN). */
  function tradeTier(data, id, cache = new Map()) {
    if (cache.has(id)) return cache.get(id);
    const sp = data.species[id];
    if (!sp) { cache.set(id, 0); return 0; }
    let o;
    const PREVO = {};
    for (const [from, list] of Object.entries(data.evo)) for (const e of list) PREVO[e.to] ??= { from: +from, ...e };
    PREVO[233] ??= { from: 137 }; PREVO[474] ??= { from: 233 };
    const prevo = x => {
      const p = PREVO[x];
      return (p && data.species[p.from] && !data.species[p.from].baby) ? p.from : null;
    };
    if (sp.unique) o = 4;
    else if (sp.legendary || sp.mythical) o = 3;
    else {
      o = sp.captureRate <= 45 ? 2 : sp.captureRate <= 120 ? 1 : 0;
      if (!sp.baby) {
        const d = prevo(id);
        const w = (data.evo[id] || []).some(e => data.species[e.to] && !data.species[e.to].legendary && !data.species[e.to].mythical);
        let depth = 0;
        for (let i = d; i != null; i = prevo(i)) depth++;
        if (d != null) o = Math.max(o, w ? 1 : depth >= 2 ? 2 : 1);
        if (d != null || !w) {
          const bst = Object.values(sp.stats || {}).reduce((a, b) => a + b, 0);
          o = Math.max(o, bst >= 500 ? 2 : bst >= 450 ? 1 : 0);
        }
        o = Math.max(o, data.cfg.TIER_MIN?.[id] ?? 0);
        if (d != null) o = Math.max(o, Math.min(2, tradeTier(data, d, cache)));
      }
    }
    cache.set(id, o);
    return o;
  }

  /** What an online trade of this mon costs (the game's fee table, no economy multiplier). */
  function tradeFee(data, mon) {
    const tier = tradeTier(data, mon.id);
    const fee = (data.cfg.TRADE_FEE || [])[Math.min(2, tier)] ?? 0;
    return Math.round(fee * (mon.shiny ? (data.cfg.TRADE_SHINY_FEE ?? 5) : 1));
  }

  /**
   * Every species the mon can become at the cap: all reachable branches, current
   * form last. Level evolutions respect the game's daytime and party gates and
   * its uid-hash pick when several branches qualify; item evolutions need the
   * item in the bag; link-cable evolutions (trades) need the trade fee in the
   * wallet. Evolutions into a closed region's dex stay out.
   */
  function evolvedBranches(data, save, mon, cap) {
    const out = [];
    const seen = new Set([mon.id]);
    const partyIds = new Set((save.team || []).map(u => monByUid(save, u)?.id).filter(Boolean));
    const walk = (id, uid, depth) => {
      if (depth > 4) return;
      const chain = data.evo[id] || [];
      // level branches: the game picks one by uid hash when several qualify
      const levelOk = chain.filter(e => e.level != null && e.level <= cap
        && daytimeMatches(data, save, data.cfg.TIME_EVOLUTIONS?.[e.to])
        && (!e.party || partyIds.has(e.party))
        && regionHas(data, save, e.to));
      const picks = levelOk.length > 1 ? [levelOk[[...uid].reduce((d, w) => d * 31 + w.charCodeAt(0) >>> 0, 7) % levelOk.length]] : levelOk;
      for (const e of picks) {
        if (seen.has(e.to) || !data.species[e.to]) continue;
        seen.add(e.to); out.push(e.to);
        walk(e.to, uid, depth + 1);
      }
      // item branches: every one you can pay for is reachable (you choose what to use)
      for (const e of chain) {
        if (e.item == null || seen.has(e.to) || !data.species[e.to]) continue;
        const owned = e.item === 'link-cable'
          ? save.money >= tradeFee(data, { id, shiny: mon.shiny })
          : (save.items?.[e.item] ?? 0) > 0;
        if (owned && regionHas(data, save, e.to) && daytimeMatches(data, save, data.cfg.TIME_EVOLUTIONS?.[e.to])) {
          seen.add(e.to); out.push(e.to);
          walk(e.to, uid, depth + 1);
        }
      }
    };
    walk(mon.id, mon.uid, 0);
    out.push(mon.id);
    return out;
  }

  /** The Pokémon that may join the team, projected at the chapter cap (evolutions included).
   *  opts.branches = false keeps one candidate per real mon (the chapter sim evolves them itself). */
  function projectCandidates(eng, data, save, level, opts = {}) {
    const away = awayUids(save);
    const cands = save.mons.filter(m => !away.has(m.uid) && data.species[m.id] && canJoinTeam(save, m));
    const branchesOf = opts.branches === false ? (c => [c.id]) : (c => evolvedBranches(data, save, c, level));
    return cands.flatMap(c => branchesOf(c).map(sid => {
      const sp = data.species[sid];
      const base = { id: sp.id, shiny: c.shiny, status: c.status, types: sp.types };
      const proj = { ...base, level };
      const hp = eng.maxHp(proj);
      // the team keeps its HP between fights: use what is left, like the game does
      const hpCur = c.hp != null ? Math.min(c.hp, hp) : hp;
      return { mon: c, base, proj, species: sp, hp, hpCur };
    }));
  }

  /** Individual metrics of every candidate against the chapter's foes. */
  function scoreCandidates(eng, data, enemies, candidates, level, fullHp = false) {
    const enemyList = enemies.map(e => {
      const types = data.species[e.id]?.types || [];
      const proj = { id: e.id, level: e.level, types };
      return {
        ...e, proj, types,
        hp: eng.maxHp(proj),
        weight: (KIND_WEIGHT[e.kind] || 1) * (e.weight || 1)
      };
    });

    const out = [];
    for (const cand of candidates) {
      const sp = data.species[cand.base?.id ?? cand.id];
      if (!sp) continue;
      const base = cand.base || { id: cand.id, shiny: cand.shiny, status: cand.status, types: sp.types };
      let dmgSum = 0, surviveSum = 0, wSum = 0, bestDmg = 0, bestMoveName = '', bestMoveKey = '', bestEff = 1;
      for (const e of enemyList) {
        // in a league the team levels up and is healed between the members
        const proj = { ...base, level: e.teamLevel ?? level };
        const hp = fullHp ? eng.maxHp(proj) : Math.min(cand.hpCur != null ? cand.hpCur : eng.maxHp(proj), eng.maxHp(proj));
        const mv = eng.bestMove(proj, e.types);
        if (!mv) continue;
        const eff = eng.typeEff(mv.type, e.types);
        const dmg = eng.damage(proj, e.proj, mv, eff) * (mv.acc / 100);
        const emv = eng.bestMove(e.proj, proj.types);
        let incoming = 0;
        if (emv) {
          const eeff = eng.typeEff(emv.type, proj.types);
          const mult = e.kind === 'gym'
            ? data.cfg.GYM_DAMAGE * (e.power || 1)
            : (data.cfg.ENEMY_DAMAGE[e.kind] ?? 1) * (e.power || 1);
          incoming = eng.damage(e.proj, proj, emv, eeff) * (emv.acc / 100) * mult;
        }
        const rounds = incoming > 0 ? hp / incoming : 99;
        dmgSum += dmg * e.weight;
        surviveSum += rounds * e.weight;
        wSum += e.weight;
        if (dmg > bestDmg) { bestDmg = dmg; bestMoveName = mv.name; bestMoveKey = mv.key; bestEff = eff; }
      }
      if (!wSum) continue;
      out.push({
        mon: cand.mon || cand, base, proj: { ...base, level }, species: sp, hp: cand.hp,
        dmg: dmgSum, survive: surviveSum,
        avgDmg: dmgSum / wSum, avgRounds: surviveSum / wSum,
        bestDmg, bestMoveName, bestMoveKey, bestEff
      });
    }
    return out;
  }

  function scoreFor(s, preset) {
    if (preset === 'defense') return s.avgRounds;
    if (preset === 'offense') return s.avgDmg;
    return Math.sqrt(Math.max(0, s.avgDmg) * Math.max(0.01, s.avgRounds));
  }

  /** One full fight: our team (in order) against one foe, the way the game chains them. */
  function simulate(team, enemy, eng, fullHp = false) {
    const ehp = enemy.hp * enemy.hpMult;
    let remaining = ehp, dealt = 0, rounds = 0, teamHp = 0, incoming = 0;
    for (const c of team) {
      const base = c.base || c.proj;
      const proj = enemy.teamLevel != null ? { ...base, level: enemy.teamLevel } : c.proj;
      const maxHp = eng.maxHp(proj);
      const hpLeft = fullHp ? maxHp : Math.min(c.hpCur != null ? c.hpCur : maxHp, maxHp);
      const mv = eng.bestMove(proj, enemy.types);
      if (!mv) continue;
      const eff = eng.typeEff(mv.type, enemy.types);
      const dmg = eng.damage(proj, enemy.proj, mv, eff) * (mv.acc / 100);
      const emv = eng.bestMove(enemy.proj, proj.types);
      let inc = 0;
      if (emv) {
        const eeff = eng.typeEff(emv.type, proj.types);
        inc = eng.damage(enemy.proj, proj, emv, eeff) * (emv.acc / 100) * enemy.damageMult;
      }
      teamHp += hpLeft;
      incoming += inc;
      const alive = inc > 0 ? hpLeft / inc : 99;
      const toKill = dmg > 0 ? remaining / dmg : 99;
      const r = Math.min(alive, toKill);
      dealt += r * dmg;
      remaining -= r * dmg;
      rounds += r;
      if (remaining <= 0) break;
    }
    const roundsDie = incoming > 0 ? teamHp / incoming : 99;
    return {
      win: remaining <= 0,
      roundsKill: remaining <= 0 ? rounds : Infinity,
      dmgDealt: dealt, roundsDie, hpLeft: Math.max(0, remaining)
    };
  }

  /** Score of a whole team against the chapter's foes. */
  /** Higher is better: how well a team wins a fight (turns to die / turns to kill). */
  function fightScore(res, preset) {
    if (preset === 'offense') return res.dmgDealt;
    if (preset === 'defense') return res.roundsDie;
    return res.roundsDie / Math.max(0.5, res.roundsKill);
  }

  function evaluateTeam(team, enemies, eng, data, preset) {
    let score = 0;
    for (const e of enemies) {
      const res = simulate(team, e, eng);
      if (preset === 'offense') score += e.weight * res.dmgDealt / Math.max(1, e.hp);
      else score += e.weight * fightScore(res, preset);
    }
    return score;
  }

  /** Greedy team builder: one Pokémon per species (the game keeps only one of each). */
  function pickTeam(scored, enemies, eng, data, preset, size = 6) {
    const pool = scored.slice()
      .sort((a, b) => scoreFor(b, preset) - scoreFor(a, preset) || b.mon.level - a.mon.level)
      .slice(0, 60);
    const chosen = [];
    const usedSpecies = new Set();
    const usedShiny = new Set();
    const usedUids = new Set();
    while (chosen.length < size) {
      let best = null, bestScore = -Infinity;
      for (const cand of pool) {
        if (chosen.includes(cand) || usedUids.has(cand.mon.uid)) continue;
        if (!cand.mon.shiny && usedSpecies.has(cand.species.id)) continue;
        if (cand.mon.shiny && usedShiny.has(cand.species.id)) continue;
        const sc = evaluateTeam(chosen.concat([cand]), enemies, eng, data, preset);
        // same score: prefer the Pokémon that is already the closest to the chapter cap
        if (sc > bestScore || (sc === bestScore && best && cand.mon.level > best.mon.level)) {
          bestScore = sc; best = cand;
        }
      }
      if (!best) break;
      chosen.push(best);
      usedSpecies.add(best.species.id);
      usedUids.add(best.mon.uid);
      if (best.mon.shiny) usedShiny.add(best.species.id);
    }
    return chosen;
  }

  /* ------------------------------------------------------------------ *
   * 6c. Chapter simulation — the game's own battle rules, ported from
   *     its bundle: move pick (OHKO / status 30% / best attack), status
   *     gates and dots, initiative, stall rule, auto-switch order, XP
   *     with mid-chapter level-ups and evolutions.
   * ------------------------------------------------------------------ */
  let simRandomState=null,simSnapshot=null;
  function seedHash(value) {
    let hash=2166136261;
    for(const ch of String(value))hash=Math.imul(hash^ch.charCodeAt(0),16777619)>>>0;
    return hash||1;
  }
  function simRandom(){
    if(simRandomState==null)return Math.random();
    simRandomState=(simRandomState+0x6d2b79f5)>>>0;
    let t=simRandomState;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);
    return((t^(t>>>14))>>>0)/4294967296;
  }
  function withSimSeed(seed,fn){const previous=simRandomState;simRandomState=seed>>>0;try{return fn()}finally{simRandomState=previous}}

  const ri = (a, b) => a + Math.floor(simRandom() * (b - a + 1));      // the game's rand int
  const rpick = list => list[Math.floor(simRandom() * list.length)];
  const statusCap = key => {
    const sure = key === 'spore' || key === 'sacred-fire' || key === 'nuzzle' || key === 'zap-cannon' || key === 'inferno' || key === 'dynamic-punch';
    const damaging = (state.data.moves[key]?.power || 0) > 0;
    const caps = state.data.statusCaps;
    return caps ? (sure ? caps.signature : damaging ? caps.damaging : caps.status)
      : (sure ? 100 : damaging ? 30 : Math.min(state.data.moves[key]?.acc ?? 100, 70));
  };
  const statusOfMv = key => (state.data.statusMoves?.[key] || [])[0];
  const STATUS_IMMUNE = { burn: ['fire'], poison: ['poison', 'steel'], freeze: ['ice'], paralysis: [], sleep: [], confusion: [] };
  const effRaw = (atkType, defTypes) => (defTypes || []).reduce((m, t) => m * (state.chart[atkType]?.[t] ?? 1), 1);
  const canStatus = (def, status) => !(STATUS_IMMUNE[status] || []).some(t => (def.types || []).includes(t));
  const psStat = (mon, stat) => {
    const st = state.data.cfg.STATUS_FX?.STAT?.[mon.status];
    return st && st[0] === stat ? st[1] : 1;
  };
  const simStats = mon => state.engine.statsOf(mon);
  const simHp = mon => Math.floor(state.engine.maxHp(mon));
  const learnOfSim = mon => state.learnAll?.learnAll?.[mon.id] || [];
  const hitPowersOf = key => {
    const o = state.data.cfg.MULTI_HIT[key];
    const base = state.data.moves[key]?.power || 0;
    if (o == null) return null;
    if (Array.isArray(o)) return [...o];
    if (o === '2-5') {
      let w = simRandom(), hits = 2;
      for (let g = 0; g < (state.data.cfg.MULTI_HIT_ODDS || []).length && (w -= state.data.cfg.MULTI_HIT_ODDS[g]) > 0; g++) hits = g + 3;
      return Array(hits).fill(base);
    }
    return Array(o).fill(base);
  };
  const minPowerOf = key => {
    const o = state.data.cfg.MULTI_HIT[key];
    const base = state.data.moves[key]?.power || 0;
    if (o == null) return base;
    if (Array.isArray(o)) return base * o[0];
    return o === '2-5' ? 2 * base : base * o;
  };
  /** The game's damage (Ue) with the roll supplied by the caller. */
  function simDamage(att, def, mv, eff, crit, roll) {
    const A = simStats(att), D = simStats(def);
    const phys = mv.cat === 'phys';
    const atk = phys ? A.atk * psStat(att, 'atk') : A.spa * psStat(att, 'spa');
    const defv = phys ? D.def * psStat(def, 'def') : D.spd * psStat(def, 'spd');
    const sp = state.data.species[att.id];
    const stab = sp && sp.types.includes(mv.type) ? 1.5 : 1;
    const x = (2 * monLevel(att) / 5 + 2) * mv.power * atk / Math.max(1, defv) / 50 + 2;
    const gap = Math.pow(state.data.cfg.LEVEL_GAP, monLevel(att) - monLevel(def));
    return Math.max(1, Math.floor(x * stab * eff * gap * (crit ? state.data.cfg.CRIT_MULT : 1) * roll));
  }
  const monLevel = mon => mon.level;
  /** The game's ot(): an OHKO-capable move, best accuracy wins. */
  function simOhko(att, def, dMult) {
    let best = null;
    for (const [lv, key] of learnOfSim(att)) {
      if (lv > att.level || state.data.cfg.MOVE_BLACKLIST.includes(key)) continue;
      const mv = state.data.moves[key];
      if (!mv) continue;
      const power = state.engine.movePower(key);
      if (power <= 0) continue;
      const eff = effRaw(mv.type, def.types);
      if (eff === 0) continue;
      const cand = { key, type: mv.type, cat: mv.cat, power, acc: state.engine.moveAcc(key) };
      const us = simDamage(att, def, { ...cand, power: minPowerOf(key) }, eff, false, .85);
      if (us * dMult < def.hp) continue;
      if (!best || cand.acc > best.acc || (cand.acc === best.acc && power > best.power)) best = cand;
    }
    return best;
  }
  /** The game's qa(): the status move it knows (the last qualifying one). */
  function simStatusMove(att, def) {
    let found = null;
    for (const [lv, key] of learnOfSim(att)) {
      if (lv > att.level) continue;
      if ((state.data.moves[key]?.power || 0) > 0) continue;
      const status = statusOfMv(key);
      if (!status || !state.data.moves[key] || !canStatus(def, status) || effRaw(state.data.moves[key].type, def.types) === 0) continue;
      found = { key, status, chance: Math.min(state.data.moves[key].acc || state.data.statusMoves?.[key]?.[1] || 70, statusCap(key)) };
    }
    return found;
  }
  /** The game's Ws(): the best attack, damage summed over the living foes. */
  function simGeneric(att, foes) {
    const living = foes.filter(f => f.hp > 0);
    const sp = state.data.species[att.id];
    const st = simStats(att);
    const foeStats = living.map(f => {
      const d = simStats(f);
      return { types: f.types, def: d.def * psStat(f, 'def'), spd: d.spd * psStat(f, 'spd') };
    });
    let best = null, bestVal = 0, hasAttack = false;
    for (const [lv, key] of learnOfSim(att)) {
      if (lv > att.level || state.data.cfg.MOVE_BLACKLIST.includes(key)) continue;
      const mv = state.data.moves[key];
      if (!mv) continue;
      const power = state.engine.movePower(key);
      if (power <= 0) continue;
      hasAttack = true;
      const phys = mv.cat === 'phys';
      const atkStat = phys ? st.atk * psStat(att, 'atk') : st.spa * psStat(att, 'spa');
      const accTerm = state.engine.moveAcc(key) / 100 * (sp && sp.types.includes(mv.type) ? 1.5 : 1);
      let val = 0;
      for (const f of foeStats) val += ((2 * monLevel(att) / 5 + 2) * power * atkStat / Math.max(1, phys ? f.def : f.spd) / 50 + 2) * accTerm * effRaw(mv.type, f.types);
      if (val > bestVal) { bestVal = val; best = key; }
    }
    if (!best) return hasAttack ? { key: 'struggle', type: 'normal', cat: 'phys', power: state.engine.movePower('struggle'), acc: 100, typeless: true } : null;
    const mv = state.data.moves[best];
    return { key: best, type: mv.type, cat: mv.cat, power: state.engine.movePower(best), acc: state.engine.moveAcc(best) };
  }
  function simInflict(mon, status) {
    if (mon.status || !canStatus(mon, status)) return;
    mon.status = status;
    mon.bit = 0;
    if (status === 'sleep') mon.sleepLeft = ri(1, 3);
    if (status === 'confusion') mon.confused = ri(2, 5);
  }
  const simClear = mon => { delete mon.status; delete mon.bit; delete mon.sleepLeft; delete mon.confused; };
  /** The game's Y(): the pre-turn gates (sleep, freeze, full-para, confusion). */
  function simGate(mon) {
    if (mon.status === 'sleep') {
      if (mon.sleepLeft > 0) { mon.sleepLeft--; return true; }
      simClear(mon); return false;
    }
    if (mon.status === 'freeze') {
      if (simRandom() >= state.data.cfg.THAW_CHANCE) return true;
      simClear(mon); return false;
    }
    if (mon.status === 'paralysis') {
      mon.bit = (mon.bit || 0) + 1;
      if (simRandom() < state.data.cfg.FULL_PARA_CHANCE) return true;
    }
    if (mon.confused) {
      if (--mon.confused <= 0) delete mon.confused;
      else if (simRandom() < state.data.cfg.CONFUSION_SELF_HIT) {
        const st = simStats(mon);
        const dmg = Math.max(1, Math.floor((2 * monLevel(mon) / 5 + 2) * 40 * st.atk / Math.max(1, st.def) / 50 + 2));
        mon.hp = Math.max(0, mon.hp - dmg);
        mon._dmg = (mon._dmg || 0) + dmg;
        return true;
      }
    }
    return false;
  }
  /** The game's oe(): the dot after acting and the status expiry. */
  function simDot(mon) {
    if (mon.status === 'paralysis') {
      if ((mon.bit || 0) >= (state.data.cfg.STATUS_FX?.PARA_TURNS ?? 3)) simClear(mon);
      return;
    }
    if (mon.status !== 'burn' && mon.status !== 'poison') return;
    const dot = Math.max(1, Math.floor(simHp(mon) / 8));
    mon.hp = Math.max(0, mon.hp - dot);
    mon._dmg = (mon._dmg || 0) + dot;
    mon.bit = (mon.bit || 0) + 1;
    if ((mon.bit || 0) >= (state.data.cfg.STATUS_FX?.DOT_TURNS ?? 5) && mon.hp > 0) simClear(mon);
  }
  /** One actor's turn (the game's Ha). Returns the damage dealt. */
  function simAct(att, def, foes, dMult) {
    if (simGate(att)) return 0;
    let dealt = 0;
    const ohko = simOhko(att, def, dMult);
    const statusMv = !ohko && simStatusMove(att, def);
    const generic = simGeneric(att, foes);
    if (statusMv && (simRandom() < state.data.cfg.STATUS_MOVE_CHANCE || (generic && generic.typeless))) {
      if (simRandom() * 100 < statusMv.chance) { simInflict(def, statusMv.status); return 1; }
      return 0;
    }
    const mv = ohko || generic;
    if (!mv) return 0;
    if (simRandom() * 100 > mv.acc) return 0;
    const eff = mv.typeless ? 1 : effRaw(mv.type, def.types);
    if (eff === 0) return 0;
    const hits = hitPowersOf(mv.key);
    let dmg = 0;
    if (hits) for (const p of hits) dmg += simDamage(att, def, { ...mv, power: p }, eff, simRandom() < state.data.cfg.CRIT_CHANCE, .85 + simRandom() * .15);
    else dmg = simDamage(att, def, mv, eff, simRandom() < state.data.cfg.CRIT_CHANCE, .85 + simRandom() * .15);
    def.hp = Math.max(0, def.hp - dmg);
    if (def.hp > 0) {
      if (def.status === 'freeze' && mv.type === 'fire') simClear(def);
      const status = statusOfMv(mv.key);
      if (status && simRandom() * 100 < Math.min(state.data.statusMoves?.[mv.key]?.[1] || 0, statusCap(mv.key)) && canStatus(def, status)) simInflict(def, status);
    }
    return dmg;
  }

  /** The game's Gt/Ks auto-switch ordering. */
  function autoScore(mon, foes) {
    const tp = state.data.cfg.TYPE_POWER;
    const myTypes = state.data.species[mon.id]?.types || [];
    let sum = 0;
    for (const foe of foes) {
      if (foe.hp <= 0) continue;
      const foeTypes = state.data.species[foe.id]?.types || foe.types || [];
      const bm = state.engine.bestMove({ id: mon.id, level: mon.level, shiny: mon.shiny }, foeTypes);
      const off = bm ? effRaw(bm.type, foeTypes) : 1;
      const def = Math.max(...foeTypes.map(t => effRaw(t, myTypes)), 1e-4);
      sum += (off === 0 ? tp.immune : off > 1 ? tp.strong : off < 1 ? tp.weak : 0)
        + (def > 1 ? tp.exposed : def < 1 ? tp.resists : 0)
        + .01 * (Math.log2(Math.max(.125, off)) - Math.log2(Math.max(.125, def)));
    }
    return sum;
  }
  /** The ordered chapter steps from the nodes the game built (heal stops + battles). */
  function chapterRoamer(node, save) {
    const id = Number(node?.roamer);
    return node?.type === 'wild' && Number.isInteger(id) && id > 0 && !roamerCaught(save, id) ? id : undefined;
  }

  function chapterPlan(data, save) {
    const plan = [];
    for (const [nodeIndex,node] of (save?.adv?.nodes || []).entries()) {
      if (node.type === 'berry') { plan.push({kind:'berry',nodeIndex,index:nodeIndex}); continue; }
      if (node.type === 'heal') { plan.push({kind:'heal', nodeIndex, index:nodeIndex}); continue; }
      const base = {kind:'battle', type:node.type, name:node.name, nodeIndex, index:nodeIndex};
      const roamer = chapterRoamer(node, save);
      if (roamer) {
        if (!data.species[roamer]) throw new Error(`第 ${nodeIndex + 1} 步缺少游荡传说资料，无法模拟。`);
        const cfg = data.cfg;
        const highest = (save?.mons || []).reduce((level, mon) => Math.max(level, Number(mon.level) || 0), 0);
        const level = Math.min(cfg.MAX_LEVEL, Math.max(cfg.ROAMING?.MIN_LEVEL ?? 100, highest));
        plan.push({ ...base, name: displayName(roamer), roamer, fixed: [{ id: roamer, level }] });
        continue;
      }
      if (node.type === 'wild' || node.type === 'trainer') {
        if (node.team?.length) {
          const fixed = node.team.map(entry => Array.isArray(entry) ? {id:+entry[0],level:+entry[1]}
            : typeof entry === 'object' ? {id:+entry.id,level:+(entry.level ?? entry.lv)} : {id:+entry,level:NaN});
          if (fixed.some(mon => !data.species[mon.id] || !Number.isFinite(mon.level) || mon.level < 1)) throw new Error(`第 ${nodeIndex+1} 步固定队伍资料不完整，未生成胜率。`);
          plan.push({...base,fixed});
        } else {
          let pool;try{pool=poolOfNode(node,data)}catch(error){throw new Error(`第 ${nodeIndex+1} 步（${zhText(node.name||'战斗')}）无法分析：${error.message}`)}
          if (!pool.length) throw new Error(`第 ${nodeIndex+1} 步（${zhText(node.name||'战斗')}）没有读到可模拟的对手，分析已停止；不会跳过这场战斗。`);
          plan.push({...base,pool,lv:node.lv || null,size:node.size ?? null});
        }
      } else if (node.type === 'gym') {
        if (!node.gym?.team?.length) throw new Error(`第 ${nodeIndex+1} 步道馆队伍缺失。`);
        const gym=node.gym, hpMult=data.cfg.GYM_HP_MULT*(gym.power||1)*Math.max(1,data.cfg.TEAM_SIZE/gym.team.length)**data.cfg.GYM_TEAM_EXP;
        plan.push({...base,name:gym.leader||gym.name,fixed:gym.team.map(([id,level])=>({id,level,hpMult})),power:gym.power||1,double:!!gym.double});
      } else if (node.type === 'static' && node.id != null) {
        plan.push({...base,fixed:[{id:node.id,level:node.level??100}]});
      }
    }
    return plan;
  }
  function selectedChapterPlan(data,save,scope=state.planScope) {
    const plan=chapterPlan(data,save);
    if(scope==='restart')return plan;
    if(scope==='after-heal'){
      const next=plan.find(step=>step.kind==='heal'&&step.nodeIndex>=(save.adv.node||0));
      if(!next)throw new Error('本章后面没有宝可梦中心。可改用“整章重试”准备下一次挑战；途中安排的队伍不会立刻上场。');
      return plan.filter(step=>step.nodeIndex>=next.nodeIndex);
    }
    return plan.filter(step=>step.nodeIndex >= (save.adv.node||0));
  }
  function failureFocus(save,plan){
    const record=(state.watcher?.fails||[]).find(f=>f.chapter===save.adv.chapter&&(!f.why||f.why==='chapter')&&['gym','trainer','wild','static'].includes(f.kind)&&plan.some(s=>s.kind==='battle'&&s.nodeIndex===f.node&&(!f.name||f.name===s.name||f.name===(save.adv.nodes||[])[f.node]?.name)));
    if(!record)return null;
    return{node:record.node,name:record.name,at:record.at,enemies:record.enemies||[],team:record.team||[]};
  }


  /** The weighted species pool of a node (the game builds it live on some chapters). */
  /** Pool formats used by generated route nodes. Inline indoor habitats take their
   * authoritative weights from HABITATS; outdoor conditions remain model estimates. */
  function poolOfNode(node,data){
    const normalize=pool=>{
      const out=new Map();
      for(const entry of pool){
        const raw=+entry.id,id=raw>20100&&raw<=20127?201:raw;
        if(!data.species[id])throw new Error('出没名单中缺少宝可梦 #'+raw+' 的资料。');
        const weight=entry.w??1;if(!Number.isFinite(weight)||weight<0)throw new Error('出没权重无效。');if(!weight)continue;
        const key=[id,entry.min,entry.max,entry.nativeLevels].join('|'),old=out.get(key);
        if(old)old.w+=weight;else out.set(key,{...entry,id,w:weight});
      }return [...out.values()];
    };
    if(node.pool?.length)return normalize(node.pool);
    if(node.species?.length){
      if(!Array.isArray(node.lv)||node.lv.length!==2||!node.lv.every(Number.isFinite)||node.lv[0]<1||node.lv[1]<node.lv[0])throw new Error('直接出没名单缺少有效等级范围。');
      const key=node.habitat||node.name+'|species',habitat=data.habitats?.[key];
      const weights=habitat?.base||Object.fromEntries(node.species.map(id=>[id,1]));
      const depth=id=>{let n=0;const seen=new Set();for(let p=state.learnAll?.PREVO?.[id];p&&!data.species[p.from]?.baby&&!seen.has(p.from);p=state.learnAll?.PREVO?.[p.from]){seen.add(p.from);n++;}return n;};
      return normalize(Object.entries(weights).filter(([,w])=>w>0).map(([raw,w])=>{
        const id=+raw,sp=data.species[id]||data.species[id>20100&&id<=20127?201:id];
        if(!sp)throw new Error('直接出没名单中缺少宝可梦 #'+id+' 的资料。');
        if(sp.baby&&!habitat?.allow?.includes(id))return null;
        const extra=habitat?(habitat.lv?.[id]??depth(id)*(data.cfg.WILD_EVOLVED_LEVELS||0)):0;
        return{id,w,min:Math.min(100,node.lv[0]+extra),max:Math.min(100,node.lv[1]+extra),nativeLevels:true};
      }).filter(Boolean));
    }
    const pool=new Map();
    for(const area of node.areas||[])for(const [id,min,max,pct,method] of data.enc[area]||[]){
      if(max>=100)continue;
      const how=String(method||'');if(!/walk|surf|rod|static|headbutt|rock-smash/.test(how))continue;
      let w=pct;if(/rod/.test(how))w*=.15;else if(/surf/.test(how))w*=.5;else if(/headbutt|rock-smash/.test(how))w*=.25;
      const old=pool.get(id)||{id,w:0,min,max};old.w+=w;old.min=Math.min(old.min,min);old.max=Math.max(old.max,max);pool.set(id,old);
    }
    return normalize([...pool.values()]);
  }


  const rollPool = pool => {
    let total = pool.reduce((a, p) => a + (p.w || p[p.length - 1] || 1), 0);
    let r = simRandom() * total;
    for (const p of pool) {
      r -= (p.w || 1);
      if (r <= 0) return p;
    }
    return pool[pool.length - 1];
  };
  /** The foes of one battle instance (wild roll, random trainer roll, or fixed team). */
  function rollBattleFoes(step, data, save, cap) {
    const cfg = data.cfg;
    if (step.roamer) {
      const { id, level } = step.fixed[0];
      const power = cfg.LEGEND_ZONE?.ROAM_POWER ?? .6;
      const hp = (cfg.LEGEND_ZONE?.ROAM_HP ?? 4) * (1 + (cfg.ENEMY_HP_PER_ALLY ?? .7) * (cfg.TEAM_SIZE - 1));
      return { foes: [simFoe(id, level, hp, power)], slots: cfg.TEAM_SIZE, kind: 'wild', index: step.index, xp: true, roamer: true, power };
    }
    if (step.fixed) {
      const count=step.fixed.length,region=state.data.chapters[save?.adv?.chapter]?.reg||'kanto';
      const slots=step.type==='static'?cfg.TEAM_SIZE:step.double&&count>=2?2:step.type==='trainer'&&count>=3&&cfg.TRIPLE?.REGIONS?.includes(region)&&simRandom()<cfg.TRIPLE.CHANCE?3:step.type==='trainer'&&count>=2&&simRandom()<cfg.DOUBLE_CHANCE?2:1;
      return {
        foes: step.fixed.map(f => simFoe(f.id, f.level, f.hpMult ?? 1, f.damageMult ?? dmgMultOf(step.type, cfg, f.power))),
        slots, dmgMult: dmgMultOf(step.type, cfg, step.power ?? 1), kind: step.type, index: step.index, xp: true,
      };
    }
    const pool = (step.pool || []).filter(p => data.species[p.id]);
    if (!pool.length) return null;
    const wildLevel = e => {
      if(e.nativeLevels)return ri(e.min,e.max);
      const band = step.lv;
      if (band) return ri(band[0], band[1]);
      return e.level ?? ri(e.min ?? 30, e.max ?? 40);
    };
    if (step.type === 'wild') {
      const e = rollPool(pool);
      const level = wildLevel(e);
      const foe = simFoe(e.id, level, 1, cfg.ENEMY_DAMAGE.wild ?? 1);
      // the game: a diurnal wild can start asleep at night
      if (new Date().getHours() >= 20 && (data.cfg.NIGHT_SLEEP ?? 0) > 0) {
        const types = data.species[e.id]?.types || [];
        const dayOnly = ['sun', 'day'].some(k => (data.cfg.WEATHER?.TYPES?.[types[0]]?.key || '').includes(k));
        if (dayOnly && simRandom() < cfg.NIGHT_SLEEP) { foe.status = 'sleep'; foe.sleepLeft = ri(1, 3); }
      }
      return { foes: [foe], slots: 1, dmgMult: cfg.ENEMY_DAMAGE.wild ?? 1, kind: 'wild', index: step.index, xp: true };
    }
    // trainer: size + evolved rolls, exactly like the game's encounter builder
    const chapter = save?.adv?.chapter ?? 0;
    const regionKey = (data.chapters[chapter] || {}).reg || 'kanto';
    const first = data.chapters.findIndex(c => (c.reg || 'kanto') === regionKey);
    const size = step.size ?? 1 + ri(0, Math.min(2, Math.floor((chapter - first) / 2) + 1));
    const foes = [];
    for (let i = 0; i < size; i++) {
      const e = rollPool(pool);
      let level = Math.min(cfg.MAX_LEVEL, (data.aceOf ? 0 : 0) + (wildLevel(e) + ri(cfg.TRAINER_LEVEL_BONUS[0], cfg.TRAINER_LEVEL_BONUS[1])), cap);
      let id = e.id;
      if (level >= cfg.TRAINER_ITEM_EVO_LEVEL) {
        // item-evolved variants once high enough
        const itemEvo = (data.evo[id] || []).find(x => x.item && data.species[x.to]);
        if (itemEvo) id = itemEvo.to;
      } else if (simRandom() < cfg.TRAINER_EVOLVED_CHANCE) {
        const chain = (data.evo[id] || []).filter(x => x.level != null && x.level <= level && data.species[x.to]);
        if (chain.length) id = chain[chain.length - 1].to;
      }
      foes.push(simFoe(id, level, 1, cfg.ENEMY_DAMAGE.trainer ?? 1));
    }
    const triple=foes.length>=3&&cfg.TRIPLE?.REGIONS?.includes(regionKey)&&simRandom()<(cfg.TRIPLE.CHANCE??0);
    const slots=triple?3:foes.length>=2&&simRandom()<(cfg.DOUBLE_CHANCE??.3)?2:1;
    return { foes, slots, foeSlots: slots, dmgMult: cfg.ENEMY_DAMAGE.trainer ?? 1, kind: 'trainer', index: step.index, xp: true };
  }
  const dmgMultOf = (type, cfg, power) => type === 'gym'
    ? cfg.GYM_DAMAGE * (power || 1)
    : (cfg.ENEMY_DAMAGE[type] ?? 1) * (power || 1);
  const simFoe = (id, level, hpMult, damageMult) => ({ id, level, types: state.data.species[id]?.types || [], hpMult: hpMult || 1, _damageMult: damageMult || 1, hp: 0 });
  /** One run of the whole chapter. Returns the battles cleared and where it ended. */
  function runChapter(mons,plan,cap,options={}) {
    let cleared=0,turns=0;const passed=[];
    const startLevels=mons.map(mon=>mon.level),seed=options.seed??1;
    for(const mon of mons)mon.hp=mon.hpStart;
    for(const step of plan){
      if(step.kind==='berry'){for(const mon of mons)if(mon.hp>0)mon.hp=Math.min(simHp(mon),mon.hp+Math.ceil(simHp(mon)*(state.data.cfg.BERRY_HEAL??.25)));continue}
      if(step.kind==='heal'){for(const mon of mons){mon.hp=simHp(mon);simClear(mon)}continue}
      const id=step.nodeIndex??step.index;
      const spec=withSimSeed(seedHash(seed+':foes:'+id),()=>rollBattleFoes(step,state.data,options.save||simSnapshot||readSave(),cap));
      if(!spec)throw new Error(`第 ${id+1} 步无法模拟，未生成胜率。`);
      for(const foe of spec.foes)foe.hp=simHp(foe);
      const result=withSimSeed(seedHash(seed+':fight:'+id),()=>simBattle(mons,spec));
      if(!result.won)return{cleared,passed,battles:plan.filter(s=>s.kind==='battle').length,ended:id,done:false,gained:Math.max(0,...mons.map((m,i)=>m.level-startLevels[i])),health:0};
      cleared++;passed.push(id);
    }
    const battles=plan.filter(step=>step.kind==='battle').length;
    const health=mons.reduce((sum,m)=>sum+Math.max(0,m.hp)/Math.max(1,simHp(m)),0)/Math.max(1,mons.length);
    return{cleared,passed,battles,ended:null,done:battles>0,gained:Math.max(0,...mons.map((m,i)=>m.level-startLevels[i])),health};
  }
  function simulateChapter(cands,plan,cap,runs,onProgress,options={}) {
    const full=!!options.fullHeal;
    const team=cands.map(candidate=>{
      const mon={...candidate.mon},max=simHp(mon);
      return{...mon,types:state.data.species[mon.id]?.types||[],hpStart:full?max:mon.hp==null?max:clamp(mon.hp,0,max),
        status:full?undefined:mon.status,sleepLeft:full?0:(mon.sleepLeft??mon.sleep??0),confused:full?0:mon.confused};
    });
    let wins=0,clearedSum=0,gainedMax=0,health=0,focusWins=0;
    const wipeAt={},previous=simSnapshot;simSnapshot=options.save||readSave();
    try{for(let i=0;i<runs;i++){
      const result=runChapter(team.map(mon=>({...mon})),plan,cap,{...options,seed:seedHash((options.seed??701)+':'+i)});
      clearedSum+=result.cleared;health+=result.health;gainedMax=Math.max(gainedMax,result.gained);
      if(result.passed.includes(options.focusNode))focusWins++;
      if(result.done)wins++;else if(result.ended!=null)wipeAt[result.ended]=(wipeAt[result.ended]||0)+1;
      if(onProgress&&i%4===0)onProgress(i+1,runs);
    }}finally{simSnapshot=previous}
    const rate=wins/Math.max(1,runs),z=1.96,n=Math.max(1,runs),den=1+z*z/n,center=(rate+z*z/(2*n))/den,margin=z*Math.sqrt(rate*(1-rate)/n+z*z/(4*n*n))/den;
    return{wins,runs,rate,...(options.focusNode!=null?{focusWins,focusRate:focusWins/n}:{}),avgCleared:clearedSum/n,totalBattles:plan.filter(step=>step.kind==='battle').length,wipeAt,gainedMax,health:health/n,interval:[Math.max(0,center-margin),Math.min(1,center+margin)]};
  }


  /** One battle (the game's ia/bs loop): slots, refills, stall, XP. */
  function simBattle(mons, spec) {
    if (spec.roamer) return simRoamingBoss(mons, spec);
    const foes = spec.foes;
    const slots = Math.max(1, Math.min(spec.slots || 1, state.data.cfg.TEAM_SIZE));
    const foeSlots = Math.max(1, Math.min(slots, 3));
    let active=[],foeActive=[];
    const refill=()=>{
      const previous=active.slice();
      const opponents=foes.filter(f=>f.hp>0).slice(0,foeSlots),alive=mons.filter(m=>m.hp>0),auto=(simSnapshot||readSave())?.autoSwitch!==false;
      const score=m=>autoScore(m,opponents)/Math.max(1,opponents.length)+(active.includes(m)?.001:0);
      const choices=auto?alive.slice().sort((a,b)=>score(b)-score(a)||mons.indexOf(a)-mons.indexOf(b)):alive;
      const selected=choices.slice(0,slots);
      for(let i=0;i<slots;i++){if(active[i]&&selected.includes(active[i]))continue;active[i]=selected.find(m=>!active.includes(m))||null;}
      active=active.filter(Boolean);
      for(const old of previous)if(!active.includes(old))old.confused=0;
      foeActive=opponents;
    };
    let turn = 0, calm = 0;
    const hpFrac = list => list.reduce((a, m) => a + m.hp, 0) / Math.max(1, list.reduce((a, m) => a + simHp(m), 0));
    const xpTarget = spec.xp;
    while (foes.some(f => f.hp > 0)) {
      refill();
      if (!active.some(m => m.hp > 0)) return { won: false, at: spec.index };
      turn++;
      if (calm > state.data.cfg.STALL_ROUNDS || turn > state.data.cfg.MAX_ROUNDS) {
        if (hpFrac(active.filter(m => m.hp > 0)) > hpFrac(foes)) {
          for (const f of foes) f.hp = 0;
          if (xpTarget) awardXp(foes[foes.length - 1], active, mons, spec.kind, true);
          return { won: true, stalled: true, at: spec.index };
        }
        if (spec.kind === 'gym' || spec.kind === 'static') return { won: false, at: spec.index };
        return { won: true, fled: true, at: spec.index };   // wild/trainer: the game flees and the node passes
      }
      const actors = [
        ...active.filter(m => m.hp > 0).map(m => ({ m, ally: true })),
        ...foeActive.filter(f => f.hp > 0).map(f => ({ m: f, ally: false })),
      ].map(x => ({ ...x, spe: simStats(x.m).spe * (x.m.status === 'paralysis' ? .25 : 1) }))
        .sort((a, b) => b.spe - a.spe || simRandom() - .5);
      let lostAlly = false, foeDown = false;
      for (const { m: actor, ally } of actors) {
        if (actor.hp <= 0) continue;
        const opposing = (ally ? foeActive : active).filter(x => x.hp > 0);
        if (!opposing.length) break;
        // target: allies pick the best damage-to-hp ratio (the game's Dn), foes pick a random ally
        const target = ally
          ? (() => {
            let best = null, bestScore = -1;
            for (const f of opposing) {
              const mv = simGeneric(actor, [f]);
              if (!mv) continue;
              const eff = mv.typeless ? 1 : effRaw(mv.type, f.types);
              const score = Math.max(0, mv.power) * eff / Math.max(1, f.hp) * (.95 + simRandom() * .1);
              if (!best || score > bestScore) { best = f; bestScore = score; }
            }
            return best || opposing[0];
          })()
          : rpick(opposing);
        const dealt = simAct(actor, target, opposing.map(x => x), ally ? 1 : spec.dmgMult);
        if (dealt) calm = 0;
        const dot = (actor._dmg || 0); actor._dmg = 0;
        if (dot) calm = 0;
        simDot(actor);
        if (actor._dmg) calm = 0;
        if (target.hp <= 0 && ally) {
          if (xpTarget) awardXp(target, active, mons, spec.kind, false);
          const next = foes.find(f => f.hp > 0 && !foeActive.includes(f));
          if (next) { const idx = foeActive.indexOf(target); foeActive[idx < 0 ? 0 : idx] = next; }
          else foeDown = true;
        }
        if (actor.hp <= 0 && ally) lostAlly = true;
      }
      calm++;
    }
    return { won: foes.every(f => f.hp <= 0), at: spec.index };
  }
  /** XP for one defeated foe, to the whole team, with mid-run level-ups. */
  function awardXp(foe, active, mons, kind, stalled) {
    const cfg = state.data.cfg;
    const base = (cfg.baseExp?.[foe.id]) || cfg.XP_BASE_REF;
    const trainerish = kind === 'trainer' || kind === 'gym';
    const share = xpLevelShare(foe.level) / cfg.XP_WINS_PER_LEVEL * Math.sqrt(base / cfg.XP_BASE_REF) * (trainerish ? 1.5 : 1);
    const cap = state.events?.cap ?? cfg.MAX_LEVEL;
    for (const mon of mons) {
      if (mon.level >= cap) continue;
      const amount = share * (active.includes(mon) ? cfg.XP_ACTIVE_BONUS : 1);
      mon.xp = (mon.xp || 0) + amount;
      let guard = 0;
      while (mon.level < cap && mon.xp >= xpForNext(mon) && guard++ < 120) {
        mon.xp -= xpForNext(mon);
        mon.level++;
      }
      // the game's pe: level evolutions with the daytime and party gates
      let evo = 0;
      while (evo++ < 4) {
        const chain = (state.data.evo[mon.id] || []).filter(e => e.level != null && mon.level >= e.level
          && daytimeMatches(state.data, simSnapshot || readSave(), state.data.cfg.TIME_EVOLUTIONS?.[e.to])
          && (!e.party || mons.some(t => t.id === e.party)));
        const eligible = chain.filter(e => regionHas(state.data, simSnapshot || readSave(), e.to));
        const next = eligible.length > 1 ? eligible[[...String(mon.uid)].reduce((hash, ch) => hash * 31 + ch.charCodeAt(0) >>> 0, 7) % eligible.length] : eligible[0];
        if (!next || !state.data.species[next.to]) break;
        mon.id = next.to;mon.types=state.data.species[mon.id]?.types||mon.types;
      }
    }
  }
  const xpBe = level => Math.floor(.8 * Math.pow(level, 2.4) + 10);
  function xpGrowth(level) {
    const cfg = state.data.cfg;
    const ratio = cfg.CHAPTER_TIME_RATIO || 1;
    const bands = [{ from: cfg.XP_GROWTH_FROM ?? 10, step: (state.data.regions[0]?.ace || [0, 8])[1] ?? 8 },
      ...state.data.regions.filter(r => r.base != null).map(r => ({ from: r.base, step: (r.ace || [0, 8])[1] ?? 8 }))]
      .sort((a, b) => a.from - b.from);
    let g = 1;
    for (let i = 0; i < bands.length; i++) {
      const to = Math.min(level, bands[i + 1]?.from ?? Infinity);
      if (to > bands[i].from) g *= Math.pow(Math.pow(ratio, 1 / bands[i].step) * (cfg.XP_GROWTH_EXTRA ?? 1), to - bands[i].from);
    }
    return g;
  }
  const xpForNext = mon => Math.floor(xpBe(mon.level) * xpGrowth(mon.level) * (state.data.cfg.XP_SCALE ?? 3) * (state.data.cfg.REGION_XP?.[mon.reg] ?? 1));
  function xpLevelShare(level) {   // the game's levelXp: base × the "start" factor
    const cfg = state.data.cfg;
    const ratio = cfg.CHAPTER_TIME_RATIO || 1;
    const bands = [{ from: cfg.XP_GROWTH_FROM ?? 10, step: (state.data.regions[0]?.ace || [0, 8])[1] ?? 8 },
      ...state.data.regions.filter(r => r.base != null).map(r => ({ from: r.base, step: (r.ace || [0, 8])[1] ?? 8 }))]
      .sort((a, b) => a.from - b.from);
    let g = 1;
    for (let i = 0; i < bands.length; i++) {
      const to = Math.min(level, bands[i + 1]?.from ?? Infinity);
      if (to > bands[i].from) g *= Math.pow(Math.pow(ratio, 1 / bands[i].step) * (cfg.XP_GROWTH_EXTRA ?? 1), to - bands[i].from);
    }
    const from = bands.find(b => level >= b.from);
    const back = from && bands.indexOf(from) > 0 ? Math.pow(Math.pow(ratio, 1 / from.step) * (cfg.XP_GROWTH_EXTRA ?? 1), level - from.from) : 1;
    return Math.floor(xpBe(level) * (g / (back || 1)));
  }

  /* ------------------------------------------------------------------ *
   * 6b. Legendary fights (roaming legendaries and their elite versions)
   * ------------------------------------------------------------------ */
  /** Build the boss (a legend zone) with the knobs the game uses for that fight. */
  function legendBoss(zone, tier, team, eng, data, damageCache) {
    const cfg = data.cfg;
    const sp = data.species[zone.id];
    if (!sp) return null;
    const level = zone.level || 100;
    const mon = { id: zone.id, level, types: sp.types };
    const maxHp = eng.maxHp(mon);
    const aura = team.length && !zone.roaming
      ? Math.pow(team.reduce((sum, c) => sum + (c.proj.shiny ? 1 : Math.max(1,
        Math.min(c.proj.level, cfg.MAX_LEVEL) / cfg.MAX_LEVEL * (cfg.RANK_STAT ?? 1) ** (c.proj.rank || 0))), 0) / team.length,
        cfg.LEGEND_ZONE?.AURA ?? 1)
      : 1;
    // the game's eliteKnobs: a per-zone override wins over the shared ELITE_K table
    const inline = tier ? (zone.elite?.[zone.id]?.[tier] || zone.elite?.[tier]) : null;
    const eliteTable = tier ? (inline
      ? [inline.hp ?? 1, inline.power ?? 1]
      : (data.legends?.elite?.[zone.id]?.[tier] || [1, 1])) : null;
    const eliteHp = tier ? (cfg.ELITE?.HP?.[tier] ?? 1) : 1;
    const elitePower = tier ? (cfg.ELITE?.POWER?.[tier] ?? 1) : 1;
    let hpKnob = (zone.hp ?? cfg.LEGEND_ZONE?.HP ?? 3) * eliteHp * (eliteTable ? eliteTable[0] : 1) * (tier ? 1 : aura);
    let powerKnob = (zone.power ?? cfg.LEGEND_ZONE?.POWER ?? .5) * elitePower * (eliteTable ? eliteTable[1] : 1) * (tier ? 1 : aura * aura);
    if (tier && data.legends?.elitePower) {
      const bounds = data.legends.elitePowerBounds;
      const adjustment = clamp(data.legends.elitePower[zone.id] ?? 1, bounds[0], bounds[1]);
      hpKnob = inline?.hp ?? (zone.hp ?? cfg.LEGEND_ZONE?.HP ?? 3) * eliteHp;
      powerKnob = inline?.power ?? (zone.power ?? cfg.LEGEND_ZONE?.POWER ?? .5) * elitePower * adjustment;
    }
    const hp = Math.floor(maxHp * (1 + (cfg.ENEMY_HP_PER_ALLY ?? .7) * (cfg.TEAM_SIZE - 1)) * hpKnob);
    const statusRules = cfg.BOSS_STATUS && {
      resist: tier ? (cfg.ELITE?.RESIST?.[tier] ?? 1) : 1,
      tick: Math.max(1, Math.floor(hp / (cfg.ELITE?.HURT?.[tier] ?? cfg.BOSS_STATUS.HURT ?? 60))),
      dotTurns: cfg.BOSS_STATUS.DOT_TURNS ?? 4, paraTurns: cfg.STATUS_FX?.PARA_TURNS ?? 3,
      block: cfg.BOSS_STATUS.PARA_BLOCK ?? .2, setup: cfg.STATUS_MOVE_CHANCE ?? .3,
    };
    const counter = zone.counter ? data.moves[zone.counter] : null;
    const burst = zone.burst ? data.moves[zone.burst] : null;

    const damageTo = target => {
      if (damageCache?.has(target)) return damageCache.get(target) * powerKnob;
      const main = eng.bestDamage(mon, target);
      const lz = cfg.LEGEND_ZONE || {};
      const c = counter ? eng.moveDamage(mon, target, { type: counter.type, cat: counter.cat, power: eng.movePower(zone.counter), acc: counter.acc || 100 }) : main;
      const b = burst ? eng.moveDamage(mon, target, { type: burst.type, cat: burst.cat, power: eng.movePower(zone.burst), acc: burst.acc || 100 }) : main;
      const damage = (cfg.ENEMY_DAMAGE?.static ?? 1) * (main / cfg.TEAM_SIZE + (lz.COUNTER ?? .3) * c / cfg.TEAM_SIZE
        + (lz.BURST ?? 1) * b / (lz.RAGE ?? 8));
      damageCache?.set(target, damage);
      return damage * powerKnob;
    };

    return { zone, mon, types: sp.types, level, maxHp, hp, powerKnob, damageTo, statusRules, data, aura };
  }

  function legendStatusChance(key, boss, pure = false) {
    const effect = boss.data.statusMoves?.[key], rules = boss.statusRules;
    if (!rules || !effect || !['burn', 'poison', 'paralysis'].includes(effect[0]) || !canStatus(boss.mon, effect[0])) return null;
    const move = boss.data.moves[key];
    if (!move || (pure && effRaw(move.type, boss.types) === 0)) return null;
    const chance = pure ? (move.acc || effect[1]) : effect[1];
    return { type: effect[0], chance: clamp(Math.min(chance, statusCap(key)) / 100 * rules.resist, 0, 1) };
  }

  // Static move and status information is shared across every candidate team and simulation.
  function legendTurnStats(team, boss, eng, profiles) {
    return team.map(c => {
      let profile = profiles?.get(c.proj);
      if (!profile) {
        const move = eng.bestMove(c.proj, boss.types);
        const damage = move ? eng.damage(c.proj, boss.mon, move, eng.typeEff(move.type, boss.types)) : 0;
        let setup = null;
        if (boss.statusRules) {
          for (const [level, key] of eng.learnset?.(c.proj) || []) {
            if (level > c.proj.level || (boss.data.moves[key]?.power || 0) > 0) continue;
            const effect = legendStatusChance(key, boss, true);
            if (effect?.chance) setup = effect;
          }
        }
        profile = { move, damage, setup, secondary: legendStatusChance(move?.key, boss) };
        profiles?.set(c.proj, profile);
      }
      return { ...profile, hp: c.hpCur ?? c.hp, incoming: boss.damageTo(c.proj) };
    });
  }

  function expectedLegendRound(team, rules) {
    let direct = 0, noDot = 1, noPara = 1, forgone = 0;
    for (const member of team) {
      const damage = member.damage * (member.move?.acc ?? 0) / 100;
      direct += damage;
      if (!rules) continue;
      const setup = member.setup ? (member.move ? rules.setup : 1) : 0;
      const pure = setup * (member.setup?.chance ?? 0);
      const secondary = (1 - setup) * (member.move?.acc ?? 0) / 100 * (member.secondary?.chance ?? 0);
      noDot *= 1 - (member.setup?.type === 'paralysis' ? 0 : pure) - (member.secondary?.type === 'paralysis' ? 0 : secondary);
      noPara *= 1 - (member.setup?.type === 'paralysis' ? pure : 0) - (member.secondary?.type === 'paralysis' ? secondary : 0);
      forgone += setup * damage;
    }
    if (!rules) return { outgoing: direct, counter: 1 };
    const dot = (1 - noDot) * rules.dotTurns;
    const para = noDot * (1 - noPara) * rules.paraTurns;
    const total = 1 + dot + para;
    return { outgoing: direct - forgone / total + rules.tick * dot / total,
      counter: 1 - rules.block * para / total };
  }

  /** One legendary fight with the game's rolls (used for the win chance). */
  function legendFightOnce(team, boss, eng, stats = legendTurnStats(team, boss, eng), random = Math.random) {
    const members = stats.map(member => ({ ...member }));
    const alive = members.filter(member => member.hp > 0);
    const rules = boss.statusRules;
    let bossHp = boss.hp, rounds = 0;
    let status = null, duration = 0;
    const inflict = effect => {
      if (!effect?.chance || status || random() >= effect.chance) return;
      status = effect.type;
      duration = status === 'paralysis' ? rules.paraTurns : rules.dotTurns;
    };
    while (bossHp > 0 && alive.length && rounds < 400) {
      for (const member of alive) {
        if (!status && member.setup && (!member.move || random() < rules.setup)) {
          inflict(member.setup);
          continue;
        }
        if (!member.move || random() * 100 >= member.move.acc) continue;
        let damage = member.damage / .925 * (.85 + random() * .15);
        if (random() < (boss.data.cfg.CRIT_CHANCE ?? 1 / 24)) damage *= boss.data.cfg.CRIT_MULT ?? 1.5;
        bossHp -= damage;
        if (bossHp <= 0) break;
        inflict(member.secondary);
      }
      rounds++;
      if (bossHp > 0 && (status === 'poison' || status === 'burn')) bossHp -= rules.tick;
      if (bossHp <= 0) break;
      if (status !== 'paralysis' || random() >= rules.block) {
        for (const member of alive) member.hp -= member.incoming / .925 * (.85 + random() * .15);
      }
      for (let i = alive.length - 1; i >= 0; i--) if (alive[i].hp <= 0) alive.splice(i, 1);
      if (status && --duration <= 0) status = null;
    }
    return { win: bossHp <= 0, rounds, remaining: members.map(member => Math.max(0, member.hp)) };
  }

  /** Victory estimate and the conditional capture chance of a normal zone. */
  function* legendOddsSteps(zone, tier, team, eng, data, save, runs = 200) {
    const boss = legendBoss(zone, tier, team, eng, data);
    if (!boss || !team.length) return null;
    const stats = legendTurnStats(team, boss, eng);
    let wins = 0, roundsSum = 0;
    for (let i = 0; i < runs; i++) {
      const r = legendFightOnce(team, boss, eng, stats);
      if (r.win) { wins++; roundsSum += r.rounds; }
      yield;
    }
    const winChance = wins / runs;
    const rounds = wins ? roundsSum / wins : 0;

    const cfg = data.cfg;
    const sp = data.species[zone.id];
    const buffEntry = save?.buffs?.capture;
    const buff = buffEntry && buffEntry.until > Date.now()
      ? (cfg.BUFF_BERRIES?.[buffEntry.key]?.mult ?? 1) : 1;
    const rate = sp
      ? ((sp.legendary || sp.mythical) ? (cfg.LEGENDARY_CAPTURE_RATE ?? 3) : (sp.captureRate ?? 45) * (cfg.CAPTURE_BONUS ?? .6)) / 255
      : 0;
    const pCatch = tier ? null : Math.min((cfg.CAPTURE_MAX ?? .6) * buff, rate * buff);
    return { wins, runs, winChance, rounds: Math.round(rounds * 10) / 10, pCatch };
  }

  function legendOdds(zone, tier, team, eng, data, save, runs = 200) {
    return finishLegendSteps(legendOddsSteps(zone, tier, team, eng, data, save, runs));
  }

  /** One legendary fight: the boss hits the whole team every round. */
  function simulateLegend(team, boss, eng, profiles) {
    const stats = legendTurnStats(team, boss, eng, profiles);
    const alive = stats.filter(member => member.hp > 0).map(member => ({ ...member }));
    let expected = expectedLegendRound(alive, boss.statusRules);
    const initialCounter = expected.counter;
    let bossHp = boss.hp, rounds = 0, dealt = 0;
    while (bossHp > 0 && alive.length && rounds < 400) {
      bossHp -= expected.outgoing;
      dealt += expected.outgoing;
      rounds++;
      if (bossHp <= 0) break;
      for (const member of alive) member.hp -= member.incoming * expected.counter;
      const before = alive.length;
      for (let i = alive.length - 1; i >= 0; i--) if (alive[i].hp <= 0) alive.splice(i, 1);
      if (alive.length !== before) expected = expectedLegendRound(alive, boss.statusRules);
    }
    const teamHp = stats.reduce((sum, member) => sum + member.hp, 0);
    const perRound = stats.length ? stats.reduce((sum, member) => sum + member.incoming, 0) / stats.length * initialCounter : 0;
    return {
      win: bossHp <= 0,
      roundsKill: bossHp <= 0 ? rounds : Infinity,
      roundsDie: perRound > 0 ? teamHp / perRound : 999,
      hpLeft: Math.max(0, bossHp),
      dealt
    };
  }

  function evaluateLegendTeam(team, zone, tier, eng, data, preset = state.preset, damageCache, profiles) {
    const boss = legendBoss(zone, tier, team, eng, data, damageCache);
    if (!boss) return 0;
    const res = simulateLegend(team, boss, eng, profiles);
    const damageFraction = Math.min(1, res.dealt / Math.max(1, boss.hp));
    const survival = res.roundsDie / (res.roundsDie + 30);
    if (!res.win) return damageFraction + (preset === 'defense' ? .6 : .15) * survival;
    if (preset === 'offense') return 2 + 1 / res.roundsKill;
    if (preset === 'defense') return 2 + survival;
    return 2 + res.roundsDie / (res.roundsDie + res.roundsKill);
  }

  /** Greedy team builder for one legendary boss. */
  function* searchLegendSteps(cands, zone, tier, eng, data, preset, size = 6) {
    // rank the candidates by what they actually bring against that boss
    const damageCache = new Map(), profiles = new Map();
    const boss = legendBoss(zone, tier, cands.slice(0, 6), eng, data, damageCache);
    if (!boss) return [];
    const contribution = c => {
      const stats = legendTurnStats([c], boss, eng, profiles);
      const expected = expectedLegendRound(stats, boss.statusRules);
      const incoming = stats[0].incoming * expected.counter;
      return expected.outgoing * Math.min(400, c.hp / Math.max(incoming, 1));
    };
    const ranked = [];
    for (const cand of cands) {
      ranked.push({ cand, score: contribution(cand) });
      yield;
    }
    ranked.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const unique = ranked.map(entry => entry.cand).filter(c => {
      const key = eventSpeciesKey(c, !!tier);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const pool = tier
      ? [...unique.filter(isLegendaryEntry).slice(0, 12), ...unique.filter(c => !isLegendaryEntry(c)).slice(0, 68)]
      : unique.slice(0, 80);
    let chosen = [];
    const score = team => evaluateLegendTeam(team, zone, tier, eng, data, preset, damageCache, profiles);
    while (chosen.length < size) {
      let best = null, bestScore = -Infinity;
      for (const cand of pool) {
        if (!canAddEventMember(chosen, cand, tier, data)) continue;
        const sc = score([...chosen, cand]);
        if (sc > bestScore) { bestScore = sc; best = cand; }
        yield;
      }
      if (!best) break;
      chosen.push(best);
    }
    let bestScore = score(chosen);
    const alternatives = [...unique.slice(0, 24), ...pool.filter(c => tier && !isLegendaryEntry(c)).slice(0, 12)];
    for (let slot = 0; slot < chosen.length; slot++) {
      const others = chosen.filter((_, i) => i !== slot);
      for (const cand of new Set(alternatives)) {
        if (cand === chosen[slot] || !canAddEventMember(others, cand, tier, data)) continue;
        const trial = chosen.slice();
        trial[slot] = cand;
        const sc = score(trial);
        if (sc > bestScore) { chosen = trial; bestScore = sc; }
        yield;
      }
    }
    return chosen;
  }

  // Cache the boss hit and learnset projections during repeat chapter trials.
  let roamingCacheEngine = null;
  const roamingFightProfiles = new Map();
  function simRoamingBoss(mons, spec) {
    const { data, engine } = state, foe = spec.foes[0];
    if (roamingCacheEngine !== engine || roamingFightProfiles.size >= 2048) {
      roamingCacheEngine = engine;
      roamingFightProfiles.clear();
    }
    const boss = legendBoss({ id: foe.id, level: foe.level, roaming: true,
      hp: data.cfg.LEGEND_ZONE?.ROAM_HP ?? 4, power: spec.power }, 0, [], engine, data);
    const living = mons.filter(mon => mon.hp > 0);
    const stats = living.map(mon => {
      const key = JSON.stringify([foe.id, foe.level, mon.id, mon.level, mon.shiny, mon.rank, mon.statMult, mon.status]);
      if (!roamingFightProfiles.has(key)) {
        const proj = { ...mon, types: data.species[mon.id].types };
        roamingFightProfiles.set(key, legendTurnStats([{proj, hp: 0}], boss, engine)[0]);
      }
      return { ...roamingFightProfiles.get(key), hp: mon.hp };
    });
    const result = legendFightOnce([], boss, engine, stats, simRandom);
    living.forEach((mon, i) => { mon.hp = Math.floor(result.remaining[i]); });
    if (result.win && spec.xp) awardXp(foe, living, mons, 'wild', false);
    return { won: result.win, at: spec.index };
  }

  function pickLegendTeam(cands, zone, tier, eng, data, size = 6) {
    return finishLegendSteps(searchLegendSteps(cands, zone, tier, eng, data, state.preset, size));
  }

  function finishLegendSteps(steps) {
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }


  /* ------------------------------------------------------------------ *
   * 7. Wipe watcher: remembers on which step the team falls
   * ------------------------------------------------------------------ */
  class WipeWatcher {
    constructor(onChange) {
      this.onChange = onChange;
      this.fails = store.get('fails', []) || [];
      this.running = false;
      this.timer = null;
      this.lastBattle = null;    // last battle seen (the fight can end before we poll)
      this.firstKo = null;       // step where the first team member fell
      this.lastDeaths = null;    // the game's own death counter (adv.deaths)
      this.lastTries = null;     // league/elite attempt counters (adv.league.tries, adv.zone.tries)
      this.prevState = null;     // chapter/step before the last change
    }
    start() {
      if (this.running) return;
      this.running = true;
      this.timer = setInterval(() => {
        try { this.poll(); } catch (e) { logError('watcher: poll', e); }
      }, 700);
      this.firstKo = null;
      this.lastDeaths = null;
      this.lastTries = null;
      this.prevState = null;
      log('info', 'watcher: started');
      try { this.poll(); } catch (e) { logError('watcher: poll', e); }
    }
    stop() {
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      log('info', 'watcher: stopped');
    }
    poll() {
      const save = readSave();
      if (!save || !save.adv) return;
      const adv = save.adv;
      const nodeIdx = adv.node;
      const battle = adv.battle;
      if (battle) {
        this.lastBattle = {
          kind: battle.kind,
          chapter: adv.chapter,
          team: (save.road?.length ? save.road : save.team || []).map(uid => monByUid(save, uid)).filter(Boolean).map(m => ({uid:m.uid,id:m.id,level:m.level})),
          node: nodeIdx,
          enemies: (battle.enemies || []).map(e => ({ id: e.id, level: e.level }))
        };
      }
      const team = (save.road?.length ? save.road : adv.team || save.team || []).map(u => monByUid(save, u)).filter(Boolean);
      const ko = team.filter(m => m.hp != null && m.hp <= 0);
      if (ko.length && !this.firstKo) {
        this.firstKo = { node: nodeIdx, at: Date.now(), name: (adv.nodes || [])[nodeIdx]?.name || '?' };
      }
      if (!ko.length) this.firstKo = null;

      // The game heals the team the instant it is wiped, so the "all knocked out" state
      // never lasts. The game now counts a wipe differently per mode (bundle 2026-11):
      //   adventure/league chapter: adv.deaths[chapter]++
      //   league run:               adv.league.tries++
      //   elite legend zone:        adv.zone.tries++
      const deaths = adv.deaths || {};
      const prev = this.lastDeaths;
      this.lastDeaths = { ...deaths };
      let died = null, diedCount = 0, why = 'chapter';
      if (prev) {
        for (const [ch, n] of Object.entries(deaths)) {
          const d = n - (prev[ch] || 0);
          if (d > 0) { died = Number(ch); diedCount = d; }
        }
      }
      const tries = {
        league: adv.league ? { reg: adv.league.reg, tier: adv.league.tier, n: adv.league.tries || 0 } : null,
        zone: adv.zone?.elite && adv.zone.id != null
          ? { id: adv.zone.id, tier: adv.zone.elite, n: adv.zone.tries || 0 } : null,
      };
      const prevTries = this.lastTries;
      this.lastTries = tries;
      if (!died && prevTries) {
        const L = tries.league, pL = prevTries.league;
        const Z = tries.zone, pZ = prevTries.zone;
        if (L && pL && L.reg === pL.reg && L.tier === pL.tier && L.n > pL.n) {
          died = adv.chapter; diedCount = L.n - pL.n; why = 'league';
        } else if (Z && pZ && Z.id === pZ.id && Z.tier === pZ.tier && Z.n > pZ.n) {
          died = adv.chapter; diedCount = Z.n - pZ.n; why = 'elite zone';
        }
      }
      const state = { chapter: adv.chapter, node: nodeIdx, name: (adv.nodes || [])[nodeIdx]?.name || '?' };
      if (!died) {
        this.prevState = state;
        return;
      }
      // report the step the team fell on (the last poll before the wipe)
      const before = this.prevState || state;
      const node = (adv.nodes || [])[before.node] || {};
      const b = this.lastBattle?.chapter === before.chapter ? this.lastBattle : {};
      const rec = {
        at: Date.now(),
        chapter: before.chapter,
        node: before.node,
        name: node.name || before.name || '?',
        kind: node.type || b.kind || '?',
        why,
        lv: node.lv || null,
        enemies: b.enemies || [],
        firstKo: this.firstKo,
        team: b.team || team.map(m => ({ uid: m.uid, id: m.id, level: m.level }))
      };
      // more than one wipe can slip through between two polls (background tab)
      for (let i = 0; i < Math.min(diedCount, 5); i++) this.fails.unshift(i === 0 ? rec : { ...rec, at: rec.at - i * 1000 });
      this.fails = this.fails.slice(0, 25);
      store.set('fails', this.fails);
      log('warn', 'watcher: team wipe', {
        why, chapter: rec.chapter, step: rec.name, kind: rec.kind, count: diedCount,
        enemies: rec.enemies.slice(0, 3),
      });
      this.firstKo = null;
      this.onChange && this.onChange(rec);
    }
    clear() {
      this.fails = [];
      this.wiped = false;
      this.firstKo = null;
      store.set('fails', []);
      log('info', 'watcher: wipes cleared');
      this.onChange && this.onChange(null);
    }
  }

  /* ------------------------------------------------------------------ *
   * 8. Team editing (drag & drop, the way the game does it)
   * ------------------------------------------------------------------ */
  /** Open the Team/PC screen (resuming the game first, and waiting out a running battle). */
  async function gotoTeamScreen(tries = 60) {
    const ready = () => !!document.querySelector('#screen-team.active') && document.querySelectorAll('#team-slots .slot').length > 0;
    log('debug', 'team screen: opening');
    for (let i = 0; i < tries; i++) {
      if (ready()) { state.waiting = null; return true; }
      const cont = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'CONTINUE');
      if (cont) { log('debug', 'team screen: resuming the game'); cont.click(); await sleep(500); continue; }
      // the game refuses to switch screens while a battle runs: wait for it to end
      const save = readSave();
      // Native Team/PC edits the planned team; the road team stays in the ongoing battle.
      const nav = document.querySelector('#side [data-screen="team"]');
      const btn = nav || [...document.querySelectorAll('button')].find(b => b.textContent.trim().toLowerCase() === 'team/pc');
      if (btn) { btn.click(); await sleep(600); }
      else await sleep(300);
    }
    state.waiting = null;
    const ok = ready();
    log(ok ? 'debug' : 'warn', 'team screen: ' + (ok ? 'open' : 'not reachable'));
    return ok;
  }

  const pcCellFor = uid => document.querySelector(`#pc-grid .pc-cell[data-uid="${uid}"]`);

  /** The PC grid is virtualised: search for the mon when it is not rendered. */
  async function findPcCell(uid,save){
    const mon=monByUid(save,uid),input=document.querySelector('#pc-search');if(!mon||!input)return null;
    // Searching alone does not mount an offscreen row in the game's virtual grid.
    input.value=String(mon.id);input.dispatchEvent(new Event('input',{bubbles:true}));
    input.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    for(let i=0;i<12;i++){
      if(placementJob?.active&&placementJob.cancelled)return null;
      const cell=pcCellFor(uid);if(cell?.isConnected&&cell.getBoundingClientRect().height){cell.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});await sleep(70);return pcCellFor(uid);}
      if(i===3)document.querySelector('#pc-grid')?.scrollIntoView({block:'start',inline:'nearest',behavior:'instant'});
      await sleep(80);
    }return null;
  }


  async function clearPcSearch() {
    const input = document.querySelector('#pc-search');
    if (!input || !input.value) return;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(350);
  }

  function dragToSlot(cell, slot) {
    const cb = cell.getBoundingClientRect(), sb = slot.getBoundingClientRect();
    const cx = cb.left + cb.width / 2, cy = cb.top + cb.height / 2;
    const tx = sb.left + sb.width / 2, ty = sb.top + sb.height / 2;
    const fire = (type, x, y, target) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true
    }));
    fire('pointerdown', cx, cy, cell);
    fire('pointermove', cx + 24, cy + 12, cell);
    fire('pointermove', tx, ty, document.body);
    fire('pointerup', tx, ty, document.body);
  }

  let placementJob=null,placementSequence=0;
  function placementProgress(job,step,name){
    job.step=step;job.name=name;
    const root=document.querySelector('#pcopt-placement');if(!root)return;
    root.querySelector('[data-place-title]').textContent=job.cancelled?'正在停止…':job.mode==='templates'?`正在保存第 ${(job.segment||0)+1} / ${job.segmentsTotal} 个模板`:`正在安排第 ${step} / ${job.total} 只`;
    root.querySelector('[data-place-status]').textContent=job.cancelled?'等待当前这一步结束后停止，不再安排后续成员。':`${name} · 已核对 ${job.verified} / ${job.total} 个位置`;
    root.querySelector('[data-place-bar]').style.width=(job.verified/job.total*100)+'%';
    state.waiting=job.cancelled?'正在停止自动安排…':`正在安排 ${step}/${job.total}：${name}`;
  }
  function cancelPlacement(reason='你已取消自动安排。'){
    const job=placementJob;if(!job?.active||job.cancelled)return;job.cancelled=true;job.cancelReason=reason;
    const button=document.querySelector('#pcopt-placement [data-place-cancel]');if(button){button.disabled=true;button.textContent='正在停止…';}
    placementProgress(job,job.step||1,job.name||'');
  }
  function startPlacement(total,visible=true){
    if(visible)document.querySelector('#pcopt-placement')?.remove();
    const job={id:++placementSequence,active:true,cancelled:false,total,verified:0,step:1,started:Date.now(),pointer:null};placementJob=job;
    job.onVisibility=()=>{if(document.hidden)cancelPlacement('页面离开前台，已停止自动安排。');};document.addEventListener('visibilitychange',job.onVisibility);
    if(!visible)return job;
    const root=document.createElement('div');root.id='pcopt-placement';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-labelledby','pcopt-placement-title');
    root.className='pcopt-help-cover pcopt-dialog pcopt-placement-cover';
    root.innerHTML=`<section class="pcopt-help-sheet modal pcopt-placement-sheet"><div class="pcopt-help-head"><b id="pcopt-placement-title" data-place-title>正在准备安排队伍</b></div><div class="pcopt-help-text"><p data-place-status role="status" aria-live="polite">正在打开队伍和盒子…</p><div class="pcopt-place-track"><div data-place-bar></div></div><p data-place-help class="pcopt-mut">完成前请暂勿操作游戏页面。冒险仍会继续；这里只调整安排队伍，到回复时才换成出战队伍。</p></div><div data-place-actions class="pcopt-place-actions"><button class="btn small ghost" data-place-cancel>取消安排</button></div></section>`;
    root.addEventListener('touchmove',e=>{if(!e.target.closest('.pcopt-help-text'))e.preventDefault()},{passive:false});root.addEventListener('wheel',e=>{if(!e.target.closest('.pcopt-help-text'))e.preventDefault()},{passive:false});
    root.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();if(job.active)cancelPlacement();else root.remove();}if(e.key==='Tab'){const buttons=[...root.querySelectorAll('button:not(:disabled)')];if(buttons.length===1){e.preventDefault();buttons[0].focus();}}});
    root.querySelector('[data-place-cancel]').onclick=()=>cancelPlacement();document.body.appendChild(root);root.querySelector('button').focus();
    return job;
  }
  function finishPlacement(result){
    const job=placementJob;if(!job)return;job.active=false;document.removeEventListener('visibilitychange',job.onVisibility);
    const root=document.querySelector('#pcopt-placement');if(!root)return;
    root.querySelector('[data-place-title]').textContent=result.ok?(result.templates?'分段模板已保存':'安排完成'):result.cancelled?'已停止自动安排':'安排未完成';
    root.querySelector('[data-place-status]').textContent=result.ok?`已核对全部 ${job.total} 个位置。`:result.error;
    const canRetry=!result.templates&&!result.ok&&!recommendationStale(readSave());
    const road=readSave()?.road,activeMatches=Array.isArray(road)&&road.length===job.desired?.length&&job.desired.every((uid,i)=>road[i]===uid);
    root.querySelector('[data-place-help]').textContent=result.ok?(activeMatches?'安排队伍与当前出战队伍已经一致。':Array.isArray(road)?'安排已保存，但当前出战队伍尚未全部换成推荐成员。游戏通常到下一个宝可梦中心回复时才采纳新安排。':'安排已保存。请以游戏实际出战队伍为准，通常到下一个宝可梦中心回复时才换人。'):`当前有 ${result.verified??job.verified} / ${job.total} 个位置符合推荐。已完成的调整会保留；${canRetry?'可以重试未完成的位置，也可关闭后检查。':'游戏状态已变化，请关闭提示后重新分析。'}`;
    root.querySelector('[data-place-bar]').style.width=((result.verified??job.verified)/job.total*100)+'%';
    if(result.templates){root.querySelector('[data-place-status]').textContent=result.ok?`全部 ${result.total} 段游戏模板已核对，原安排模板已恢复。`:`${result.error||'保存未完成'} 已核对 ${result.saved??0}/${result.total??0} 段。`;root.querySelector('[data-place-help]').textContent=result.ok?'可返回分段方案开启自动提前安排。模板保存不会保证当前出战队伍已改变，请以游戏实际出战为准。':'已经核对成功的分段模板会保留。返回分段方案可再次保存剩余模板；开启自动前需要全部核对。';}
    const actions=root.querySelector('[data-place-actions]');actions.innerHTML='';
    if(canRetry){const retry=document.createElement('button');retry.textContent='重试未完成位置';retry.className='btn small';retry.style.cssText='min-height:44px;flex:1';retry.onclick=()=>{root.remove();applyTeamFromPanel()};actions.appendChild(retry);}
    const close=document.createElement('button');close.textContent=result.ok?'知道了，返回游戏':'关闭提示';close.className='btn small ghost';close.style.cssText='min-height:44px;flex:1';close.onclick=()=>root.remove();actions.appendChild(close);close.focus();
  }
  function plannedSlots(){
    // Match the native le(): the floating mini team is the real drop target while the PC is visible.
    const mini=document.querySelector('#team-mini');return [...(mini?.classList.contains('show')?mini:document.querySelector('#team-slots'))?.querySelectorAll('.slot')||[]];
  }
  async function dragPlannedMember(uid,index){
    const job=placementJob,save=readSave(),from=(save?.team||[]).indexOf(uid);let cell;
    if(from<0){cell=await findPcCell(uid,save);if(!cell)return{ok:false,error:job.cancelled?'已请求停止。':'盒子当前没有显示该成员。请关闭提示并检查盒子的属性、地区等筛选。'};}
    else{let slots=plannedSlots();cell=slots[from];if(!cell)return{ok:false,error:'没有找到当前队伍成员。'};if(!document.querySelector('#team-mini.show')){document.querySelector('#team-slots').scrollIntoView({block:'center',behavior:'instant'});await sleep(80);cell=plannedSlots()[from];}}
    if(job.cancelled)return{ok:false,error:'已请求停止。'};
    const stop=job.guard?.();if(stop){cancelPlacement(stop);return{ok:false,error:stop}}
    let target=plannedSlots()[index];if(!cell?.isConnected||!target?.isConnected)return{ok:false,error:'队伍或盒子列表刚刚重绘，请重试。'};
    const cb=cell.getBoundingClientRect();if(!cb.width||!cb.height)return{ok:false,error:'盒子卡片尚未显示，请重试。'};
    const cx=cb.left+cb.width/2,cy=cb.top+cb.height/2,pointerId=17400+job.id;let down=false,released=false,last={x:cx,y:cy};
    const fire=(type,x,y,node=document.body)=>{last={x,y};node.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId,pointerType:'mouse',button:0,buttons:type==='pointerup'||type==='pointercancel'?0:1,isPrimary:true}));};
    const toasts=new Set([...document.querySelectorAll('#toasts .toast')]);
    try{
      down=true;fire('pointerdown',cx,cy,cell);fire('pointermove',cx+12,cy+9,cell);await sleep(30);
      if(!document.body.classList.contains('mon-sorting'))return{ok:false,error:'游戏的拖动没有启动，页面可能还未就绪。'};
      // The first move pins a virtual PC row. Never scroll it away before native drag begins.
      target=plannedSlots()[index];if(!target?.isConnected)return{ok:false,error:'队伍位置已重绘，请重试。'};
      const rect=target.getBoundingClientRect(),drop={x:rect.left+rect.width/2,y:rect.top+rect.height/2};fire('pointermove',drop.x,drop.y);await sleep(25);
      // Native team sorting moves the hovered card to the source slot. Keep the original
      // destination coordinates rather than following that card back and undoing the swap.
      if(!target.isConnected)return{ok:false,error:'队伍位置已重绘，请重试。'};
      const stop=job.guard?.();if(stop){cancelPlacement(stop);return{ok:false,error:stop}}
      fire('pointermove',drop.x,drop.y);fire('pointerup',drop.x,drop.y);released=true;
      for(let n=0;n<15;n++){if(readSave()?.team?.[index]===uid)return{ok:true};await sleep(80);}
      const refusal=[...document.querySelectorAll('#toasts .toast')].filter(t=>!toasts.has(t)).map(t=>t.textContent.trim()).join('；');
      return{ok:false,error:refusal?'游戏提示：'+refusal:'拖动已结束，但游戏没有确认放入该位置。'};
    }catch(error){logError('apply: native drag',error);return{ok:false,error:'换队操作中断：'+error.message};}
    finally{if(down&&!released){try{fire('pointermove',cx,cy);fire('pointerup',cx,cy)}catch{}}job.pointer=null;}
  }
  async function applyTeam(team,options={}){
    const desired=team.slice(0,6).map(c=>c.mon.uid),owner=!options.job,job=options.job||startPlacement(desired.length,options.dialog!==false),oldSearch=document.querySelector('#pc-search')?.value||'';
    if(owner)job.desired=desired;
    const verified=()=>desired.filter((uid,i)=>readSave()?.team?.[i]===uid).length;let done=0,same=0;
    try{
      if(!await gotoTeamScreen())return{ok:false,done,same,verified:verified(),error:'无法打开队伍页面，请关闭其他游戏弹窗后重试。'};
      for(let i=0;i<desired.length;i++){
        const stop=job.guard?.();if(stop)cancelPlacement(stop);
        if(job.cancelled)return{ok:false,cancelled:true,done,same,verified:verified(),error:job.cancelReason};
        const uid=desired[i],save=readSave(),mon=save&&monByUid(save,uid);if(!mon||!canJoinTeam(save,mon)||awayUids(save).has(uid))return{ok:false,done,same,verified:verified(),error:'推荐成员已不在当前可用盒子中，请重新分析。'};
        placementProgress(job,(job.offset||0)+i+1,displayName(mon.id));
        if(save.team?.[i]===uid){same++;job.verified=(job.offset||0)+verified();continue;}
        const move=await dragPlannedMember(uid,i);
        if(readSave()?.team?.[i]===uid){done++;job.verified=(job.offset||0)+verified();}
        else if(job.cancelled)return{ok:false,cancelled:true,done,same,verified:verified(),error:job.cancelReason};
        else return{ok:false,done,same,verified:verified(),error:`第 ${i+1} 个位置（${displayName(mon.id)}）未完成：${move.error||'游戏未确认。'}`};
        if(desired.slice(0,i+1).some((u,j)=>readSave()?.team?.[j]!==u))return{ok:false,done,same,verified:verified(),error:'游戏同时调整了其他成员，前面的安排已变化。请关闭提示核对阵容限制后重新分析。'};
      }
      const ok=readSave()?.team?.length===desired.length&&verified()===desired.length;
      return{ok,done,same,verified:verified(),error:ok?'':'当前队伍人数或顺序与推荐不同，请关闭提示检查。'};
    }finally{
      const input=document.querySelector('#pc-search');if(input&&input.value!==oldSearch){input.value=oldSearch;input.dispatchEvent(new Event('input',{bubbles:true}));}
      if(owner){job.active=false;document.removeEventListener('visibilitychange',job.onVisibility);state.waiting=null;}
    }
  }


  /* ------------------------------------------------------------------ *
   * 8b. PokéAPI (pokeapi.co) cross-check and the game's moves panel
   * ------------------------------------------------------------------ */
  async function pokeApiSpecies(name) {
    const key = 'api:' + name;
    if (state.apiCache[key]) return state.apiCache[key];
    const cached = store.get(key, null);
    if (cached) { state.apiCache[key] = cached; return cached; }
    const data = await httpGetJson('https://pokeapi.co/api/v2/pokemon/' + encodeURIComponent(name));
    const out = {
      types: (data.types || []).map(t => t.type.name),
      stats: {
        hp: data.stats?.[0]?.base_stat, atk: data.stats?.[1]?.base_stat, def: data.stats?.[2]?.base_stat,
        spa: data.stats?.[3]?.base_stat, spd: data.stats?.[4]?.base_stat, spe: data.stats?.[5]?.base_stat
      },
      learn: (data.moves || [])
        .filter(m => m.move && m.move.name)
        .map(m => {
          const vg = (m.version_group_details || []).find(v => v.move_learn_method?.name === 'level-up')
            || (m.version_group_details || [])[0];
          return { key: m.move.name, level: vg?.level_learned_at ?? 0 };
        })
    };
    store.set(key, out);
    state.apiCache[key] = out;
    return out;
  }

  /** Open the game's own moves panel for a Pokémon (the authoritative learnset). */
  async function showMovesPanel(uid) {
    if (!await gotoTeamScreen()) return false;
    document.querySelector('.mvd-root .dc-x')?.click();
    document.querySelector('.modal-root .dc-x')?.click();
    await sleep(250);
    let cell = await findPcCell(uid, readSave() || { mons: [] });
    if (!cell) {
      await clearPcSearch();
      // already in the team: open its slot instead
      cell = document.querySelector(`#team-slots .slot[data-uid="${uid}"]`);
    }
    if (!cell) return false;
    cell.click();
    await sleep(600);
    const mv = document.querySelector('.modal-root .dc-move');
    if (mv) mv.click();
    await sleep(500);
    await clearPcSearch();
    return !!mv;
  }

  /* ------------------------------------------------------------------ *
   * 8b. Shiny raids: boss, DPS scores, fastest clear
   * ------------------------------------------------------------------ */
  /** The raid boss of the picker header ("Raid vs X" / FR "Raid contre X"). */

  function pickerName(txt) {
    const lang = window.LANG_PICK?.lang || document.documentElement.lang;
    const template = (window.I18N || {})[lang]?.['{label} contre {name}'];
    if (template?.includes('{name}')) {
      const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = template.split(/(\{label\}|\{name\})/).map(s => s === '{label}' ? '.*?' : s === '{name}' ? '(.+?)' : escapeRe(s)).join('');
      const m = txt.match(new RegExp('^' + pattern + '$', 'i'));
      if (m) return m[1].trim();
    }
    const m = txt.match(/\b(?:contre|vs\.?)\s+(.+)$/i) || txt.match(/(?:对战|对抗|挑战|迎战|對戰|對抗|挑戰|对|對)\s*(.+)$/);
    return m ? m[1].trim() : null;
  }

  function headerBossId(headEl) {
    for (const img of headEl.querySelectorAll('img[data-id]')) {
      if (img.closest?.('[data-pcopt]')) continue;
      const id = Number(img.dataset.id);
      if (Number.isInteger(id) && id > 0 && (state.data?.species?.[id] || state.legends?.zones?.some(z => z.id === id))) return id;
    }
    const name = pickerName(headEl.querySelector('h2')?.textContent.replace(/\s+/g, ' ').trim() || '');
    return name ? speciesIdByName(name) : null;
  }

  function raidContext() {
    const headEl = document.querySelector('#evt-pick-head');
    const head = headEl?.querySelector('h2');
    if (!head || !state.data?.cfg?.RAID) return null;
    const txt = head.textContent.replace(/\s+/g, ' ').trim();
    if (!/raid|团体战|團體戰/i.test(txt)) return null;
    const id = headerBossId(headEl);
    if (!id || !state.data.species[id]) return null;
    return { id, name: displayName(id) };
  }

  /** The boss as a sim mon: level 100, shiny, with the raid HP/power knobs. */
  function raidBoss(rc) {
    const cfg = state.data.cfg;
    const raid = cfg.RAID || {};
    const boss = raid.BOSS || { HP: 3.3, POWER: .7, BST_REF: 500, HP_EXP: 1.8, POWER_EXP: 1 };
    const sp = state.data.species[rc.id];
    const mon = { id: rc.id, level: raid.LEVEL ?? 100, shiny: true, types: sp.types };
    const bst = Object.values(sp.stats).reduce((a, b) => a + b, 0);
    const scale = boss.BST_REF / bst;
    const adj = boss.ADJ?.[rc.id] ?? 1;
    const hpPower = (raid.hpPower ?? boss.HP) * Math.pow(scale, boss.HP_EXP) * adj;
    const dmgMult = (raid.power ?? boss.POWER) * Math.pow(scale, boss.POWER_EXP) * adj;
    return { mon, hpPower, dmgMult, maxHp: Math.floor(state.engine.maxHp(mon) * (1 + (cfg.ENEMY_HP_PER_ALLY ?? .7) * ((cfg.RAID?.MINE ?? 2) * (1 + (cfg.RAID?.ALLIES ?? 2)) - 1)) * hpPower) };
  }
  /** Damage per round a mon puts into the raid boss (expected, accuracy-weighted). */
  function raidDps(mon, boss) {
    const mv = state.engine.bestMove(mon, boss.mon.types);
    if (!mv) return 0;
    const eff = effRaw(mv.type, boss.mon.types);
    const dmg = state.engine.damage(mon, boss.mon, mv, eff);
    const acc = state.engine.moveAcc(mv.key);
    const out = dmg * (acc / 100);
    if (!Number.isFinite(out)) log('warn', 'raid: dps NaN', { id: mon.id, level: mon.level, mv: mv.key, dmg, acc, eff, hasChart: !!state.chart, hasEngine: !!state.engine });
    return out;
  }
  // Raid allies are ranked for this boss, using each trainer's whole offered pair.
  function raidAllyMon(mon) {
    const cap = state.data.cfg.RAID?.LEVEL ?? 100;
    const rank = clamp(Math.floor(Number(mon.rank) || 0), 0, 5);
    const mult = Number(mon.statMult);
    return {...mon, level:clamp(Number(mon.level) || 1, 1, cap),
      rank, statMult:(Number.isFinite(mult) && mult > 0 ? mult : 1)};
  }

  function readRaidPickKeys(region) {
    const picks = readSave()?.raids?.pick?.[region];
    return Array.from({length:state.data?.cfg?.RAID?.ALLIES ?? 2}, (_, i) => picks?.[i] ?? null);
  }

  function raidCardContext(card) {
    if (!card?.isConnected || !card.dataset.rc || card.classList.contains('done') || card.classList.contains('lock')) return null;
    const image = card.querySelector('.boss img');
    const asset = image?.getAttribute('src') || '';
    const assetId = asset.match(/\/(\d+)(?:-[a-z]+)?\.(?:png|gif|webp)(?:[?#]|$)/i)?.[1];
    const id = Number(image?.dataset.id || assetId) || speciesIdByName(card.querySelector('h3')?.textContent?.trim() || '');
    if (!state.data?.species?.[id]) return null;
    const region = card.dataset.rc;
    const count = card.querySelectorAll('[data-raid-slot]').length;
    return {region, id, count, running:card.classList.contains('run')};
  }

  const raidCardFor = region => [...document.querySelectorAll('#screen-raid .rc-card[data-rc]')].find(card => card.dataset.rc === region);
  function assertRaidContext(ctx) {
    const now = raidCardContext(raidCardFor(ctx.region));
    if (!now || now.id !== ctx.id) throw new Error('团体战首领或页面已变化，请重新选择。');
    if (now.running || !now.count) throw new Error('当前正在团体战中，请退出战斗后再选择同伴。');
    return now;
  }

  function readRaidAllyCandidate(row, ctx, boss) {
    const key = row.dataset.pick;
    if (!key || row.disabled) return null;
    const raw = (readSave()?.raids?.bots?.[ctx?.region] || []).find(candidate => candidate.key === key);
    const cap = state.data.cfg.RAID?.LEVEL ?? 100;
    const mons = [...row.querySelectorAll('.rt-mon')].map((node, i) => {
      const id = Number(node.querySelector('img[data-id]')?.dataset.id);
      if (!state.data.species[id]) return null;
      if (raw?.mons?.[i]?.id === id) return raidAllyMon(raw.mons[i]);
      const levelNode = node.querySelector('.rt-lv');
      if (!levelNode) return null;
      const copy = levelNode.cloneNode(true);
      copy.querySelectorAll('s,del').forEach(old => old.remove());
      const numbers = copy.textContent.match(/\d+/g);
      if (!numbers?.length) return null;
      const rankText = node.querySelector('.rk-n')?.textContent?.trim() || '';
      const rank = ['', 'I', 'II', 'III', 'IV', 'V'].indexOf(rankText);
      return raidAllyMon({id, level:Math.min(cap, Number(numbers[numbers.length - 1])),
        shiny:!!node.querySelector('.shiny-mk,.shiny-ico') || /shiny/i.test(node.querySelector('img[data-id]')?.getAttribute('src') || ''),
        rank:Math.max(0, rank), statMult:key.startsWith('bot') ? state.data.cfg.RAID.BOT_STATS ?? 1 : 1});
    });
    if (!mons.length || mons.some(mon => !mon)) return null;
    const profiles = mons.map(mon => raidCombatProfile(mon, boss));
    const dps = profiles.reduce((sum, profile) => sum + profile.dps, 0);
    if (!Number.isFinite(dps)) return null;
    return {key, name:row.querySelector('.nm b,.nm')?.textContent.trim() || key, mons, dps, profiles};
  }

  function chooseRaidAllyPair(candidates, current, count, boss) {
    const unique = new Map();
    for (const candidate of candidates) if (candidate?.key && Number.isFinite(candidate.dps)) unique.set(candidate.key, candidate);
    const raw = [...unique.values()].sort((a, b) => b.dps - a.dps);
    const referenceDps = raw.slice(0, count).reduce((sum, candidate) => sum + candidate.dps, 0);
    const horizon = boss ? Math.min(400, Math.max(1, Math.ceil(boss.maxHp / Math.max(1, referenceDps)))) : 1;
    const value = candidate => boss && candidate.profiles ? raidContribution(candidate.profiles, horizon) : candidate.dps * horizon;
    const best = raw.sort((a, b) => value(b) - value(a) || b.dps - a.dps
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, count);
    if (best.length < count) throw new Error(`可读取的同伴不足 ${count} 位，请检查候选列表后重试。`);
    // Retain winners already in a slot: the game excludes an ally selected in the other slot.
    const chosen = new Set(best.map(candidate => candidate.key));
    const retained = new Set();
    const assigned = current.slice(0, count).map(key => chosen.has(key) && !retained.has(key) ? (retained.add(key), key) : null);
    while (assigned.length < count) assigned.push(null);
    const remaining = best.filter(candidate => !assigned.includes(candidate.key));
    for (let i = 0; i < count; i++) if (!assigned[i]) assigned[i] = remaining.shift().key;
    return {best, assigned, dps:best.reduce((sum, candidate) => sum + candidate.dps, 0)};
  }

  function annotateRaidSuggestions() {
    const boss = state.raidAllyBoss || state.raidPreviewBoss || state.raidBoss;
    if (!boss) return;
    const ctx = state.raidAllyContext || state.raidPreviewContext || {region:''};
    // Keep the original damage badges on the game's community species suggestions.
    document.querySelectorAll('#evt-pick .rp-pk').forEach(card => {
      const id = Number(card.querySelector('img[data-id]')?.dataset.id);
      if (!state.data.species[id]) return;
      const mine = (readSave()?.mons || []).filter(mon => mon.id === id);
      const dps = mine.length ? Math.max(...mine.map(mon => raidDps(raidAllyMon(mon), boss)))
        : raidDps({id, level:state.data.cfg.RAID?.LEVEL ?? 100, shiny:false}, boss);
      const signature = boss.mon.id + ':' + dps;
      if (card.dataset.pcoptScore === signature) return;
      let tag = card.querySelector('.pcopt-atk');
      if (!tag) { tag = document.createElement('span'); tag.className = 'pcopt-atk'; card.prepend(tag); }
      tag.textContent = '伤害 ' + Math.round(dps);
      tag.style.cssText = 'position:absolute;left:3px;top:3px;font-size:10px;padding:1px 5px;border-radius:4px;background:var(--panel);color:var(--text);z-index:2';
      card.style.position = 'relative'; card.dataset.pcoptScore = signature;
    });
    document.querySelectorAll('.modal-root.open .raid-pick[data-pick]').forEach(row => {
      const candidate = readRaidAllyCandidate(row, ctx, boss);
      if (!candidate) return;
      const signature = boss.mon.id + ':' + candidate.dps;
      if (row.dataset.pcoptScore === signature) return;
      let tag = row.querySelector('.pcopt-atk');
      const host = row.querySelector('.raid-ally .nm') || row.querySelector('.raid-ally') || row.querySelector('.nm');
      if (!host) return;
      if (!tag) { tag = document.createElement('span'); tag.className = 'pcopt-atk'; }
      if (tag.parentElement !== host) host.appendChild(tag);
      row.classList.add('pcopt-scored-ally');
      tag.textContent = '预计伤害 ' + Math.round(candidate.dps) + '/回合';
      tag.style.cssText = 'display:block;grid-column:1/-1;font-size:12px;line-height:1.4;padding:2px 0;color:var(--muted);white-space:normal';
      row.dataset.pcoptScore = signature;
    });
  }

  async function waitRaidUi(check, message, attempts = 30) {
    for (let i = 0; i < attempts; i++) { const value = check(); if (value) return value; await sleep(100); }
    throw new Error(message);
  }

  async function closeRaidChooser(modal) {
    if (!modal?.isConnected || !modal.classList.contains('open')) return;
    const close = modal.querySelector('.dc-x');
    if (!close) throw new Error('未找到同伴窗口的关闭按钮，请手动关闭后重试。');
    close.click();
    await waitRaidUi(() => !modal.isConnected || !modal.classList.contains('open'), '同伴窗口未能关闭，请重试。');
  }

  async function openRaidChooser(ctx, slot) {
    assertRaidContext(ctx);
    if (document.querySelector('.modal-root.open')) throw new Error('请先关闭当前弹窗，再选择同伴。');
    const button = [...raidCardFor(ctx.region).querySelectorAll('[data-raid-slot]')].find(el => el.dataset.raidSlot === ctx.region + '|' + slot);
    if (!button || button.disabled) throw new Error('当前同伴位置不可编辑，请退出战斗后重试。');
    button.click();
    return waitRaidUi(() => [...document.querySelectorAll('.modal-root.open')].find(root => root.querySelector('.raid-scroll')), '未能打开同伴列表，请重试。');
  }

  async function closeRaidEventPicker(ctx) {
    const picker = document.querySelector('#evt-pick.open');
    if (!picker) return;
    const rc = raidContext();
    if (rc?.id !== ctx.id) throw new Error('请先关闭其他选队窗口。');
    const close = picker.querySelector('[data-evt-close]');
    if (!close) throw new Error('请先关闭己方选队窗口，再选择同伴。');
    close.click();
    await waitRaidUi(() => !picker.isConnected || !picker.classList.contains('open'), '己方选队窗口尚未关闭，请重试。');
  }

  async function optimizeRaidAllies(ctx) {
    const active = assertRaidContext(ctx), count = state.data.cfg.RAID?.ALLIES ?? 2;
    if (active.count !== count) throw new Error('同伴位置数量与游戏配置不一致，请刷新游戏。');
    await closeRaidEventPicker(ctx);
    const boss = raidBoss({id:ctx.id}), candidates = new Map(), original = readRaidPickKeys(ctx.region);
    state.raidAllyContext = ctx; state.raidAllyBoss = boss;
    let ownedModal = null;
    try {
      // Read every slot without making a choice. The union restores candidates hidden by the other selected ally.
      for (let slot = 0; slot < count; slot++) {
        ownedModal = await openRaidChooser(ctx, slot);
        annotateRaidSuggestions();
        for (const row of ownedModal.querySelectorAll('.raid-pick[data-pick]')) {
          const candidate = readRaidAllyCandidate(row, ctx, boss);
          if (!candidate) throw new Error('部分同伴资料无法读取，尚未应用推荐，请刷新后重试。');
          candidates.set(candidate.key, candidate);
        }
        await closeRaidChooser(ownedModal); ownedModal = null;
      }
      if (JSON.stringify(original) !== JSON.stringify(readRaidPickKeys(ctx.region))) throw new Error('选择期间同伴发生变化，请重新点击。');
      const plan = chooseRaidAllyPair([...candidates.values()], original, count, boss);
      for (let slot = 0; slot < count; slot++) {
        assertRaidContext(ctx);
        const key = plan.assigned[slot];
        if (readRaidPickKeys(ctx.region)[slot] === key) continue;
        ownedModal = await openRaidChooser(ctx, slot);
        const row = [...ownedModal.querySelectorAll('.raid-pick[data-pick]')].find(el => el.dataset.pick === key);
        const current = row && readRaidAllyCandidate(row, ctx, boss);
        const expected = plan.best.find(candidate => candidate.key === key);
        if (!current || current.profiles.length !== expected.profiles.length || current.profiles.some((profile, i) => profile.dps !== expected.profiles[i].dps || profile.rounds !== expected.profiles[i].rounds)) throw new Error('同伴候选名单已刷新，请重新点击。');
        row.click();
        await waitRaidUi(() => readRaidPickKeys(ctx.region)[slot] === key, '同伴未保存成功，请重试。');
        await waitRaidUi(() => !ownedModal.isConnected || !ownedModal.classList.contains('open'), '选择后弹窗未关闭，请重试。');
        ownedModal = null;
      }
      assertRaidContext(ctx);
      const saved = readRaidPickKeys(ctx.region);
      if (!plan.assigned.every((key, i) => saved[i] === key)) throw new Error('两个同伴位置核对失败，请重新点击。');
      return {...plan, candidates:candidates.size, region:ctx.region, id:ctx.id};
    } finally {
      try { if (ownedModal) await closeRaidChooser(ownedModal); }
      finally { state.raidAllyContext = null; state.raidAllyBoss = null; }
    }
  }

  function raidAllyResultKey(ctx) { return ctx.region + ':' + ctx.id; }
  async function runRaidAllyAction(ctx, includeMine = false) {
    if (state.busy || state.raidAllyBusy) return;
    state.busy = true; state.raidAllyBusy = ctx.region; state.errors = [];
    state.raidAllyResults ||= {};
    const resultKey = raidAllyResultKey(ctx);
    state.raidAllyResults[resultKey] = '正在读取候选并选择同伴…'; refreshUi();
    try {
      assertRaidContext(ctx);
      const result = await optimizeRaidAllies(ctx);
      state.raidAllyResults[resultKey] = {keys:result.assigned.slice(), text:'已核对 ' + result.best.map(candidate => candidate.name).join('、')
        + ` · 同伴预计伤害 ${Math.round(result.dps)}/回合 · 比较 ${result.candidates} 位候选`};
      log('info', 'raid: allies verified', {region:ctx.region, keys:result.assigned, dps:result.dps});
    } catch (error) {
      state.raidAllyResults[resultKey] = '选择失败：' + error.message;
      state.errors = [state.raidAllyResults[resultKey]];
      logError('raid: allies failed', error);
    } finally { state.busy = false; state.raidAllyBusy = null; refreshUi(); }
  }

  function mountRaidAllyButtons() {
    if (!state.engine) return;
    for (const card of document.querySelectorAll('#screen-raid .rc-card[data-rc]')) {
      const ctx = raidCardContext(card);
      if (!ctx) continue;
      const host = card;
      const blocked = ctx.running || !ctx.count;
      const result = state.raidAllyResults?.[raidAllyResultKey(ctx)];
      const current = readRaidPickKeys(ctx.region);
      const saved = typeof result === 'string' ? result : result?.keys?.every((key, i) => current[i] === key) ? result.text : result ? '同伴名单或选择已变化，请重新点击选择。' : '';
      const message = blocked ? '开战后不可换同伴，退出战斗后再选。' : saved || '按当前首领的预计伤害和生存时间，比较每位同伴的整组宝可梦。';
      const html = `<button class="btn small" data-act="allies" ${blocked || state.busy ? 'disabled' : ''}>${state.raidAllyBusy === ctx.region ? '正在选择…' : '一键最佳同伴'}</button><p class="pcopt-mut" role="status" aria-live="polite">${esc(message)}</p>`;
      const box = mountBlock(host, 'raid-allies', JSON.stringify([ctx.id, blocked, state.busy, state.raidAllyBusy, message]), html, el => {
        el.querySelector('[data-act="allies"]').onclick = () => runRaidAllyAction(ctx);
      });
      box?.classList.add('pcopt-raid-ally-box');
    }
  }

  let raidProfileEngine = null;
  const raidProfiles = new Map();

  function raidCombatProfile(mon, boss) {
    const engine = state.engine, cfg = state.data.cfg;
    if (raidProfileEngine !== engine || raidProfiles.size >= 2048) {
      raidProfileEngine = engine;
      raidProfiles.clear();
    }
    const key = JSON.stringify([boss.mon.id, boss.dmgMult, mon.id, mon.level, !!mon.shiny, mon.rank, mon.statMult, mon.hpMult]);
    if (!raidProfiles.has(key)) {
      const target = { ...mon, types: state.data.species[mon.id].types };
      const hp = engine.maxHp(target);
      const incoming = engine.bestDamage(boss.mon, target) / Math.max(1, cfg.TEAM_SIZE)
        * boss.dmgMult * (cfg.ENEMY_DAMAGE?.static ?? 1);
      const rounds = incoming > 0 ? Math.max(1, Math.ceil(hp / incoming)) : Infinity;
      raidProfiles.set(key, { dps: raidDps(target, boss), rounds });
    }
    return raidProfiles.get(key);
  }

  const raidContribution = (profiles, rounds) => profiles.reduce((sum, profile) =>
    sum + profile.dps * Math.min(rounds, profile.rounds), 0);

  function chooseRaidOwnTeam(entries, count, boss, data) {
    const byDps = entries.slice().sort((a, b) => b.profile.dps - a.profile.dps);
    const reference = [];
    for (const entry of byDps) {
      if (canAddEventMember(reference, entry, 0, data)) reference.push(entry);
      if (reference.length === count) break;
    }
    const rawDps = reference.reduce((sum, entry) => sum + entry.profile.dps, 0);
    const horizon = Math.min(400, Math.max(1, Math.ceil(boss.maxHp / Math.max(1, rawDps))));
    const ranked = entries.slice().sort((a, b) =>
      raidContribution([b.profile], horizon) - raidContribution([a.profile], horizon) || b.profile.dps - a.profile.dps);
    const team = [];
    for (const entry of ranked) {
      if (canAddEventMember(team, entry, 0, data)) team.push(entry);
      if (team.length === count) break;
    }
    return team;
  }

  /** Apply the recommended own members to this event picker only. */
  async function fastestClear(rc) {
    const { data } = state, boss = raidBoss(rc), save = readSave(), count = data.cfg.RAID?.MINE ?? 2;
    const level = data.cfg.RAID?.LEVEL ?? data.cfg.MAX_LEVEL;
    const head = document.querySelector('#evt-pick-head');
    const active = () => eventPickerOpen(head) && raidContext()?.id === rc.id;
    const mine = eventCandidates(save, level);
    const entries = [];
    let until = performance.now() + 12;
    for (const candidate of mine) {
      entries.push({ ...candidate, profile: raidCombatProfile(candidate.proj, boss) });
      if (performance.now() < until) continue;
      await sleep(0);
      if (!active()) throw new Error('选队窗口已变化，请重新打开后再试。');
      until = performance.now() + 12;
    }
    const team = chooseRaidOwnTeam(entries, count, boss, data);
    if (team.length < count) throw new Error(`当前只有 ${team.length} 只符合限制的可用宝可梦，未应用队伍。`);
    if (!active()) throw new Error('选队窗口已变化，请重新打开后再试。');
    const done = await applyToEventPicker(team);
    if (done !== count) throw new Error(`已核对 ${done}/${count} 个己方位置，请检查窗口和成员限制后重试。`);
    const members = team.map(({ mon, profile }) =>
      `${displayName(mon.id)} ${Math.round(profile.dps)} 伤害/回合、约 ${Number.isFinite(profile.rounds) ? profile.rounds : '—'} 回合倒下`);
    state.evtOdds = { key: 'raid:' + rc.id, text: '己方已核对 · ' + members.join('；') };
    return { team };
  }


  /* ------------------------------------------------------------------ *
   * 8c. Inside the game: my controls next to its own "Optimize" button
   * ------------------------------------------------------------------ */
  function speciesIdByName(name) {
    const lang = i18n();
    for (const [k, v] of Object.entries(lang?.pokemon || {})) {
      if ((Array.isArray(v) ? v[0] : v) === name) return +k;
    }
    for (const pack of Object.values(window.I18N_DATA || {})) {
      for (const [k, v] of Object.entries(pack.pokemon || {})) {
        if ((Array.isArray(v) ? v[0] : v) === name) return +k;
      }
    }
    for (const [k, v] of Object.entries({ ...ZH_NAMES.pokemon, ...FORM_NAMES })) {
      if (v === name) return +k;
    }
    for (const [k, sp] of Object.entries(state.data?.species || {})) {
      if (sp.name === name) return +k;
    }
    return null;
  }

  function eventPickerOpen(head) {
    if (!head?.isConnected) return false;
    const picker = head.closest('#evt-pick');
    return !picker || picker.classList.contains('open');
  }

  /** Read the actual boss and the zone used for region and elite settings. */
  function pickerContext() {
    const head = document.querySelector('#evt-pick-head');
    if (!eventPickerOpen(head) || !state.legends || !state.data) return null;
    const text = head.querySelector('h2')?.textContent || '';
    const match = text.match(/(?:[eé]lite|精英)[\s：:]*([1-5]|IV|III|II|V|I)(?=\s|$|对|[:：])/i);
    const tier = match ? ({ I: 1, II: 2, III: 3, IV: 4, V: 5 }[match[1].toUpperCase()] || Number(match[1])) : 0;
    const id = headerBossId(head);
    if (!id) return null;
    const formBase = state.data.species[id]?.formBase;
    const zone = state.legends.zones.find(z => z.id === id) || state.legends.zones.find(z => z.id === formBase);
    if (!zone) return null;
    return { zone: id === zone.id ? zone : { ...zone, id, zoneId: zone.id }, tier };
  }

  function oddsText(estimate) {
    if (!estimate) return '';
    const { wins, runs, rounds, pCatch } = estimate;
    if (!wins) return `${runs} 次模拟未取胜`;
    const rate = Math.round(estimate.winChance * 1000) / 10;
    return `模拟胜率 ${rate}%（${wins}/${runs}） · 取胜平均 ${rounds} 回合`
      + (pCatch == null ? '' : ` · 取胜后单次捕获率 ${(pCatch * 100).toFixed(1)}%`);
  }


  /** Apply exact individual IDs through the game's own pointer handlers. */
  async function applyToEventPicker(team) {
    const head = document.querySelector('#evt-pick-head'), input = document.querySelector('#evt-search');
    if (!eventPickerOpen(head)) return 0;
    const title = head.querySelector('h2')?.textContent, boss = headerBossId(head);
    const initialSearch = input?.value || '';
    const active = () => eventPickerOpen(head) && head === document.querySelector('#evt-pick-head')
      && head.querySelector('h2')?.textContent === title && headerBossId(head) === boss;
    const slots = () => $$('#evt-team .slot');
    const pcCell = uid => $$('#evt-pc .pc-cell[data-uid]').find(cell => cell.dataset.uid === uid);
    const count = Math.min(team.length, slots().length);
    let changedSearch = false;
    try {
      for (let i = 0; i < count && active(); i++) {
        const uid = team[i].mon.uid;
        const placed = () => active() && slots()[i]?.dataset.uid === uid;
        for (let attempt = 0; attempt < 2 && active() && !placed(); attempt++) {
          let cell = slots().find(slot => slot.dataset.uid === uid) || pcCell(uid);
          if (!cell && input) {
            const mon = monByUid(readSave(), uid);
            if (!mon) break;
            input.value = gameSearchName(mon.id, true);
            changedSearch = true;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(450);
            if (!active()) break;
            cell = pcCell(uid);
          }
          const slot = slots()[i];
          if (!cell || !slot) break;
          await dragToSlot(cell, slot);
          for (let check = 0; check < 10 && active() && !placed(); check++) await sleep(100);
        }
        if (!placed()) break;
      }
    } finally {
      if (changedSearch && active() && input.isConnected) {
        input.value = initialSearch;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    return active() ? team.slice(0, count).filter((entry, i) => slots()[i]?.dataset.uid === entry.mon.uid).length : 0;
  }


  /** Add my controls beside the game's own "Optimize" button, inside its team picker.
   *  Raids get the fastest-clear button + DPS badges; legend zones get the odds + team. */
  async function injectPickerUi() {
    const head = document.querySelector('#evt-pick-head');
    if (!eventPickerOpen(head)) return;
    if (!state.engine) { try { await ensureData(); } catch { return; } }
    if (!head.isConnected) return;
    const rc = raidContext();
    if (rc) {
      state.raidBoss = raidBoss(rc);
      mountRaidBox(head, rc);
      annotateRaidSuggestions();
      return;
    }
    const ctx = pickerContext();
    if (!ctx) return;
    mountLegendBox(head, ctx);
  }



  /** Put my controls in the game's Team/PC header: they optimise for the chapter being run. */
  /* ------------------------------------------------------------------ *
   * 9. UI
   * ------------------------------------------------------------------ */
  const state = {
    data: null, chart: null, chartSource: '', engine: null, learnAll: null,
    dataPhase: 'waiting', dataError: '', dataAttempts: 0, dataRetryAt: 0,
    chapterOpen: store.get('chapterExpanded', false) === true,
    planScope: store.get('planScope', 'restart') === 'after-heal' ? 'after-heal' : 'restart',
    monitorOpen: store.get('monitorExpanded', false) === true,
    events: null, enemies: null, scored: null, team: null,
    preset: 'balanced', errors: [], busy: false, watcher: null, eligible: 0,
    apiCache: {}, info: {}, legends: null, waiting: null,
    evtOdds: null, loading: null,
    league: false, leagueInfo: null,
    segments: null, segOn: null, reuseAll: false, switching: false, selfClick: false, manual: null
  };

  const TYPE_COLORS = {
    normal: '#A8A77A', fire: '#EE8130', water: '#6390F0', electric: '#F7D02C', grass: '#7AC74C', ice: '#96D9D6',
    fighting: '#C22E28', poison: '#A33EA1', ground: '#E2BF65', flying: '#A98FF3', psychic: '#F95587', bug: '#A6B91A',
    rock: '#B6A136', ghost: '#735797', dragon: '#6F35FC', dark: '#705746', steel: '#B7B7CE', fairy: '#D685AD'
  };
  const typeColor = t => TYPE_COLORS[t] || '#888';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }


  // Chinese names are bundled from the game's own Simplified Chinese pack.
  // Display text must never be used as an API slug or a PC search query.
  const ZH_NAMES = {"pokemon":{"1":"妙蛙种子","2":"妙蛙草","3":"妙蛙花","4":"小火龙","5":"火恐龙","6":"喷火龙","7":"杰尼龟","8":"卡咪龟","9":"水箭龟","10":"绿毛虫","11":"铁甲蛹","12":"巴大蝶","13":"独角虫","14":"铁壳蛹","15":"大针蜂","16":"波波","17":"比比鸟","18":"大比鸟","19":"小拉达","20":"拉达","21":"烈雀","22":"大嘴雀","23":"阿柏蛇","24":"阿柏怪","25":"皮卡丘","26":"雷丘","27":"穿山鼠","28":"穿山王","29":"尼多兰","30":"尼多娜","31":"尼多后","32":"尼多朗","33":"尼多力诺","34":"尼多王","35":"皮皮","36":"皮可西","37":"六尾","38":"九尾","39":"胖丁","40":"胖可丁","41":"超音蝠","42":"大嘴蝠","43":"走路草","44":"臭臭花","45":"霸王花","46":"派拉斯","47":"派拉斯特","48":"毛球","49":"摩鲁蛾","50":"地鼠","51":"三地鼠","52":"喵喵","53":"猫老大","54":"可达鸭","55":"哥达鸭","56":"猴怪","57":"火暴猴","58":"卡蒂狗","59":"风速狗","60":"蚊香蝌蚪","61":"蚊香君","62":"蚊香泳士","63":"凯西","64":"勇基拉","65":"胡地","66":"腕力","67":"豪力","68":"怪力","69":"喇叭芽","70":"口呆花","71":"大食花","72":"玛瑙水母","73":"毒刺水母","74":"小拳石","75":"隆隆石","76":"隆隆岩","77":"小火马","78":"烈焰马","79":"呆呆兽","80":"呆壳兽","81":"小磁怪","82":"三合一磁怪","83":"大葱鸭","84":"嘟嘟","85":"嘟嘟利","86":"小海狮","87":"白海狮","88":"臭泥","89":"臭臭泥","90":"大舌贝","91":"刺甲贝","92":"鬼斯","93":"鬼斯通","94":"耿鬼","95":"大岩蛇","96":"催眠貘","97":"引梦貘人","98":"大钳蟹","99":"巨钳蟹","100":"霹雳电球","101":"顽皮雷弹","102":"蛋蛋","103":"椰蛋树","104":"卡拉卡拉","105":"嘎啦嘎啦","106":"飞腿郎","107":"快拳郎","108":"大舌头","109":"瓦斯弹","110":"双弹瓦斯","111":"独角犀牛","112":"钻角犀兽","113":"吉利蛋","114":"蔓藤怪","115":"袋兽","116":"墨海马","117":"海刺龙","118":"角金鱼","119":"金鱼王","120":"海星星","121":"宝石海星","122":"魔墙人偶","123":"飞天螳螂","124":"迷唇姐","125":"电击兽","126":"鸭嘴火兽","127":"凯罗斯","128":"肯泰罗","129":"鲤鱼王","130":"暴鲤龙","131":"拉普拉斯","132":"百变怪","133":"伊布","134":"水伊布","135":"雷伊布","136":"火伊布","137":"多边兽","138":"菊石兽","139":"多刺菊石兽","140":"化石盔","141":"镰刀盔","142":"化石翼龙","143":"卡比兽","144":"急冻鸟","145":"闪电鸟","146":"火焰鸟","147":"迷你龙","148":"哈克龙","149":"快龙","150":"超梦","151":"梦幻","152":"菊草叶","153":"月桂叶","154":"大竺葵","155":"火球鼠","156":"火岩鼠","157":"火暴兽","158":"小锯鳄","159":"蓝鳄","160":"大力鳄","161":"尾立","162":"大尾立","163":"咕咕","164":"猫头夜鹰","165":"芭瓢虫","166":"安瓢虫","167":"圆丝蛛","168":"阿利多斯","169":"叉字蝠","170":"灯笼鱼","171":"电灯怪","172":"皮丘","173":"皮宝宝","174":"宝宝丁","175":"波克比","176":"波克基古","177":"天然雀","178":"天然鸟","179":"咩利羊","180":"茸茸羊","181":"电龙","182":"美丽花","183":"玛力露","184":"玛力露丽","185":"树才怪","186":"蚊香蛙皇","187":"毽子草","188":"毽子花","189":"毽子棉","190":"长尾怪手","191":"向日种子","192":"向日花怪","193":"蜻蜻蜓","194":"乌波","195":"沼王","196":"太阳伊布","197":"月亮伊布","198":"黑暗鸦","199":"呆呆王","200":"梦妖","201":"未知图腾","202":"果然翁","203":"麒麟奇","204":"榛果球","205":"佛烈托斯","206":"土龙弟弟","207":"天蝎","208":"大钢蛇","209":"布鲁","210":"布鲁皇","211":"千针鱼","212":"巨钳螳螂","213":"壶壶","214":"赫拉克罗斯","215":"狃拉","216":"熊宝宝","217":"圈圈熊","218":"熔岩虫","219":"熔岩蜗牛","220":"小山猪","221":"长毛猪","222":"太阳珊瑚","223":"铁炮鱼","224":"章鱼桶","225":"信使鸟","226":"巨翅飞鱼","227":"盔甲鸟","228":"戴鲁比","229":"黑鲁加","230":"刺龙王","231":"小小象","232":"顿甲","233":"多边兽２型","234":"惊角鹿","235":"图图犬","236":"无畏小子","237":"战舞郎","238":"迷唇娃","239":"电击怪","240":"鸭嘴宝宝","241":"大奶罐","242":"幸福蛋","243":"雷公","244":"炎帝","245":"水君","246":"幼基拉斯","247":"沙基拉斯","248":"班基拉斯","249":"洛奇亚","250":"凤王","251":"时拉比","252":"木守宫","253":"森林蜥蜴","254":"蜥蜴王","255":"火稚鸡","256":"力壮鸡","257":"火焰鸡","258":"水跃鱼","259":"沼跃鱼","260":"巨沼怪","261":"土狼犬","262":"大狼犬","263":"蛇纹熊","264":"直冲熊","265":"刺尾虫","266":"甲壳茧","267":"狩猎凤蝶","268":"盾甲茧","269":"毒粉蛾","270":"莲叶童子","271":"莲帽小童","272":"乐天河童","273":"橡实果","274":"长鼻叶","275":"狡猾天狗","276":"傲骨燕","277":"大王燕","278":"长翅鸥","279":"大嘴鸥","280":"拉鲁拉丝","281":"奇鲁莉安","282":"沙奈朵","283":"溜溜糖球","284":"雨翅蛾","285":"蘑蘑菇","286":"斗笠菇","287":"懒人獭","288":"过动猿","289":"请假王","290":"土居忍士","291":"铁面忍者","292":"脱壳忍者","293":"咕妞妞","294":"吼爆弹","295":"爆音怪","296":"幕下力士","297":"铁掌力士","298":"露力丽","299":"朝北鼻","300":"向尾喵","301":"优雅猫","302":"勾魂眼","303":"大嘴娃","304":"可可多拉","305":"可多拉","306":"波士可多拉","307":"玛沙那","308":"恰雷姆","309":"落雷兽","310":"雷电兽","311":"正电拍拍","312":"負电拍拍","313":"电萤虫","314":"甜甜萤","315":"毒蔷薇","316":"溶食兽","317":"吞食兽","318":"利牙鱼","319":"巨牙鲨","320":"吼吼鲸","321":"吼鲸王","322":"呆火驼","323":"喷火驼","324":"煤炭龟","325":"跳跳猪","326":"噗噗猪","327":"晃晃斑","328":"大颚蚁","329":"超音波幼虫","330":"沙漠蜻蜓","331":"刺球仙人掌","332":"梦歌仙人掌","333":"青绵鸟","334":"七夕青鸟","335":"猫鼬斩","336":"饭匙蛇","337":"月石","338":"太阳岩","339":"泥泥鳅","340":"鲶鱼王","341":"龙虾小兵","342":"铁螯龙虾","343":"天秤偶","344":"念力土偶","345":"触手百合","346":"摇篮百合","347":"太古羽虫","348":"太古盔甲","349":"丑丑鱼","350":"美纳斯","351":"飘浮泡泡","352":"变隐龙","353":"怨影娃娃","354":"诅咒娃娃","355":"夜巡灵","356":"彷徨夜灵","357":"热带龙","358":"风铃铃","359":"阿勃梭鲁","360":"小果然","361":"雪童子","362":"冰鬼护","363":"海豹球","364":"海魔狮","365":"帝牙海狮","366":"珍珠贝","367":"猎斑鱼","368":"樱花鱼","369":"古空棘鱼","370":"爱心鱼","371":"宝贝龙","372":"甲壳龙","373":"暴飞龙","374":"铁哑铃","375":"金属怪","376":"巨金怪","377":"雷吉洛克","378":"雷吉艾斯","379":"雷吉斯奇鲁","380":"拉帝亚斯","381":"拉帝欧斯","382":"盖欧卡","383":"固拉多","384":"烈空坐","385":"基拉祈","386":"代欧奇希斯","387":"草苗龟","388":"树林龟","389":"土台龟","390":"小火焰猴","391":"猛火猴","392":"烈焰猴","393":"波加曼","394":"波皇子","395":"帝王拿波","396":"姆克儿","397":"姆克鸟","398":"姆克鹰","399":"大牙狸","400":"大尾狸","401":"圆法师","402":"音箱蟀","403":"小猫怪","404":"勒克猫","405":"伦琴猫","406":"含羞苞","407":"罗丝雷朵","408":"头盖龙","409":"战槌龙","410":"盾甲龙","411":"护城龙","412":"结草儿","413":"结草贵妇","414":"绅士蛾","415":"三蜜蜂","416":"蜂女王","417":"帕奇利兹","418":"泳圈鼬","419":"浮潜鼬","420":"樱花宝","421":"樱花儿","422":"无壳海兔","423":"海兔兽","424":"双尾怪手","425":"飘飘球","426":"随风球","427":"卷卷耳","428":"长耳兔","429":"梦妖魔","430":"乌鸦头头","431":"魅力喵","432":"东施喵","433":"铃铛响","434":"臭鼬噗","435":"坦克臭鼬","436":"铜镜怪","437":"青铜钟","438":"盆才怪","439":"魔尼尼","440":"小福蛋","441":"聒噪鸟","442":"花岩怪","443":"圆陆鲨","444":"尖牙陆鲨","445":"烈咬陆鲨","446":"小卡比兽","447":"利欧路","448":"路卡利欧","449":"沙河马","450":"河马兽","451":"钳尾蝎","452":"龙王蝎","453":"不良蛙","454":"毒骷蛙","455":"尖牙笼","456":"荧光鱼","457":"霓虹鱼","458":"小球飞鱼","459":"雪笠怪","460":"暴雪王","461":"玛狃拉","462":"自爆磁怪","463":"大舌舔","464":"超甲狂犀","465":"巨蔓藤","466":"电击魔兽","467":"鸭嘴炎兽","468":"波克基斯","469":"远古巨蜓","470":"叶伊布","471":"冰伊布","472":"天蝎王","473":"象牙猪","474":"多边兽乙型","475":"艾路雷朵","476":"大朝北鼻","477":"黑夜魔灵","478":"雪妖女","479":"洛托姆","480":"由克希","481":"艾姆利多","482":"亚克诺姆","483":"帝牙卢卡","484":"帕路奇亚","485":"席多蓝恩","486":"雷吉奇卡斯","487":"骑拉帝纳","488":"克雷色利亚","489":"霏欧纳","490":"玛纳霏","491":"达克莱伊","492":"谢米","493":"阿尔宙斯","494":"比克提尼","495":"藤藤蛇","496":"青藤蛇","497":"君主蛇","498":"暖暖猪","499":"炒炒猪","500":"炎武王","501":"水水獭","502":"双刃丸","503":"大剑鬼","504":"探探鼠","505":"步哨鼠","506":"小约克","507":"哈约克","508":"长毛狗","509":"扒手猫","510":"酷豹","511":"花椰猴","512":"花椰猿","513":"爆香猴","514":"爆香猿","515":"冷水猴","516":"冷水猿","517":"食梦梦","518":"梦梦蚀","519":"豆豆鸽","520":"咕咕鸽","521":"高傲雉鸡","522":"斑斑马","523":"雷电斑马","524":"石丸子","525":"地幔岩","526":"庞岩怪","527":"滚滚蝙蝠","528":"心蝙蝠","529":"螺钉地鼠","530":"龙头地鼠","531":"差不多娃娃","532":"搬运小匠","533":"铁骨土人","534":"修建老匠","535":"圆蝌蚪","536":"蓝蟾蜍","537":"蟾蜍王","538":"投摔鬼","539":"打击鬼","540":"虫宝包","541":"宝包茧","542":"保姆虫","543":"百足蜈蚣","544":"车轮球","545":"蜈蚣王","546":"木棉球","547":"风妖精","548":"百合根娃娃","549":"裙儿小姐","550":"野蛮鲈鱼","551":"黑眼鳄","552":"混混鳄","553":"流氓鳄","554":"火红不倒翁","555":"达摩狒狒","556":"沙铃仙人掌","557":"石居蟹","558":"岩殿居蟹","559":"滑滑小子","560":"头巾混混","561":"象征鸟","562":"哭哭面具","563":"迭失棺","564":"原盖海龟","565":"肋骨海龟","566":"始祖小鸟","567":"始祖大鸟","568":"破破袋","569":"灰尘山","570":"索罗亚","571":"索罗亚克","572":"泡沫栗鼠","573":"奇诺栗鼠","574":"哥德宝宝","575":"哥德小童","576":"哥德小姐","577":"单卵细胞球","578":"双卵细胞球","579":"人造细胞卵","580":"鸭宝宝","581":"舞天鹅","582":"迷你冰","583":"多多冰","584":"双倍多多冰","585":"四季鹿","586":"萌芽鹿","587":"电飞鼠","588":"盖盖虫","589":"骑士蜗牛","590":"哎呀球菇","591":"败露球菇","592":"轻飘飘","593":"胖嘟嘟","594":"保姆曼波","595":"电电虫","596":"电蜘蛛","597":"种子铁球","598":"坚果哑铃","599":"齿轮儿","600":"齿轮组","601":"齿轮怪","602":"麻麻小鱼","603":"麻麻鳗","604":"麻麻鳗鱼王","605":"小灰怪","606":"大宇怪","607":"烛光灵","608":"灯火幽灵","609":"水晶灯火灵","610":"牙牙","611":"斧牙龙","612":"双斧战龙","613":"喷嚏熊","614":"冻原熊","615":"几何雪花","616":"小嘴蜗","617":"敏捷虫","618":"泥巴鱼","619":"功夫鼬","620":"师父鼬","621":"赤面龙","622":"泥偶小人","623":"泥偶巨人","624":"驹刀小兵","625":"劈斩司令","626":"爆炸头水牛","627":"毛头小鹰","628":"勇士雄鹰","629":"秃鹰丫头","630":"秃鹰娜","631":"熔蚁兽","632":"铁蚁","633":"单首龙","634":"双首暴龙","635":"三首恶龙","636":"燃烧虫","637":"火神蛾","638":"勾帕路翁","639":"代拉基翁","640":"毕力吉翁","641":"龙卷云","642":"雷电云","643":"莱希拉姆","644":"捷克罗姆","645":"土地云","646":"酋雷姆","647":"凯路迪欧","648":"美洛耶塔","649":"盖诺赛克特"},"moves":{"confusion":"念力","stored-power":"辅助力量","work-up":"自我激励","headbutt":"头锤","inferno":"炼狱","incinerate":"烧尽","quick-attack":"电光一闪","reversal":"起死回生","zen-headbutt":"意念头锤","vine-whip":"藤鞭","leer":"瞪眼","wrap":"紧束","overheat":"过热","tackle":"撞击","flare-blitz":"闪焰冲锋","magical-leaf":"魔法叶","leech-seed":"寄生种子","leaf-blade":"叶刃","slam":"摔打","mega-drain":"超级吸取","gastro-acid":"胃液","tail-whip":"摇尾巴","leaf-storm":"飞叶风暴","defense-curl":"变圆","smog":"浊雾","ember":"火花","rollout":"滚动","flame-charge":"蓄能焰袭","focus-energy":"聚气","endure":"挺住","soak":"浸水","growth":"生长","flamethrower":"喷射火焰","heat-crash":"高温重压","final-gambit":"搏命","double-edge":"舍身冲撞","roar":"吼叫","assurance":"恶意追击","fury-cutter":"连斩","water-gun":"水枪","coil":"盘蜷","water-pulse":"水之波动","giga-drain":"终极吸取","swords-dance":"剑舞","hydro-pump":"水炮","aerial-ace":"燕返","sand-attack":"泼沙","slash":"劈开","detect":"看穿","bite":"咬住","head-smash":"双刃头锤","take-down":"猛撞","crunch":"咬碎","after-you":"您先请","nasty-plot":"诡计","arm-thrust":"猛推","hyper-fang":"必杀门牙","psych-up":"自我暗示","baby-doll-eyes":"圆瞳","confuse-ray":"奇异之光","play-rough":"嬉闹","encore":"再来一次","helping-hand":"帮助","last-resort":"珍藏","scratch":"抓","fake-out":"击掌奇袭","fury-swipes":"乱抓","aqua-jet":"水流喷射","torment":"无理取闹","hypnosis":"催眠术","bide":"忍耐","super-fang":"愤怒门牙","night-slash":"暗袭要害","hone-claws":"磨爪","searing-shot":"火焰弹","play-nice":"和睦相处","lick":"舌舔","seed-bomb":"种子炸弹","recycle":"回收利用","yawn":"哈欠","grass-knot":"打草结","natural-gift":"自然之恩","flame-burst":"烈焰溅射","baton-pass":"接棒","fire-blast":"大字爆炎","scald":"热水","water-sport":"玩水","aqua-tail":"水流尾","giga-impact":"终极冲击","growl":"叫声","sucker-punch":"突袭","imprison":"封印","psychic":"精神强念","psybeam":"幻象光线","calm-mind":"冥想","moonblast":"月亮之力","acrobatics":"杂技","gust":"起风","air-cutter":"空气利刃","dream-eater":"食梦","feather-dance":"羽毛舞","amnesia":"瞬间失忆","swagger":"虚张声势","tailwind":"顺风","air-slash":"空气斩","mean-look":"黑色目光","magic-coat":"魔法反射","thunder-wave":"电磁波","spark":"电光","taunt":"挑衅","thrash":"大闹一番","stomp":"踩踏","harden":"变硬","fling":"投掷","v-create":"Ｖ热焰","future-sight":"预知未来","smack-down":"击落","rock-slide":"岩崩","rock-blast":"岩石爆击","sky-attack":"神鸟猛击","stone-edge":"尖石攻击","explosion":"大爆炸","roost":"羽栖","shock-wave":"电击波","power-gem":"力量宝石","simple-beam":"单纯光束","endeavor":"蛮干","rapid-spin":"高速旋转","wild-charge":"疯狂伏特","brine":"盐水","agility":"高速移动","metal-claw":"金属爪","dig":"挖洞","earthquake":"地震","discharge":"放电","disarming-voice":"魅惑之声","pound":"拍击","hyper-voice":"巨声","low-kick":"踢倒","iron-defense":"铁壁","moonlight":"月光","attract":"迷人","misty-terrain":"薄雾场地","rock-throw":"落石","scary-face":"鬼面","crush-claw":"撕裂爪","dynamic-punch":"爆裂拳","fissure":"地裂","drill-run":"直冲钻","superpower":"蛮力","echoed-voice":"回声","horn-drill":"角钻","mud-slap":"掷泥","supersonic":"超音波","acid":"溶解液","wonder-room":"奇妙空间","stealth-rock":"隐形岩","mud-shot":"泥巴射击","round":"轮唱","heal-pulse":"治愈波动","flail":"抓狂","hammer-arm":"臂锤","sandstorm":"沙暴","uproar":"吵闹","focus-punch":"真气拳","drain-punch":"吸取拳","bind":"绑紧","wide-guard":"广域防守","life-dew":"生命水滴","quick-guard":"快速防守","storm-throw":"山岚摔","aqua-ring":"水流环","bubble-beam":"泡沫光线","bulk-up":"健美","rain-dance":"求雨","muddy-water":"浊流","revenge":"报复","double-kick":"二连踢","string-shot":"吐丝","razor-leaf":"飞叶快刀","circle-throw":"巴投","close-combat":"近身战","seismic-toss":"地球上投","low-sweep":"下盘踢","rock-smash":"碎岩","bug-bite":"虫咬","bug-buzz":"虫鸣","poison-sting":"毒针","sticky-web":"黏黏网","screech":"刺耳声","protect":"守住","absorb":"吸取","venom-drench":"毒液陷阱","stun-spore":"麻痹粉","fairy-wind":"妖精之风","megahorn":"超级角击","poison-powder":"毒粉","charm":"撒娇","cotton-guard":"棉花防守","energy-ball":"能量球","sleep-powder":"催眠粉","solar-beam":"日光束","synthesis":"光合作用","wave-crash":"波动冲","sand-tomb":"流沙地狱","foul-play":"欺诈","counter":"双倍奉还","brick-break":"劈瓦","fell-stinger":"致命针刺","entrainment":"找伙伴","outrage":"逆鳞","belly-drum":"腹鼓","toxic":"剧毒","venoshock":"毒液冲击","fire-punch":"火焰拳","peck":"啄","x-scissor":"十字剪","sweet-scent":"甜甜香气","petal-blizzard":"落英缤纷","pin-missile":"飞弹针","charge":"充电","sunny-day":"大晴天","spiky-shield":"尖刺防守","withdraw":"缩入壳中","fire-fang":"火焰牙","rock-polish":"岩石打磨","rock-wrecker":"岩石炮","struggle-bug":"虫之抵抗","high-jump-kick":"飞膝踢","beat-up":"围攻","payback":"以牙还牙","whirlwind":"吹飞","cosmic-power":"宇宙力量","gravity":"重力","reflect":"反射壁","poison-tail":"毒尾","disable":"定身法","skill-swap":"特性互换","night-shade":"黑夜魔影","will-o-wisp":"鬼火","shell-smash":"破壳","hex":"祸不单行","vital-throw":"借力摔","dark-pulse":"恶之波动","guard-split":"防守平分","light-screen":"光墙","shadow-ball":"暗影球","power-split":"力量平分","facade":"硬撑","dragon-claw":"龙爪","destiny-bond":"同命","wing-attack":"翅膀攻击","shadow-claw":"暗影爪","crafty-shield":"戏法防守","haze":"黑雾","dragon-breath":"龙息","pluck":"啄食","razor-shell":"贝壳刃","poison-gas":"毒瓦斯","ancient-power":"原始之力","u-turn":"急速折返","stockpile":"蓄力","ingrain":"扎根","swallow":"吞下","acid-spray":"酸液炸弹","petal-dance":"花瓣舞","sludge-bomb":"污泥炸弹","gunk-shot":"垃圾射击","night-daze":"暗黑爆破","pain-split":"分担痛楚","fake-tears":"假哭","sing":"唱歌","retaliate":"报仇","knock-off":"拍落","body-slam":"泰山压顶","cotton-spore":"棉孢子","power-trip":"嚣张","swift":"高速星星","recover":"自我再生","acupressure":"点穴","tail-slap":"扫尾拍打","tickle":"挠痒","astonish":"惊吓","psyshock":"精神冲击","ally-switch":"交换场地","acid-armor":"溶化","defog":"清除浓雾","hail":"冰雹","toxic-spikes":"毒菱","hurricane":"暴风","avalanche":"雪崩","icy-wind":"冰冻之风","belch":"打嗝","thunder-shock":"电击","bullet-seed":"种子机关枪","ice-beam":"冰冻光束","double-team":"影子分身","clear-smog":"清除之烟","flatter":"吹捧","magic-room":"魔法空间","brave-bird":"勇鸟猛攻","mist":"白雾","grudge":"怨念","mirror-coat":"镜面反射","iron-head":"铁头","false-swipe":"点到为止","curse":"诅咒","horn-leech":"木角","whirlpool":"潮旋","wish":"祈愿","metal-burst":"金属爆炸","electroweb":"电网","flash-cannon":"加农光炮","gyro-ball":"陀螺球","nuzzle":"蹭蹭脸颊","vice-grip":"夹住","charge-beam":"充电光束","gear-grind":"齿轮飞盘","shift-gear":"换档","lock-on":"锁定","zap-cannon":"电磁炮","rage-powder":"愤怒粉","teleport":"瞬间移动","fire-spin":"火焰旋涡","spore":"蘑菇孢子","electro-ball":"电球","healing-wish":"治愈之愿","water-spout":"喷水","icicle-spear":"冰锥","safeguard":"神秘守护","hyper-beam":"破坏光线","self-destruct":"自爆","autotomize":"身体轻量化","sheer-cold":"绝对零度","volt-switch":"伏特替换","metal-sound":"金属音","electric-terrain":"电气场地","power-whip":"强力鞭打","snowscape":"雪景","powder-snow":"细雪","blizzard":"暴风雪","dragon-pulse":"龙之波动","sludge":"污泥攻击","aurora-beam":"极光束","ice-shard":"冰砾","rest":"睡觉","thunderbolt":"十万伏特","power-swap":"力量互换","minimize":"变小","shadow-punch":"暗影拳","mega-punch":"百万吨重拳","fury-attack":"乱击","bounce":"弹跳","throat-chop":"地狱突刺","horn-attack":"角撞","dragon-dance":"龙之舞","bone-rush":"骨棒乱打","memento":"临别礼物","dragon-tail":"龙尾","heavy-slam":"重磅冲撞","fire-lash":"火焰鞭","dragon-rush":"龙之俯冲","spit-up":"喷出","quiver-dance":"蝶舞","leech-life":"吸血","flame-wheel":"火焰轮","freeze-dry":"冷冻干燥","phantom-force":"潜灵奇袭","extrasensory":"神通力","thunder-fang":"雷电牙","thunder":"打雷","guillotine":"断头钳","heat-wave":"热风","breaking-swipe":"广域破坏","icicle-crash":"冰柱坠击","frost-breath":"冰息","rock-tomb":"岩石封锁","bulldoze":"重踏","wildbolt-storm":"鸣雷风暴","blue-flare":"青焰","freeze-shock":"冰冻伏特","ice-burn":"极寒冷焰","head-charge":"爆炸头突击","role-play":"扮演","fusion-flare":"交错火焰","block":"挡路","fusion-bolt":"交错闪电","aura-sphere":"波导弹","guard-swap":"防守互换","stomping-tantrum":"跺脚","earth-power":"大地之力","teeter-dance":"摇晃舞","secret-sword":"神秘之剑","glaciate":"冰封世界","headlong-rush":"突飞猛扑","techno-blast":"高科技光炮","magnet-rise":"电磁飘浮","sacred-sword":"圣剑","force-palm":"发劲","mach-punch":"音速拳","noble-roar":"战吼","drill-peck":"啄钻","feint":"佯攻","bolt-strike":"雷击","defend-order":"防御指令","lunge":"猛扑","sandsear-storm":"热沙风暴","perish-song":"灭亡之歌","bleakwind-storm":"枯叶风暴","leafage":"树叶","relic-song":"古老之歌","morning-sun":"晨光","liquidation":"水流裂破","comeuppance":"复仇","double-hit":"二连击","mimic":"模仿","slack-off":"偷懒","copycat":"仿效","raging-fury":"大愤慨","worry-seed":"烦恼种子","dazzling-gleam":"魔法闪耀","covet":"渴望","infestation":"死缠烂打","shadow-sneak":"影子偷袭","spite":"怨恨","sweet-kiss":"天使之吻","extreme-speed":"神速","metronome":"挥指","confide":"密语","splash":"跃起","meteor-mash":"彗星拳","smokescreen":"烟幕","poison-jab":"毒击","wood-hammer":"木槌","aromatic-mist":"芳香薄雾","chatter":"喋喋不休","parting-shot":"抛下狠话","vacuum-wave":"真空波","poison-fang":"剧毒牙","ice-punch":"冰冻拳","cross-poison":"十字毒刃","attack-order":"攻击指令","leaf-tornado":"青草搅拌器","crabhammer":"蟹钳锤","thunder-punch":"雷电拳","grassy-terrain":"青草场地","ice-fang":"冰冻牙","psycho-cut":"精神利刃","tri-attack":"三重攻击","mystical-power":"神秘之力","aurora-veil":"极光幕","iron-tail":"铁尾","tearful-look":"泪眼汪汪","trick":"戏法","body-press":"扑击","struggle":"挣扎","lunar-blessing":"新月祈祷","lava-plume":"喷烟","conversion-2":"纹理２","trick-room":"戏法空间","conversion":"纹理","draining-kiss":"吸取之吻","spacial-rend":"亚空裂斩","substitute":"替身","roar-of-time":"时光咆哮","dive":"潜水","tail-glow":"萤火","twister":"龙卷风","crush-grip":"捏碎","follow-me":"看我嘛","pay-day":"聚宝功","lunar-dance":"新月舞","seed-flare":"种子闪光","howl":"长嚎","dark-void":"暗黑洞","shadow-force":"暗影潜袭","laser-focus":"磨砺","judgment":"制裁光砾","cross-chop":"十字劈","dual-chop":"二连劈","heart-swap":"心灵互换","strength":"怪力","surf":"冲浪","sludge-wave":"污泥波","magma-storm":"熔岩风暴","glare":"大蛇瞪眼","bonemerang":"骨头回力镖","cut":"居合斩","bullet-punch":"子弹拳","mega-kick":"百万吨重踢","aromatherapy":"芳香治疗","waterfall":"攀瀑","submission":"地狱翻滚","rage-fist":"愤怒之拳","axe-kick":"下压踢","smart-strike":"修长之角","eerie-impulse":"怪异电波","soft-boiled":"生蛋","lovely-kiss":"恶魔之吻","blaze-kick":"火焰踢","transform":"变身","sleep-talk":"梦话","snore":"打鼾","high-horsepower":"十万马力","psystrike":"精神击破","reflect-type":"镜面属性","psycho-shift":"精神转移","snarl":"大声咆哮","quash":"延后","eruption":"喷火","octazooka":"章鱼桶炮","spikes":"撒菱","take-heart":"勇气填充","hidden-power":"觉醒力量","steel-wing":"钢翼","sketch":"写生","raging-bull":"怒牛","mind-reader":"心之眼","toxic-thread":"毒丝","twin-beam":"双光束","boomburst":"爆音波","hyper-drill":"强力钻","power-trick":"力量戏法","present":"礼物","triple-kick":"三连踢","milk-drink":"喝牛奶","heal-bell":"治愈铃声","aeroblast":"气旋攻击","fly":"飞翔","weather-ball":"气象球","sacred-fire":"神圣之火","alluring-voice":"魅诱之声","thief":"小偷","assist":"借助","barrier":"屏障","barrage":"投球","bestow":"传递礼物","burning-jealousy":"妒火","bone-club":"骨棒","magnetic-flux":"磁场操控","bubble":"泡沫","mist-ball":"薄雾球","camouflage":"保护色","chilling-water":"泼冷水","switcheroo":"掉包","captivate":"诱惑","clamp":"贝壳夹击","comet-punch":"连续拳","double-slap":"连环巴掌","luster-purge":"洁净光芒","draco-meteor":"流星群","dragon-rage":"龙之怒","dragon-ascent":"画龙点睛","doom-desire":"破灭之愿","embargo":"查封","feint-attack":"出奇一击","fire-pledge":"火之誓约","origin-pulse":"根源波动","foresight":"识破","focus-blast":"真气弹","flash":"闪光","grass-pledge":"草之誓约","dizzy-punch":"迷昏拳","heal-block":"回复封锁","egg-bomb":"炸蛋","expanding-force":"广域战力","heal-order":"回复指令","heart-stamp":"爱心印章","ice-spinner":"冰旋","flip-turn":"快速折返","chip-away":"逐步击破","precipice-blades":"断崖之剑","jump-kick":"飞踢","kinesis":"折弯汤匙","frustration":"迁怒","lash-out":"泄愤","psycho-boost":"精神突进","mat-block":"掀榻榻米","magnitude":"震级","magnet-bomb":"磁铁炸弹","me-first":"抢先一步","meditate":"瑜伽姿势","mirror-shot":"镜光射击","mud-bomb":"泥巴炸弹","mud-sport":"玩泥巴","grassy-glide":"青草滑梯","mystical-fire":"魔法火焰","odor-sleuth":"气味侦测","nightmare":"恶梦","needle-arm":"尖刺臂","pounce":"虫扑","ominous-wind":"奇异之风","poltergeist":"灵骚","psychic-fangs":"精神之牙","power-up-punch":"增强拳","psychic-noise":"精神噪音","constrict":"缠绕","lucky-chant":"幸运咒语","psywave":"精神波","punishment":"惩罚","pursuit":"追打","razor-wind":"旋风刀","rage":"愤怒","refresh":"焕然一新","return":"报恩","rock-climb":"攀岩","secret-power":"秘密之力","sharpen":"棱角化","signal-beam":"信号光束","silver-wind":"银色旋风","dual-wingbeat":"双翼","skitter-smack":"爬击","skull-bash":"火箭头锤","sky-drop":"自由落体","smelling-salts":"清醒","miracle-eye":"奇迹之眼","snatch":"化为己用","spike-cannon":"尖刺加农炮","ion-deluge":"等离子浴","spider-web":"蛛网","supercell-slam":"闪电强袭","mirror-move":"鹦鹉学舌","steamroller":"疯狂滚压","synchronoise":"同步干扰","telekinesis":"意念移物","tera-blast":"太晶爆发","temper-flare":"豁出去","meteor-beam":"流星光束","trailblaze":"起草","scale-shot":"鳞射","scorching-sands":"热沙大地","triple-axel":"三旋击","twineedle":"双针","wake-up-slap":"唤醒巴掌","trump-card":"王牌","wring-out":"绞紧","sky-uppercut":"冲天拳","grass-whistle":"草笛","solar-blade":"日光刃","sonic-boom":"音爆","nature-power":"自然之力"},"text":{"poison":"毒","normal":"一般","dragon":"龙","Zarbi":"未知图腾","Morphéo":"飘浮泡泡","Kyurem":"酋雷姆","Riposte":"反击","Échange":"交换","Balance":"平衡","Brume":"雾","Stalactite":"冰柱徽章","Blizzard":"暴风雪","Brouillard":"起雾","Distorsion":"毁坏的世界","Cascade":"蓝色","Cadeau":"礼物","Vol":"飞行","Retour":"返回","Badge Roche":"灰色徽章","Bourg Palette → Argenta":"真新镇 → 深灰市","Labo du Prof. Chen":"大木博士的研究所","Le Prof. Chen te propose un Pokémon !":"大木博士要送你一只宝可梦！","Route 1":"1号道路","Jadielle":"常青市","Route 2":"2号道路","Forêt de Jade":"常青森林","Argenta":"深灰市","Musée d'Argenta":"深灰博物馆","Arène d'Argenta":"深灰道馆","Pierre":"小刚","Roche":"灰色","Badge Cascade":"蓝色徽章","Route 3 → Azuria":"3号道路 → 华蓝市","Route 3":"3号道路","Centre Pokémon (Route 4)":"宝可梦中心（4号道路）","Un vendeur louche t'offre un Magicarpe…":"一个可疑的商人要卖给你一条鲤鱼王……","Mont Sélénite":"月见山","Deux fossiles au fond de la grotte… lequel prends-tu ?":"洞窟深处有两块化石……你要拿哪一块？","Route 4":"4号道路","Azuria":"华蓝市","Pont Pépite":"金球大桥","Arène d'Azuria":"华蓝道馆","Ondine":"小霞","Badge Foudre":"橙色徽章","Route 5 → Carmin sur Mer":"5号道路 → 枯叶市","Route 5":"5号道路","Route 6":"6号道路","Carmin sur Mer":"枯叶市","Océane":"圣特安努号","Route 11":"11号道路","Grotte Taupiqueur":"地鼠洞穴","Arène de Carmin":"枯叶道馆","Major Bob":"马志士","Foudre":"橙色","Badge Prisme":"彩虹徽章","Route 9 → Céladopole":"9号道路 → 玉虹市","Route 9":"9号道路","Route 10":"10号道路","Grotte":"洞窟","Lavanville":"紫苑镇","Route 8":"8号道路","Route 7":"7号道路","Céladopole":"玉虹市","Manoir Céladon":"玉虹公寓","Une Poké Ball traîne sur une table… c'est un Évoli !":"桌上放着一个精灵球……是伊布！","Arène de Céladopole":"玉虹道馆","Erika":"莉佳","Prisme":"彩虹","Badge Âme":"粉红徽章","Tour Pokémon → Parmanie":"宝可梦塔 → 浅红市","Tour Pokémon":"宝可梦塔","Le fantôme d'une mère Ossatueur barre le sommet de la Tour !":"嘎啦嘎啦妈妈的幽灵挡在了塔顶！","L'âme d'Ossatueur s'apaise… M. Fuji te confie son petit.":"嘎啦嘎啦的灵魂得到了安息……藤老爷把它的孩子托付给了你。","Route 12":"12号道路","Un Ronflex bloque le passage !":"卡比兽挡住了去路！","Route 12-13":"12-13号道路","Route 14-15":"14-15号道路","Parmanie":"浅红市","Parc Safari":"狩猎地带","Arène de Parmanie":"浅红道馆","Koga":"阿桔","Âme":"粉红","Badge Marais":"金色徽章","Safrania":"金黄市","Piste Cyclable":"自行车道","Repaire Rocket":"火箭队基地","Tu mets la main sur le Scope Sylphe : les Spectres de la Tour Pokémon ne pourront plus se cacher !":"你拿到了西尔佛检视镜：宝可梦塔的幽灵再也藏不住了！","Routes 7-8":"7-8号道路","Dojo de Safrania":"格斗道场","Le Maître Karaté t'offre un de ses Pokémon !":"空手道大王要送你一只他的宝可梦！","Sylphe SARL":"西尔佛公司","Sylphe SARL 7e":"西尔佛公司7楼","Arène de Safrania":"金黄道馆","Morgane":"娜姿","Marais":"金色","Badge Volcan":"深红徽章","Routes maritimes → Cramois'Île":"水路 → 红莲岛","Routes 19-20":"19-20号道路","Centrale":"无人发电厂","Îles Écume":"双子岛","Cramois'Île":"红莲岛","Labo de Cramois'Île":"红莲岛研究所","Le labo ranime ton fossile !":"研究所复活了你的化石！","Manoir Pokémon":"宝可梦屋","Arène de Cramois'Île":"红莲道馆","Auguste":"夏伯","Volcan":"深红","Badge Terre":"绿色徽章","Route 21 → Jadielle":"21号道路 → 常青市","Route 21":"21号道路","Bourg Palette":"真新镇","Route 22":"22号道路","Arène de Jadielle":"常青道馆","Giovanni":"坂木","Terre":"绿色","Route Victoire":"冠军之路","Route 23 → Route Victoire":"23号道路 → 冠军之路","Route 23":"23号道路","Blue":"青绿","Blue t'attend à la sortie de la Route Victoire : un dernier combat avant la Ligue !":"青绿在冠军之路的出口等着你：联盟前的最后一战！","Conseil 4 : Olga":"四天王：科拿","Plateau Indigo":"石英高原","Salle":"房间","Salle 4":"第4房间","Olga":"科拿","Conseil 4 : Aldo":"四天王：希巴","Aldo":"希巴","Conseil 4 : Agatha":"四天王：菊子","Agatha":"菊子","Conseil 4 : Peter":"四天王：阿渡","Peter":"阿渡","Maître de la Ligue":"联盟冠军","Maître":"冠军","Badge Zéphyr":"飞翼徽章","Bourg Geon → Mauville":"若叶镇 → 桔梗市","Labo du Prof. Orme":"空木博士的研究所","Le Prof. Orme te confie un Pokémon !":"空木博士把一只宝可梦托付给了你！","Bourg Geon":"若叶镇","Route 29":"29号道路","Ville Griotte":"吉花市","Routes 30-31":"30-31号道路","Mauville":"桔梗市","Assistant du Prof. Orme":"空木博士的助手","L'assistant du Prof. Orme te confie l'œuf de M. Pokémon : il part couver à la Pension !":"空木博士的助手把宝可梦爷爷的蛋交给了你：它会被送到培育屋孵化！","Tour Chétiflor":"喇叭芽之塔","Arène de Mauville":"桔梗道馆","Albert":"阿速","Zéphyr":"飞翼","Badge Essaim":"昆虫徽章","Route 32 → Écorcia":"32号道路 → 桧皮镇","Route 32":"32号道路","Ruines d'Alpha":"阿露福遗迹","Caves Jumelles":"连接洞窟","Route 33":"33号道路","Écorcia":"桧皮镇","Puits Ramoloss":"呆呆兽之井","Arène d'Écorcia":"桧皮道馆","Hector":"阿笔","Essaim":"昆虫","Badge Plaine":"平原徽章","Bois aux Chênes → Doublonville":"桐树林 → 满金市","Bois aux Chênes":"桐树林","Route 34":"34号道路","Pension de la Route 34":"34号道路培育屋","Le papi de la Pension te confie un œuf mystère : il part couver à la Pension !":"培育屋的爷爷交给你一颗神秘的蛋：它会被送到培育屋孵化！","Doublonville":"满金市","Maison de Léo":"正辉的家","Léo, de passage chez lui, te confie un Évoli !":"回家探亲的正辉送给你一只伊布！","Route 35":"35号道路","Arène de Doublonville":"满金道馆","Blanche":"小茜","Plaine":"平原","Badge Brume":"雾徽章","Parc Naturel → Rosalia":"自然公园 → 圆朱市","Parc Naturel":"自然公园","Route 36":"36号道路","Un drôle d'arbre bloque la route… il bouge !":"一棵奇怪的树挡住了道路……它动了！","Route 37":"37号道路","Rosalia":"圆朱市","Tour Cendrée":"烧焦塔","Théâtre de Rosalia":"圆朱歌舞练场","Kimono Sayo":"舞女纱代","Kimono Zuki":"舞女小月","Kimono Kuni":"舞女小国","Kimono Miki":"舞女小干","Kimono Naoko":"舞女直子","Arène de Rosalia":"圆朱道馆","Mortimer":"松叶","Badge Choc":"冲击徽章","Routes 38-39 → Irisia":"38-39号道路 → 湛蓝市","Route 38":"38号道路","Route 39":"39号道路","Oliville":"浅葱市","Routes 40-41":"40-41号道路","Irisia":"湛蓝市","Maison d'Irisia":"湛蓝市的民宅","Un habitant inquiet te confie son Caratroc.":"一位忧心忡忡的居民把他的壶壶托付给了你。","Arène d'Irisia":"湛蓝道馆","Chuck":"阿四","Choc":"冲击","Badge Minéral":"钢铁徽章","Îles Tourbillon → Oliville":"漩涡列岛 → 浅葱市","Îles Tourbillon":"漩涡列岛","Phare d'Oliville":"浅葱灯塔","Arène d'Oliville":"浅葱道馆","Jasmine":"阿蜜","Minéral":"钢铁","Lac Colère":"愤怒之湖","Mont Creuset → Lac Colère":"擂钵山 → 愤怒之湖","Route 42":"42号道路","Mont Creuset":"擂钵山","Le Roi du Karaté, vaincu, te confie un Debugant.":"被打败的空手道大王送给你一只无畏小子。","Acajou":"卡吉镇","Route 43":"43号道路","Le lac s'agite… un Léviator rouge surgit, fou de rage !":"湖面翻腾起来……一条红色的暴鲤龙怒气冲冲地冒了出来！","Badge Glacier":"冰河徽章","Repaire Rocket B2":"火箭队基地B2","Un Électrode alimente la machine des Rocket !":"顽皮雷弹在为火箭队的机器供电！","Arène d'Acajou":"卡吉道馆","Frédo":"柳伯","Glacier":"冰河","Tour Radio":"广播塔","Sous-sol":"地下室","Tour Radio 5F":"广播塔5楼","Admin Rocket":"火箭队干部","Le chef des Rocket t'attend au sommet de la Tour Radio !":"火箭队首领在广播塔顶等着你！","Badge Lever":"升龙徽章","Route 44 → Ébènelle":"44号道路 → 烟墨市","Route 44":"44号道路","Route de Glace":"冰之小径","Ébènelle":"烟墨市","Routes 45-46":"45-46号道路","Antre du Dragon":"龙之洞","Le Doyen du clan te confie un Minidraco.":"龙族的长老把一只迷你龙托付给了你。","Arène d'Ébènelle":"烟墨道馆","Sandra":"小椿","Lever":"升龙","Routes 26-27 → Route Victoire":"26-27号道路 → 冠军之路","Route 26":"26号道路","Route 27":"27号道路","Silver":"银","Silver te barre la sortie de la Route Victoire !":"银挡在了冠军之路的出口！","Conseil 4 : Clément":"四天王：一树","Clément":"一树","Conseil 4 : Koga":"四天王：阿桔","Conseil 4 : Marion":"四天王：梨花","Marion":"梨花","Maître Johto":"城都冠军","Mont Argenté":"白银山","Bourg Palette → Route 28 → Mont Argenté":"真新镇 → 28号道路 → 白银山","Seize badges ! Le Prof. Chen te confie un Pokémon de Kanto.":"十六枚徽章！大木博士把一只关都的宝可梦托付给了你。","Route 28":"28号道路","Sommet":"山顶","Sommet du Mont Argenté":"白银山山顶","Red":"赤红","Légende":"传说","…":"……","Badge Roche (Hoenn)":"原石徽章","Bourg-en-Vol → Mérouville":"未白镇 → 卡那兹市","Labo du Prof. Seko":"小田卷博士的研究所","Le Prof. Seko te confie un Pokémon !":"小田卷博士把一只宝可梦托付给了你！","Bourg-en-Vol":"未白镇","Route 101":"101号道路","Rosyères":"古辰镇","Routes 102-103":"102-103号道路","Clémenti-Ville":"橙华市","Route 104":"104号道路","Bois Clémenti":"橙华森林","Mérouville":"卡那兹市","Arène de Mérouville":"卡那兹道馆","Roxanne":"杜娟","Roche (Hoenn)":"原石","Badge Poing":"拳头徽章","Route 116 → Myokara":"116号道路 → 武斗镇","Route 116":"116号道路","Tunnel Mérazon":"卡绿隧道","Routes 105-106":"105-106号道路","Myokara":"武斗镇","Grotte Granite":"石之洞窟","Arène de Myokara":"武斗道馆","Bastien":"藤树","Poing":"拳头","Badge Dynamo":"发电徽章","Routes 107-110 → Lavandia":"107-110号道路 → 紫堇市","Routes 107-108":"107-108号道路","Épave":"弃船","Route 109":"109号道路","Poivressel":"凯那市","Musée Océanographique":"海洋博物馆","Sbire Aqua":"海洋队手下","Route 110":"110号道路","Lavandia":"紫堇市","Arène de Lavandia":"紫堇道馆","Voltère":"铁旋","Dynamo":"发电","Badge Chaleur":"热量徽章","Route 117 → Vermilava":"117号道路 → 釜炎镇","Route 117":"117号道路","Vergazon":"绿荫镇","Route 112":"112号道路","Chemin Ardent":"火焰小径","Route 113":"113号道路","Autéquia":"秋叶镇","Sentier Sinuroc":"凹凸山道","Vermilava":"釜炎镇","Arène de Vermilava":"釜炎道馆","Adriane":"亚莎","Chaleur":"热量","Mont Chimnée":"烟囱山","Route 114 → Mont Chimnée":"114号道路 → 烟囱山","Route 114":"114号道路","Chutes Météore":"流星瀑布","Chef Max":"首领赤焰松","Max, le chef de la Team Magma, veut réveiller le volcan !":"熔岩队首领赤焰松想要唤醒火山！","Badge Balance":"平衡徽章","Route 111 → Clémenti-Ville":"111号道路 → 橙华市","Désert de la Route 111":"111号道路沙漠","Tour Mirage":"幻影之塔","Au sommet de la Tour Mirage, deux fossiles… lequel prends-tu ?":"幻影之塔的顶上有两块化石……你要拿哪一块？","New Lavandia":"新紫堇","Devon SARL":"得文公司","Devon SARL ranime ton fossile !":"得文公司复活了你的化石！","Arène de Clémenti-Ville":"橙华道馆","Norman":"千里","Badge Plume":"羽毛徽章","Route 118 → Cimetronelle":"118号道路 → 茵郁市","Route 118":"118号道路","Route 123":"123号道路","Route 119":"119号道路","Institut Météo":"天气研究所","Pour te remercier d'avoir chassé la Team Aqua, l'Institut Météo te confie un Morphéo !":"为了感谢你赶走了海洋队，天气研究所送给你一只飘浮泡泡！","Route 120":"120号道路","Pierre Rochard te montre son Scope Devon : les Kecleon invisibles se dévoilent !":"大吾给你看了他的得文侦测镜：隐形的变隐龙现出了原形！","Cimetronelle":"茵郁市","Arène de Cimetronelle":"茵郁道馆","Alizée":"娜琪","Plume":"羽毛","Mont Mémoria":"送神山","Route 121 → Mont Mémoria":"121号道路 → 送神山","Route 121":"121号道路","Nénucrique":"水静市","Route 122":"122号道路","Sommet du Mont Mémoria":"送神山山顶","Planque Aqua":"海洋队基地","Admin Aqua":"海洋队干部","Un admin de la Team Aqua garde la planque !":"海洋队的干部守着基地！","Badge Esprit":"心灵徽章","Routes 124-125 → Algatia":"124-125号道路 → 绿岭市","Route 124":"124号道路","Algatia":"绿岭市","Maison de Pierre Rochard":"大吾的家","Maître Hoenn":"丰缘冠军","Pierre Rochard t'a laissé une Poké Ball chez lui : un Terhal !":"大吾在家里给你留了一个精灵球：是铁哑铃！","Route 125":"125号道路","Grotte Tréfonds":"浅滩洞穴","Salle de glace":"冰之间","Centre Spatial":"宇宙中心","Arène d'Algatia":"绿岭道馆","Lévy et Tatia":"小枫与小南","Esprit":"心灵","La crise":"危机","Planque Magma → Caverne Fondmer":"熔岩队基地 → 海底洞窟","Planque Magma":"熔岩队基地","Route 128":"128号道路","Fonds marins":"海底","Caverne Fondmer":"海底洞窟","Chef Arthur":"首领水梧桐","Arthur, le chef de la Team Aqua, veut réveiller Kyogre !":"海洋队首领水梧桐想要唤醒盖欧卡！","Badge Pluie":"雨滴徽章","Route 126 → Atalanopolis":"126号道路 → 琉璃市","Route 126":"126号道路","Grotte Origine":"觉醒祠堂","Route 127":"127号道路","Routes 129-131":"129-131号道路","Pacifiville":"暮水镇","Routes 132-134":"132-134号道路","Atalanopolis":"琉璃市","Arène d'Atalanopolis":"琉璃道馆","Juan":"亚当","Pluie":"下雨","Éternara → Route Victoire":"彩幽市 → 冠军之路","Éternara":"彩幽市","Timmy":"满充","Timmy t'attend à la sortie de la Route Victoire !":"满充在冠军之路的出口等着你！","Conseil 4 : Damien":"四天王：花月","Ligue Pokémon":"宝可梦联盟","Damien":"花月","Conseil 4 : Spectra":"四天王：芙蓉","Spectra":"芙蓉","Conseil 4 : Glacia":"四天王：波妮","Glacia":"波妮","Conseil 4 : Aragon":"四天王：源治","Aragon":"源治","Pierre Rochard":"大吾","Badge Charbon":"煤炭徽章","Bonaugure → Charbourg":"双叶镇 → 黑金市","Lac Vérité":"心齐湖","Au bord du Lac Vérité, la mallette du Prof. Sorbier : choisis ton Pokémon !":"心齐湖畔有山梨博士的公文包：选择你的宝可梦吧！","Bonaugure":"双叶镇","Route 201":"201号道路","Louka":"阿驯","Littorella":"真砂镇","Route 202":"202号道路","Féli-Cité":"祝庆市","Route 203":"203号道路","Entrée de Charbourg":"黑金闸口","Charbourg":"黑金市","Mine de Charbourg":"黑金炭坑","Musée Minier de Charbourg":"黑金炭坑博物馆","Au Musée Minier, deux fossiles… lequel prends-tu ?":"炭坑博物馆里有两块化石……你要拿哪一块？","Le Musée Minier ranime ton fossile !":"炭坑博物馆复活了你的化石！","Arène de Charbourg":"黑金道馆","Pierrick":"瓢太","Charbon":"煤炭","Badge Forêt":"森林徽章","Route 204 → Vestigion":"204号道路 → 百代市","Route 204":"204号道路","Floraville":"花苑镇","Pré de Floraville":"花苑花田","Route 205 (sud)":"205号道路（南）","Les Éoliennes":"山谷发电厂","Capture d'abord Motisma":"先捕获洛托姆","Les éoliennes s'emballent sous l'orage… un Motisma Hélice en surgit !":"风车在雷雨中疯狂转动……一只旋转洛托姆冒了出来！","mars":"3月","Mars":"伙星","Forêt Vestigion":"百代森林","Vieux Château":"森之洋馆","Télé du Vieux Château":"森之洋馆的电视","La télé du Vieux Château s'allume toute seule… un Motisma en surgit !":"森之洋馆的电视自己打开了……一只洛托姆冒了出来！","Route 205 (est)":"205号道路（东）","Vestigion":"百代市","Bâtiment Galaxie de Vestigion":"银河百代大楼","Jupiter":"岁星","Cynthia te confie un œuf pour te remercier : il part couver à la Pension !":"竹兰为了感谢你，交给你一颗蛋：它会被送到培育屋孵化！","Arène de Vestigion":"百代道馆","Flo":"菜种","Forêt":"森林","Badge Fantôme":"遗迹徽章","Route 206 → Unionpolis":"206号道路 → 家缘市","Route 206":"206号道路","Grotte Revêche":"迷幻洞窟","Route 207":"207号道路","Mont Couronné":"天冠山","Route 208":"208号道路","Unionpolis":"家缘市","Une habitante d'Unionpolis te confie un Évoli !":"一位家缘市的居民送给你一只伊布！","Square Paisible":"互动广场","Arène d'Unionpolis":"家缘道馆","Kiméra":"梅丽莎","Fantôme":"遗迹","Badge Pavé":"铺石徽章","Route 209 → Voilaroc":"209号道路 → 帷幕市","Route 209":"209号道路","Tour Perdue":"迷失塔","Tour Sacrée":"灵魂之塔","Capture tous les Pokémon Spectre":"捕获所有幽灵属性宝可梦","Les 108 âmes de la Tour Sacrée se réveillent… Spiritomb apparaît !":"灵魂之塔的108个灵魂苏醒了……花岩怪出现了！","Bonville":"随意镇","Ruines de Bonville":"随意遗迹","Route 210 (sud)":"210号道路（南）","Route 215":"215号道路","Voilaroc":"帷幕市","Un habitant de Voilaroc te confie un Porygon !":"一位帷幕市的居民送给你一只多边兽！","Arène de Voilaroc":"帷幕道馆","Mélina":"阿李","Pavé":"铺石","Badge Palustre":"湿地徽章","Route 214 → Verchamps":"214号道路 → 野原市","Hangar Galaxie":"银河仓库","Route 214":"214号道路","Tunnel du Ruinemaniac":"遗迹迷隧道","Hôtel Grand Lac":"湖畔大饭店","Rive du Lac Courage":"立志湖畔","Route 213":"213号道路","Un Motisma Lavage s'échappe de la buanderie de l'Hôtel Grand Lac, sous la pluie !":"雨中，一只清洗洛托姆从湖畔大饭店的洗衣房溜了出来！","Verchamps":"野原市","Grand Marais":"大湿地","Route 212 (sud)":"212号道路（南）","Jardin Trophée":"自豪的后院","Un Motisma Tonte file entre les massifs du Jardin Trophée !":"一只切割洛托姆在自豪的后院的花坛间飞驰！","Route 212 (nord)":"212号道路（北）","Arène de Verchamps":"野原道馆","Lovis":"吉宪","Palustre":"湿地","Badge Mine":"矿山徽章","Route 210 → Joliberges":"210号道路 → 水脉市","Route 210 (nord)":"210号道路（北）","Célestia":"神和镇","Route 211":"211号道路","Mont Couronné (Route 211)":"天冠山（211号道路）","Route 218":"218号道路","Joliberges":"水脉市","Arène de Joliberges":"水脉道馆","Charles":"东瓜","Mine":"矿山","Les Lacs":"三座湖","Île de Fer → Lac Vérité":"钢铁岛 → 心齐湖","Rivage de l'Île de Fer":"钢铁岛海岸","Île de Fer":"钢铁岛","Armand te confie un œuf pour te remercier : il part couver à la Pension !":"亚玄为了感谢你，交给你一颗蛋：它会被送到培育屋孵化！","Lac Courage asséché":"干涸的立志湖","Mars, commandante de la Team Galaxie, garde le Lac Vérité !":"银河队干部伙星守着心齐湖！","Badge Glaçon":"冰河徽章","Route 216 → Frimapic":"216号道路 → 雪峰市","Mont Couronné (Route 216)":"天冠山（216号道路）","Route 216":"216号道路","Route 217":"217号道路","Un Motisma Froid surgit du blizzard, dans la nuit !":"夜里，一只结冰洛托姆从暴风雪中冒了出来！","Frimapic":"雪峰市","Rive du Lac Savoir":"睿智湖畔","Lac Savoir":"睿智湖","Arène de Frimapic":"雪峰道馆","Gladys":"小菘","Glaçon":"冰河","QG Galaxie":"银河队基地","Voilaroc → QG Galaxie":"帷幕市 → 银河队基地","Hélio":"赤日","Saturne":"镇星","Saturne, commandant de la Team Galaxie, te barre la route !":"银河队干部镇星挡住了你的去路！","Monde Distorsion":"毁坏的世界","Mont Couronné → Monde Distorsion":"天冠山 → 毁坏的世界","Mont Couronné enneigé":"积雪的天冠山","Colonnes Lances":"枪之柱","Source Adieu":"送行之泉","Dans le Monde Distorsion, Hélio veut recréer le monde !":"在毁坏的世界里，赤日想要重新创造世界！","Badge Phare":"灯塔徽章","Routes 219-222 → Rivamar":"219-222号道路 → 滨海市","Route 219":"219号道路","Chenal 220":"220号水路","Maître Sinnoh":"神奥冠军","Route 221":"221号道路","Route 222":"222号道路","Rivamar":"滨海市","Arène de Rivamar":"滨海道馆","Tanguy":"电次","Phare":"灯塔","Chenal 223 → Route Victoire":"223号水路 → 冠军之路","Chenal 223":"223号水路","Louka t'attend avant la Ligue !":"阿驯在联盟前等着你！","Conseil 4 : Aaron":"四天王：阿柳","Aaron":"阿柳","Conseil 4 : Terry":"四天王：菊野","Terry":"菊野","Conseil 4 : Adrien":"四天王：大叶","Adrien":"大叶","Conseil 4 : Lucio":"四天王：悟松","Lucio":"悟松","Cynthia":"竹兰","Mont Abrupt":"严酷山","Aire de Combat → Mont Abrupt":"战斗区 → 严酷山","Aire de Combat":"战斗区","Route 225":"225号道路","Chenal 226":"226号水路","Route 227":"227号道路","Un Motisma Chaleur surgit des cendres brûlantes !":"一只加热洛托姆从炽热的灰烬中冒了出来！","Aire de Survie":"生存区","Route 228":"228号道路","Pluton":"冥王","Pluton veut capturer Heatran au cœur du Mont Abrupt !":"冥王想在严酷山深处捕捉席多蓝恩！","Badge Triple":"三元徽章","Renouet → Ogoesse":"鹿子镇 → 三曜市","Renouet":"鹿子镇","Chez toi à Renouet, le cadeau du Prof. Keteleeria : choisis ton Pokémon !":"在鹿子镇的家里，红豆杉博士送来的礼物：选择你的宝可梦吧！","Arabelle":"唐草镇","N":"N","Ogoesse":"三曜市","À Ogoesse, une serveuse du restaurant te confie un Pokémon pour affronter l'arène !":"在三曜市，餐厅的女服务员把一只宝可梦托付给你，让你去挑战道馆！","Vestiges du Rêve":"梦的遗址","Arène d'Ogoesse":"三曜道馆","Rachid":"天桐","Triple":"三元徽章","Armando":"伯特","Noa":"寇恩","Badge Basique":"基础徽章","Route 3 → Maillard":"3号道路 → 七宝市","Veine Souterraine":"泉源洞穴","Route 3 (est)":"3号道路（东）","Maillard":"七宝市","Musée de Maillard":"七宝博物馆","Le Musée de Maillard ranime ton fossile !":"七宝博物馆复活了你的化石！","Arène de Maillard":"七宝道馆","Aloé":"芦荟","Basique":"基础徽章","Badge Élytre":"甲虫徽章","Forêt d'Empoigne → Volucité":"矢车森林 → 飞云市","Forêt d'Empoigne":"矢车森林","Forêt d'Empoigne (est)":"矢车森林（东）","Pont Sagiciel":"天箭桥","Volucité":"飞云市","Arène de Volucité":"飞云道馆","Artie":"亚堤","Élytre":"甲虫徽章","Château Enfoui":"古代城","Route 4 → Château Enfoui":"4号道路 → 古代城","Désert Délassant":"荒野名胜区","À l'entrée du Château Enfoui, un Montagnard te montre deux fossiles trouvés dans le sable… lequel prends-tu ?":"在古代城的入口，一位登山男给你看了两块在沙中发现的化石……你要哪一块？","Maître Unys":"合众冠军","Sous le soleil ardent, un œuf brûlant affleure du sable… il part couver à la Pension !":"在大晴天下，一颗滚烫的蛋从沙中露了出来……它将被送去培育屋孵化！","Tcheren":"黑连","Badge Volt":"伏特徽章","Méanville → Route 5":"雷文市 → 5号道路","Route 4 (nord)":"4号道路（北）","Méanville":"雷文市","Route 16":"16号道路","Arène de Méanville":"雷文道馆","Inezia":"小菊儿","Volt":"伏特徽章","Badge Sismique":"震动徽章","Pont Yoneuve → Port Yoneuve":"帆巴吊桥 → 帆巴市","Pont Yoneuve":"帆巴吊桥","Port Yoneuve":"帆巴市","Hangar Frigorifique":"冷冻仓库","Arène de Port Yoneuve":"帆巴道馆","Bardane":"菊老大","Sismique":"震动徽章","Badge Jet":"喷射徽章","Route 6 → Parsemille":"6号道路 → 吹寄市","Route 6 (nord)":"6号道路（北）","Grotte Électrolithe":"电气石洞穴","Grotte Parsemille":"吹寄洞穴","Les dix crocs brisés mènent à un nid au fond de la grotte… un Coupenotte surgit !":"十颗断牙指向洞穴深处的一个巢穴……牙牙出现了！","Parsemille":"吹寄市","Arène de Parsemille":"吹寄道馆","Carolina":"风露","Jet":"喷射徽章","Badge Stalactite":"冰柱徽章","Route 7 → Flocombe":"7号道路 → 雪花市","Tour des Cieux":"天堂之塔","Route 7 (nord)":"7号道路（北）","Mont Foré":"罗斯山","Flocombe":"雪花市","Arène de Flocombe":"雪花道馆","Zhu":"哈奇库","Tour Dragospire":"龙螺旋之塔","Tourbière Flocombe → Tour Dragospire":"雪花湿地 → 龙螺旋之塔","Tourbière Flocombe":"雪花湿地","Bianca":"白露","Badge Mythe":"传说徽章","Route 9 → Janusia":"9号道路 → 双龙市","Route 9 (est)":"9号道路（东）","Janusia":"双龙市","Arène de Janusia":"双龙道馆","Watson":"夏卡","Mythe":"传说徽章","Iris":"艾莉丝","Route 10 → Route Victoire":"10号道路 → 冠军之路","Conseil 4 : Anis":"四天王：婉龙","Anis":"婉龙","Conseil 4 : Pieris":"四天王：越橘","Pieris":"越橘","Conseil 4 : Percila":"四天王：嘉德丽雅","Percila":"嘉德丽雅","Conseil 4 : Kunz":"四天王：连武","Kunz":"连武","Palais de N":"N的城堡","Ghetis":"魁奇思","Grotte Cyclopéenne":"巨人洞窟","Route 11 → Grotte Cyclopéenne":"11号道路 → 巨人洞窟","Pont du Hameau":"村庄桥","Route 13":"13号道路","Vaguelone":"涟漪镇","Baie Vaguelone":"涟漪湾","Route 14":"14号道路","Entrelasque":"笼目镇","Route 15":"15号道路","Forêt Blanche":"白森林","Ville Noire":"黑色市","Bois des Illusions":"迷幻森林","Goyah":"阿戴克","Kanto":"关都","Johto":"城都","Hoenn":"丰缘","Sinnoh":"神奥","Unys":"合众","Kalos":"卡洛斯","Alola":"阿罗拉","Galar":"伽勒尔","Paldea":"帕底亚","Grotte Ardente":"炽热洞窟","Caverne Azurée":"华蓝洞窟","Île Lointaine":"遥远的孤岛","Tour Carillon":"铃铛塔","Ruines du Désert":"沙漠遗迹","Grotte de l'Île":"小岛横穴","Tombeau Antique":"古代墓穴","Grotte Terra":"大地洞穴","Grotte Marine":"海洋洞穴","Sommet des Vœux":"许愿山顶","Île Aurore":"诞生之岛","Obtiens un ticket pour l'Île Aurore":"获得前往诞生之岛的船票","Caverne Savoir":"睿智洞窟","Caverne Courage":"立志洞窟","Bats {n} dresseurs dans la région":"在该地区打败{n}位训练家","Faille Temporelle":"时间裂缝","Possède Créhelf, Créfollet et Créfadet":"拥有由克希、艾姆利多和亚克诺姆","Trouve l'Orbe Adamant au Mont Couronné":"在天冠山找到金刚宝珠","Faille Spatiale":"空间裂缝","Trouve l'Orbe Perlé au Mont Couronné":"在天冠山找到白玉宝珠","Grotte Retour":"归途洞窟","Possède Dialga et Palkia":"拥有帝牙卢卡和帕路奇亚","Cœur de la Distorsion":"毁坏的世界深处","Possède Giratina (Forme Alternative)":"拥有骑拉帝纳（别种形态）","Trouve l'Orbe Platiné au Mont Couronné enneigé":"在积雪的天冠山找到白金宝珠","Cœur du Mont Abrupt":"严酷山深处","Temple de Frimapic":"雪峰神殿","Trouve le Galet Blanc au Château Enfoui":"在古代城找到光明石","Trouve le Galet Noir au Château Enfoui":"在古代城找到黑暗石","Possède Reshiram et Zekrom":"拥有莱希拉姆和捷克罗姆","Kyurem Noir":"暗黑酋雷姆","Possède Kyurem":"拥有酋雷姆","Kyurem Blanc":"焰白酋雷姆","Salle Épreuve":"试练之室","Labo P2":"P2实验室","Module Aqua":"水流卡带","Possède Genesect":"拥有盖诺赛克特","Trouve le Module Aqua":"找到水流卡带","Module Choc":"闪电卡带","Trouve le Module Choc":"找到闪电卡带","Module Pyro":"火焰卡带","Trouve le Module Pyro":"找到火焰卡带","Module Cryo":"冰冻卡带","Trouve le Module Cryo":"找到冰冻卡带","Île Liberté":"自由庭园岛","Théâtre de Méanville":"雷文市音乐剧剧场","Possède Victini et Keldeo":"拥有比克提尼和凯路迪欧","Ballet de Méanville":"雷文市芭蕾舞","Possède Meloetta (Forme Chant)":"拥有美洛耶塔（歌声形态）","Autel Abondance":"丰饶之祠","Reflet du Miroir Sacré":"现形镜的倒影","Possède Boréas":"拥有龙卷云","Trouve le Miroir Sacré sur la Route 14":"在14号道路找到现形镜","Possède Fulguris":"拥有雷电云","Possède Démétéros":"拥有土地云","Île Pleine Lune":"满月岛","Île Nouvellune":"新月岛","Possède Cresselia":"拥有克雷色利亚","Paradis Fleuri":"花之乐园","Ciel du Paradis Fleuri":"花之乐园的天空","Possède Shaymin (Forme Terrestre)":"拥有谢米（陆上形态）","Trouve la Gracidée au Pré de Floraville":"在花苑花田找到葛拉西蒂亚花","Pilier Céleste":"天空柱","Possède Groudon et Kyogre":"拥有固拉多和盖欧卡","Halloween":"万圣节","Baie Framby":"蔓莓果","Baie Framby dorée":"金色蔓莓果","Baie Nanab":"蕉香果","Baie Enigma":"谜芝果","Baie Nanana":"凰梨果","Baie Lansat":"兰萨果","Baie Frista":"星桃果","Baie Pommo":"雾莲果"}};
  const TYPE_NAMES = {normal:'一般',fire:'火',water:'水',electric:'电',grass:'草',ice:'冰',fighting:'格斗',poison:'毒',ground:'地面',flying:'飞行',psychic:'超能力',bug:'虫',rock:'岩石',ghost:'幽灵',dragon:'龙',dark:'恶',steel:'钢',fairy:'妖精'};
  const REGION_NAMES = {kanto:'关都',johto:'城都',hoenn:'丰缘',sinnoh:'神奥',unova:'合众',kalos:'卡洛斯',alola:'阿罗拉',galar:'伽勒尔',paldea:'帕底亚'};
  const KIND_NAMES = {wild:'野生宝可梦',trainer:'训练家',gym:'道馆',story:'剧情战斗',heal:'回复点',boss:'首领',league:'联盟',chapter:'章节','elite zone':'精英区域',rival:'劲敌',legend:'传说宝可梦'};
  const FORM_NAMES = {38601:'代欧奇希斯（攻击形态）',38602:'代欧奇希斯（防御形态）',38603:'代欧奇希斯（速度形态）',48701:'骑拉帝纳（起源形态）',49201:'谢米（天空形态）',64101:'龙卷云（灵兽形态）',64201:'雷电云（灵兽形态）',64501:'土地云（灵兽形态）',64601:'暗黑酋雷姆',64602:'焰白酋雷姆',64801:'美洛耶塔（舞步形态）',64901:'盖诺赛克特（水流卡带）',64902:'盖诺赛克特（闪电卡带）',64903:'盖诺赛克特（火焰卡带）',64904:'盖诺赛克特（冰冻卡带）'};
  const zhType = t => TYPE_NAMES[t] || t;
  const zhRegion = r => REGION_NAMES[r] || r;
  const zhText = s => (window.I18N || {})['zh-Hans']?.[s] || ZH_NAMES.text[s] || s;
  const zhKind = k => KIND_NAMES[k] || zhText(k);
  function zhError(message) {
    return String(message ?? '').replace(/this chapter has a single segment — nothing to switch/g, '本章只有一段，无需自动换队')
      .replace(/all team templates are used — use free all templates/g, '所有队伍模板均已使用；可选择允许复用全部模板')
      .replace(/no battles in this chapter/g, '当前章节尚无可模拟的战斗，请先进入章节')
      .replace(/team screen not reachable/g, '无法打开队伍／盒子页面')
      .replace(/team template (\d+) not found/g, '未找到队伍模板 $1')
      .replace(/invalid game tables/g, '游戏数据不完整，请重新读取')
      .replace(/segments: /g, '分段配队失败：').replace(/game update changed the bundle: implausible /g, '游戏更新后，以下数据表未通过校验：')
      .replace(/game update changed the bundle: /g, '游戏更新导致数据格式变化：')
      .replace(/bundle parse failed: /g, '游戏数据解析失败：')
      .replace(/learnset error: /g, '招式学习表读取失败：')
      .replace(/legend optimizer error: /g, '传说配队失败：')
      .replace(/optimizer error: /g, '配队失败：').replace(/apply failed: /g, '应用队伍失败：')
      .replace(/legend zones not found in the bundle/g, '游戏数据中未找到传说区域')
      .replace(/game bundle not loaded yet/g, '游戏资源尚未加载，请稍后重试')
      .replace(/no candidate found in the PC/g, '盒子中没有符合条件的宝可梦')
      .replace(/no save found|no save/g, '未找到游戏存档，请先进入游戏')
      .replace(/chapter not found/g, '未找到当前章节').replace(/no boss zone/g, '未找到首领区域')
      .replace(/team screen not available/g, '无法打开队伍／盒子页面')
      .replace(/team slots not found/g, '未找到队伍位置')
      .replace(/network error|Failed to fetch/g, '网络请求失败').replace(/timeout/g, '请求超时')
      .replace(/unbalanced literal/g, '数据括号不匹配').replace(/marker not found:?/g, '未找到数据标记：')
      .replace(/no literal after /g, '此标记后没有可读取的数据：')
      .replace(/incomplete type chart/g, '属性克制表不完整').replace(/type table not found/g, '未找到属性表')
      .replace(/not found/g, '未找到');
  }
  function gameSearchName(id, picker = false) {
    const entry = i18n()?.pokemon?.[id];
    const name = Array.isArray(entry) ? entry[0] : entry;
    if (name) return name;
    const lang = window.LANG_PICK?.lang || document.documentElement.lang;
    if ((lang === 'zh-Hans' || lang === 'zh-CN') && ZH_NAMES.pokemon[id]) return ZH_NAMES.pokemon[id];
    const en = englishData()?.pokemon?.[id];
    if (lang === 'en' && en) return Array.isArray(en) ? en[0] : en;
    if (lang === 'fr' && state.data?.species?.[id]?.name) return state.data.species[id].name;
    // Both native search boxes accept a Pokédex number. Event pickers use a form's base number.
    // This fallback keeps drag-and-drop working even when the page's locale pack is hidden.
    return String(picker && id >= 10000 ? Math.floor(id / 100) : id);
  }

  /** Active game language for search queries. */
  function i18n() {
    const data = window.I18N_DATA || {};
    const lang = window.LANG_PICK?.lang || document.documentElement.lang;
    return data[lang] || (lang ? null : Object.values(data)[0]) || null;
  }
  /** The game ships an English pack even in other languages: use it for every name. */
  function englishData() {
    return (window.I18N_DATA || {}).en || null;
  }
  async function ensureEnglish() {
    if (englishData()) return true;
    const load = async url => {
      const code = await httpGet(url);
      // Upstream 1.6.4: keep names inside the userscript realm, rather than the page realm.
      (0, eval)(code);
      return url;
    };
    try {
      // the page may already carry the pack, else the boot manifest lists every language bundle
      const onPage = document.querySelector('script[src*="lang-en"]')?.src;
      if (onPage) await load(onPage);
      else {
        const base = bundleUrl() || document.querySelector('script[src*="/boot.js"]')?.src || location.href;
        const boot = await httpGet(new URL('/boot.js', base).href);
        const m = boot.match(/bundle\/(lang-en\.[0-9a-z]+\.js)/);
        if (!m) { log('warn', 'names: no English pack in the boot manifest'); return false; }
        await load(new URL('/bundle/' + m[1], base).href);
      }
      log('info', 'names: English pack loaded');
    } catch (e) { logError('names: English pack', e); }
    if (englishData()) { refreshUi(); return true; }
    return false;
  }
  function displayName(id) {
    const zh = (window.I18N_DATA || {})['zh-Hans']?.pokemon?.[id];
    const chinese = (Array.isArray(zh) ? zh[0] : zh) || ZH_NAMES.pokemon[id] || FORM_NAMES[id];
    if (chinese) return chinese;
    const en = englishData()?.pokemon?.[id];
    const name = Array.isArray(en) ? en[0] : en;
    if (name) return name;
    const lang = i18n();
    const n = lang?.pokemon?.[id];
    return (Array.isArray(n) ? n[0] : n) || state.data?.species?.[id]?.name || ('#' + id);
  }
  function displayMove(key) {
    const zh = (window.I18N_DATA || {})['zh-Hans']?.moves?.[key] || ZH_NAMES.moves[key];
    if (zh) return Array.isArray(zh) ? zh[0] : zh;
    const en = englishData()?.moves?.[key];
    const name = Array.isArray(en) ? en[0] : en;
    if (name) return name;
    const lang = i18n();
    const n = lang?.moves?.[key];
    return (Array.isArray(n) ? n[0] : n) || state.data?.moves?.[key]?.name || key;
  }

  /** The game's own type badge (same markup as the rest of the UI). */
  const typeBadge = t => `<span class="type sm" data-type="${t}" style="--tc:${typeColor(t)};background:var(--tc)">${zhType(t)}</span>`;

  function typeChips(enemies, data) {
    if (!enemies || !data) return '<span class="pcopt-mut">暂无数据</span>';
    const counts = {};
    for (const e of enemies) {
      const types = data.species[e.id]?.types || [];
      const w = (KIND_WEIGHT[e.kind] || 1) * (e.weight || 1);
      for (const t of types) counts[t] = (counts[t] || 0) + w;
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, [, c]) => a + c, 0) || 1;
    return entries.map(([t, c]) => `${typeBadge(t)}<span class="pcopt-mut">${Math.round(c / total * 100)}%</span>`).join('');
  }

  function renderFails() {
    const fails = state.watcher?.fails || [];
    if (!fails.length) return '<div class="pcopt-mut">尚无团灭记录</div>';
    return fails.map(f => {
      const foes = (f.enemies || []).map(e => displayName(e.id) + ' 等级 ' + e.level).join('，');
      const meta = '第 ' + (f.node+1) + ' 步' + ' · ' + zhKind(f.kind || '')
        + (f.why && f.why !== 'chapter' ? ' · ' + zhKind(f.why) : '')
        + (f.lv ? ' · 等级 ' + f.lv.join('-') : '')
        + (f.firstKo ? ' · 首次倒下：第 ' + (f.firstKo.node+1) + ' 步' : '');
      return `<div class="pcopt-fail" style="padding:6px 0;border-bottom:1px solid var(--line)"><div><b>${esc(zhText(f.name))}</b> <span class="pcopt-mut">${esc(meta)}</span></div><div class="pcopt-mut">${esc(foes)}</div><div class="pcopt-mut">${esc(new Date(f.at).toLocaleTimeString('zh-CN'))}</div></div>`;
    }).join('');
  }



  /** The Defense / Offense / Balanced switch (same preset for both optimizers). */
  const presetSeg = () => `<div class="seg" data-presets>
    <button data-preset="defense" class="${state.preset === 'defense' ? 'on' : ''}">防守</button>
    <button data-preset="offense" class="${state.preset === 'offense' ? 'on' : ''}">进攻</button>
    <button data-preset="balanced" class="${state.preset === 'balanced' ? 'on' : ''}">均衡</button></div>`;

  function renderTeam(){
    if(!state.team)return '<div class="pcopt-mut">按实际等级、当前形态和当前状态计算，不预设练到等级上限。</div>';
    return state.team.map((candidate,i)=>{
      const mon=candidate.mon,sp=candidate.species,was=(state.sim?.baseline&&readSave()?.team||[]).includes(mon.uid);
      return `<div class="pcopt-mon"><div><b>${i+1}. ${esc(displayName(mon.id))}</b> <span class="pcopt-mut">当前等级 ${mon.level}${mon.shiny?' ✨':''}${mon.rank?' · 阶级 '+mon.rank:''}</span><div class="pcopt-row">${sp.types.map(typeBadge).join('')}</div><div class="pcopt-mut">${esc(candidate.bestMoveKey?displayMove(candidate.bestMoveKey):'无可用攻击招式')} · 预计伤害 ${Math.round(candidate.avgDmg||0)}/回合 · 预计承受 ${Math.round(candidate.avgRounds||0)} 回合</div><div class="pcopt-mut">${was?'当前队伍成员':'候选补位'} · ${candidate.hpCur<=0?'当前已倒下':`${state.sim?.scope==='restart'?'满血开局':'首战前生命值'} ${Math.round(candidate.hpCur)}/${candidate.hp}`}</div><div class="pcopt-mut" data-info="${mon.uid}">${state.info[mon.uid]||''}</div></div><div class="pcopt-row"><button class="btn small ghost" data-moves="${mon.uid}">招式</button><button class="btn small ghost" data-api="${mon.uid}">资料核对</button></div></div>`;
    }).join('');
  }


  /* ---- segment teams: one team per stretch between Pokémon Centers ---- */
  /** Split the chapter plan at heal nodes (each segment starts from a healed team). */
  function segmentPlans(plan){
    const result=[];let current=[],healNode=null;
    const push=()=>{if(current.some(s=>s.kind==='battle'))result.push({plan:current,startNode:current[0].nodeIndex,endNode:current[current.length-1].nodeIndex,healNode});current=[]};
    for(const step of plan){if(step.kind==='heal'){push();healNode=step.nodeIndex}else current.push(step)}push();return result;
  }
  function segmentIssue(save,plan=state.segments){
    if(!plan||plan.version!==3)return '请先分析当前路线的分段方案。';
    if(plan.route!==routeSignature(save))return '章节或路线已变化，请重新分析分段。';
    if(plan.list.length!==plan.total)return `分段方案不完整（${plan.list.length}/${plan.total}），请重新分析。`;
    return memberIssue(save,plan.members);
  }
  function sameTeam(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((uid,i)=>b[i]===uid);}
  function templateMatches(save,entry){return entry.slot!=null&&sameTeam(save?.teamSets?.list?.[entry.slot],entry.team);}
  function segmentStatus(save){
    const plan=state.segments;if(!plan)return '';
    const issue=segmentIssue(save,plan);if(issue)return issue;
    const saved=plan.list.filter(e=>templateMatches(save,e)).length;
    return `方案 ${plan.list.length}/${plan.total} 段 · 游戏模板 ${saved}/${plan.total} 已核对${plan.auto?' · 自动提前安排已开启':''}${plan.roster!=null&&plan.roster!==rosterStamp(save)?' · 盒子或等级已更新，可重算':''}`;
  }
  async function prepareSegments(){
    if(state.busy||!state.engine)return;state.busy=true;state.errors=[];state.waiting='正在分析各段用途…';refreshUi();
    const previous=state.segments;if(previous?.auto){previous.auto=false;store.set('segments',previous)}
    try{
      const save=JSON.parse(JSON.stringify(readSave()));if(!save?.adv)throw Error('没有冒险存档。');
      if(save.adv.event||save.adv.zone||save.adv.tower||save.adv.league)throw Error('分段方案用于普通章节，请先退出特殊挑战。');
      const info=chapterInfo(state.data,save.adv.chapter,save),segs=segmentPlans(selectedChapterPlan(state.data,save));if(!segs.length)throw Error('分析范围没有战斗。');
      const list=[];
      for(let i=0;i<segs.length;i++){
        state.waiting=`正在分析第 ${i+1}/${segs.length} 段…`;refreshUi();
        const segment=segs[i],result=await searchChapterTeam(save,info,info.cap,MOBILE_BUILD?3000:4500,segment.plan,{fullHeal:true});if(result.error)throw Error(result.error);
        if(routeSignature(readSave())!==routeSignature(save))throw Error('计算期间章节或路线已变化，请重新分析分段。');
        const team=result.team.map(c=>c.mon.uid),existing=(save.teamSets?.list||[]).findIndex(t=>sameTeam(t,team));
        list.push({startNode:segment.startNode,endNode:segment.endNode,healNode:segment.healNode,team,names:result.team.map(c=>displayName(c.mon.id)),levels:result.team.map(c=>c.mon.level),slot:existing>=0?existing:null,res:result.res,baseline:result.baseline,reason:result.reason,evaluated:result.evaluated,poolSize:result.poolSize,totalCandidates:result.totalCandidates,label:[...new Set(segment.plan.filter(s=>s.kind==='battle').map(s=>zhText(s.name||s.type)))].join(' → ')});
      }
      const members=memberBasis(save,[...new Set(list.flatMap(e=>e.team))]),issue=memberIssue(readSave(),members);if(issue)throw Error(issue);
      if(state.planScope==='after-heal'&&nextHealNode(save)!==nextHealNode(readSave()))throw Error('计算期间已经过目标回复点，请重新分析后续分段。');
      state.segments={version:3,roster:rosterStamp(save),chapter:info.index,route:routeSignature(save),createdAt:Date.now(),scope:state.planScope,list,total:segs.length,members,auto:false,manualUntil:null,pending:null};
      store.set('segments',state.segments);state.segmentNotice=`已分析完整 ${list.length} 段，游戏队伍未改动。可逐段安排，或保存游戏模板后开启自动提前安排。`;
    }catch(error){state.errors=[error.message]}
    finally{state.busy=false;state.waiting=null;state.progress=null;refreshUi()}
  }
  async function arrangeSegment(index){
    if(state.busy)return;const save=readSave(),issue=segmentIssue(save),entry=state.segments?.list[index];if(issue||!entry){state.errors=[issue||'未找到该段方案。'];refreshUi();return}
    state.busy=true;state.errors=[];let result;
    try{
      const candidates=currentCandidates(save,true),team=entry.team.map(uid=>candidates.find(c=>c.mon.uid===uid));if(team.some(c=>!c))throw Error('本段成员已不可用，请重新分析。');
      result=await applyTeam(team);if(!result.ok&&!result.cancelled)throw Error(result.error);
      state.segments.manualUntil=nextHealNode(readSave());state.segments.pending=null;
      const slot=readSave()?.teamSets?.on;if(slot!=null&&sameTeam(readSave()?.teamSets?.list?.[slot],entry.team))entry.slot=slot;
      store.set('segments',state.segments);state.segmentNotice=result.ok?`第 ${index+1} 段安排已核对；当前战斗不换人。已暂停本次回复前的自动安排。`:`安排已停止，${result.verified}/${entry.team.length} 个位置符合本段方案，可再次安排。`;
    }catch(error){state.errors=[error.message];result={...result,ok:false,error:error.message,verified:result?.verified??0}}
    finally{state.busy=false;state.waiting=null;refreshUi();if(result)finishPlacement(result)}
  }
  async function saveSegmentTemplates(){
    if(state.busy)return;const snapshot=readSave(),plan=state.segments,issue=segmentIssue(snapshot,plan);if(issue){state.errors=[issue];refreshUi();return}
    for(const entry of plan.list)if(!templateMatches(snapshot,entry)){const match=(snapshot.teamSets?.list||[]).findIndex(t=>sameTeam(t,entry.team));if(match>=0)entry.slot=match;}
    const originalSlot=snapshot.teamSets?.on;if(originalSlot==null){state.errors=['请先在游戏队伍页选定一个当前队伍模板，再保存分段模板；助手会保留它。'];refreshUi();return}
    const used=new Set([originalSlot]),jobs=[];
    for(const entry of plan.list)if(templateMatches(snapshot,entry)){used.add(entry.slot)}
    const free=Array.from({length:5},(_,i)=>i).filter(i=>!used.has(i)&&(!snapshot.teamSets?.list?.[i]?.length||state.reuseAll||sameTeam(snapshot.teamSets?.list?.[i],plan.ownedTemplates?.[i])));
    const missing=[...new Map(plan.list.filter(e=>!templateMatches(snapshot,e)).map(e=>[JSON.stringify(e.team),e])).values()];
    if(free.length<missing.length){state.errors=[`需要 ${missing.length} 个可写模板，目前只有 ${free.length} 个。方案已完整保留；可手动逐段安排，或允许覆盖其他模板后保存。`];refreshUi();return}
    for(const entry of missing)jobs.push({entry,slot:free.shift()});
    if(!jobs.length){store.set('segments',plan);state.segmentNotice='所有分段的游戏模板已经一致，可以开启自动提前安排。';refreshUi();return}
    state.busy=true;state.errors=[];plan.auto=false;plan.pending=null;store.set('segments',plan);let completed=0,result;
    const job=startPlacement(jobs.reduce((n,x)=>n+x.entry.team.length,0));job.mode='templates';job.segmentsTotal=jobs.length;job.desired=snapshot.team.slice();
    document.querySelector('#pcopt-placement [data-place-help]').textContent='保存时会短暂切换安排名单，每个模板保存后恢复原安排。相同阵容可共用模板。请暂勿操作，可取消；冒险仍会继续。';
    const roadBefore=(snapshot.road||[]).slice(),boundary=nextHealNode(snapshot),touched=new Set();
    job.guard=()=>{const save=readSave();if(job.restoring)return '';if(routeSignature(save)!==plan.route)return '章节或路线已变化，已停止保存后续模板。';if(boundary>=0&&(save.adv.node||0)>boundary||!sameTeam(save.road||[],roadBefore))return '保存期间游戏已回复或出战队伍改变，已停止后续模板；请核对实际出战成员。';return memberIssue(save,plan.members)};
    try{
      if(!await gotoTeamScreen())throw Error('无法进入队伍页。');
      for(let i=0;i<jobs.length;i++){
        const {entry,slot}=jobs[i];job.segment=i;job.offset=completed;const stop=job.guard();if(stop)cancelPlacement(stop);if(job.cancelled)break;
        state.selfClick=true;try{document.querySelector(`#team-sets button[data-set="${slot}"]`)?.click()}finally{state.selfClick=false}
        touched.add(slot);await sleep(120);if(readSave()?.teamSets?.on!==slot)throw Error('游戏模板未选中，已停止保存。');
        const save=readSave(),candidates=currentCandidates(save,true),team=entry.team.map(uid=>candidates.find(c=>c.mon.uid===uid));
        const applied=await applyTeam(team,{job});if(!applied.ok){if(applied.cancelled)break;throw Error(applied.error)}
        // Native refresh updates the active template after its save call. Selecting the
        // original template flushes that last change and restores the planned team atomically.
        state.selfClick=true;try{document.querySelector(`#team-sets button[data-set="${originalSlot}"]`)?.click()}finally{state.selfClick=false}
        if(!sameTeam(readSave()?.teamSets?.list?.[slot],entry.team))throw Error('游戏模板内容核对失败，已停止后续保存。');
        for(const other of plan.list)if(sameTeam(other.team,entry.team))other.slot=slot;completed+=entry.team.length;job.verified=completed;store.set('segments',plan);
      }
      const saved=plan.list.filter(e=>templateMatches(readSave(),e)).length;
      result={ok:!job.cancelled&&saved===plan.total,cancelled:job.cancelled,verified:job.verified,error:job.cancelReason||`已保存 ${saved}/${plan.total} 段。`,templates:true,saved,total:plan.total};
      state.segmentNotice=`游戏模板已核对 ${saved}/${plan.total} 段${saved===plan.total?'，可开启自动提前安排。':'；尚未全部保存，自动未开启。'}`;
    }catch(error){state.errors=[error.message];result={ok:false,verified:job.verified,error:error.message,templates:true}}
    finally{
      job.restoring=true;state.selfClick=true;try{document.querySelector(`#team-sets button[data-set="${originalSlot}"]`)?.click()}finally{state.selfClick=false}
      if(readSave()?.teamSets?.on!==originalSlot||!sameTeam(readSave()?.team,snapshot.team)){result={...result,ok:false,error:'未能恢复原安排模板，请关闭提示核对队伍。',templates:true};state.errors=[result.error]}
      plan.ownedTemplates=plan.ownedTemplates||{};for(const slot of touched)plan.ownedTemplates[slot]=(readSave()?.teamSets?.list?.[slot]||[]).slice();
      job.active=false;document.removeEventListener('visibilitychange',job.onVisibility);state.busy=false;state.waiting=null;state.reuseAll=false;store.set('reuseTemplates',false);store.set('segments',plan);result.saved=plan.list.filter(e=>templateMatches(readSave(),e)).length;result.total=plan.total;refreshUi();finishPlacement(result);
    }
  }


  /** Free every template for the segment planner: the next prepare may overwrite all of them
   *  (the game itself has no delete, so this cannot empty them). */
  function freeTemplates(){
    if(state.busy)return;state.reuseAll=!state.reuseAll;store.set('reuseTemplates',state.reuseAll);
    const save=readSave(),slots=(save?.teamSets?.list||[]).map((list,i)=>list?.length&&i!==save.teamSets.on?i+1:null).filter(n=>n!=null);
    state.segmentNotice=state.reuseAll?`下次保存允许覆盖其他模板${slots.length?'（'+slots.join('、')+'）':''}；当前模板保留，分段方案未改动。`:'已取消覆盖许可，下次保存只使用空模板和本方案未改动的草稿。';refreshUi();
  }


  /** Manual template switch (Progress screen). The watcher leaves it alone until the next segment. */
  async function switchTemplate(slot){
    if(state.busy)return;let button=document.querySelector(`#team-sets button[data-set="${slot}"]`);
    if(!button){if(!await gotoTeamScreen())return;button=document.querySelector(`#team-sets button[data-set="${slot}"]`)}
    if(!button){state.errors=['未找到对应队伍模板。'];refreshUi();return}
    state.selfClick=true;try{button.click();if(readSave()?.teamSets?.on!==slot)throw Error('游戏模板未切换，请重试。');
      if(state.segments?.version===3){state.segments.manualUntil=nextHealNode(readSave());state.segments.pending=null;store.set('segments',state.segments)}
      state.segmentNotice='手动安排已保存，本次回复前自动不会覆盖；实际换人仍等游戏回复。';
    }catch(error){state.errors=[error.message]}finally{state.selfClick=false;refreshUi()}
  }


  /** The current segment index of the running chapter (heal nodes split it).
   *  The switch happens one node BEFORE a center: the game heals the team when
   *  the heal node starts, so a team fielded at the center would miss the heal. */
  function segmentIndex(save){
    const plan=state.segments;if(!plan||plan.version!==3||plan.route!==routeSignature(save))return null;
    const node=save.adv.node||0;let found=null;for(let i=0;i<plan.list.length;i++)if(node>=plan.list[i].startNode)found=i;return found;
  }
  function nextSegmentTarget(save){
    const plan=state.segments;if(!plan||plan.route!==routeSignature(save))return null;
    const node=save.adv.node||0;const entry=plan.list.find(e=>e.healNode!=null&&e.healNode>=node);return entry||null;
  }
  async function switchSegment(){
    const plan=state.segments;if(!plan?.auto||state.busy||state.switching||document.hidden||roamerHunt)return;
    const save=readSave(),stop=reason=>{plan.auto=false;plan.pending=null;state.segmentNotice=reason;store.set('segments',plan);refreshUi()};
    const issue=segmentIssue(save,plan);if(issue){stop(issue+' 自动安排已停止。');return}
    if(plan.pending&&(save.adv.node||0)>plan.pending.heal){
      const latest=plan.list.filter(e=>e.healNode!=null&&e.healNode<(save.adv.node||0)).at(-1);if(latest?.healNode>plan.pending.heal){stop('已经跨过后续回复点，下一段未能及时安排。自动已停止，请检查出战队伍。');return}
      const expected=plan.list.find(e=>e.healNode===plan.pending.heal);if(!expected||!sameTeam(save.road,expected.team)){stop('已经过回复点，但出战名单与预定方案不同。自动安排已停止，请核对后再开启。');return}
      state.segmentNotice=`回复后已核对第 ${plan.list.indexOf(expected)+1} 段出战队伍。`;plan.pending=null;store.set('segments',plan);
    }
    if(plan.manualUntil!=null){if(plan.manualUntil<0||(save.adv.node||0)<=plan.manualUntil){state.segmentNotice='本次回复前保留你的手动安排；经过该回复点后再自动准备后续段。';return}plan.manualUntil=null;}
    const target=nextSegmentTarget(save);if(!target){plan.auto=false;state.segmentNotice='本次路线的后续回复点已全部经过，自动安排已结束。';store.set('segments',plan);refreshUi();return}
    if(!templateMatches(save,target)){stop('下一段的游戏模板已变化或尚未保存，请重新保存模板后开启自动。');return}
    if(sameTeam(save.team,target.team)){if(plan.pending?.heal!==target.healNode){plan.pending={heal:target.healNode};store.set('segments',plan)}return}
    state.switching=true;state.selfClick=true;
    try{
      const button=document.querySelector(`#team-sets button[data-set="${target.slot}"]`);if(!button){state.segmentNotice='等待游戏队伍模板就绪；未改动现有安排。';return}
      button.click();const now=readSave();if(!sameTeam(now.team,target.team)){stop('游戏没有采纳下一段安排，自动已停止，请检查模板或成员限制。');return}
      plan.pending={heal:target.healNode};state.segmentNotice=`已提前安排第 ${plan.list.indexOf(target)+1} 段，等待第 ${target.healNode+1} 步回复；当前战斗继续用原出战队伍。`;store.set('segments',plan);
    }finally{state.switching=false;state.selfClick=false;refreshUi()}
  }


  /** The simulation progress bar: updated in place so the panel never flickers. */
  function updateProgress() {
    const bar = document.getElementById('pcopt-simbar');
    if (state.progress) {
      if (!bar) { refreshUi(); return; }
      bar.style.display = 'flex';
      const fill = bar.firstElementChild.firstElementChild;
      fill.style.width = Math.round((state.progress.pct || 0) * 100) + '%';
      bar.lastElementChild.textContent = state.progress.label || '';
    } else if (bar) bar.style.display = 'none';
  }

  /** What the mon becomes at the cap through level evolutions (display only). */
  function endFormAtCap(mon, cap) {
    let cur = mon.id;
    for (let hop = 0; hop < 4; hop++) {
      const next = (state.data.evo[cur] || []).find(e => e.level != null && e.level <= cap && state.data.species[e.to]);
      if (!next) break;
      cur = next.to;
    }
    return cur;
  }

  /* ------------------------------------------------------------------ *
   * 9b. UI — every block lives inside the game's own screens
   *     Progress: run monitor (chapter, events, wipes, status)
   *     Team/PC:  chapter optimizer + progress bar
   *     Pickers:  legendary optimizer / raid fastest clear
   * ------------------------------------------------------------------ */
  /** Shared styles for the injected blocks (the game's classes still do most of the work). */
  function ensureStyle() {
    if (document.getElementById('pcopt-style')) return;
    const st = document.createElement('style');
    st.id = 'pcopt-style';
    st.textContent = `      .pcopt-help-button{position:relative;flex:none;display:inline-grid;place-items:center;box-sizing:border-box;width:24px;height:24px;min-width:24px;min-height:24px;padding:0;margin:0;border-radius:50%;border:2px solid var(--line);background:var(--panel-2);font-size:0;color:transparent;cursor:help;text-transform:none;letter-spacing:normal;text-shadow:none;vertical-align:middle;touch-action:manipulation}
      .pcopt-help-button::before{content:"?";position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;font:700 18px/1 var(--font,system-ui);color:var(--text-2)}
      .pcopt-help-button:hover,.pcopt-help-button:focus-visible{border-color:var(--line-hover)}.pcopt-help-button:hover::before{color:var(--text)}
      .pcopt-title-line,.pcopt-help-line,.pcopt-field-label{display:inline-flex;align-items:center;gap:8px;vertical-align:middle}.pcopt-title-line{flex-wrap:wrap;row-gap:2px}.pcopt-title-line small{white-space:nowrap}
      .pcopt-help-line{max-width:100%;line-height:1.5}.pcopt-help-line>b{min-width:0;overflow-wrap:anywhere}.pcopt-field{display:flex;align-items:center;gap:12px;min-width:0;width:100%}.pcopt-field-label{flex:none;white-space:nowrap}.pcopt-field select{flex:1;min-width:0;max-width:480px}
      .pcopt-help-cover{position:fixed;inset:0;z-index:2147482700;background:#0d142abf;display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;font:15px/1.7 system-ui;color:var(--text,#edf2ff)}
      .pcopt-help-sheet{background:var(--panel,#1e263c);border:1px solid var(--line,#53627a);border-radius:18px;padding:20px;width:100%;max-width:540px;max-height:85dvh;overflow:auto;box-sizing:border-box;overscroll-behavior:contain}
      .pcopt-help-head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:19px}.pcopt-help-head button{width:44px;min-width:44px;min-height:44px;padding:0;display:grid;place-items:center;font-size:24px;cursor:pointer}
      .pcopt-help-text ol{padding-left:23px}.pcopt-help-text li{margin:10px 0}.pcopt-help-done{width:100%;min-height:44px;margin-top:10px}
      .pcopt-note{border-left:3px solid #7ba7e8;padding:8px 10px;margin:9px 0;font-size:13px;line-height:1.6;color:var(--muted)}
      .pcopt-segment-card{padding:12px 0;border-bottom:1px solid var(--line);line-height:1.7;overflow-wrap:anywhere}.pcopt-segment-card b{font-size:14px}.pcopt-segment-card .btn{min-height:44px;margin-top:8px}.pcopt-segment-status{font-size:12px;color:var(--muted)}
      @media(max-width:600px){.pcopt-help-cover{align-items:flex-end;padding:10px 10px max(10px,env(safe-area-inset-bottom))}.pcopt-help-sheet{max-height:82dvh;border-radius:18px}.pcopt-field{display:grid;gap:8px}.pcopt-field select{width:100%;max-width:none}.pcopt-field-label{font-weight:600}}
      /* Local dialog tokens use the same game palette while following the device. */
      .pcopt-dialog{--bg:#12141c;--panel:#1c2030;--panel-2:#252a3d;--panel-3:#30364c;--line:#333a52;--line-hover:#64708e;--text:#eef1f8;--text-2:#c3cbe0;--muted:#9aa3bb;--ink:#10121a;--blue:#3b6fe0;--red:#e3353b;--yellow:#ffcb05;--sunken:#171b29;--well:#171b29;color-scheme:dark;color:var(--text);font:16px/1.65 var(--font,system-ui);background:#080c18b3;padding:16px}
      .pcopt-dialog .pcopt-help-sheet{display:flex;flex-direction:column;padding:0;width:min(560px,100%);max-height:calc(100dvh - 32px);border:3px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:0 20px 60px #0009;overflow:hidden}
      .pcopt-dialog .pcopt-help-head{padding:16px 18px;border-bottom:2px solid var(--line);background:linear-gradient(100deg,var(--blue),color-mix(in srgb,var(--blue),var(--panel) 65%));flex-shrink:0;align-items:center;color:#fff;font:700 22px/1.35 var(--font-title,var(--font));gap:12px}
      .pcopt-dialog .pcopt-help-head>b{flex:1;min-width:0;overflow-wrap:anywhere}.pcopt-dialog .pcopt-help-head .btn{color:var(--red)!important;flex:none;width:44px;height:44px;min-height:44px;--bc:var(--panel-2)!important;font:24px/1 var(--font)}
      .pcopt-dialog .pcopt-help-text{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:16px 18px;color:var(--text);font-size:15px;line-height:1.8}
      .pcopt-dialog .pcopt-help-text p{margin:0 0 12px}.pcopt-dialog .pcopt-help-text p:last-child{margin-bottom:0}.pcopt-dialog .pcopt-help-text ol{margin:0 0 14px;padding-left:24px}.pcopt-dialog .pcopt-help-text li{margin:0 0 12px}.pcopt-dialog .pcopt-help-text b{color:var(--text)}
      .pcopt-dialog .pcopt-help-done{flex-shrink:0;align-self:stretch;width:auto;margin:12px 18px 18px;min-height:46px;--bc:var(--blue)!important}
      .pcopt-dialog .pcopt-place-actions{display:flex;gap:10px;padding:12px 18px 18px;flex-shrink:0}.pcopt-dialog .pcopt-place-actions .btn{flex:1;min-height:46px;font-size:15px}.pcopt-dialog [data-place-help]{font-size:14px;color:var(--muted);margin-top:16px}
      .pcopt-place-track{height:9px;background:var(--line);border-radius:5px;overflow:hidden;margin:14px 0}.pcopt-place-track>[data-place-bar]{height:100%;width:0;background:var(--blue);transition:width .2s}
      .pcopt-placement-cover{z-index:2147482600;touch-action:auto}.pcopt-placement-cover .pcopt-placement-sheet{max-width:440px}
      .pcopt-growth-card{border:2px solid var(--line);background:var(--panel-2);border-radius:12px;padding:12px;margin:12px 0;font-size:13px;line-height:1.7}.pcopt-growth-card p{margin:8px 0}.pcopt-growth-card small{display:block;color:var(--muted);font-size:12px}.pcopt-growth-card ul{padding-left:20px;margin:8px 0}.pcopt-growth-head{display:flex;align-items:center;gap:10px}.pcopt-growth-head img{width:56px;height:56px;object-fit:contain;image-rendering:pixelated;flex:none}.pcopt-growth-head>div{min-width:0;overflow-wrap:anywhere}
      @media(prefers-color-scheme:light){.pcopt-dialog{--bg:#e8ecf4;--panel:#fff;--panel-2:#f0f3f8;--panel-3:#e4e9f2;--line:#cfd6e3;--line-hover:#9aa5ba;--text:#1b2133;--text-2:#3f4860;--muted:#687189;--ink:#1b1b22;--red:#d8323a;--yellow:#f5b800;--sunken:#dde2ec;--well:#eef1f6;color-scheme:light;background:#17203988}}
      @media(max-width:600px){.pcopt-dialog{align-items:center;padding:12px 10px max(12px,env(safe-area-inset-bottom))}.pcopt-dialog .pcopt-help-sheet{max-height:calc(100dvh - 32px - env(safe-area-inset-bottom));border-radius:16px}.pcopt-dialog .pcopt-help-head{font-size:20px;padding:14px}.pcopt-dialog .pcopt-help-text{padding:14px;font-size:15px}.pcopt-dialog .pcopt-help-done{margin:10px 14px 14px}.pcopt-dialog .pcopt-place-actions{padding:10px 14px 14px}}

      .pcopt-dialog .pcopt-help-head svg{width:22px;height:22px;display:block}
      @media(prefers-reduced-motion:reduce){.pcopt-dialog .pcopt-help-sheet{animation:none}.pcopt-place-track>[data-place-bar]{transition:none}}

      .pcopt-roamer{margin:8px 0 4px}.pcopt-roamer select{min-height:44px;max-width:100%;font-size:16px;color:var(--text);background:var(--panel)}
      .pcopt-roamer button{min-height:44px}.pcopt-roamer [data-roamer-time],.pcopt-roamer [data-roamer-wait]{font-variant-numeric:tabular-nums}
      .pcopt-chapter-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;cursor:pointer;list-style:none;padding:4px 0;touch-action:manipulation}
      .pcopt-chapter-summary::-webkit-details-marker{display:none}
      .pcopt-chapter-heading{display:flex;flex-direction:column;min-width:0;gap:2px}
      .pcopt-chapter-heading b{font-size:15px}
      .pcopt-chapter-heading small{font-size:10px;color:var(--muted)}
      .pcopt-chapter-heading .pcopt-mut{font-size:12px;overflow-wrap:anywhere}
      .pcopt-chapter-toggle{white-space:nowrap;font-size:13px;color:var(--muted);flex-shrink:0}
      .pcopt-chapter-panel>.pcopt-chapter-summary .pcopt-when-open{display:none}
      .pcopt-chapter-panel[open]>.pcopt-chapter-summary .pcopt-when-closed{display:none}
      .pcopt-chapter-panel[open]>.pcopt-chapter-summary .pcopt-when-open{display:inline}
      .pcopt-chapter-body{border-top:1px solid var(--line);padding-top:10px;margin-top:6px}
      .pcopt-collapse-bottom{width:100%;min-height:44px;margin-top:12px}
      .pcopt-context{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
      .pcopt-context select{font-size:16px;min-height:44px;max-width:100%}
      .pcopt-explain{padding:8px;border:1px solid var(--line);border-radius:8px;font-size:13px;line-height:1.6;margin:8px 0}
      .pcopt-plan-list button{min-height:44px;margin:4px 4px 4px 0}

      .raid-pick.pcopt-scored-ally{grid-template-rows:minmax(72px,auto);min-height:72px}
      .raid-pick .raid-ally{min-width:0}
      .raid-pick .raid-ally .nm{min-width:0;white-space:normal;overflow-wrap:anywhere}
      .raid-pick .raid-ally .pcopt-atk{max-width:100%}

      .pcopt-raid-ally-box .btn.small{min-height:44px;white-space:normal}
      .pcopt-block.pcopt-raid-ally-box{grid-column:1/-1;align-self:start;position:relative;z-index:1;margin:0 12px 12px!important;max-width:calc(100% - 24px);min-width:0}
      .pcopt-raid-ally-box [role="status"]{overflow-wrap:anywhere}
      .pcopt-raid-ally-box p{margin:6px 0 0}

      .pcopt-block{margin:10px;padding:10px 14px;border-radius:12px;border:2px solid var(--line);
        background:color-mix(in srgb,var(--panel) 92%,transparent);color:var(--text)}
      #evt-pick-head .pcopt-block{flex:1 1 100%;margin:6px 0 0}
      .pcopt-block .pcopt-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .pcopt-block .pcopt-mut{color:var(--muted);font-size:13px;line-height:1.5}
      .pcopt-block .pcopt-mon{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)}
      .pcopt-block .pcopt-mon:last-child{border-bottom:0}
      .pcopt-block .pcopt-log{max-height:150px;overflow:auto}
      .pcopt-block .pcopt-err{color:var(--red)}
      .pcopt-block .btn.small{font-size:13px;padding:5px 10px}
      .pcopt-block .seg button{font-size:13px;padding:5px 9px}
      .pcopt-block select{font-size:13px;padding:4px 8px;max-width:100%}
      .pcopt-block .type.sm{font-size:11px}
      .pcopt-templates{margin:8px 10px 2px;flex-wrap:wrap}
      .pcopt-title{font-weight:700;font-size:15px;margin:0 0 6px;display:flex;justify-content:space-between;
        align-items:center;gap:8px;flex-wrap:wrap}
      .pcopt-block[data-pcopt="monitor"]{grid-column:1/-1;align-self:start;min-height:0;min-width:0;margin-top:14px;padding:8px 12px}
      .pcopt-monitor-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer;font-size:13px;line-height:1.5;list-style:none}
      .pcopt-monitor-summary::-webkit-details-marker{display:none}
      .pcopt-monitor-summary small{font-size:10px;color:var(--muted)}
      .pcopt-monitor-status{flex:1;min-width:160px;color:var(--muted)}
      .pcopt-monitor-content{padding-top:8px}
      [data-monitor-toggle]{font-size:12px;color:var(--muted)}
      .pcopt-title small{color:var(--muted);font-weight:400;font-size:11px}
    `;
    document.head.appendChild(st);
  }

  /** Create or reuse a block inside the host and rebuild it only when its signature changed. */
  function mountBlock(host, key, sig, html, bind, place = {}) {
    if (!host) return null;
    ensureStyle();
    let el = host.querySelector(`[data-pcopt="${key}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pcopt-block';
      el.dataset.pcopt = key;
      const before = place.before ? host.querySelector(place.before) : null;
      if (before) host.insertBefore(el, before);
      else if (place.prepend) host.prepend(el);
      else host.appendChild(el);
    }
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = html;
      bind(el);
    }
    return el;
  }

  const errLine = () => state.errors.length ? `<div class="pcopt-err">${state.errors.map(e => esc(zhError(e))).join('<br>')}</div>` : '';
  const updateLine = () => state.update
    ? `<div class="pcopt-mut">中文版已更新至 ${esc(state.update.repo)}，当前安装的是 ${esc(state.update.installed)}。<a href="https://github.com/yuezhihuohua/pokecatch-helper-zh-cn/releases" target="_blank" rel="noopener noreferrer">查看发布页</a></div>` : '';

  /* Roamer hunt adapted from GrumpyOwl's 1.6.7, commit 0e6720cf1177df3d14f0bada9fe62a1644479837. */
  const ROAMER_POLL_MS = 700;
  const ROAMER_CAPTURE_GRACE_MS = 4000;
  const ROAMER_HOUR_MS = 60 * 60 * 1000;
  const ROAMER_RESTART_LIMIT = 120;
  const ROAMER_REST_MS = 10 * 60 * 1000;
  let roamerHunt = null;
  let roamerSelection = null;
  let roamerNotice = '';
  const roamerPacing = { restarts: [], next: 0, restUntil: 0 };

  const roamerCaught = (save, id) => Array.isArray(save?.roam?.caught) && save.roam.caught.some(value => Number(value) === id);
  const roamerSpecial = adv => adv?.event || adv?.zone || adv?.league || adv?.tower || adv?.raid;

  function roamerPlacement(save, id) {
    const at = save?.roam?.at?.[id];
    if (at?.ch == null || at.until == null) return null;
    const ch = Number(at.ch), until = Number(at.until);
    return Number.isInteger(ch) && ch >= 0 && Number.isFinite(until) ? { id, ch, until } : null;
  }

  function roamerOptions(save, now = Date.now()) {
    return Object.keys(save?.roam?.at || {}).map(Number)
      .filter(id => Number.isInteger(id) && id > 0 && !roamerCaught(save, id))
      .map(id => roamerPlacement(save, id))
      .filter(entry => entry && entry.until > now)
      .sort((a, b) => a.until - b.until || a.id - b.id);
  }

  // Pick a delay once per click and retain the budget across stop/start in this page.
  function roamerRestartTime(pacing, now) {
    pacing.restarts = pacing.restarts.filter(time => now - time < ROAMER_HOUR_MS);
    if (pacing.restarts.length >= ROAMER_RESTART_LIMIT && !pacing.restUntil) {
      pacing.restUntil = Math.max(now + ROAMER_REST_MS, pacing.restarts[0] + ROAMER_HOUR_MS);
    }
    if (pacing.restUntil <= now) pacing.restUntil = 0;
    return Math.max(pacing.next, pacing.restUntil);
  }

  function recordRoamerRestart(pacing, now, random = Math.random()) {
    pacing.restarts.push(now);
    pacing.next = now + 8000 + random * 8000;
  }

  function nextRoamerAction(save, job, now) {
    const adv = save?.adv;
    if (!adv) return 'save';
    if (roamerCaught(save, job.id)) return 'caught';
    if (roamerSpecial(adv)) return 'special';
    if (Number(adv.battle?.roam) === job.id) return 'fight';
    if (job.resolveAt && now < job.resolveAt) return 'capture';
    const at = roamerPlacement(save, job.id);
    if (!at) return 'gone';
    if (at.until <= now) return 'expired';
    if (adv.paused) return 'paused';
    if (adv.battle || adv.pending) return 'waiting';
    if (job.resolveAt || adv.chapter !== at.ch) return 'restart';
    if (!Array.isArray(adv.nodes) || !adv.nodes.length) return 'route';
    // The game assigns node.roamer when it builds a chapter. Let marked routes play out.
    return adv.nodes.some((node, i) => i >= adv.node && Number(node?.roamer) === job.id) ? 'route' : 'restart';
  }

  const roamerMap = () => document.querySelector('#screen-map.active');
  const roamerAdventure = () => document.querySelector('#screen-adventure.active');
  const canDriveRoamer = job => roamerHunt === job && !document.hidden && !state.busy
    && !!(roamerMap() || roamerAdventure());

  function stopRoamerHunt(message = '已停止追捕。正在进行的战斗会由游戏继续处理。') {
    if (!roamerHunt) return;
    clearInterval(roamerHunt.timer);
    roamerHunt = null;
    roamerNotice = message;
    refreshUi();
  }

  function roamerStatus(job, message) {
    if (roamerHunt !== job || job.status === message) return;
    job.status = message;
    refreshUi();
  }

  /** Drive the game's chapter controls. The job and placement are checked again before restarting. */
  async function restartRoamerChapter(job, ch) {
    const stillTarget = () => {
      if (!canDriveRoamer(job)) return false;
      const save = readSave(), at = roamerPlacement(save, job.id);
      return at?.ch === ch && nextRoamerAction(save, job, Date.now()) === 'restart';
    };
    if (!stillTarget()) return;
    if (!roamerMap()) {
      const navigate = document.querySelector('#side [data-screen="map"]:not(.locked)')
        || document.querySelector('#chapter-btn, #tabs [data-screen="map"]:not(.locked)');
      if (!navigate) throw new Error('找不到游戏的进度入口。');
      navigate.click();
      for (let i = 0; i < 10 && stillTarget() && !roamerMap(); i++) await sleep(200);
      if (!stillTarget()) return;
    }
    const map = roamerMap();
    if (!map) throw new Error('游戏未打开进度页。');
    const rowAt = () => map.querySelector(`.mp-row[data-ch="${ch}"]`);
    let row = rowAt();
    const region = state.data?.chapters?.[ch]?.reg || 'kanto';
    if (!row) {
      const regionButton = map.querySelector(`.rg.open[data-rg="${region}"]`);
      if (regionButton && stillTarget()) {
        regionButton.click();
        for (let i = 0; i < 8 && stillTarget() && !rowAt(); i++) await sleep(200);
        row = rowAt();
      }
    }
    if (!stillTarget() || roamerMap() !== map) return;
    if (!row) throw new Error('进度页找不到目标章节，请确认已解锁。');
    row.click();
    const buttonAt = () => {
      const sameChapter = readSave()?.adv?.chapter === ch;
      return map.querySelector(`.mp-restart[data-restart="${ch}"]:not([disabled])`)
        || (!sameChapter && map.querySelector(`.mp-go[data-go="${ch}"]:not([disabled])`));
    };
    for (let i = 0; i < 10 && stillTarget() && !buttonAt(); i++) await sleep(180);
    if (!stillTarget() || roamerMap() !== map) return;
    const button = buttonAt();
    if (!button) throw new Error('游戏未提供目标章节的重开或前往按钮。');
    const before = readSave(), now = Date.now();
    if (roamerRestartTime(roamerPacing, now) > now) return;
    recordRoamerRestart(roamerPacing, now);
    job.restarts++;
    button.click();
    for (let i = 0; i < 18; i++) {
      if (roamerHunt !== job) return;
      const after = readSave();
      if (after !== before && after?.adv?.chapter === ch
        && (before.adv.chapter !== ch || after.adv.node === 0 || after.adv.node < before.adv.node || roamerAdventure())) {
        job.resolveAt = 0;
        roamerStatus(job, '已进入目标章节，等待游荡遭遇。');
        return;
      }
      await sleep(200);
    }
    throw new Error('游戏未确认重开，请核对当前路线。');
  }

  async function pollRoamerHunt(job) {
    if (roamerHunt !== job || job.working || document.hidden) return;
    const save = readSave(), now = Date.now();
    if (job.inFight && Number(save?.adv?.battle?.roam) !== job.id) {
      job.inFight = false;
      job.resolveAt = now + ROAMER_CAPTURE_GRACE_MS;
    }
    const action = nextRoamerAction(save, job, now);
    const stops = {
      caught: `已捕获${displayName(job.id)}，追捕结束。`,
      expired: '目标出没时间已结束，追捕已停止。',
      gone: '游戏已不显示该目标，追捕已停止。',
      special: '已进入特殊挑战，追捕已停止。',
      save: '暂时无法读取冒险进度，追捕已停止。',
    };
    if (stops[action]) { stopRoamerHunt(stops[action]); return; }
    if (action === 'fight' && !job.inFight) {
      job.inFight = true;
      job.resolveAt = 0;
      job.encounters++;
    }
    const at = roamerPlacement(save, job.id);
    if (at && at.ch !== job.ch) {
      job.ch = at.ch;
      roamerStatus(job, '目标换章，追捕将跟随。');
    }
    const messages = {
      fight: '正在与目标战斗，等待游戏结算。',
      capture: '等待游戏写入捕获结果…',
      paused: '冒险已暂停。恢复冒险后继续追捕。',
      waiting: '等待当前战斗或游戏事件结束…',
      route: '等待路线上的游荡遭遇…',
    };
    if (messages[action]) { roamerStatus(job, messages[action]); return; }
    if (!canDriveRoamer(job)) {
      roamerStatus(job, state.busy ? '等待配队助手完成操作…' : '回到冒险或进度页后继续追捕。');
      return;
    }
    const next = roamerRestartTime(roamerPacing, now);
    if (next > now) {
      roamerStatus(job, roamerPacing.restUntil > now ? '已达到重开频率上限，休息中。' : '正在等待下次重开…');
      return;
    }
    job.working = true;
    roamerStatus(job, '正在打开目标章节…');
    try {
      await restartRoamerChapter(job, at.ch);
    } catch (error) {
      if (roamerHunt === job) stopRoamerHunt('追捕已停止：' + error.message);
    } finally {
      job.working = false;
    }
  }

  function startRoamerHunt(selection) {
    if (roamerHunt) return;
    const save = readSave(), at = roamerPlacement(save, Number(selection));
    if (!save?.adv || !state.data || state.busy || roamerSpecial(save.adv) || !at
      || at.until <= Date.now() || roamerCaught(save, at.id)) {
      roamerNotice = '暂时无法开始。请核对目标时间和当前冒险状态，再重试。';
      refreshUi();
      return;
    }
    const plan = state.segments;
    if (plan?.auto) {
      plan.auto = false;
      plan.pending = null;
      state.segmentNotice = '已开始追捕游荡传说，分段自动安排已关闭。';
      store.set('segments', plan);
    }
    const job = { id: at.id, ch: at.ch, inFight: false, resolveAt: 0, restarts: 0, encounters: 0,
      working: false, status: '准备追捕…', timer: null };
    roamerSelection = at.id;
    roamerNotice = '';
    roamerHunt = job;
    job.timer = setInterval(() => pollRoamerHunt(job).catch(error => {
      if (roamerHunt === job) stopRoamerHunt('追捕已停止：' + error.message);
    }), ROAMER_POLL_MS);
    refreshUi();
  }

  function roamerChapterLabel(ch) {
    const chapter = state.data?.chapters?.[ch], region = chapter?.reg || 'kanto';
    if (!chapter) return '章节 ' + ch;
    const chapters = chaptersOf(state.data, region);
    const title = zhText(chapter.name || '');
    return `${REGION_NAMES[region] || region}第 ${chapters.indexOf(ch) + 1} 章${title ? ' · ' + title : ''}`;
  }

  function roamerTimeLeft(until, now) {
    const seconds = Math.max(0, Math.ceil((until - now) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function paintRoamerCountdown(box, until, next, now) {
    const time = box?.querySelector('[data-roamer-time]');
    const text = until ? `剩余 ${roamerTimeLeft(until, now)}` : '';
    if (time && time.textContent !== text) time.textContent = text;
    const wait = box?.querySelector('[data-roamer-wait]');
    const pause = next > now ? `下次重开还需 ${roamerTimeLeft(next, now)}` : '';
    if (wait && wait.textContent !== pause) wait.textContent = pause;
  }

  function mountRoamerHunt(host, compact = false) {
    if (!host) return;
    const job = roamerHunt;
    if (compact && !job) {
      if (!roamerNotice) { host.querySelector('[data-pcopt="roamer-active"]')?.remove(); return; }
      const notice = `<div class="pcopt-row"><span role="status">${esc(roamerNotice)}</span>
        <button type="button" class="btn small ghost" data-roamer-dismiss>关闭提示</button></div>`;
      mountBlock(host, 'roamer-active', notice, notice, el => {
        el.classList.add('pcopt-roamer');
        el.querySelector('[data-roamer-dismiss]').onclick = () => { roamerNotice = ''; refreshUi(); };
      }, { before: '#arena' });
      return;
    }
    const save = readSave(), now = Date.now();
    const options = job ? [] : roamerOptions(save, now);
    const selected = job ? roamerPlacement(save, job.id) : options.find(entry => entry.id === roamerSelection) || options[0];
    const count = Number(save?.items?.['master-ball']) || 0;
    const available = !!selected && !!save?.adv && !!state.data && !state.busy && !roamerSpecial(save.adv);
    const name = selected ? displayName(selected.id) : job ? displayName(job.id) : '';
    const chapter = selected || job ? roamerChapterLabel(selected?.ch ?? job.ch) : '';
    const next = job?.status.includes('休息') || job?.status.includes('下次重开')
      ? Math.max(roamerPacing.next, roamerPacing.restUntil) : 0;
    const target = name ? `<span>${esc(name)} · ${esc(chapter)}</span> <span class="pcopt-mut" data-roamer-time></span>` : '';
    const html = job ? `
      <div class="pcopt-row"><b>游荡传说追捕</b> ${target}
        <button type="button" class="btn small ghost" data-roamer-stop>停止追捕</button></div>
      <div class="pcopt-mut" role="status">${esc(job.status)} 已重开 ${job.restarts} 次，遭遇 ${job.encounters} 次。</div>
      <div class="pcopt-mut" data-roamer-wait></div>` : `
      <div class="pcopt-row"><b>游荡传说追捕</b></div>
      <div class="pcopt-row">
        <select aria-label="选择游荡传说" data-roamer-select ${options.length ? '' : 'disabled'}>
          ${options.length ? options.map(entry => `<option value="${entry.id}" ${entry.id === selected?.id ? 'selected' : ''}>${esc(displayName(entry.id))}</option>`).join('')
            : '<option>暂无可追捕目标</option>'}
        </select>
        <button type="button" class="btn small" data-roamer-start ${available ? '' : 'disabled'}>开始追捕</button>
      </div>
      ${target ? `<div>${target}</div><div class="pcopt-mut">开始后会按需重开章节。背包大师球 ${count} 个；捕获判定时，游戏可自动使用大师球。</div>` : ''}
      ${selected && save?.adv?.paused ? '<div class="pcopt-mut">冒险暂停中，需在游戏内恢复才能推进。</div>' : ''}
      ${selected && roamerSpecial(save?.adv) ? '<div class="pcopt-mut">请先结束当前特殊挑战。</div>' : ''}
      ${selected && state.segments?.auto ? '<div class="pcopt-mut">开始后将关闭分段自动安排，已保存的方案保留。</div>' : ''}
      ${roamerNotice ? `<div class="pcopt-mut" role="status">${esc(roamerNotice)}</div>` : ''}`;
    const box = mountBlock(host, compact ? 'roamer-active' : 'roamer-hunt', html, html, el => {
      el.classList.add('pcopt-roamer');
      const select = el.querySelector('[data-roamer-select]');
      if (select) select.onchange = () => {
        roamerSelection = Number(select.value);
        refreshUi();
        host.querySelector('[data-roamer-select]')?.focus();
      };
      const start = el.querySelector('[data-roamer-start]');
      if (start) start.onclick = () => startRoamerHunt(selected?.id);
      const stop = el.querySelector('[data-roamer-stop]');
      if (stop) stop.onclick = () => stopRoamerHunt();
    }, compact ? { before: '#arena' } : {});
    paintRoamerCountdown(box, selected?.until, next, now);
  }

  /** The Progress screen: what the game is doing right now, the wipes, the data status. */
  function mountMonitor() {
    const body = document.querySelector('#screen-map .map-body');
    if (!body) return;
    const save = readSave(), adv = save?.adv, node = adv?.nodes?.[adv.node];
    const fails = state.watcher?.fails || [], last = fails[0];
    const ready = !!state.engine;
    const status = state.dataPhase === 'failed' ? '读取失败 · 展开可重试'
      : ready ? '数据已就绪' : state.dataPhase === 'loading' ? '正在读取数据…' : '等待游戏资源…';
    const html = `
      <details class="pcopt-monitor-details" ${state.monitorOpen ? 'open' : ''}>
        <summary class="pcopt-monitor-summary">
          <span><b>冒险监测</b> <small>v${VERSION}</small></span>
          <span class="pcopt-monitor-status">${esc(status)} · ${state.watcher?.running ? '监测中' : '监测未开启'} · ${fails.length} 条记录</span>
          <span data-monitor-toggle>${state.monitorOpen ? '收起' : '展开'}</span>
        </summary>
        <div class="pcopt-monitor-content">
          <div class="pcopt-mut">章节 ${adv?.chapter ?? '-'} · ${esc(zhText(state.events?.name || ''))} · 进度 ${adv?.node ?? '-'} / ${(adv?.nodes || []).length} · 等级上限 ${state.events?.cap ?? '-'}</div>
          <div class="pcopt-mut">${ready ? '已读取 ' + Object.keys(state.data.species).length + ' 种宝可梦 · 属性表：游戏内置' : state.dataPhase === 'waiting' ? '等待游戏加载资源，插件会自动继续。' : state.dataPhase === 'loading' ? '正在读取游戏数据，请稍候。' : '会自动重试，也可点击下方按钮立即重试。'}</div>
          ${state.dataError ? `<div class="pcopt-err">${esc(state.dataError)}</div>` : ''}
          ${updateLine()}${errLine()}
          ${state.leagueInfo ? `<div class="pcopt-mut">${esc(state.leagueInfo)}</div>` : ''}
          ${last ? `<div class="pcopt-mut">上次团灭：第 ${last.node} 步 · ${esc(zhText(last.name))}</div>` : ''}
          <div class="pcopt-row" style="margin:4px 0">${ready ? typeChips(state.enemies, state.data) : ''}</div>
          <div class="pcopt-row">
            <button class="btn small ghost" data-act="watch">${state.watcher?.running ? '● 正在监测' : '监测团灭'}</button>
            <button class="btn small ghost" data-act="retry" ${state.loading ? 'disabled' : ''}>${state.loading ? '正在读取…' : '重新读取数据'}</button>
            <button class="btn small ghost" data-act="clear">清空记录</button>
          </div>
          <div class="pcopt-log" style="max-height:160px;overflow:auto;overscroll-behavior:contain;margin-top:6px">${renderFails()}</div>
        </div>
      </details>`;
    const sig = JSON.stringify([adv?.chapter, adv?.node, node?.name, state.events?.name, state.events?.cap,
      fails.length, last?.at, state.watcher?.running, state.dataPhase, state.dataError, state.monitorOpen,
      state.errors, state.update?.repo, state.leagueInfo]);
    const el = mountBlock(body, 'monitor', sig, html, el => {
      const details = el.querySelector('details');
      details.ontoggle = () => {
        if (state.monitorOpen !== details.open) {
          state.monitorOpen = details.open;
          store.set('monitorExpanded', details.open);
        }
        el.querySelector('[data-monitor-toggle]').textContent = details.open ? '收起' : '展开';
      };
      el.querySelector('[data-act="watch"]').onclick = () => {
        if (state.watcher?.running) state.watcher.stop(); else state.watcher?.start();
        refreshUi();
      };
      el.querySelector('[data-act="clear"]').onclick = () => { state.watcher?.clear(); refreshUi(); };
      el.querySelector('[data-act="retry"]').onclick = () => ensureData({ force: true });
    });
    mountRoamerHunt(el?.querySelector('.pcopt-monitor-content'));
    // A region switch may append the game's new content after an existing block.
    if (el && body.lastElementChild !== el) body.appendChild(el);
  }

  /** The Adventure screen: the game's own team-template bar, between the route timeline and the arena.
   *  The buttons are the game's markup (sprites, tooltips, active state), so it reads as native. */
  function mountTemplates() {
    const adv = document.querySelector('#screen-adventure .adv-main');
    const save = readSave();
    const sets = save?.teamSets;
    if (!adv || !sets || !Array.isArray(sets.list)) return;
    let el = adv.querySelector('[data-pcopt="templates"]');
    if (!el) {
      el = document.createElement('div');
      el.dataset.pcopt = 'templates';
      el.className = 'pcopt-templates seg team-sets';
      const arena = adv.querySelector('#arena');
      if (arena) adv.insertBefore(el, arena); else adv.appendChild(el);
    }
    // the game renders its bar when the Team/PC screen opens: clone it, else build the same markup
    const source = document.querySelector('#team-sets');
    const sourceHtml = source && source.children.length ? source.innerHTML : '';
    const sprite = (uids) => {
      const m = (uids || []).map(u => monByUid(save, u)).find(Boolean);
      if (!m) return '';
      return `<span class="ts-lead"><div class="sprbox" style="height:32px"><img src="assets/pokemon/${m.id}.png" alt="" data-id="${m.id}" data-k="1" style="width:68px;height:56px;transform:translate(0px, 0px)"></div></span>`;
    };
    const fallback = [0, 1, 2, 3, 4].map(i => {
      const uids = sets.list[i] || [];
      const names = uids.map(u => monByUid(save, u)).filter(Boolean).map(m => displayName(m.id));
      const on = sets.on === i;
      return `<button type="button" data-set="${i}" class="${on ? 'on' : ''}${uids.length ? '' : ' ts-empty'}" aria-pressed="${on}">`
        + `${uids.length ? sprite(uids) + (i + 1) : '<span class="ts-lead ts-none">+</span>'}`
        + `<span class="bag-tip ts-tip" role="tooltip"><b>队伍 ${i + 1}${on ? ' · 使用中' : ''}</b>`
        + `<small>${esc(names.slice(0, 6).join(', ') || '空模板')}</small></span></button>`;
    }).join('');
    const sig = (sourceHtml || ('fallback:' + (sets.list || []).map(x => (x || []).join('.')).join('|'))) + '|' + (sets.on ?? '');
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = sourceHtml || fallback;
    }
    // the game's bar is only re-rendered on the Team/PC screen, so set the active state from the save
    el.querySelectorAll('button[data-set]').forEach(b => {
      const on = +b.dataset.set === sets.on;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.onclick = e => { e.preventDefault(); e.stopPropagation(); switchTemplate(+b.dataset.set); };
    });
  }

  /** The Team/PC screen: the chapter optimizer with its progress bar and the current team. */
  function mountChapter(){
    const host=document.querySelector('#screen-team');if(!host||!state.data)return;
    const sim=state.sim,save=readSave(),stale=!!state.team&&recommendationStale(save),staleReason=stale?recommendationIssue(save):'',updateNote=state.team?recommendationNote(save):'';
    const pct=n=>Math.round(n*100)+'%',baseline=sim?.baseline;
    const already=!!state.team?.length&&state.team.every((c,i)=>save?.team?.[i]===c.mon.uid);
    const waitingHeal=already&&Array.isArray(save?.road)&&!state.team.every((c,i)=>save.road[i]===c.mon.uid);
    const baseSummary=state.busy?(state.waiting||'正在分析，可展开查看进度'):state.errors?.length?'有提示，展开查看':stale?'结果已过期，展开重新分析':waitingHeal?'已安排，等待回复时换队':already?'推荐队伍已安排':sim?'推荐方案已就绪':'展开分析与安排队伍';
    const summary=state.segments?.auto?'自动分段开启 · '+baseSummary:baseSummary;
    const recent=(state.watcher?.fails||[]).find(f=>f.chapter===save?.adv?.chapter&&(!f.why||f.why==='chapter')&&['gym','trainer','wild','static'].includes(f.kind));
    const wipeText=res=>!res?'无可用对照':Object.entries(res.wipeAt||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([i,n])=>'第 '+(+i+1)+' 步 '+zhText(save?.adv?.nodes?.[i]?.name||'战斗')+'（'+n+'/'+res.runs+' 次）').join('；')||'本次复核未团灭';
    const history=recent?`<div class="pcopt-explain"><b>最近实战团灭：第 ${recent.node+1} 步 · ${esc(zhText(recent.name))}</b><br><small>${esc(new Date(recent.at).toLocaleString('zh-CN'))} · ${esc((recent.enemies||[]).map(m=>displayName(m.id)+' Lv.'+m.level).join('、')||'未采集到完整对手')}</small><br><span class="pcopt-mut">${sim?.focus?'本次优先优化通过这场战斗的比例。':sim?'这条记录不在本次路线或无法匹配，本次按路线通关表现比较。':'可匹配当前章节的团灭位置会自动用于下一次计算。'}</span></div>`:'<div class="pcopt-mut">当前章节暂无可匹配的实战团灭记录：先模拟整章，显示预计容易失败的位置；监测到团灭后，下次计算优先针对该位置。</div>';
    const report=sim?`<div class="pcopt-explain">${sim.focus?`<b>突破上次团灭战斗：推荐 ${pct(sim.focusRate)}${baseline?' · 原安排 '+pct(baseline.focusRate):''}</b><br>`:''}<div class="pcopt-help-line"><b>分析范围全程通过：推荐 ${pct(sim.rate)}${baseline?' · 原安排 '+pct(baseline.rate):''}</b>${helpButton('results','模拟结果怎么看')}</div><br>${sim.scope==='restart'?'整章重试，回复后满血开局':'下一个宝可梦中心回复后开始'} · 第 ${sim.range[0]+1}–${sim.range[1]+1} 步<p>${esc(sim.reason)}</p>${sim.roamers?.length ? `<p class="pcopt-mut">已计入当前路线标记的游荡遭遇：${esc(sim.roamers.map(displayName).join("、"))}。重开章节后，遭遇位置可能变化。</p>` : ""}<p>原安排最常团灭：${esc(wipeText(baseline))}<br>推荐最常团灭：${esc(wipeText(sim))}</p>${sim.changes?.added?.length?'<p>建议换入：'+esc(sim.changes.added.join('、'))+'<br>换下：'+esc(sim.changes.removed.join('、'))+'</p>':''}<details><summary>查看模拟依据</summary><p>独立复核 ${sim.runs} 次 · 全程通过率样本估计区间 ${pct(sim.interval[0])}–${pct(sim.interval[1])}<br>平均通过 ${sim.avgCleared.toFixed(1)}/${sim.totalBattles} 场 · 比较 ${sim.evaluated} 组队伍 · 候选 ${sim.poolSize}/${sim.totalCandidates}<br>以计算时的实际等级、形态和阶级为基础；正常获得经验、掉血与战斗推进不会锁住安排按钮。升级后可重新计算。</p></details><small>实战记录与模拟结果分开显示；模型估计不保证通关。</small></div>`:'';
    const upcoming=nextSegmentTarget(save);
    const segmentIssueText=state.segments?segmentIssue(save):'',readyTemplates=state.segments&&!segmentIssueText&&state.segments.list.every(e=>templateMatches(save,e));
    const segment=state.segments?.version===3?`<div class="pcopt-plan-list"><b>${esc(segmentStatus(save))}</b><br><small>分析于 ${esc(new Date(state.segments.createdAt).toLocaleString('zh-CN'))} · 后续段按当时等级满血估计</small>${state.segments.list.map((entry,i)=>`<div class="pcopt-segment-card"><b>第 ${i+1} 段 · 第 ${entry.startNode+1}–${entry.endNode+1} 步</b><div>${esc(entry.label)}</div><div class="pcopt-segment-status">${esc(entry.names.map((name,j)=>name+' Lv.'+entry.levels[j]).join('、'))}<br>模型通过 ${pct(entry.res.rate)}${entry.res.rate<.5?' · 暂未找到稳定通关方案':''}${entry.slot!=null?' · 游戏模板 '+(entry.slot+1)+(templateMatches(save,entry)?' 已核对':' 已变化'): ' · 方案已保存，未写入游戏模板'}${entry.reason?'<br>'+esc(entry.reason)+'<br>现队全程 '+pct(entry.baseline?.rate??0)+' · 比较 '+entry.evaluated+' 组':''}${i>0&&state.segments.list.slice(0,i).some(e=>sameTeam(e.team,entry.team))?'<br>与前面的分段共用队伍，无需重复换人。':''}</div><button class="btn small ghost" data-arrange-segment="${i}" ${state.busy||segmentIssueText?'disabled':''}>安排本段</button></div>`).join('')}<button class="btn small ghost" data-act="save-segments" ${state.busy||segmentIssueText?'disabled':''}>保存游戏模板</button><label style="display:block;margin-top:12px"><input type="checkbox" data-auto-segments ${state.segments.auto?'checked':''} ${state.busy||!readyTemplates?'disabled':''}> 自动提前安排下一段</label><div class="pcopt-segment-status">${upcoming?'下一回复点后使用第 '+(state.segments.list.indexOf(upcoming)+1)+' 段；当前出战队伍不变。':'本章后面没有尚未处理的回复点。'}</div>${!readyTemplates&&!segmentIssueText?'<p class="pcopt-mut">先保存并核对全部游戏模板，再开启自动。</p>':''}${state.segmentNotice?'<p class="pcopt-note" role="status">'+esc(state.segmentNotice)+'</p>':''}</div>`:'';
    const html=`<details class="pcopt-chapter-panel" data-chapter-panel ${state.chapterOpen?'open':''}><summary class="pcopt-chapter-summary"><span class="pcopt-chapter-heading"><span class="pcopt-title-line"><b>实战配队</b>${helpButton('start','实战配队使用说明')}<small>${MOBILE_BUILD?'手机版 ':''}v${VERSION}</small></span><span class="pcopt-mut" role="status">${esc(summary)}</span></span><span class="pcopt-chapter-toggle" aria-hidden="true"><span class="pcopt-when-closed">展开 ▾</span><span class="pcopt-when-open">收起 ▴</span></span></summary><div class="pcopt-chapter-body"><div class="pcopt-mut">章节 ${Number.isInteger(state.events?.index)?state.events.index+1:'-'} · 等级上限 ${state.events?.cap??'-'}</div>
      <div class="pcopt-context"><div class="pcopt-field"><div class="pcopt-field-label"><label for="pcopt-plan-scope">配队目标</label>${helpButton('target','如何选择配队目标')}</div><select id="pcopt-plan-scope" data-scope ${state.busy?'disabled':''}><option value="restart" ${state.planScope==='restart'?'selected':''}>整章挑战 · 优先突破团灭点</option><option value="after-heal" ${state.planScope==='after-heal'?'selected':''}>下次回复后 · 后续路线</option></select></div></div>
      <div class="pcopt-mut">先分析，再安排。冒险可以继续；途中通常在宝可梦中心回复时换成出战队伍。</div>
      ${state.team?.length&&state.applyNotice&&!stale?'<div class="pcopt-mut" role="status">'+esc(state.applyNotice)+'</div>':''}<div class="pcopt-row" style="margin-top:6px">${presetSeg()}<button class="btn small" data-act="run" ${state.busy?'disabled':''}>${state.busy?'计算中…':'分析并推荐'}</button><div id="pcopt-simbar" style="display:none;flex:1 1 160px;gap:6px"><div style="flex:1;height:10px;background:var(--line)"><div style="height:100%;width:0;background:var(--c)"></div></div><span class="pcopt-mut"></span></div><button class="btn small ghost" data-act="apply" ${!state.team?.length||state.busy||stale||already?'disabled':''}>${stale?'请重新分析':already?'已安排此队伍':'安排推荐队伍'}</button></div>
      ${errLine()}${history}${report}${already?'<div class="pcopt-mut">安排队伍已经一致；实际出战队伍仍以游戏为准，路途中可能还在等待回复。</div>':''}${stale?'<div class="pcopt-note" role="status">'+esc(staleReason)+'</div>':updateNote?'<div class="pcopt-note">'+esc(updateNote)+'</div>':''}<details data-segment-panel class="pcopt-explain" ${state.segmentPanelOpen?'open':''}><summary><span class="pcopt-help-line">分段方案${state.segments?.list?.length?' · '+state.segments.list.length+'/'+state.segments.total+' 段':''}${helpButton('segments','分段和自动换队怎么用')}</span></summary><p>先分析各段，再决定安排；只计算方案不会改动游戏队伍。</p><div class="pcopt-row"><button class="btn small ghost" data-act="segments" ${state.busy?'disabled':''}>分析分段方案</button><button class="btn small ghost" data-act="free" ${state.busy?'disabled':''}>${state.reuseAll?'取消覆盖许可':'允许覆盖其他模板'}</button></div>${segment}</details>
      ${renderGrowth(save)}${state.reuseAll?'<div class="pcopt-mut">下次保存游戏模板时允许覆盖非当前模板；分析方案不会覆盖。</div>':''}${state.team?`<details data-roster-panel ${state.rosterPanelOpen?'open':''}><summary>推荐名单与单只指标 · ${state.team.length} 只</summary><div data-team>${renderTeam()}</div></details>`:''}${state.waiting?'<div class="pcopt-mut">'+esc(state.waiting)+'</div>':''}<button class="btn small ghost pcopt-collapse-bottom" data-act="collapse">收起实战配队 ▴</button></div></details>`;
    mountBlock(host,'chapter',JSON.stringify([state.chapterOpen,state.planScope,state.busy,state.waiting,sim,updateNote,staleReason,segmentStatus(save),state.team?.map(c=>c.mon.uid),stale,already,recent?.at,state.errors,state.segments,state.segmentNotice,state.reuseAll,state.applyNotice,state.segmentPanelOpen,state.rosterPanelOpen,state.growthOpen,state.growth,state.events?.index,!!state.growth&&state.growth.fingerprint!==growthFingerprint(save)]),html,el=>{
      const panel=el.querySelector('[data-chapter-panel]');
      const remember=()=>{if(!panel.isConnected)return;const open=panel.open;if(state.chapterOpen!==open){state.chapterOpen=open;store.set('chapterExpanded',open)}};
      panel.ontoggle=remember;
      el.querySelector('[data-act="collapse"]').onclick=()=>{panel.open=false;remember();panel.querySelector('summary').focus();panel.scrollIntoView({block:'nearest'})};
      const roster=el.querySelector('[data-roster-panel]');if(roster)roster.ontoggle=()=>{state.rosterPanelOpen=roster.open};
      const advanced=el.querySelector('[data-segment-panel]');advanced.ontoggle=()=>{state.segmentPanelOpen=advanced.open};
      el.querySelector('[data-scope]').onchange=e=>{state.planScope=e.target.value;store.set('planScope',state.planScope);state.team=null;state.sim=null;state.resultFingerprint=null;state.resultContext=null;state.resultStale=false;refreshUi()};
      el.querySelectorAll('[data-preset]').forEach(button=>button.onclick=()=>{if(state.busy)return;state.preset=button.dataset.preset;state.team=null;state.sim=null;state.resultContext=null;refreshUi()});
      const growth=el.querySelector('[data-growth-panel]');growth.ontoggle=()=>{state.growthOpen=growth.open};el.querySelector('[data-act="growth"]').onclick=runGrowth;
      el.querySelector('[data-act="run"]').onclick=runOptimizer;
      el.querySelector('[data-act="apply"]').onclick=()=>applyTeamFromPanel();
      el.querySelector('[data-act="segments"]').onclick=prepareSegments;
      el.querySelector('[data-act="free"]').onclick=freeTemplates;
      el.querySelectorAll('[data-planning-help]').forEach(button=>button.onclick=event=>{event.preventDefault();event.stopPropagation();openPlanningHelp(button.dataset.planningHelp)});
      el.querySelectorAll('[data-arrange-segment]').forEach(button=>button.onclick=()=>arrangeSegment(+button.dataset.arrangeSegment));
      const saveSegments=el.querySelector('[data-act="save-segments"]');if(saveSegments)saveSegments.onclick=saveSegmentTemplates;
      const auto=el.querySelector('[data-auto-segments]');if(auto)auto.onchange=()=>{if(auto.checked&&roamerHunt){auto.checked=false;state.segmentNotice='追捕进行中，请先停止追捕再开启分段自动安排。';refreshUi();return}if(auto.checked&&!nextSegmentTarget(readSave())){auto.checked=false;state.segmentNotice='本章后面没有可安排的回复点。可手动安排，为下一次挑战准备。';state.segments.auto=false;store.set('segments',state.segments);refreshUi();return}state.segments.auto=auto.checked;state.segments.manualUntil=null;state.segments.pending=null;store.set('segments',state.segments);state.segmentNotice=auto.checked?'已开启：会在路上提前安排下一回复点后的队伍，并在回复后核对。':'自动已关闭，保留当前安排。';refreshUi();if(auto.checked)switchSegment()};
      el.querySelectorAll('[data-moves]').forEach(button=>button.onclick=()=>showMovesPanel(button.dataset.moves));
      el.querySelectorAll('[data-api]').forEach(button=>button.onclick=()=>compareWithPokeApi(button.dataset.api,el.querySelector(`[data-info="${button.dataset.api}"]`)));
    },{before:'.pc-sticky'});
  }


  let legendJob = null;
  let legendResult = null;
  let legendNotice = null;

  const legendKey = ({ zone, tier }) => [zone.region, zone.id, tier].join(':');
  const legendLevel = (zone, tier, data) => tier ? data.cfg.MAX_LEVEL : (zone.level ?? data.cfg.MAX_LEVEL);

  function sameLegendPicker(head, key) {
    if (!eventPickerOpen(head) || document.querySelector('#evt-pick-head') !== head || raidContext()) return false;
    const ctx = pickerContext();
    return !!ctx && legendKey(ctx) === key;
  }

  function legendInfo(ctx, result) {
    const { engine, data } = state;
    const { zone, tier } = ctx;
    const boss = result?.boss || legendBoss(zone, tier, [], engine, data);
    if (!boss) return '';
    return `${esc(displayName(zone.id))} · ${boss.types.map(zhType).join('/')} · ${boss.hp.toLocaleString('zh-CN')} 生命值`
      + (zone.burst ? ` · ${esc(displayMove(zone.burst))}` : '') + (tier ? ` · 精英 ${tier}` : '');
  }

  function renderLegendTeam(result) {
    if (!result) return '';
    const statusNames = { burn: '灼伤', poison: '中毒', paralysis: '麻痹' };
    return result.team.map(({ mon, proj, species }, i) => {
      const level = proj.level < mon.level ? `实际等级 ${mon.level} · 本场按 ${proj.level} 级` : `等级 ${mon.level}`;
      const profile = result.profiles[i];
      const dmg = Math.round(profile.damage * (profile.move?.acc ?? 0) / 100);
      const rounds = profile.incoming > 0 ? Math.max(1, Math.ceil(profile.hp / profile.incoming)) : null;
      const effects = new Set([profile.setup?.type, profile.secondary?.type].filter(Boolean));
      return `<div class="pcopt-mon"><div>${i + 1}. <b>${esc(displayName(species.id))}</b> <span class="pcopt-mut">${level}${proj.shiny ? ' ✨' : ''}</span>`
        + `<div class="pcopt-row">${species.types.map(typeBadge).join('')}</div>`
        + `<div class="pcopt-mut">约 ${dmg} 伤害/回合${rounds ? ` · 预计能撑 ${rounds} 回合` : ''}${effects.size ? ' · 可施加' + [...effects].map(type => statusNames[type]).join('、') : ''}</div></div></div>`;
    }).join('');
  }

  /** The legendary picker computes a recommendation before the player chooses to apply it. */
  function mountLegendBox(head, ctx) {
    const key = legendKey(ctx);
    const result = legendResult?.head === head && legendResult.key === key && legendResult.preset === state.preset
      ? legendResult : null;
    const job = legendJob?.head === head && legendJob.key === key ? legendJob : null;
    const notice = legendNotice?.head === head && legendNotice.key === key ? legendNotice.text : '';
    const status = job?.status || notice || (result ? `已推荐 ${result.team.length} 只，可应用这些位置。` : '点击“助手配队”生成传说对战队伍');
    const info = legendInfo(ctx, result);
    const odds = result ? oddsText(result.odds) : '';
    const rows = renderLegendTeam(result);
    const sig = JSON.stringify([key, state.preset, state.busy, info, status, !!job, odds, rows, state.errors]);
    const html = `
      <div class="pcopt-row" style="margin-top:6px">
        ${presetSeg()}
        <button type="button" class="btn small" data-act="run" ${state.busy ? 'disabled' : ''}>${job ? '计算中…' : '✨ 助手配队'}</button>
        <button type="button" class="btn small ghost" data-act="apply" ${result && !state.busy ? '' : 'disabled'}>应用队伍</button>
        ${job ? '<button type="button" class="btn small ghost" data-act="cancel-legend">取消计算</button>' : ''}
      </div>
      <div class="pcopt-mut">${info}</div>
      <div class="pcopt-mut" role="status">${esc(status)}</div>
      ${odds ? `<div class="pcopt-mut">${odds}</div>` : ''}
      ${rows ? `<div data-team>${rows}</div>` : ''}
      ${errLine()}`;
    mountBlock(head, 'legend', sig, html, el => {
      el.querySelectorAll('[data-preset]').forEach(button => {
        button.disabled = !!job;
        button.onclick = () => {
          if (state.busy || state.preset === button.dataset.preset) return;
          state.preset = button.dataset.preset;
          legendNotice = null;
          legendResult = null;
          refreshUi();
        };
      });
      el.querySelector('[data-act="run"]').onclick = () => runLegendOptimizer(head, ctx);
      el.querySelector('[data-act="apply"]').onclick = async () => {
        if (!result || result.preset !== state.preset || !sameLegendPicker(head, key) || state.busy) return;
        const available = new Map(eventCandidates(readSave(), legendLevel(ctx.zone, ctx.tier, state.data), ctx.zone.region)
          .map(candidate => [candidate.mon.uid, candidate.mon]));
        if (result.team.some(({ mon }) => {
          const current = available.get(mon.uid);
          return !current || memberSignature(current) !== memberSignature(mon) || current.level !== mon.level;
        })) {
          legendResult = null;
          legendNotice = { head, key, text: '推荐成员已变化，请重新配队。' };
          refreshUi();
          return;
        }
        legendNotice = { head, key, text: '正在应用队伍…' };
        await applyTeamFromPanel(result.team, true);
        legendNotice = { head, key, text: state.errors.length ? '队伍应用未完成。' : `已应用并核对 ${result.team.length} 个位置。` };
        refreshUi();
      };
      const cancel = el.querySelector('[data-act="cancel-legend"]');
      if (cancel) cancel.onclick = () => { job.cancelled = true; };
    });
  }

  async function runLegendOptimizer(head = document.querySelector('#evt-pick-head'), ctx = pickerContext()) {
    if (!head || !ctx || state.busy) return;
    const { zone, tier } = ctx;
    const key = legendKey(ctx);
    const preset = state.preset;
    const job = { head, key, cancelled: false, status: '正在读取可用宝可梦…' };
    const active = () => !job.cancelled && sameLegendPicker(head, key);
    state.busy = true;
    state.errors = [];
    legendResult = null;
    legendNotice = null;
    legendJob = job;
    refreshUi();

    // Yield to the page between short batches so clicks, scrolling, and closing still work.
    const runSteps = async steps => {
      while (active()) {
        const deadline = performance.now() + 12;
        do {
          const step = steps.next();
          if (step.done) return step.value;
        } while (performance.now() < deadline);
        await sleep(0);
      }
      return null;
    };

    try {
      await sleep(20);
      if (!active()) return;
      if (!await ensureData()) throw new Error('游戏数据尚未就绪，请重试。');
      if (!active()) return;
      const save = readSave();
      if (!save) throw new Error('未读取到冒险存档。');
      const { data, engine } = state;
      const candidates = eventCandidates(save, legendLevel(zone, tier, data), zone.region);
      job.status = '正在比较候选阵容…';
      refreshUi();
      const team = await runSteps(searchLegendSteps(candidates, zone, tier, engine, data, preset));
      if (!active()) return;
      if (!team?.length) throw new Error('没有符合条件的宝可梦。');
      job.status = '正在模拟胜率…';
      refreshUi();
      const odds = await runSteps(legendOddsSteps(zone, tier, team, engine, data, save));
      if (!active()) return;
      const boss = legendBoss(zone, tier, team, engine, data);
      legendResult = { head, key, preset, team, odds, boss, profiles: legendTurnStats(team, boss, engine) };
    } catch (error) {
      logError('legend optimizer: failed', error);
      if (active()) legendNotice = { head, key, text: '配队失败：' + zhError(error?.message || error) };
    } finally {
      if (job.cancelled && sameLegendPicker(head, key)) {
        legendNotice = { head, key, text: '已取消配队，可重新计算。' };
      }
      legendJob = null;
      state.busy = false;
      refreshUi();
    }
  }


  /** The raid picker: fastest clear and the total DPS line. */
  function mountRaidBox(head,rc){
    const saved=state.evtOdds?.key==='raid:'+rc.id?state.evtOdds.text:'';
    const html=`<div class="pcopt-row"><button class="btn small" data-act="run" ${state.busy?'disabled':''}${state.busy?"正在比较或填入…":"推荐并填入己方两只"}</button></div><div class="pcopt-mut">这里只选择你的宝可梦。同伴请关闭此窗口，回团体战主页面选择。</div><div class="pcopt-mut" role="status">${esc(saved)}</div>${errLine()}`;
    mountBlock(head,'raid',JSON.stringify([rc.id,state.busy,saved,state.errors]),html,el=>{
      el.querySelector('[data-act="run"]').onclick=async()=>{
        if(state.busy)return;state.busy=true;state.errors=[];refreshUi();
        try{await fastestClear(rc)}catch(error){state.errors=[error.message]}finally{state.busy=false;refreshUi()}
      };
    });
  }

  /** Remove the floating panel and the old quick-optimize rows a previous version left behind. */
  function cleanupLegacy() {
    document.getElementById('pcopt-panel')?.remove();
    document.getElementById('pcopt-team-ui')?.remove();
    const oldRow = document.getElementById('pcopt-evt');
    if (oldRow && !oldRow.closest('[data-pcopt]')) oldRow.remove();
    document.querySelectorAll('#evt-pick-head .pcopt-row:not(.pcopt-block):not([data-pcopt])').forEach(el => {
      if (!el.closest('[data-pcopt]')) el.remove();
    });
  }

  /** Refresh every block that is currently on screen (cheap: signature-guarded). */
  function refreshUi() {
    try {
      cleanupLegacy();
      mountMonitor();
      mountRoamerHunt(document.querySelector('#screen-adventure .adv-main'), true);
      mountTemplates();
      mountChapter();
      mountRaidAllyButtons();
      if (state.raidPreviewContext) annotateRaidSuggestions();
      if (document.querySelector('#evt-pick-head')) injectPickerUi().catch(e => logError('picker ui: inject', e));
      else state.raidBoss = null;
    } catch (e) { logError('ui: refresh', e); }
  }

  /* ------------------------------------------------------------------ *
   * 10. Boot + actions
   * ------------------------------------------------------------------ */
  const dataLooksValid = d => !!d && d.species && Object.keys(d.species).length > 100
    && d.moves && Object.keys(d.moves).length > 50
    && d.cfg?.BERRY_HEAL != null && d.habitats && Object.keys(d.habitats).length > 10
    && Array.isArray(d.chapters) && d.chapters.length > 10;

  function clearStartupErrors() {
    state.errors = state.errors.filter(message => !/^(?:game bundle not loaded yet|bundle parse failed:|learnset error:|legend zones not found in the bundle)/.test(message));
  }

  async function ensureData(options = {}) {
    if (state.loading) return state.loading;
    if (state.engine && !options.force) return true;
    if (!options.force && state.dataPhase === 'failed' && Date.now() < state.dataRetryAt) return false;
    const url = bundleUrl();
    if (!url) {
      state.dataPhase = 'waiting';
      state.dataError = '';
      clearStartupErrors();
      return false;
    }
    state.dataPhase = 'loading';
    state.dataError = '';
    // Start in a microtask so a cached load cannot finish before state.loading is assigned.
    state.loading = Promise.resolve().then(async () => {
      const cacheKey = 'bundle:zh1110:' + url;
      let data = options.force ? null : store.get(cacheKey, null);
      if (!dataLooksValid(data) || !data.chart || Object.keys(data.chart).length < 18) data = null;
      if (!data) {
        data = await parseBundle(url);
        if (!dataLooksValid(data) || !data.chart || Object.keys(data.chart).length < 18) throw new Error('invalid game tables');
        store.set(cacheKey, data);
      }
      const learnAll = buildLearnAll(data);
      // The game already ships the full type chart. External reference sites are optional,
      // and must not block startup on a slow or unavailable cross-origin connection.
      const chart = data.chart;
      const engine = makeEngine(data, chart, learnAll);
      Object.assign(state, { data, learnAll, chart, engine, chartSource: 'game', legends: data.legends,
        dataPhase: 'ready', dataError: '', dataAttempts: 0, dataRetryAt: 0 });
      clearStartupErrors();
      if (!data.legends) state.errors.push('legend zones not found in the bundle');
      refreshChapter();
      log('info', 'data: engine ready', { species: Object.keys(data.species).length,
        legends: data.legends?.zones?.length ?? 0, chart: state.chartSource });
      return true;
    }).catch(error => {
      state.dataAttempts++;
      state.dataPhase = 'failed';
      state.dataError = '读取失败：' + zhError(error?.message || error);
      state.dataRetryAt = Date.now() + Math.min(60000, 1500 * Math.pow(2, Math.min(5, state.dataAttempts - 1)));
      logError('data: initialization failed', error);
      return false;
    }).finally(() => {
      state.loading = null;
      refreshUi();
    });
    refreshUi();
    return state.loading;
  }

  function maybeLoadData() {
    if (state.engine || state.loading || Date.now() < state.dataRetryAt) return;
    ensureData().catch(error => logError('data: retry', error));
  }

  /** Read the current chapter events (foes, types, cap) without running the full optimizer. */
  function refreshChapter() {
    const save = readSave();
    if (!save || !save.adv || !state.data) return;
    const info = chapterInfo(state.data, save.adv.chapter, save);
    if (!info) return;
    state.events = info;
    const league = leagueChapters(state.data, info.index);
    state.league = league.length > 0;
    state.leagueInfo = league.length
      ? `联盟：${league.map(i => zhText((state.data.chapters[i].steps.find(st => st.kind === 'gym')?.leader) || '?')).join(' → ')} · 团灭后从第一位重新开始`
      : null;
    state.enemies = chapterEnemies(state.data, info, save.adv.nodes).map(e => {
      const types = state.data.species[e.id]?.types || [];
      const proj = { id: e.id, level: e.level, types };
      return { ...e, proj, types, hp: state.engine ? state.engine.maxHp(proj) : 0 };
    });
    const away = awayUids(save);
    state.eligible = save.mons.filter(m => !away.has(m.uid) && state.data.species[m.id] && canJoinTeam(save, m)).length;
  }

  /** Search the chapter's best team by Monte-Carlo simulation of the whole run. */
  const PLANNING_HELP={
    growth:{title:'培养方向怎么看',body:'<ol><li>先按当前实力分析，得到现在可以使用的推荐队伍，再展开“培养方向”。</li><li>逐项比较只升级、一步进化、进化后升级的收益。显示目标等级、道具现有数量、交换或时段等条件，升级目标不超过这只宝可梦当前成长上限。</li><li>每一项都是独立假设，不是把所有培养一起完成的方案；收益不能相加。</li><li>完成实际培养后，重新“分析并推荐”，再安排队伍。培养面板不会自动升级、进化、消费或换人。</li></ol><p>比较的是对当前路线的帮助，不是长期强度排名。搜索有限，目标等级不一定是最低所需等级；同族进化限制仍需在游戏中确认。交换进化要有其他玩家配合，不能当成用一件道具就完成。</p>'},
    start:{title:'实战配队怎么用',body:'<ol><li>想为下一次完整挑战做准备，选“整章挑战”；正在路上想优化下一次回复后的战斗，选“下次回复后”。</li><li>点“分析并推荐”，先看目标战斗、全程结果和换入名单。计算时可以继续冒险。</li><li>点“安排推荐队伍”才开始实际换队。查看进度，可取消或重试。</li><li>“安排完成”表示名单已保存。途中通常在下一个宝可梦中心回复时成为出战队伍，当前战斗继续用原成员。</li></ol><p>队伍页面编辑的是安排名单；战斗自动换人只在当前出战成员里选择。新抓成员不会单独锁住已有方案，推荐成员进化或不可用时会注明原因。</p>'},
    target:{title:'怎么选择分析目标',body:'<p><b>整章挑战 · 优先突破团灭点</b>：按目前实际等级、形态，模拟从章首满血挑战。适合为重试准备一套队伍；不会替你重开章节。</p><p><b>下次回复后 · 后续路线</b>：从前方第一个尚未处理的宝可梦中心之后开始比较。到中心之前仍是原出战队伍。如果本章后面没有中心，请用整章挑战。</p><p>等级上限是成长边界，不会把低等级成员直接当成满级。“培养方向”另外比较升级或进化后的假设。防守／进攻／均衡影响候选偏好，最终仍按路线表现比较。</p>'},
    results:{title:'怎样看模拟结果',body:'<p>“突破团灭点”表示从分析起点出发，能走到并通过最近那场匹配战斗的模拟比例；“分析范围全程通过”表示整个选定范围都通过。</p><p>64次是电脑模拟，不是真实战绩。推荐与原安排使用相同场景；失败位置计数表示首次倒在该处的次数，不是那场战斗单独的失败率。</p><p>单只伤害／承受回合是路线样本的粗略指标；显示的招式不是强制只用这一招。历史团灭和模拟统计分开显示。候选搜索、天气与部分战斗效果仍有近似，不保证通关。</p>'},
    segments:{title:'分段方案与自动换队',body:'<ol><li>“分析分段方案”按宝可梦中心切段，只计算并保存在助手里，不改游戏队伍。每段显示用途、计算时等级、原队对照和保留原因。相同队伍会共用模板，不需要为了分段强行换人。</li><li>可点“安排本段”手动使用；实际换人仍等游戏回复。</li><li>需要自动换队时，先在游戏队伍页选定一个当前模板，再点“保存游戏模板”。它会显示进度，并使用空模板；需要覆盖时先看清目标。当前模板保留，位置不够会明确提示，不会把一段冒充整章。</li><li>全部保存核对后再开启“自动提前安排”。助手在路上提前选择下一回复点后的模板，当前战斗不受影响；到回复后核对实际出战名单。自动只负责未来回复点后的段，不会替你从第一段重开。</li></ol><p>手动选择会暂停本次回复前的自动安排。刷新后自动默认关闭，先进入队伍页确认模板再开启。切到后台不操作，回来会检查是否错过；路线变化、模板被改、成员进化或不可用时停止并注明原因。自动换队只服务于这份路线方案，不会替你重开章节。</p><p>保存模板会短暂切换安排名单，期间请看进度。若游戏在保存期间已回复，会停止后续写入并提示核对出战队伍。后续段按计算时等级满血估计，升级后可重新分析。</p>'}
  };
  function helpButton(key,label='使用说明'){return `<button type="button" class="pcopt-help-button" data-planning-help="${key}" aria-label="${label}" title="${label}">?</button>`;}
  function openPlanningHelp(key){
    const item=PLANNING_HELP[key];if(!item)return;document.querySelector('#pcopt-help')?.remove();const previous=document.activeElement,root=document.createElement('div');root.id='pcopt-help';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-labelledby','pcopt-help-title');root.className='pcopt-help-cover pcopt-dialog';
    root.innerHTML=`<section class="pcopt-help-sheet modal"><div class="pcopt-help-head"><b id="pcopt-help-title">${item.title}</b><button type="button" class="btn small ghost" data-help-close aria-label="关闭说明"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 5 14 14M5 19 19 5"/></svg></button></div><div class="pcopt-help-text">${item.body}</div><button type="button" class="btn pcopt-help-done" data-help-close>知道了</button></section>`;
    const close=()=>{root.remove();if(previous?.isConnected)previous.focus()};root.querySelectorAll('[data-help-close]').forEach(b=>b.onclick=close);root.onclick=e=>{if(e.target===root)close()};
    root.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();close()}if(e.key==='Tab'){const list=[...root.querySelectorAll('button')],first=list[0],last=list[list.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});document.body.appendChild(root);root.querySelector('button').focus();
  }

  function growthFingerprint(save){
    const keys=[...new Set(Object.values(state.data.evo).flat().map(e=>e.item).filter(k=>k&&k!=='link-cable'))].sort();
    return JSON.stringify([routeSignature(save),state.planScope,state.preset,state.team?.map(c=>c.mon.uid),rosterStamp(save),save.adv?.unlocked,save.travel?.to,save.adv?.badges,keys.map(k=>[k,save.items?.[k]||0]),new Date().getHours(),state.planScope==='after-heal'?nextHealNode(save):null]);
  }
  function growthCap(save,mon){
    if(!Number.isInteger(save.adv?.unlocked))return null;
    const data=state.data,max=data.cfg.MAX_LEVEL,chapters=key=>data.chapters.map((c,i)=>i).filter(i=>(data.chapters[i].reg||'kanto')===key);
    const capAt=i=>{const c=data.chapters[i],margin=c.capMargin??(c.league?(data.cfg.LEAGUE_CAP_MARGIN??3):(data.cfg.LEVEL_CAP_MARGIN??0));let n=aceOf(data,i)+margin;
      if(c.league&&c.capMargin==null&&!c.steps.some(s=>s.champion))n=Math.min(n,Math.max(...chapters(c.reg||'kanto').filter(j=>data.chapters[j].league).map(j=>aceOf(data,j))));return n;};
    const next=key=>chapters(key).find(i=>i>=save.adv.unlocked&&data.chapters[i].steps.some(s=>s.kind==='gym')&&!data.chapters[i].steps.some(s=>s.champion&&save.adv.badges?.includes(s.badge)));
    if(save.link){let key=mon.reg==='kanto2'?'johto':mon.reg||'kanto';if(!data.regions.some(r=>r.key===key))key='kanto';const n=next(key);return Math.min(max,n!=null?capAt(n):Math.max(...chapters(key).map(capAt),data.cfg.LEAGUE_DONE_CAP??100));}
    let reached=0;for(const r of data.regions){if(!r.key||!r.ace||!(r.open||save.travel?.to?.includes(r.key)))continue;const n=next(r.key);if(n!=null)return Math.min(max,capAt(n));for(const j of chapters(r.key))reached=Math.max(reached,capAt(j));}return Math.min(max,reached?Math.max(reached,data.cfg.LEAGUE_DONE_CAP??100):max);
  }
  function futureCandidate(original,id,level){
    const mon={...original,id,level,xp:level===original.level?(original.xp||0):0};for(const k of ['hp','status','bit','sleep','sleepLeft','confused'])delete mon[k];
    const species=state.data.species[id],proj={...mon,types:species.types},hp=state.engine.maxHp(proj);return{mon,base:proj,proj,species,hp,hpCur:hp};
  }
  function growthVariants(save){
    const result=[],skipped={rank:0,region:0,party:0},party=new Set([...(save.team||[]),...(save.road||[])].map(u=>monByUid(save,u)?.id));
    for(const candidate of currentCandidates(save,true)){
      const m=candidate.mon,cap=growthCap(save,m);if(!cap)continue;
      const levels=new Set([Math.min(cap,m.level+5),cap]);
      for(const [lv]of state.learnAll.learnAll[m.id]||[])if(lv>m.level&&lv<=cap&&lv<=m.level+5)levels.add(lv);
      for(const e of state.data.evo[m.id]||[])if(e.level>m.level&&e.level<=cap)levels.add(e.level);
      const upgrades=[...levels].filter(n=>n>m.level).sort((a,b)=>a-b);const selected=[...upgrades.slice(0,2),...(upgrades.length?[upgrades.at(-1)]:[])];
      for(const level of new Set(selected))result.push({uid:m.uid,fromId:m.id,fromLevel:m.level,id:m.id,level,kind:'level',cap,requirements:[`提升 ${level-m.level} 级，保留当前形态`],conditional:false,candidate:futureCandidate(m,m.id,level)});
      for(const e of state.data.evo[m.id]||[]){
        if(!state.data.species[e.to])continue;if(m.rank){skipped.rank++;continue;}if(!regionHas(state.data,save,e.to)){skipped.region++;continue;}
        if(e.party&&!party.has(e.party)){skipped.party++;continue;}
        const level=Math.max(m.level,e.level||m.level);if(e.level>cap&&m.level<e.level)continue;
        const requirements=[],time=state.data.cfg.TIME_EVOLUTIONS?.[e.to],timeOk=daytimeMatches(state.data,save,time);
        if(level>m.level)requirements.push(`先提升 ${level-m.level} 级至 Lv.${level}`);
        if(e.level)requirements.push(`等级条件 Lv.${e.level}；在游戏内确认进化`);
        if(e.party)requirements.push(`队伍需有${displayName(e.party)}`);
        if(time)requirements.push(timeOk?'当前时段条件符合':`需等待符合${time==='night'?'夜间':time==='morning'?'清晨':'指定时段'}的条件`);
        let conditional=!timeOk;
        if(e.item==='link-cable'){conditional=true;requirements.push('交换进化：需要其他玩家配合；返还个体及接收等级待确认，此处按同等级形态估计');}
        else if(e.item){const n=save.items?.[e.item]||0;requirements.push(`${zhText(state.data.itemNames?.[e.item]||GROWTH_ITEM_NAMES[e.item]||e.item)} ×1（现有 ${n}）`);conditional=conditional||n<1;}
        const duplicate=save.mons.some(other=>other.uid!==m.uid&&other.id===e.to&&!!other.shiny===!!m.shiny&&(!save.link||((other.reg===save.link.to)===(m.reg===save.link.to))));
        if(duplicate){conditional=true;requirements.push('已持有同色目标形态，可能受游戏同族保留规则限制，须核对进化按钮');}
        if(e.level){const eligible=(state.data.evo[m.id]||[]).filter(v=>v.level&&v.level<=level&&regionHas(state.data,save,v.to)&&daytimeMatches(state.data,save,state.data.cfg.TIME_EVOLUTIONS?.[v.to])&&(!v.party||party.has(v.party)));
          if(eligible.length>1){const index=[...m.uid].reduce((h,c)=>h*31+c.charCodeAt(0)>>>0,7)%eligible.length;if(eligible[index].to!==e.to)continue;}}
        result.push({uid:m.uid,fromId:m.id,fromLevel:m.level,id:e.to,level,kind:'evolve',cap,item:e.item||null,requirements,conditional,candidate:futureCandidate(m,e.to,level)});
        if(cap>level)result.push({...result.at(-1),level:cap,kind:'both',requirements:[...requirements,`进化后练至 Lv.${cap}（合计提升 ${cap-m.level} 级）`],candidate:futureCandidate(m,e.to,cap)});
      }
    }return{variants:result,skipped};
  }
  const GROWTH_ITEM_NAMES={'fire-stone':'火之石','water-stone':'水之石','thunder-stone':'雷之石','leaf-stone':'叶之石','moon-stone':'月之石','sun-stone':'日之石','shiny-stone':'光之石','dusk-stone':'暗之石','dawn-stone':'觉醒之石','ice-stone':'冰之石','kings-rock':'王者之证','metal-coat':'金属膜','dragon-scale':'龙之鳞片','soothe-bell':'安抚之铃','prism-scale':'美丽鳞片','deep-sea-tooth':'深海之牙','deep-sea-scale':'深海之鳞','protector':'护具','electirizer':'电力增幅器','magmarizer':'熔岩增幅器','reaper-cloth':'灵界之布','razor-claw':'锐利之爪','razor-fang':'锐利之牙','oval-stone':'浑圆之石','shed-shell':'脱壳'};
  function growthOptionsForTeam(team,v){
    const same=team.findIndex(c=>c.mon.uid===v.uid),slots=same>=0?[same]:team.map((_,i)=>i),out=[];
    for(const slot of slots){if(team.some((c,i)=>i!==slot&&(c.mon.uid===v.uid||c.mon.id===v.id&&!!c.mon.shiny===!!v.candidate.mon.shiny)))continue;const members=team.slice();members[slot]=v.candidate;out.push({members,slot,replaced:team[slot].mon.id});}return out;
  }
  function growthCompare(a,b){return (a.res.focusRate!=null&&b.res.focusRate!=null?a.res.focusRate-b.res.focusRate:0)||a.res.rate-b.res.rate||a.res.avgCleared-b.res.avgCleared||Number(b.conditional)-Number(a.conditional)||((b.level-b.fromLevel)-(a.level-a.fromLevel))||a.res.health-b.res.health;}
  async function analyzeGrowth(save,team,options={}){
    const plan=selectedChapterPlan(state.data,save),focus=failureFocus(save,plan),fingerprint=growthFingerprint(save),seed=seedHash('growth:'+fingerprint+':'+team.map(c=>c.mon.uid).join('|'));
    const all=growthVariants(save),scored=rankCurrentCandidates(all.variants.map(v=>v.candidate),plan,save,true);
    const ranked=all.variants.map((v,i)=>({...v,score:scored[i].currentScore})).sort((a,b)=>b.score-a.score||(a.level-a.fromLevel)-(b.level-b.fromLevel));
    const pool=[],add=v=>{if(v&&!pool.includes(v))pool.push(v)};for(const kind of ['level','evolve','both'])ranked.filter(v=>v.kind===kind).slice(0,3).forEach(add);ranked.forEach(add);
    const limit=options.limit??(MOBILE_BUILD?12:18),deadline=Date.now()+(options.budget??(MOBILE_BUILD?9000:14000)),screen=[],evaluate=(members,runs,validation)=>simulateChapter(members,plan,state.events.cap,runs,null,{save,fullHeal:true,focusNode:focus?.node,seed:seedHash(seed+(validation?':validation':':screen'))});let tested=0;
    for(const v of pool.slice(0,limit)){
      if(tested&&Date.now()>deadline)break;let best=null;
      for(const choice of growthOptionsForTeam(team,v)){const res=evaluate(choice.members,8,false);if(!best||compareTeamResults(res,best.res)>0)best={...choice,res};}
      if(best)screen.push({...v,...best});tested++;state.progress={pct:Math.min(.7,tested/Math.min(limit,pool.length)*.7),label:`比较培养方向 ${tested}/${Math.min(limit,pool.length)}…`};if(!options.silent)updateProgress();await sleep(0);
      if(options.check&&growthFingerprint(readSave())!==fingerprint)throw Error('培养计算期间，仓库、等级或培养条件已变化，请重新分析。');
    }
    screen.sort((a,b)=>growthCompare(b,a));
    const baseline=evaluate(team,64,true),shortlist=screen.slice(0,4),validated=[],freeOptions=[];
    for(const v of shortlist){const res=evaluate(v.members,64,true),gain=(focus?res.focusWins-baseline.focusWins:res.wins-baseline.wins),clearGain=res.avgCleared-baseline.avgCleared;
      const original=monByUid(save,v.uid),plain=team.slice();plain[v.slot]=futureCandidate(original,original.id,original.level);const untrained=evaluate(plain,64,true),trainingGain=focus?res.focusWins-untrained.focusWins:res.wins-untrained.wins,trainingClear=res.avgCleared-untrained.avgCleared;
      const beatsBaseline=gain>2||(gain>=0&&clearGain>=.3),beatsUntrained=trainingGain>2||(trainingGain>=0&&trainingClear>=.3);if(beatsBaseline&&!beatsUntrained)freeOptions.push({uid:v.uid,id:original.id,rate:untrained.rate});
      validated.push({...v,res,untrained,gain,clearGain,meaningful:beatsBaseline&&beatsUntrained});state.progress={pct:.85,label:'复核培养收益，并检查不培养能否达到同样效果…'};if(!options.silent)updateProgress();await sleep(0);}
    validated.sort((a,b)=>growthCompare(b,a));
    return{fingerprint,at:Date.now(),baseline,focus,range:[plan[0].nodeIndex,plan.at(-1).nodeIndex],tested,validated:shortlist.length,freeOptions:[...new Map(freeOptions.map(v=>[v.uid,v])).values()],total:pool.length,skipped:all.skipped,list:validated.filter(v=>v.meaningful&&!validated.some(o=>o!==v&&o.meaningful&&o.uid===v.uid&&o.kind==='level'&&v.kind==='both'&&o.level<=v.level&&o.res.rate>=v.res.rate&&o.res.avgCleared>=v.res.avgCleared&&(o.res.focusRate??1)>=(v.res.focusRate??1))).slice(0,3).map(({candidate,members,...v})=>v),seed};
  }
  async function runGrowth(){
    if(state.busy)return;if(!state.team?.length||recommendationStale(readSave())){state.errors=['请先按当前实力“分析并推荐”，再比较培养方向。'];refreshUi();return;}
    state.busy=true;state.growthBusy=true;state.growthOpen=true;state.errors=[];state.waiting='正在比较升级与进化的收益…';refreshUi();
    try{const save=JSON.parse(JSON.stringify(readSave())),current=new Map(currentCandidates(save,true).map(c=>[c.mon.uid,c])),team=state.team.map(c=>current.get(c.mon.uid));if(team.some(c=>!c))throw Error('推荐成员已变化，请重新分析。');
      const out=await analyzeGrowth(save,team,{check:true});if(growthFingerprint(readSave())!==out.fingerprint)throw Error('培养条件已变化，请重新分析。');state.growth=out;
    }catch(e){state.errors=[e.message]}finally{state.busy=false;state.growthBusy=false;state.progress=null;state.waiting=null;refreshUi();}
  }
  function renderGrowth(save){
    const out=state.growth,stale=out&&out.fingerprint!==growthFingerprint(save),pct=n=>Math.round(n*100)+'%',kinds={level:'升级',evolve:'进化',both:'进化并升级'};
    return `<details class="pcopt-explain" data-growth-panel ${state.growthOpen?'open':''}><summary><span class="pcopt-help-line">培养方向${out?' · '+(stale?'需要重算':out.list.length+' 项有明显收益'):''}${helpButton('growth','培养建议怎么看')}</span></summary><p class="pcopt-mut">先得到当前实力推荐，再比较“培养一只之后”的收益。只做预估，不消耗资源。</p><button class="btn small ghost" data-act="growth" ${state.busy||!state.team?.length||recommendationStale(save)?'disabled':''}>${state.growthBusy?'正在比较，请稍候…':out?'重新分析培养方向':'分析培养方向'}</button>${out?`<p class="pcopt-mut">分析于 ${esc(new Date(out.at).toLocaleTimeString('zh-CN'))} · 第 ${out.range[0]+1}–${out.range[1]+1} 步<br>当前实力推荐：全程 ${pct(out.baseline.rate)}${out.focus?' · 突破团灭点 '+pct(out.baseline.focusRate):''}<br>候选培养方式 ${out.total} 种；已试算 ${out.tested} 种，前 ${out.validated} 种进入独立复核。</p>${stale?'<p class="pcopt-note">仓库、等级、目标或培养条件已变化，下面是旧结果，请重新分析。</p>':''}${out.freeOptions?.length?'<p class="pcopt-note">有 '+out.freeOptions.length+' 个个体现状已接近培养后的收益，不建议为本章额外投入；可重新分析现有队伍比较。</p>':''}${out.list.map(v=>`<article class="pcopt-growth-card"><div class="pcopt-growth-head"><img src="assets/pokemon/${v.id}.png" alt="" loading="lazy"><div><b>${esc(displayName(v.fromId))} Lv.${v.fromLevel} → ${esc(displayName(v.id))} Lv.${v.level}</b><small>${kinds[v.kind]} · 个体尾号 ${esc(v.uid.slice(-5))} · ${v.conditional?'条件未齐／需额外核实':v.kind==='level'?'仅需练级；不要求进化':'按条件培养后再核对进化界面'}</small></div></div><p>全程模型通过 ${pct(out.baseline.rate)} → <b>${pct(v.res.rate)}</b><br>该个体不培养、仅换入：${pct(v.untrained.rate)}${out.focus?'<br>突破团灭点 '+pct(out.baseline.focusRate)+' → '+pct(v.res.focusRate):''}<br>平均推进 ${out.baseline.avgCleared.toFixed(1)} → ${v.res.avgCleared.toFixed(1)} 场</p><p>${v.uid===state.team?.[v.slot]?.mon.uid?'培养原推荐中的这一只':'培养后替换 '+esc(displayName(v.replaced))}；当前成长上限 Lv.${v.cap}</p><ul>${v.requirements.map(t=>'<li>'+esc(t)+'</li>').join('')}</ul><small>仅评估这一项培养，其他成员维持分析时状态。完成后重新“分析并推荐”，再安排实际队伍。</small></article>`).join('')||'<p class="pcopt-note">本次有限搜索未找到明显改善。当前方案可能已经够用，也可能需要更多培养或候选；不表示这些宝可梦没有长期价值。</p>'}<details><summary>评估范围与限制</summary><p>每项独立比较，不能把收益相加。均按满血出发；初筛每队 8 次，复核与对照共用同一批 64 个场景。只试算单个成员的升级、一步进化及其升级组合，不穷举全部组合或多步进化。显示等级是已测试档位，不保证是最低所需等级；还受模型近似影响。</p><p>进化还需在游戏中核对同族保留等限制。强化阶级导致不能进化、目标地区未开放或缺少同队条件的部分路径未纳入（分别 ${out.skipped.rank}/${out.skipped.region}/${out.skipped.party} 条）。缺少的道具及交换条件会单独标记。方案不会自动升级、进化、使用糖果或替换队伍。</p></details>`:''}</details>`;
  }

  function routeSignature(save){
    return JSON.stringify([save?.adv?.chapter,save?.adv?.event,save?.adv?.zone,save?.adv?.tower,save?.adv?.league,
      save?.link?.side,save?.link?.to,save?.autoSwitch!==false,(save?.adv?.nodes||[]).map(n=>({type:n.type,name:n.name,team:n.team,gym:n.gym,id:n.id,level:n.level,lv:n.lv,areas:n.areas,species:n.species,pool:n.pool,size:n.size,classes:n.classes,statMult:n.statMult,rank:n.rank,gymTrainer:n.gymTrainer,roamer:chapterRoamer(n,save)}))]);
  }
  function memberSignature(mon){return JSON.stringify([mon.id,mon.rank||0,!!mon.shiny,mon.reg||'kanto',mon.taste,mon.statMult||1,mon.hpMult||1]);}
  function memberBasis(save,uids){return uids.map(uid=>{const mon=monByUid(save,uid);return{uid,signature:mon&&memberSignature(mon),level:mon?.level};});}
  function memberIssue(save,basis){
    if(!save)return '未读取到游戏存档，请稍后重试。';const away=awayUids(save);
    for(const old of basis||[]){const mon=monByUid(save,old.uid);if(!mon||away.has(old.uid)||!canJoinTeam(save,mon))return '方案中的成员已不可用，请重新分析。';
      if(memberSignature(mon)!==old.signature)return `${displayName(mon.id)} 的形态或能力条件已变化，请重新分析。`;
      if(mon.level<old.level)return `${displayName(mon.id)} 的等级降低了，请重新分析。`;}
    return '';
  }
  function nextHealNode(save){return(save?.adv?.nodes||[]).findIndex((n,i)=>i>=(save?.adv?.node||0)&&n.type==='heal');}
  function recommendationIssue(save){
    if(state.resultContext){const ctx=state.resultContext;
      if(ctx.scope!==state.planScope)return '分析目标已变化，请重新分析。';
      if(ctx.route!==routeSignature(save))return '章节、路线或地区限制已变化，请重新分析。';
      if(ctx.scope==='after-heal'&&ctx.heal!==nextHealNode(save))return '用于分析的宝可梦中心已经经过，请重新分析后续路线。';
      return memberIssue(save,ctx.members);
    }
    const comparable=state.resultPlannedTeamBasis?{...save,team:state.resultPlannedTeamBasis}:save;
    if(state.resultStale||state.resultFingerprint!==optimizationFingerprint(comparable))return '这份旧方案缺少当前分析条件，请重新分析。';
    return(save?.mons||[]).some(m=>state.resultLevels?.[m.uid]!=null&&m.level<state.resultLevels[m.uid])?'成员等级降低，请重新分析。':'';
  }
  function rosterStamp(save){return seedHash(JSON.stringify((save?.mons||[]).map(m=>[m.uid,memberSignature(m),m.level]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))));}
  function recommendationNote(save){return state.resultContext&&!recommendationIssue(save)&&state.resultContext.roster!==rosterStamp(save)?'盒子或等级有更新：现有方案仍可安排，也可重新分析比较新成员。':'';}

  function optimizationFingerprint(save){
    if(state.planScope==='restart'||state.planScope==='after-heal'){
      const next=state.planScope==='after-heal'?(save?.adv?.nodes||[]).findIndex((n,i)=>i>=(save?.adv?.node||0)&&n.type==='heal'):null;
      return JSON.stringify([state.planScope,save?.adv?.chapter,save?.adv?.event,save?.adv?.zone,save?.adv?.tower,save?.adv?.league,next,seedHash(JSON.stringify(save?.adv?.nodes||[])),save?.link?.side,save?.link?.to,save?.team,
        (save?.mons||[]).map(m=>[m.uid,m.id,m.rank,m.shiny,m.reg,m.taste]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
    }
    return JSON.stringify([save?.adv?.chapter,save?.adv?.node,!!save?.adv?.battle,seedHash(JSON.stringify(save?.adv?.nodes||[])),save?.link?.side,save?.link?.to,save?.team,
      (save?.mons||[]).map(m=>[m.uid,m.id,m.level,m.xp,m.rank,m.shiny,m.hp,m.status,m.sleep,m.bit,m.confused]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
  }
  function currentCandidates(save,fullHeal=false,eventCap=null,allow=mon=>canJoinTeam(save,mon)){
    const away=awayUids(save);
    return(save.mons||[]).filter(m=>!away.has(m.uid)&&state.data.species[m.id]&&allow(m)).map(original=>{
      const mon={...original};if(fullHeal){delete mon.status;delete mon.bit;delete mon.sleep;delete mon.sleepLeft;delete mon.confused;}
      const level=eventCap==null?mon.level:Math.min(mon.level,eventCap),sp=state.data.species[mon.id];
      const proj={...mon,level,types:sp.types},hp=state.engine.maxHp(proj),hpCur=fullHeal?hp:mon.hp==null?hp:clamp(mon.hp,0,hp);
      return{mon,base:proj,proj,species:sp,hp,hpCur};
    });
  }
  function recommendationStale(save){return !!recommendationIssue(save);}
  function rankCurrentCandidates(candidates,plan,save,fullHeal){
    const foes=[];
    for(const step of plan){if(step.kind!=='battle')continue;
      const spec=withSimSeed(seedHash('rank:'+step.nodeIndex),()=>rollBattleFoes(step,state.data,save,state.events?.cap??100));
      if(!spec)throw new Error('无法读取战斗对手，未计算推荐。');
      for(const foe of spec.foes)foes.push({...foe,weight:step.roamer?3:step.type==='gym'?2:1});
    }
    return candidates.map(candidate=>{
      const hp=fullHeal?candidate.hp:candidate.hpCur;let dmg=0,survive=0,weight=0,bestDmg=-1,bestMoveKey='',special=[];
      for(const foe of foes){const mv=state.engine.bestMove(candidate.proj,foe.types),ev=state.engine.bestMove(foe,candidate.proj.types),w=foe.weight;
        const out=mv?state.engine.damage(candidate.proj,foe,mv,effRaw(mv.type,foe.types))*mv.acc/100:0;
        const incoming=ev?state.engine.damage(foe,candidate.proj,ev,effRaw(ev.type,candidate.proj.types))*ev.acc/100*(foe._damageMult||1):0;
        const rounds=hp<=0?0:Math.min(50,incoming>0?hp/incoming:50);
        dmg+=out*w;survive+=rounds*w;weight+=w;special.push(out*Math.min(rounds,10));
        if(out>bestDmg){bestDmg=out;bestMoveKey=mv?.key||''}
      }
      const avgDmg=dmg/Math.max(1,weight),avgRounds=survive/Math.max(1,weight);
      return{...candidate,avgDmg,avgRounds,bestMoveKey,special,currentScore:Math.sqrt(Math.max(0,avgDmg)*Math.max(0,avgRounds))};
    });
  }
  function makeSearchPool(scored,save){
    const byUid=new Map(scored.map(c=>[c.mon.uid,c])),out=[],add=c=>{if(c&&!out.includes(c))out.push(c)};
    for(const uid of save.team||[])add(byUid.get(uid));
    const sort=(fn)=>scored.slice().sort((a,b)=>fn(b)-fn(a)||b.mon.level-a.mon.level||String(a.mon.uid).localeCompare(String(b.mon.uid)));
    for(const c of sort(c=>scoreFor(c,state.preset)).slice(0,18))add(c);
    for(const metric of [c=>c.avgDmg,c=>c.avgRounds,c=>c.mon.level])for(const c of sort(metric).slice(0,6))add(c);
    const count=Math.max(0,...scored.map(c=>c.special.length));
    for(let i=0;i<count&&out.length<48;i++)for(const c of sort(c=>c.special[i]||0).slice(0,2))add(c);
    return out.slice(0,MOBILE_BUILD?40:48);
  }
  function compareTeamResults(a,b){
    return (a.focusRate!=null&&b.focusRate!=null?a.focusRate-b.focusRate:0)||a.rate-b.rate||a.avgCleared-b.avgCleared||a.health-b.health;
  }
  async function searchChapterTeam(save,info,cap,budgetMs,planOverride=null,options={}){
    const plan=planOverride||selectedChapterPlan(state.data,save),fullHeal=options.fullHeal??((state.planScope==='restart'&&!planOverride)||plan[0]?.kind==='heal');
    if(!plan.some(s=>s.kind==='battle'))return{error:'当前范围内没有剩余战斗。'};
    const focus=options.focus===false?null:failureFocus(save,plan);
    const candidates=currentCandidates(save,fullHeal),scored=rankCurrentCandidates(candidates,plan,save,fullHeal),pool=makeSearchPool(scored,save);
    if(!pool.length)return{error:'没有可加入队伍的宝可梦。'};
    const byUid=new Map(scored.map(c=>[c.mon.uid,c])),key=team=>(save.autoSwitch===false?team.map(c=>c.mon.uid):team.map(c=>c.mon.uid).sort()).join('|');
    const current=(save.team||[]).map(uid=>byUid.get(uid)).filter(Boolean),size=Math.min(6,new Set(pool.map(c=>(c.mon.shiny?"shiny:":"mon:")+c.mon.id)).size);
    const build=metric=>{const seen=new Set(),team=[];for(const c of pool.slice().sort((a,b)=>metric(b)-metric(a)||b.mon.level-a.mon.level||String(a.mon.uid).localeCompare(String(b.mon.uid))))if(team.length<size&&!seen.has((c.mon.shiny?"shiny:":"mon:")+c.mon.id)){seen.add((c.mon.shiny?"shiny:":"mon:")+c.mon.id);team.push(c)}return team};
    const seeds=[current,build(c=>scoreFor(c,state.preset)),build(c=>c.avgDmg),build(c=>c.avgRounds),build(c=>c.mon.level)].filter(t=>t.length);
    if(save.autoSwitch===false&&current.length)seeds.push(current.slice().reverse());
    const unique=new Map(seeds.map(team=>[key(team),team])),seed=seedHash(JSON.stringify([info.index,plan.map(p=>p.nodeIndex),state.planScope,save.mons.map(m=>[m.uid,m.id,m.level,m.hp,m.rank,m.status])]));
    const started=Date.now(),deadline=started+Math.max(1500,budgetMs),limit=MOBILE_BUILD?44:72,records=new Map();let evaluated=0;
    const evaluate=async(team,runs,validation=false)=>{
      const res=simulateChapter(team,plan,cap,runs,null,{save,fullHeal,focusNode:focus?.node,seed:validation?seedHash(seed+':validation'):seed});
      await sleep(0);return res;
    };
    for(const team of unique.values()){const res=await evaluate(team,12);records.set(key(team),{team,res});evaluated++}
    let best=[...records.values()].sort((a,b)=>compareTeamResults(b.res,a.res))[0];
    const seen=new Set(records.keys());
    outer:for(let pass=0;pass<2;pass++){
      const anchor=best.team.slice();
      for(let offset=0;offset<pool.length;offset++)for(let slot=0;slot<anchor.length;slot++){
        const candidate=pool[(offset+slot*7)%pool.length];
        if(evaluated>=limit||Date.now()>deadline)break outer;
        if(anchor.some((c,i)=>i!==slot&&(c.mon.uid===candidate.mon.uid||c.mon.id===candidate.mon.id&&!!c.mon.shiny===!!candidate.mon.shiny)))continue;
        const team=anchor.slice();team[slot]=candidate;const id=key(team);if(seen.has(id))continue;seen.add(id);
        const res=await evaluate(team,12),record={team,res};records.set(id,record);evaluated++;
        if(compareTeamResults(res,best.res)>0)best=record;
        state.progress={pct:Math.min(.8,evaluated/limit*.8),label:`按当前实力比较 ${evaluated} 组队伍…`};updateProgress();
      }
      if(key(anchor)===key(best.team))break;
    }
    const ranked=[...records.values()].sort((a,b)=>compareTeamResults(b.res,a.res));
    const finalists=new Map(ranked.slice(0,3).map(r=>[key(r.team),r.team]));if(current.length)finalists.set(key(current),current);
    const validated=[];
    for(const team of finalists.values()){const res=await evaluate(team,64,true);validated.push({team,res});state.progress={pct:.85,label:'用同一批独立场景复核推荐与当前队伍…'};updateProgress()}
    const baseline=validated.find(r=>key(r.team)===key(current));
    let winner=validated.slice().sort((a,b)=>compareTeamResults(b.res,a.res))[0],reason=focus?'优先比较通过上次团灭战斗的比例，再比较整段通关与推进距离。':'推荐在相同场景中通过更多战斗。';
    if(baseline&&key(winner.team)!==key(current)){
      const winsGain=focus?winner.res.focusWins-baseline.res.focusWins:winner.res.wins-baseline.res.wins;
      const clearGain=winner.res.avgCleared-baseline.res.avgCleared;
      if(winsGain<=2&&!(winsGain>=0&&clearGain>=.3)){winner=baseline;reason='与当前队伍差异较小，保留当前队伍，避免因模拟波动反复换队。'}
    }else if(baseline){reason='当前队伍已是本次搜索中较稳的方案，保留原队。'}
    if(!baseline)reason='没有可用的当前队伍对照，推荐仅基于本次候选搜索。';
    if(winner.res.wins===0)reason+=(focus&&winner.res.focusWins>0?' 本次方案能突破部分团灭场景，但尚未找到整段通关方案。':' 本次复核未找到整段通关方案，当前结果仅供尝试。');
    const result=winner.team.slice();
    return{team:result,res:winner.res,baseline:baseline?.res||null,plan,evaluated,reason,focus,poolSize:pool.length,totalCandidates:candidates.length,seed,fullHeal,
      range:[plan[0].nodeIndex,plan[plan.length-1].nodeIndex]};
  }
  async function runOptimizer(){
    if(state.busy)return;
    state.busy=true;state.errors=[];state.applyNotice='';state.resultStale=false;state.team=null;state.sim=null;state.resultFingerprint=null;state.resultLevels=null;state.resultPlannedTeamBasis=null;state.resultContext=null;refreshUi();
    try{
      await ensureData();if(!state.engine)throw new Error('游戏数据尚未就绪。');
      const original=readSave();if(!original?.adv)throw new Error('未读取到冒险存档。');
      if(original.adv.event||original.adv.zone||original.adv.tower||original.adv.league)throw new Error('当前是特殊挑战，请使用对应的传说或团体战配队入口；本面板评估普通章节。');
      const save=JSON.parse(JSON.stringify(original)),fingerprint=optimizationFingerprint(save),info=chapterInfo(state.data,save.adv.chapter,save);
      state.events=info;const started=Date.now(),out=await searchChapterTeam(save,info,info.cap,MOBILE_BUILD?7000:11000);
      if(out.error)throw new Error(out.error);
      state.team=out.team;state.resultFingerprint=fingerprint;state.resultPlannedTeamBasis=(save.team||[]).slice();state.resultLevels=Object.fromEntries(save.mons.map(m=>[m.uid,m.level]));state.resultContext={route:routeSignature(save),scope:state.planScope,heal:nextHealNode(save),members:memberBasis(save,out.team.map(c=>c.mon.uid)),roster:rosterStamp(save)};state.resultStale=recommendationStale(readSave());
      const chosen=new Set(out.team.map(c=>c.mon.uid)),old=new Set(save.team||[]),changes={added:out.team.filter(c=>!old.has(c.mon.uid)).map(c=>displayName(c.mon.id)),removed:(save.team||[]).filter(uid=>!chosen.has(uid)).map(uid=>displayName(monByUid(save,uid)?.id))};
      state.sim={...out.res,changes,baseline:out.baseline,reason:out.reason,focus:out.focus,range:out.range,scope:state.planScope,poolSize:out.poolSize,totalCandidates:out.totalCandidates,roamers:out.plan.filter(step=>step.roamer).map(step=>step.roamer),evaluated:out.evaluated,ms:Date.now()-started};
      if(state.resultStale)state.errors=[recommendationIssue(readSave())];
    }catch(error){state.errors=[error.message]}finally{state.busy=false;state.progress=null;refreshUi()}
  }


  /** Compare the game learnset with the canonical PokéAPI one (the game is freer). */
  async function compareWithPokeApi(uid, info) {
    const save = readSave();
    const mon = save && monByUid(save, uid);
    if (!mon) return;
    const en = englishData()?.pokemon?.[mon.id];
    const name = mon.id > 0 && mon.id <= 649 ? String(mon.id)
      : (Array.isArray(en) ? en[0] : en || gameSearchName(mon.id)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    try {
      const api = await pokeApiSpecies(name);
      const game = (state.learnAll?.learnAll?.[mon.id] || []).filter(([lv]) => lv <= (state.events?.cap ?? 100));
      const apiKeys = new Set(api.learn.map(l => l.key));
      const extra = game.filter(([, key]) => !apiKeys.has(key)).map(([lv, key]) => displayMove(key) + '@' + lv);
      const same = api.types.length === (state.data.species[mon.id]?.types.length)
        && api.types.every(t => (state.data.species[mon.id]?.types || []).includes(t));
      if (info) {
        info.innerHTML = `PokéAPI: ${api.types.map(zhType).join('/')}${same ? '' : '（游戏内：' + (state.data.species[mon.id]?.types.map(zhType).join('/')) + '）'}`
          + (extra.length ? `<br>游戏内多出 ${extra.length} 个招式：${extra.slice(0, 6).join(', ')}${extra.length > 6 ? '…' : ''}` : '<br>未发现游戏内额外招式');
        state.info[uid] = info.innerHTML;
      }
    } catch (e) {
      if (info) { info.textContent = 'PokéAPI：' + zhError(e.message); state.info[uid] = info.textContent; }
    }
  }



  async function applyTeamFromPanel(team,picker=false){
    team=team||state.team;if(!team?.length||state.busy)return;
    if(!picker&&recommendationStale(readSave())){state.errors=[recommendationIssue(readSave())];refreshUi();return}
    state.busy=true;state.errors=[];state.applyNotice='';refreshUi();
    const before=readSave();let result=null;
    try{
      if(picker){const done=await applyToEventPicker(team);if(done!==team.length)throw new Error(`选队仅完成 ${done}/${team.length} 只，请保持窗口打开后重试。`)}
      else{result=await applyTeam(team);if(!result.ok&&!result.cancelled)throw new Error(result.error||'队伍未完整应用。');if(result.ok&&!team.every((c,i)=>readSave()?.team?.[i]===c.mon.uid))throw new Error('队伍顺序核对失败。');
        const now=readSave();if(optimizationFingerprint({...now,team:before.team})===optimizationFingerprint(before)){state.resultFingerprint=optimizationFingerprint(now);state.resultPlannedTeamBasis=(now.team||[]).slice();state.resultStale=false;}
        state.applyNotice=result.cancelled?`已停止自动安排，当前 ${result.verified}/${team.length} 个位置符合推荐；已完成部分保留，可重试。`:'推荐已写入安排队伍并核对。冒险途中通常在下一个宝可梦中心回复时才换人；当前战斗不会立刻替换。';}
    }catch(error){state.errors=['应用失败：'+error.message];if(!picker){const now=readSave();if(optimizationFingerprint({...now,team:before.team})===optimizationFingerprint(before)){state.resultFingerprint=optimizationFingerprint(now);state.resultPlannedTeamBasis=(now.team||[]).slice();state.resultStale=false;}result={...result,ok:false,verified:result?.verified??placementJob?.verified??0,error:error.message};}}
    finally{if(!picker&&result&&state.segments?.version===3){state.segments.manualUntil=nextHealNode(readSave());state.segments.pending=null;store.set('segments',state.segments);}
      state.busy=false;state.waiting=null;refreshUi();if(!picker&&result)finishPlacement(result)}
  }


  function boot() {
    log('info', 'boot', { version: VERSION, bundle: bundleUrl()?.split('/').pop() || null });
    // a prepared segment plan survives a reload (the templates live in the save)
    state.segments = store.get('segments', null);
    if (state.segments && (!Array.isArray(state.segments.list) || state.segments.version !== 3)) { state.segments = null; store.set('segments', null); }
    if(state.segments?.auto){state.segments.auto=false;state.segments.pending=null;state.segmentNotice='已恢复分段方案。刷新后自动默认关闭，请进入队伍页确认模板再开启。';store.set('segments',state.segments);}
    state.planScope = store.get('planScope', 'restart') === 'after-heal' ? 'after-heal' : 'restart';
    state.chapterOpen = store.get('chapterExpanded', false) === true;
    state.reuseAll = store.get('reuseTemplates', false) === true;
    // a previous version's floating panel / quick rows: gone, the blocks replace them
    cleanupLegacy();
    ensureEnglish().catch(e => logError('names: English pack', e));
    checkUpdate().catch(e => logError('update: check', e));
    // the game's own team picker (legend zones, raids, elite league): put my controls beside its Optimize button
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        try { maybeLoadData(); refreshUi(); } catch (e) { logError('ui: observer', e); }
      });
    }).observe(document.body, { childList: true, subtree: true });
    // a template picked in the game's own bar is the player's choice: the watcher leaves that segment alone
    document.addEventListener('click', e => {
      const ally = e.target.closest?.('[data-raid-slot]');
      if (ally && state.engine) { const ctx = raidCardContext(ally.closest('.rc-card')); if (ctx) { state.raidPreviewContext = ctx; state.raidPreviewBoss = raidBoss({id:ctx.id}); } }
      const edit = e.target.closest?.('[data-raid-edit]');
      if (edit) state.lastRaidRegion = edit.dataset.raidEdit;
      const b = e.target.closest?.('#team-sets button[data-set]');
      if (!b || state.selfClick) return;
      state.manual = { idx: segmentIndex(readSave()), slot: +b.dataset.set, at: Date.now() };
      if(state.segments?.version===3){state.segments.manualUntil=nextHealNode(readSave());state.segments.pending=null;store.set('segments',state.segments);}
      log('info', 'templates: manual pick in the game', { slot: +b.dataset.set });
    }, true);
    document.addEventListener('pointerdown',event=>{if(!event.isTrusted||state.busy||!state.segments?.auto||!event.target.closest?.('#team-slots .slot,#team-mini .slot,#pc-grid .pc-cell'))return;state.segments.manualUntil=nextHealNode(readSave());state.segments.pending=null;store.set('segments',state.segments);},true);
    state.watcher = new WipeWatcher(rec => {
      refreshUi();
      if (rec && !roamerHunt) {
        // the run restarts from the chapter start: drop the manual pick and field segment 1 again
        state.manual = null;
        state.segOn = null;
        // the team fell on this step: rebuild an optimal team for the chapter
        runOptimizer();
      }
    });
    refreshUi();
    ensureData().then(ready => {
      refreshUi();
      if (!ready) return;
      log('info', 'boot: ready', {
        species: state.data ? Object.keys(state.data.species).length : 0,
        legends: state.legends?.zones?.length ?? 0,
        errors: state.errors,
      });
    }).catch(e => logError('boot: data', e));
    // Recover from delayed scripts and transient network errors without a page reload.
    setInterval(maybeLoadData, 1000);
    // segment teams: switch the prepared template when the run reaches a Pokémon Center
    setInterval(() => { try { switchSegment(); } catch (e) { logError('segments: switch', e); } }, 700);
    // the game keeps playing in the background: keep the panel in sync
    setInterval(() => {
      if (state.busy) return;
      try { refreshChapter(); refreshUi(); } catch (e) { logError('ui: refresh', e); }
    }, 5000);
  }

  const start = () => { try { boot(); } catch (e) { logError('boot', e); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // exposed for tests / manual checks
  window.__pcopt = {
    raidAllyMon, readRaidAllyCandidate, chooseRaidAllyPair, optimizeRaidAllies, runRaidAllyAction, raidCardContext, readRaidPickKeys, fastestClear,
    freeTemplates, routeSignature, memberBasis, memberIssue, recommendationIssue, recommendationNote, segmentIssue, segmentStatus, nextSegmentTarget, arrangeSegment, saveSegmentTemplates, openPlanningHelp, simBattle, rollBattleFoes, autoScore,
    cancelPlacement, placementStatus:()=>placementJob&&({active:placementJob.active,cancelled:placementJob.cancelled,verified:placementJob.verified,total:placementJob.total}),
    growthVariants, growthCap, futureCandidate, growthOptionsForTeam, analyzeGrowth, runGrowth, renderGrowth,
    parseBundle, poolOfNode, routeBand, failureFocus, recommendationStale, currentCandidates, rankCurrentCandidates, selectedChapterPlan, makeSearchPool, compareTeamResults, seedHash, withSimSeed, runChapter, simulateChapter, segmentPlans, segmentIndex, optimizationFingerprint,
    state, ensureData, runOptimizer, parsePokemonDbChart, buildLearnAll, makeEngine,
    chapterEnemies, chapterInfo, readSave, scoreCandidates, pickTeam, scoreFor,
    WipeWatcher, applyTeam, bundleUrl, httpGet, canJoinTeam, showMovesPanel, pokeApiSpecies, compareWithPokeApi,
    parseLegends, legendBoss, simulateLegend, pickLegendTeam, evaluateLegendTeam, runLegendOptimizer,
    legendFightOnce, legendOdds, logs,
    projectCandidates, evolvedBranches, refreshChapter,
    chapterPlan, segmentPlans, prepareSegments, switchSegment, freeTemplates, switchTemplate, simulateChapter, searchChapterTeam, rollBattleFoes, simBattle, simAct, simOhko, simGeneric, autoScore, ensureEnglish,
    raidDps, raidBoss, annotateRaidSuggestions
  };
})();
