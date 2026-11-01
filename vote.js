/* EVO Awards 2026 — власні голосування і ставки фішками (замість Tally).
   Дані — Supabase (Postgres): вхід через Discord, усі записи через функції бази (schema.sql у репозиторії EvoProcesses_CP,
   scripts/awards_2026/voting/). Ключ anon публічний за задумом Supabase: що можна робити, вирішують правила в базі.
   Тестовий режим без бази: ?mock=1 (дані в localStorage цього браузера), дата для перевірки блоків: ?today=2026-11-23. */

const VOTE_CFG = {
  url: 'https://rofzgohmhqxgngkiruik.supabase.co',
  anonKey: 'sb_publishable_zEC4Lbhn4Fz2siYEmoElcw_uDRX-lUI',   // publishable — публічний за задумом Supabase
};

const QS = new URLSearchParams(location.search);
const MOCK = QS.has('mock');

/* ─── бекенд: Supabase або тестовий ─────────────────────────────────────────── */
const ERR = {
  not_signed_in: 'Спершу увійди через Discord.', already_claimed: 'Ти вже обрав себе зі списку.',
  unknown_player: 'Такого гравця немає в списку EVO / REVO.', player_taken: 'Цього гравця вже обрав інший акаунт Discord — напиши адміну.',
  not_participant: 'Спершу обери себе зі списку гравців.', poll_closed: 'Опитування зараз закрите.', bad_payload: 'Форма заповнена некоректно.',
  market_closed: 'Ставки в цій номінації вже закриті.', over_budget: 'Не вистачає фішок: сума ставок більша за бюджет.',
  bad_amount: 'Ставка — ціле число фішок від 0.', unknown_option: 'Такого претендента немає в шортлисті.', unknown_market: 'Номінацію не знайдено.',
};
const errText = e => { const m = String((e && (e.message || e.error_description)) || e || '');
  const k = Object.keys(ERR).find(k => m.includes(k)); return k ? ERR[k] : 'Не вдалося зберегти: ' + m; };

function supabaseBackend() {
  const sb = window.supabase.createClient(VOTE_CFG.url, VOTE_CFG.anonKey, { auth: { persistSession: true, detectSessionInUrl: true } });
  const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw error; return data; };
  const sel = async q => { const { data, error } = await q; if (error) throw error; return data; };
  return {
    async session() { const { data } = await sb.auth.getSession(); const s = data.session;
      return s ? { signedIn: true, name: (s.user.user_metadata || {}).full_name || (s.user.user_metadata || {}).name || 'Discord' } : { signedIn: false }; },
    signIn: () => sb.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo: location.origin + location.pathname + '#vote' } }),
    signOut: () => sb.auth.signOut(),
    me: () => rpc('me'),
    roster: () => sel(sb.from('roster').select('player,team').order('player')),
    rosterFree: () => rpc('roster_free'),
    claim: player => rpc('claim_player', { p_player: player }),
    myAnswers: () => sel(sb.from('answers').select('poll_id,payload,updated_at')),
    submit: (poll, payload) => rpc('submit_answers', { p_poll: poll, p_payload: payload }),
    markets: () => sel(sb.from('markets').select('id,title,ord,opens_at,closes_at,winner,market_options(option,ord)').order('ord')),
    pools: () => rpc('market_pools'),
    myBets: () => sel(sb.from('bets').select('market_id,option,amount')),
    placeBets: (m, bets) => rpc('place_bets', { p_market: m, p_bets: bets }),
    leaderboard: () => rpc('leaderboard'),
  };
}

/* Тестовий бекенд: повторює правила бази (бюджет, один гравець — один акаунт, тоталізатор) у localStorage. */
function mockBackend(players) {
  const KEY = 'evo_vote_mock';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } };
  const save = d => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} };
  let db = load();
  if (!db) {
    const names = players.map(p => p.nick);
    const pick = (k, n) => Array.from({ length: n }, (_, i) => names[(k * 7 + i * 13) % names.length]);
    const noms = ['Блог року', 'EVO ♥', 'Тренер року', 'Рятівник року', 'Fold of the Year', 'Always Online', 'Hand of the Year', 'Новачок року'];
    db = { budget: 1000, me: null, signedIn: false, answers: {}, bets: [],
      roster: players.map(p => ({ player: p.nick, team: p.team })),
      markets: noms.map((t, k) => ({ id: 'm' + (k + 1), title: t, ord: k, winner: null, options: pick(k, 4 + (k % 2)) })),
      others: [] };
    // інші учасники зі ставками — щоб було видно банки й коефіцієнти
    for (let u = 0; u < 24; u++) { const pl = names[(u * 5 + 3) % names.length]; db.others.push({ player: pl, team: (players.find(p => p.nick === pl) || {}).team || 'EVO' });
      db.markets.forEach((m, k) => { if ((u + k) % 3 === 0) db.bets.push({ user: pl, market_id: m.id, option: m.options[(u + k) % m.options.length], amount: 20 + ((u * 37 + k * 11) % 9) * 10 }); }); }
    save(db);
  }
  const chk = () => { if (!db.signedIn) throw new Error('not_signed_in'); };
  const part = () => { chk(); if (!db.me) throw new Error('not_participant'); };
  const staked = u => db.bets.filter(b => b.user === u).reduce((s, b) => s + b.amount, 0);
  const meObj = () => db.me ? { player: db.me.player, team: db.me.team, budget: db.budget, staked: staked(db.me.player) } : null;
  const taken = () => new Set([...(db.me ? [db.me.player] : []), ...db.others.map(o => o.player)]);
  const A = x => Promise.resolve(JSON.parse(JSON.stringify(x)));
  return {
    session: () => A(db.signedIn ? { signedIn: true, name: 'Тестовий акаунт' } : { signedIn: false }),
    signIn: () => { db.signedIn = true; save(db); location.reload(); },
    signOut: () => { db.signedIn = false; save(db); return A(null); },
    me: () => A(db.signedIn ? meObj() : null),
    roster: () => A(db.roster),
    rosterFree: () => A(db.roster.filter(r => !taken().has(r.player))),
    claim: p => { chk(); if (db.me) throw new Error('already_claimed'); const r = db.roster.find(x => x.player === p); if (!r) throw new Error('unknown_player');
      if (taken().has(p)) throw new Error('player_taken'); db.me = { player: p, team: r.team }; save(db); return A(meObj()); },
    myAnswers: () => A(db.me ? Object.entries(db.answers).map(([poll_id, v]) => ({ poll_id, payload: v.payload, updated_at: v.at })) : []),
    submit: (poll, payload) => { part(); db.answers[poll] = { payload, at: new Date().toISOString() }; save(db); return A(new Date().toISOString()); },
    markets: () => A(db.markets.map(m => ({ id: m.id, title: m.title, ord: m.ord, winner: m.winner, closes_at: '2026-11-29T21:59:59Z',
      market_options: m.options.map((o, i) => ({ option: o, ord: i })) }))),
    pools: () => A(db.markets.flatMap(m => m.options.map(o => { const bs = db.bets.filter(b => b.market_id === m.id && b.option === o);
      return { market_id: m.id, option: o, pool: bs.reduce((s, b) => s + b.amount, 0), bettors: bs.length }; }))),
    myBets: () => A(db.me ? db.bets.filter(b => b.user === db.me.player) : []),
    placeBets: (mid, bets) => { part(); const m = db.markets.find(x => x.id === mid); if (!m) throw new Error('unknown_market'); if (m.winner) throw new Error('market_closed');
      const rest = db.bets.filter(b => !(b.user === db.me.player && b.market_id === mid)); const add = [];
      for (const [o, a] of Object.entries(bets)) { if (!Number.isInteger(a) || a < 0) throw new Error('bad_amount'); if (!m.options.includes(o)) throw new Error('unknown_option');
        if (a > 0) add.push({ user: db.me.player, market_id: mid, option: o, amount: a }); }
      const tot = [...rest, ...add].filter(b => b.user === db.me.player).reduce((s, b) => s + b.amount, 0);
      if (tot > db.budget) throw new Error('over_budget'); db.bets = [...rest, ...add]; save(db); return A(meObj()); },
    leaderboard: () => { const users = [...(db.me ? [db.me] : []), ...db.others];
      const rows = users.map(u => { let payout = 0, won = 0, settled = 0;
        db.markets.filter(m => m.winner).forEach(m => { const bs = db.bets.filter(b => b.market_id === m.id); if (!bs.length) return;
          const mine = bs.filter(b => b.user === u.player); if (!mine.length) return; settled++;
          const tot = bs.reduce((s, b) => s + b.amount, 0), onW = bs.filter(b => b.option === m.winner).reduce((s, b) => s + b.amount, 0);
          mine.forEach(b => { payout += onW ? (b.option === m.winner ? b.amount * tot / onW : 0) : b.amount; }); if (mine.some(b => b.option === m.winner)) won++; });
        const st = staked(u.player); return { player: u.player, team: u.team, staked: st, payout: Math.round(payout * 100) / 100,
          balance: Math.round((db.budget - st + payout) * 100) / 100, won, settled }; });
      return A(rows.sort((a, b) => b.balance - a.balance || a.player.localeCompare(b.player))); },
    // лише для тесту: оголосити переможців усіх номінацій
    _settle: () => { db.markets.forEach(m => { const ps = {}; db.bets.filter(b => b.market_id === m.id).forEach(b => ps[b.option] = (ps[b.option] || 0) + b.amount);
      m.winner = Object.keys(ps).sort((a, b) => ps[b] - ps[a])[0] || m.options[0]; }); save(db); },
    _reset: () => { localStorage.removeItem(KEY); },
  };
}

/* ─── стан ───────────────────────────────────────────────────────────────── */
const Vote = { api: null, ready: false, sess: { signedIn: false }, me: null, answers: {}, roster: [], markets: null };

const fmtN = n => Math.round(n).toLocaleString('uk-UA');
const enabled = () => MOCK || (VOTE_CFG.url && VOTE_CFG.anonKey);

async function voteInit() {
  if (!enabled()) { renderAuth(); return; }
  try {
    if (MOCK) { const pj = await fetch('players.json').then(r => r.json()).catch(() => ({ players: [] }));
      Vote.api = mockBackend((pj.players || []).map(p => ({ nick: p.nick, team: p.team || 'EVO' }))); }
    else {
      await new Promise((ok, bad) => { const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'; s.onload = ok; s.onerror = bad; document.head.append(s); });
      Vote.api = supabaseBackend();
    }
    await refreshMe();
    Vote.ready = true;
  } catch (e) { console.error(e); Vote.error = 'Не вдалося підключитися до голосування. Онови сторінку трохи згодом.'; }
  renderAuth(); renderBoard();
  document.querySelectorAll('.poll.expanded').forEach(c => fillSlot(c, POLLS.find(p => 'poll-' + p.id === c.id)));
}

async function refreshMe() {
  Vote.sess = await Vote.api.session();
  Vote.me = Vote.sess.signedIn ? await Vote.api.me() : null;
  Vote.answers = {};
  if (Vote.me) (await Vote.api.myAnswers()).forEach(a => { Vote.answers[a.poll_id] = a; });
  // позначки «✓ Ти проголосував» для власних опитувань — лише за даними бази (на будь-якому пристрої; без входу — без позначок)
  const v = votedSet();
  POLLS.filter(p => p.engine === 'own').forEach(p => { if (Vote.answers[p.id]) v.add(p.id); else v.delete(p.id);
    const chip = document.querySelector('#poll-' + p.id + ' .meta .chip'); if (!chip) return;
    if (Vote.answers[p.id]) { chip.className = 'chip done'; chip.textContent = '✓ Ти проголосував'; }
    else if (chip.classList.contains('done')) { const [c, l] = STATUS[p.status] || STATUS.soon; chip.className = 'chip ' + c; chip.textContent = l; } });
  store(VOTED_KEY, JSON.stringify([...v]));
  renderFab();
}

/* ─── панель входу ────────────────────────────────────────────────────────── */
function renderAuth() {
  const box = document.getElementById('auth'); if (!box) return;
  const anyOwn = POLLS.some(p => p.engine === 'own' && p.status !== 'closed');
  if (!enabled()) { box.innerHTML = anyOwn ? `<div class="auth-row"><b>Вхід через Discord</b><span class="muted">з'явиться до старту Блоку 2 — ${dLabel(POLLS.find(p => p.engine === 'own').opens)}.</span></div>` : ''; return; }
  if (Vote.error) { box.innerHTML = `<div class="auth-row"><span class="muted">${esc(Vote.error)}</span></div>`; return; }
  if (!Vote.ready) { box.innerHTML = `<div class="auth-row"><span class="muted">Підключаємось…</span></div>`; return; }
  if (!Vote.sess.signedIn) {
    box.innerHTML = `<div class="auth-row"><div><b>Увійди, щоб голосувати і ставити фішки</b><small>Вхід через Discord — щоб кожен гравець голосував один раз. Хто за кого голосував, не публікується.</small></div>
      <button class="btn discord" type="button" data-act="signin">${DISCORD_SVG}Увійти через Discord</button></div>`;
  } else if (!Vote.me) {
    box.innerHTML = `<div class="auth-row claim"><div><b>Хто ти в EVO?</b><small>Обери себе зі списку гравців EVO і REVO. Вибір — один раз, змінити може лише адмін.</small></div>
      <div class="claim-form"><input id="claim-input" list="claim-list" placeholder="Почни вводити своє ім'я" autocomplete="off"><datalist id="claim-list"></datalist>
      <button class="btn" type="button" data-act="claim">Це я</button></div><small class="err" id="claim-err"></small>
      <button class="link" type="button" data-act="signout">Вийти з Discord-акаунта ${esc(Vote.sess.name || '')}</button></div>`;
    Vote.api.rosterFree().then(r => { document.getElementById('claim-list').innerHTML = r.map(x => `<option value="${esc(x.player)}">${x.team}</option>`).join(''); });
  } else {
    const free = Vote.me.budget - Vote.me.staked;
    box.innerHTML = `<div class="auth-row ok"><div><b>${esc(Vote.me.player)}</b> <span class="chip team ${Vote.me.team === 'REVO' ? 'revo' : ''}">${esc(Vote.me.team)}</span>
      <small>Discord: ${esc(Vote.sess.name || '')} · <button class="link" type="button" data-act="signout">вийти</button></small></div>
      <div class="chips-bal" title="Фішки для ставок на переможців"><span class="coin"></span><b>${fmtN(free)}</b><small>фішок вільно з ${fmtN(Vote.me.budget)}</small></div></div>`;
  }
}
const DISCORD_SVG = '<svg width="20" height="16" viewBox="0 0 71 55" aria-hidden="true"><path fill="currentColor" d="M60.1 4.9A58.5 58.5 0 0 0 45.6.4a40 40 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A40 40 0 0 0 25.8.4 58.4 58.4 0 0 0 11.3 4.9C2.1 18.6-.4 32 .8 45.2a58.9 58.9 0 0 0 18 9.1 43 43 0 0 0 3.8-6.3 38 38 0 0 1-6-2.9l1.5-1.1a42 42 0 0 0 35.8 0l1.5 1.1a38 38 0 0 1-6 2.9 43 43 0 0 0 3.8 6.3 58.7 58.7 0 0 0 18-9.1C72.6 30 68.8 16.7 60.1 4.9ZM23.7 37.1c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2 6.5 3.3 6.4 7.2c0 4-2.8 7.2-6.4 7.2Zm23.6 0c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2 6.5 3.3 6.4 7.2c0 4-2.8 7.2-6.4 7.2Z"/></svg>';

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || !Vote.api) return;
  const act = b.dataset.act;
  if (act === 'signin') { Vote.api.signIn(); return; }
  if (act === 'signout') { await Vote.api.signOut(); await refreshMe(); renderAuth(); rerenderOwn(); return; }
  if (act === 'claim') {
    const v = document.getElementById('claim-input').value.trim(), err = document.getElementById('claim-err');
    try { await Vote.api.claim(v); await refreshMe(); renderAuth(); rerenderOwn(); renderBoard(); }
    catch (x) { err.textContent = errText(x); }
  }
});
const rerenderOwn = () => document.querySelectorAll('.poll.expanded').forEach(c => { const p = POLLS.find(x => 'poll-' + x.id === c.id); if (p && p.engine === 'own') fillSlot(c, p); });

/* ─── форми власних опитувань ─────────────────────────────────────────────── */
// Викликається з fillSlot() для опитувань з engine:'own'.
async function renderOwnPoll(card, p) {
  const slot = card.querySelector('.slot');
  const gate = msg => { slot.innerHTML = `<div class="form-empty">${msg}</div>`; };
  if (!enabled()) return gate('Форма відкриється тут ' + dLabel(p.opens) + ' — анонс буде в Discord.');
  if (!Vote.ready) return gate(Vote.error ? esc(Vote.error) : 'Підключаємось…');
  if (!Vote.sess.signedIn || !Vote.me) return gate(`Щоб проголосувати, <a href="#vote" class="inline-link">увійди через Discord і обери себе</a> вгорі цього блоку.`);
  const prev = Vote.answers[p.id];
  if (prev && !card.dataset.editing && p.id !== 'final') return showOwnThanks(card, p, prev);
  if (p.id === 'final') return renderFinal(card, p);
  if (!Vote.roster.length && p.form.some(q => q.type === 'nominate')) Vote.roster = await Vote.api.roster();
  const val = (prev && prev.payload) || {};
  slot.innerHTML = `<form class="own-form" novalidate>${p.form.map(q => qHtml(q, val)).join('')}
    <div class="poll-actions"><button class="btn" type="submit">${prev ? 'Зберегти зміни' : 'Надіслати'}</button><span class="form-msg"></span></div></form>`;
  if (!document.getElementById('roster-all')) { const dl = document.createElement('datalist'); dl.id = 'roster-all';
    dl.innerHTML = Vote.roster.map(r => `<option value="${esc(r.player)}">`).join(''); document.body.append(dl); }
  const form = slot.querySelector('form');
  form.addEventListener('change', () => limitMulti(form, p));
  limitMulti(form, p);
  form.addEventListener('submit', async ev => {
    ev.preventDefault(); const msg = form.querySelector('.form-msg');
    const { payload, error } = collect(form, p); if (error) { msg.textContent = error; msg.className = 'form-msg err'; return; }
    const btn = form.querySelector('[type=submit]'); btn.disabled = true; msg.textContent = 'Зберігаємо…'; msg.className = 'form-msg';
    try { await Vote.api.submit(p.id, payload); Vote.answers[p.id] = { poll_id: p.id, payload, updated_at: new Date().toISOString() };
      delete card.dataset.editing; markVoted(p.id); }
    catch (x) { msg.textContent = errText(x); msg.className = 'form-msg err'; btn.disabled = false; }
  });
}

function qHtml(q, val) {
  const v = val[q.id], name = 'q-' + q.id, opt = q.optional ? '<span class="opt-tag">необов\'язково</span>' : '';
  const head = `<legend>${esc(q.title)} ${opt}</legend>${q.hint ? `<p class="hint">${esc(q.hint)}</p>` : ''}`;
  if (q.type === 'single') return `<fieldset class="q" data-q="${q.id}">${head}<div class="choices">${q.options.map((o, i) =>
    `<label class="choice"><input type="radio" name="${name}" value="${esc(o)}" ${v === o ? 'checked' : ''}><span class="key">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span></label>`).join('')}</div></fieldset>`;
  if (q.type === 'multi') return `<fieldset class="q" data-q="${q.id}" data-max="${q.max || 99}">${head}<div class="choices multi">${q.options.map(o =>
    `<label class="choice"><input type="checkbox" name="${name}" value="${esc(o)}" ${(v || []).includes(o) ? 'checked' : ''}><span class="box"></span><span>${esc(o)}</span></label>`).join('')}</div>
    ${q.max ? `<p class="count" data-count="${q.id}"></p>` : ''}</fieldset>`;
  if (q.type === 'text') return `<fieldset class="q" data-q="${q.id}">${head}<textarea name="${name}" rows="${q.rows || 3}" maxlength="${q.maxlength || 600}" placeholder="${esc(q.placeholder || '')}">${esc(v || '')}</textarea></fieldset>`;
  if (q.type === 'nominate') return `<fieldset class="q nominate" data-q="${q.id}">${head}<div class="nom-grid">${q.items.map(it => { const x = (v || {})[it] || {};
    return `<div class="nom-row" data-item="${esc(it)}"><span class="nom-name">${esc(it)}</span>
      <input class="who" list="roster-all" placeholder="Кого висуваєш" value="${esc(x.who || '')}" maxlength="60">
      <input class="why" placeholder="Коротко — чому" value="${esc(x.why || '')}" maxlength="300"></div>`; }).join('')}</div></fieldset>`;
  return '';
}

function limitMulti(form) {
  form.querySelectorAll('fieldset[data-max]').forEach(fs => { const max = +fs.dataset.max, boxes = [...fs.querySelectorAll('input[type=checkbox]')];
    const n = boxes.filter(b => b.checked).length; boxes.forEach(b => { b.disabled = !b.checked && n >= max; b.closest('.choice').classList.toggle('off', b.disabled); });
    const c = fs.querySelector('[data-count]'); if (c) c.textContent = `Обрано ${n} з ${max}`; });
}

function collect(form, p) {
  const out = {};
  for (const q of p.form) {
    const fs = form.querySelector(`[data-q="${q.id}"]`);
    if (q.type === 'single') { const c = fs.querySelector('input:checked'); if (c) out[q.id] = c.value; }
    else if (q.type === 'multi') { const c = [...fs.querySelectorAll('input:checked')].map(x => x.value); if (c.length) out[q.id] = c; }
    else if (q.type === 'text') { const t = fs.querySelector('textarea').value.trim(); if (t) out[q.id] = t; }
    else if (q.type === 'nominate') { const m = {};
      for (const row of fs.querySelectorAll('.nom-row')) { const who = row.querySelector('.who').value.trim(), why = row.querySelector('.why').value.trim();
        if (!who) continue;
        if (Vote.me && who.toLowerCase() === Vote.me.player.toLowerCase()) return { error: `Себе висувати не можна — «${row.dataset.item}».` };
        m[row.dataset.item] = why ? { who, why } : { who }; }
      if (Object.keys(m).length) out[q.id] = m; }
    if (!q.optional && out[q.id] === undefined) return { error: `Заповни: «${q.title}».` };
  }
  return { payload: out };
}

function showOwnThanks(card, p, prev) {
  showThanks(card, p);
  const box = card.querySelector('.thanks > div:last-child');
  const when = prev && prev.updated_at ? new Date(prev.updated_at).toLocaleString('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }) : '';
  const a = document.createElement('div'); a.className = 'poll-actions';
  a.innerHTML = `<button class="btn ghost" type="button">Змінити відповідь</button>${when ? `<span class="muted small">збережено ${esc(when)}</span>` : ''}`;
  a.querySelector('button').onclick = () => { card.dataset.editing = '1'; renderOwnPoll(card, p); };
  box.append(a);
}

/* ─── фінал: голос + ставки ───────────────────────────────────────────────── */
async function renderFinal(card, p) {
  const slot = card.querySelector('.slot');
  slot.innerHTML = `<div class="form-empty">Завантажуємо шортлист…</div>`;
  let markets, pools, mine;
  try { [markets, pools, mine] = await Promise.all([Vote.api.markets(), Vote.api.pools(), Vote.api.myBets()]); }
  catch (x) { slot.innerHTML = `<div class="form-empty">${esc(errText(x))}</div>`; return; }
  if (!markets.length) { slot.innerHTML = `<div class="form-empty">Шортлист з'явиться тут на старті блоку — анонс буде в Discord.</div>`; return; }
  const votes = (Vote.answers.final && Vote.answers.final.payload && Vote.answers.final.payload.votes) || {};
  const pool = {}, tot = {}; pools.forEach(r => { pool[r.market_id + '|' + r.option] = +r.pool; tot[r.market_id] = (tot[r.market_id] || 0) + +r.pool; });
  const my = {}; mine.forEach(b => { my[b.market_id + '|' + b.option] = b.amount; });
  const budget = Vote.me.budget;
  slot.innerHTML = `<div class="bet-head">
      <div><b>Голос і ставки</b><p class="hint">У кожній номінації обери, за кого голосуєш. Окремо можеш поставити фішки на того, хто, на твою думку, переможе — не обов'язково на того, за кого голосуєш.
      Банк номінації ділиться між тими, хто вгадав, пропорційно ставкам. Коефіцієнт — скільки фішок повернеться за кожну поставлену, якщо банк не зміниться.</p></div>
      <div class="chips-bal big"><span class="coin"></span><b data-free>${fmtN(budget - Vote.me.staked)}</b><small>фішок вільно з ${fmtN(budget)}</small></div></div>
    <form class="own-form final" novalidate>${markets.map(m => mkHtml(m, votes, pool, tot, my)).join('')}
      <div class="poll-actions sticky-save"><button class="btn" type="submit">Зберегти голос і ставки</button><span class="form-msg"></span></div></form>`;
  const form = slot.querySelector('form');
  const recalc = () => {
    let sum = 0; form.querySelectorAll('.stake').forEach(i => { const n = Math.max(0, Math.floor(+i.value || 0)); sum += n; });
    const free = budget - sum; const f = slot.querySelector('[data-free]'); f.textContent = fmtN(free); f.closest('.chips-bal').classList.toggle('neg', free < 0);
    form.querySelectorAll('.mk').forEach(mk => { const mid = mk.dataset.m; let t = tot[mid] || 0;
      mk.querySelectorAll('.opt').forEach(o => { const k = mid + '|' + o.dataset.o; t += (Math.floor(+o.querySelector('.stake').value || 0)) - (my[k] || 0); });
      mk.querySelectorAll('.opt').forEach(o => { const k = mid + '|' + o.dataset.o, mineNow = Math.floor(+o.querySelector('.stake').value || 0);
        const pl = (pool[k] || 0) - (my[k] || 0) + mineNow; o.querySelector('.odds').textContent = pl > 0 ? `банк ${fmtN(pl)} · ×${(t / pl).toFixed(2)}` : `ще ніхто · ×—`; }); });
    form.querySelector('[type=submit]').disabled = free < 0;
    form.querySelector('.form-msg').textContent = free < 0 ? `Перебір на ${fmtN(-free)} фішок` : '';
    form.querySelector('.form-msg').className = 'form-msg' + (free < 0 ? ' err' : '');
  };
  form.addEventListener('input', recalc); recalc();
  form.querySelectorAll('[data-plus]').forEach(b => b.onclick = () => { const i = b.closest('.opt').querySelector('.stake'); i.value = Math.max(0, (Math.floor(+i.value || 0)) + +b.dataset.plus); recalc(); });
  form.addEventListener('submit', async ev => {
    ev.preventDefault(); const msg = form.querySelector('.form-msg'), btn = form.querySelector('[type=submit]');
    const nv = {}; form.querySelectorAll('.mk').forEach(mk => { const c = mk.querySelector('input[type=radio]:checked'); if (c) nv[mk.dataset.m] = c.value; });
    const changes = [];
    form.querySelectorAll('.mk:not(.closed)').forEach(mk => { const mid = mk.dataset.m, nb = {}; let oldSum = 0, newSum = 0, diff = false;
      mk.querySelectorAll('.opt').forEach(o => { const k = mid + '|' + o.dataset.o, a = Math.max(0, Math.floor(+o.querySelector('.stake').value || 0));
        if (a) nb[o.dataset.o] = a; oldSum += my[k] || 0; newSum += a; if ((my[k] || 0) !== a) diff = true; });
      if (diff) changes.push({ mid, nb, delta: newSum - oldSum }); });
    if (!Object.keys(nv).length && !changes.length) { msg.textContent = 'Обери хоча б одного переможця або зроби ставку.'; msg.className = 'form-msg err'; return; }
    btn.disabled = true; msg.textContent = 'Зберігаємо…'; msg.className = 'form-msg';
    try {
      if (Object.keys(nv).length) { await Vote.api.submit('final', { votes: nv }); Vote.answers.final = { poll_id: 'final', payload: { votes: nv }, updated_at: new Date().toISOString() }; }
      changes.sort((a, b) => a.delta - b.delta);                 // спершу зменшення — щоб не впертися в бюджет посередині
      for (const c of changes) await Vote.api.placeBets(c.mid, c.nb);
      Vote.me = await Vote.api.me(); renderAuth(); renderBoard();
      if (Object.keys(nv).length) markVoted('final');
      await renderFinal(card, p);
      const m2 = card.querySelector('.form-msg'); if (m2) { m2.textContent = '✓ Збережено. До 29 листопада можна змінити.'; m2.className = 'form-msg ok'; }
    } catch (x) { msg.textContent = errText(x); msg.className = 'form-msg err'; btn.disabled = false; }
  });
}

function mkHtml(m, votes, pool, tot, my) {
  const closed = !!m.winner || (m.closes_at && new Date(m.closes_at) < new Date());
  const opts = (m.market_options || []).slice().sort((a, b) => a.ord - b.ord);
  return `<fieldset class="mk${closed ? ' closed' : ''}" data-m="${esc(m.id)}"><legend>${esc(m.title)}</legend>
    ${m.winner ? `<p class="winner">🏆 Переможець: <b>${esc(m.winner)}</b></p>` : ''}
    ${opts.map(o => { const k = m.id + '|' + o.option, mine = my[k] || 0;
      return `<div class="opt${m.winner === o.option ? ' win' : ''}" data-o="${esc(o.option)}">
        <label class="pick"><input type="radio" name="v-${esc(m.id)}" value="${esc(o.option)}" ${votes[m.id] === o.option ? 'checked' : ''} ${closed ? 'disabled' : ''}><span class="dot"></span><span class="nm">${esc(o.option)}</span></label>
        <span class="odds"></span>
        <span class="stake-box"><span class="coin sm"></span><input class="stake" type="number" inputmode="numeric" min="0" step="10" value="${mine || ''}" placeholder="0" ${closed ? 'disabled' : ''} aria-label="Фішок на ${esc(o.option)}">
        ${closed ? '' : '<button type="button" class="plus" data-plus="50">+50</button>'}</span></div>`; }).join('')}
  </fieldset>`;
}

/* ─── таблиця фішок ──────────────────────────────────────────────────────── */
async function renderBoard() {
  const box = document.getElementById('chips-board'); if (!box) return;
  const fin = POLLS.find(p => p.id === 'final');
  if (!enabled() || !Vote.ready || (fin && fin.status === 'soon' && !MOCK)) { box.hidden = true; return; }
  let rows; try { rows = await Vote.api.leaderboard(); } catch (e) { box.hidden = true; return; }
  box.hidden = false;
  const settled = rows.some(r => r.settled > 0);
  const meP = Vote.me && Vote.me.player;
  const top = rows.filter(r => r.staked > 0 || r.settled > 0);
  box.innerHTML = `<div class="lb-head"><div><div class="kicker">Фішки</div><h3>${settled ? 'Хто вгадав переможців' : 'Ставки на переможців'}</h3>
      <p class="hint">${settled ? 'Баланс після оголошення переможців: невитрачені фішки + виграші.' : `Учасників зі ставками: ${top.length}. Переможців оголосимо на ефірі ${dLabel(EVENT_DATE)} — тоді тут з'явиться підсумок.`}</p></div>
      ${MOCK ? '<div class="poll-actions"><button class="btn ghost" type="button" id="mock-settle">Тест: оголосити переможців</button><button class="btn ghost" type="button" id="mock-reset">Тест: скинути дані</button></div>' : ''}</div>
    ${top.length ? `<div class="board-wrap"><table class="lb"><thead><tr><th>#</th><th>Гравець</th><th>Команда</th><th class="r">${settled ? 'Баланс' : 'Вільно'}</th><th class="r">У ставках</th>${settled ? '<th class="r">Вгадано</th>' : ''}</tr></thead><tbody>
      ${top.map((r, i) => `<tr class="${r.player === meP ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.player)}</td><td><span class="chip team ${r.team === 'REVO' ? 'revo' : ''}">${esc(r.team)}</span></td>
        <td class="r"><b>${fmtN(settled ? r.balance : r.balance)}</b></td><td class="r">${fmtN(r.staked)}</td>${settled ? `<td class="r">${r.won} з ${r.settled}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>` : '<div class="form-empty">Ставок ще немає — стань першим.</div>'}`;
  if (MOCK) { const s = document.getElementById('mock-settle'); if (s) s.onclick = () => { Vote.api._settle(); location.reload(); };
    const r = document.getElementById('mock-reset'); if (r) r.onclick = () => { Vote.api._reset(); location.reload(); }; }
}

voteInit();
