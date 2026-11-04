/* EVO Awards 2026 — власні голосування і ставки фішками.
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
  not_signed_in: 'Спершу увійди через Discord.', already_claimed: 'Роль і нік уже збережені.',
  bad_role: 'Обери, хто ти: Адмін, EVO, REVO чи Друг.', bad_nick: 'Нік — від 2 до 40 символів.',
  nick_taken: 'Такий нік уже зайнятий — напиши адміну, якщо це твій.', role_not_allowed: 'Це опитування — не для твоєї ролі.',
  not_participant: 'Спершу обери роль і впиши нік.', poll_closed: 'Опитування зараз закрите.', bad_payload: 'Форма заповнена некоректно.',
  market_closed: 'Ставки в цій номінації вже закриті.', no_bets: 'Для твого акаунта ставки вимкнені — можна лише голосувати.',
  staff_no_nominate: 'Адміни не висувають претендентів — висувають гравці.', self_nomination: 'Себе висувати не можна.', over_budget: 'Не вистачає фішок: сума ставок більша за бюджет.',
  bad_amount: 'Ставка — ціле число фішок від 0.', unknown_option: 'Такого претендента немає в шортлисті.', unknown_market: 'Номінацію не знайдено.',
};
const errText = e => { const m = String((e && (e.message || e.error_description)) || e || '');
  const k = Object.keys(ERR).find(k => m.includes(k)); return k ? ERR[k] : 'Не вдалося зберегти: ' + m; };

function supabaseBackend() {
  // pkce: Supabase повертає ?code=… у query, а не токени в #, тож адреса повернення не конфліктує з якорями сторінки
  const sb = window.supabase.createClient(VOTE_CFG.url, VOTE_CFG.anonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
  const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw error; return data; };
  const sel = async q => { const { data, error } = await q; if (error) throw error; return data; };
  return {
    async session() { const { data } = await sb.auth.getSession(); const s = data.session;
      return s ? { signedIn: true, name: (s.user.user_metadata || {}).full_name || (s.user.user_metadata || {}).name || 'Discord' } : { signedIn: false }; },
    signIn: () => { try { sessionStorage.setItem('evo_after_login', '1'); } catch (e) {}
      const q = new URLSearchParams(location.search); q.delete('code');
      return sb.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo: location.origin + location.pathname + (q.size ? '?' + q : '') } }); },
    signOut: () => sb.auth.signOut(),
    me: () => rpc('me'),
    roster: () => sel(sb.from('roster').select('player,team').order('player')),
    register: (role, nick) => rpc('register', { p_role: role, p_nick: nick }),
    myAnswers: () => sel(sb.from('answers').select('poll_id,payload,updated_at')),
    submit: (poll, payload) => rpc('submit_answers', { p_poll: poll, p_payload: payload }),
    markets: () => sel(sb.from('markets').select('id,title,ord,opens_at,closes_at,winner,market_options!market_options_market_id_fkey(option,ord)').order('ord')),   // два зв'язки (ще markets_winner_fk) — вказуємо явно
    pools: () => rpc('market_pools'),
    myBets: () => sel(sb.from('bets').select('market_id,option,amount')),
    placeBets: (m, bets) => rpc('place_bets', { p_market: m, p_bets: bets }),
    leaderboard: () => rpc('leaderboard'),
    betResults: () => rpc('bet_results'),
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
    const noms = ['Найкращий блог', 'Серце EVO', 'Харизма EVO', 'Тренер року', 'Фолд року'];
    db = { budget: 1000, me: null, signedIn: false, answers: {}, bets: [],
      roster: players.map(p => ({ player: p.nick, team: p.team })),
      markets: [...noms.map((t, k) => ({ id: 'm' + (k + 1), title: t, ord: k, winner: null, options: pick(k, 4 + (k % 2)) })),
                { id: 'test1', title: 'Тестова номінація', ord: 0, winner: null, options: ['Претендент A', 'Претендент B', 'Претендент C'] }],
      others: [] };
    // інші учасники зі ставками — щоб було видно банки й коефіцієнти
    for (let u = 0; u < 24; u++) { const pl = names[(u * 5 + 3) % names.length]; db.others.push({ player: pl, team: (players.find(p => p.nick === pl) || {}).team || 'EVO' });
      db.markets.forEach((m, k) => { if ((u + k) % 3 === 0) db.bets.push({ user: pl, market_id: m.id, option: m.options[(u + k) % m.options.length], amount: 20 + ((u * 37 + k * 11) % 9) * 10 }); }); }
    save(db);
  }
  const chk = () => { if (!db.signedIn) throw new Error('not_signed_in'); };
  const part = () => { chk(); if (!db.me) throw new Error('not_participant'); };
  const staked = u => db.bets.filter(b => b.user === u).reduce((s, b) => s + b.amount, 0);
  const meObj = () => db.me ? { player: db.me.player, team: db.me.team, can_bet: true, budget: db.budget, staked: staked(db.me.player) } : null;
  const taken = () => new Set([...(db.me ? [db.me.player] : []), ...db.others.map(o => o.player)]);
  const A = x => Promise.resolve(JSON.parse(JSON.stringify(x)));
  return {
    session: () => A(db.signedIn ? { signedIn: true, name: 'Тестовий акаунт' } : { signedIn: false }),
    signIn: () => { db.signedIn = true; save(db); location.reload(); },
    signOut: () => { db.signedIn = false; save(db); return A(null); },
    me: () => A(db.signedIn ? meObj() : null),
    roster: () => A(db.roster),
    register: (role, nick) => { chk(); if (db.me) throw new Error('already_claimed'); if (!ROLES[role]) throw new Error('bad_role');
      nick = (nick || '').trim(); if (nick.length < 2 || nick.length > 40) throw new Error('bad_nick');
      if ([...taken()].some(x => x.toLowerCase() === nick.toLowerCase())) throw new Error('nick_taken');
      db.me = { player: nick, team: role }; save(db); return A(meObj()); },
    myAnswers: () => A(db.me ? Object.entries(db.answers).map(([poll_id, v]) => ({ poll_id, payload: v.payload, updated_at: v.at })) : []),
    submit: (poll, payload) => { part(); if (!canVote(poll, db.me.team)) throw new Error('role_not_allowed'); db.answers[poll] = { payload, at: new Date().toISOString() }; save(db); return A(new Date().toISOString()); },
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
    betResults: () => { const out = [], users = [...(db.me ? [db.me] : []), ...db.others];
      db.markets.filter(m => m.winner).forEach(m => { const bs = db.bets.filter(b => b.market_id === m.id); if (!bs.length) return;
        const tot = bs.reduce((s, b) => s + b.amount, 0), onW = bs.filter(b => b.option === m.winner).reduce((s, b) => s + b.amount, 0);
        bs.forEach(b => { const u = users.find(x => x.player === b.user) || { team:'' };
          out.push({ player: b.user, team: u.team, market: m.title, ord: m.ord, option: b.option, staked: b.amount,
            payout: Math.round((onW ? (b.option === m.winner ? b.amount * tot / onW : 0) : b.amount) * 100) / 100 }); }); });
      return A(out); },
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
  // повернення з Discord: прибрати ?code= з адреси і показати блок голосування
  const back = (() => { try { const f = sessionStorage.getItem('evo_after_login'); sessionStorage.removeItem('evo_after_login'); return f; } catch (e) { return null; } })();
  if (QS.has('code')) { const q = new URLSearchParams(location.search); q.delete('code');
    history.replaceState(null, '', location.pathname + (q.size ? '?' + q : '') + '#vote'); }
  if (back || QS.has('code')) { const v = document.getElementById('vote'); if (v) v.scrollIntoView(); }
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
    if (Vote.answers[p.id]) { chip.className = 'chip done'; chip.textContent = '✓ Голос прийнято'; }
    else if (chip.classList.contains('done')) { const [c, l] = STATUS[p.status] || STATUS.soon; chip.className = 'chip ' + c; chip.textContent = l; } });
  store(VOTED_KEY, JSON.stringify([...v]));
  renderFab();
}

/* ─── панель входу ────────────────────────────────────────────────────────── */
function renderAuth() { renderAuthBox(); renderNavAcct(); }

/* Акаунт у закріпленій верхній панелі — вхід / вихід і фішки з будь-якого місця сторінки. */
function renderNavAcct() {
  const box = document.getElementById('nav-acct'); if (!box) return;
  if (!enabled() || Vote.error || !Vote.ready) { box.innerHTML = ''; return; }
  if (!Vote.sess.signedIn) {
    box.innerHTML = `<button class="btn discord sm" type="button" data-act="signin">${DISCORD_SVG}Увійти</button>`;
  } else if (!Vote.me) {
    box.innerHTML = `<a class="btn sm" href="#vote">Заверши вхід</a><button class="link" type="button" data-act="signout">Вийти</button>`;
  } else {
    const chips = Vote.me.can_bet === false ? '' : `<span class="acct-chips" title="Фішок доступно з ${fmtN(Vote.me.budget)}"><span class="coin sm"></span>${fmtN(Vote.me.budget - Vote.me.staked)}</span>`;
    box.innerHTML = `<div class="acct"><button class="acct-pill" type="button" aria-haspopup="true" aria-label="Акаунт">
        <span class="acct-ava">${esc((Vote.me.player || '?').trim().charAt(0).toUpperCase())}</span>${chips || `<span class="acct-nick">${esc(Vote.me.player)}</span>`}<span class="caret">▾</span></button>
      <div class="acct-menu">
        <div class="row"><span class="acct-nick" title="Discord: ${esc(Vote.sess.name || '')}">${esc(Vote.me.player)}</span><span class="chip team ${Vote.me.team === 'REVO' ? 'revo' : ''}">${esc(teamLabel(Vote.me.team))}</span></div>
        ${chips ? `<div class="row"><span>Фішок доступно</span>${chips}</div>` : ''}
        <button class="link" type="button" data-act="signout">Вийти</button>
      </div></div>`;
    const acct = box.querySelector('.acct');   // на телефоні наведення немає — відкривається тапом
    acct.querySelector('.acct-pill').addEventListener('click', e => { e.stopPropagation(); acct.classList.toggle('open'); });
    document.addEventListener('click', e => { if (!acct.contains(e.target)) acct.classList.remove('open'); });
  }
}

function renderAuthBox() {
  const box = document.getElementById('auth'); if (!box) return;
  const anyOwn = POLLS.some(p => p.engine === 'own' && p.status !== 'closed');
  if (!enabled()) { box.innerHTML = anyOwn ? `<div class="auth-row"><b>Вхід через Discord</b><span class="muted">з'явиться до старту Блоку 1 — ${dLabel(POLLS.find(p => p.engine === 'own').opens)}.</span></div>` : ''; return; }
  if (Vote.error) { box.innerHTML = `<div class="auth-row"><span class="muted">${esc(Vote.error)}</span></div>`; return; }
  if (!Vote.ready) { box.innerHTML = `<div class="auth-row"><span class="muted">Підключаємось…</span></div>`; return; }
  if (!Vote.sess.signedIn) {
    box.innerHTML = `<div class="auth-row"><div><b>Увійди, щоб голосувати і ставити фішки</b><small>Вхід через Discord, голосування анонімне.</small></div>
      <button class="btn discord" type="button" data-act="signin">${DISCORD_SVG}Увійти через Discord</button></div>`;
  } else if (!Vote.me) {
    box.innerHTML = `<div class="auth-row claim"><div><b>Останній крок входу: хто ти і твій нік</b><small>Discord: ${esc(Vote.sess.name || '')}. Роль і нік зберігаються один раз — при наступних входах їх не питаємо. Змінити може лише адмін.</small></div>
      <div class="role-pick" role="radiogroup" aria-label="Роль">${Object.entries(ROLES).map(([k, v]) =>
        `<label class="choice"><input type="radio" name="reg-role" value="${k}"><span>${v}</span></label>`).join('')}</div>
      <div class="claim-form"><input id="claim-input" placeholder="Твій нік" maxlength="40" autocomplete="nickname" value="${esc(Vote.sess.name || '')}">
      <button class="btn" type="button" data-act="register">Зберегти</button></div><small class="err" id="claim-err"></small>
      <button class="link" type="button" data-act="signout">Вийти з Discord-акаунта ${esc(Vote.sess.name || '')}</button></div>`;
  } else box.innerHTML = '';   // після входу акаунт і фішки — у верхній панелі
}
/* Ролі учасника (обирає при першому вході) і хто голосує в якому опитуванні — як polls.roles у schema.sql. */
const ROLES = { EVO: 'EVO', REVO: 'REVO', ADMIN: 'Адмін', FRIEND: 'Друг' };
const POLL_ROLES = {};   // голосують і висувають усі учасники: гравці, адміни, тренери, друзі (polls.roles у базі — так само)
const LUCKY_TEAMS = ['EVO', 'REVO'];   // Lucky Gambler — лише гравці; адміни, тренери й друзі ставлять, але не в розіграші
const canVote = (poll, role) => !POLL_ROLES[poll] || POLL_ROLES[poll].includes(role);
const teamLabel = t => ROLES[t] || (t === 'STAFF' ? 'Адмін' : t);
const DISCORD_SVG = '<svg width="20" height="16" viewBox="0 0 71 55" aria-hidden="true"><path fill="currentColor" d="M60.1 4.9A58.5 58.5 0 0 0 45.6.4a40 40 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A40 40 0 0 0 25.8.4 58.4 58.4 0 0 0 11.3 4.9C2.1 18.6-.4 32 .8 45.2a58.9 58.9 0 0 0 18 9.1 43 43 0 0 0 3.8-6.3 38 38 0 0 1-6-2.9l1.5-1.1a42 42 0 0 0 35.8 0l1.5 1.1a38 38 0 0 1-6 2.9 43 43 0 0 0 3.8 6.3 58.7 58.7 0 0 0 18-9.1C72.6 30 68.8 16.7 60.1 4.9ZM23.7 37.1c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2 6.5 3.3 6.4 7.2c0 4-2.8 7.2-6.4 7.2Zm23.6 0c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2 6.5 3.3 6.4 7.2c0 4-2.8 7.2-6.4 7.2Z"/></svg>';

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || !Vote.api) return;
  const act = b.dataset.act;
  if (act === 'signin') { Vote.api.signIn(); return; }
  if (act === 'signout') { await Vote.api.signOut(); await refreshMe(); renderAuth(); rerenderOwn(); return; }
  if (act === 'register') {
    const r = document.querySelector('input[name=reg-role]:checked'), v = document.getElementById('claim-input').value.trim(), err = document.getElementById('claim-err');
    if (!r) { err.textContent = ERR.bad_role; return; }
    if (v.length < 2) { err.textContent = ERR.bad_nick; return; }
    try { await Vote.api.register(r.value, v); await refreshMe(); renderAuth(); rerenderOwn(); renderBoard(); }
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
  if (Vote.sess.signedIn && !Vote.me) return gate(`Заверши вхід <a href="#vote" class="inline-link">вгорі блоку голосування</a>: обери роль і впиши нік.`);
  if (!Vote.sess.signedIn) return gate(`Щоб проголосувати, <button type="button" class="link inline-link" data-act="signin">увійди через Discord</button>.`);
  const prev = Vote.answers[p.id];
  if (prev && !card.dataset.editing && !p.bets) return showOwnThanks(card, p, prev);
  if (!canVote(p.id, Vote.me.team) && !(p.bets && Vote.me.can_bet !== false)) return gate(p.id === 'nominate'
    ? 'Претендентів висувають гравці EVO і REVO.' + (Vote.me.team === 'ADMIN' ? ' Ком\'юніті голосування — з ' + dLabel((POLLS.find(x => x.id === 'final') || p).opens) + '.' : '')
    : 'Це опитування — для гравців і адмінів школи.');
  if (p.bets) return renderFinal(card, p);
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

const DISCORD_POST = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+\/?$/;   // посилання на повідомлення
const noteOf = (q, o) => q.notes && q.notes[o] ? `<small class="c-note">${esc(q.notes[o])}</small>` : '';

function qHtml(q, val) {
  const v = val[q.id], name = 'q-' + q.id, opt = q.optional ? '<span class="opt-tag">необов\'язково</span>' : '';
  const head = `<legend>${esc(q.title)} ${opt}</legend>${q.hint ? `<p class="hint">${esc(q.hint)}</p>` : ''}`;
  if (q.type === 'single') return `<fieldset class="q" data-q="${q.id}">${head}<div class="choices">${q.options.map((o, i) =>
    `<label class="choice"><input type="radio" name="${name}" value="${esc(o)}" ${v === o ? 'checked' : ''}><span class="key">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span></label>`).join('')}</div></fieldset>`;
  const box = o => `<label class="choice"><input type="checkbox" name="${name}" value="${esc(o)}" ${(v || []).includes(o) ? 'checked' : ''}><span class="box"></span><span class="c-t">${esc(o)}${noteOf(q, o)}</span></label>`;
  if (q.type === 'multi') return `<fieldset class="q" data-q="${q.id}" data-max="${q.max || 99}">${head}${q.groups
      ? q.groups.map(([g, opts]) => `<p class="choice-group">${esc(g)}</p><div class="choices multi">${opts.map(box).join('')}</div>`).join('')
      : `<div class="choices multi">${q.options.map(box).join('')}</div>`}
    ${q.max ? `<p class="count" data-count="${q.id}"></p>` : ''}</fieldset>`;
  if (q.type === 'text') return `<fieldset class="q" data-q="${q.id}">${head}<textarea name="${name}" rows="${q.rows || 3}" maxlength="${q.maxlength || 600}" placeholder="${esc(q.placeholder || '')}">${esc(v || '')}</textarea></fieldset>`;
  if (q.type === 'nominate') return `<fieldset class="q nominate" data-q="${q.id}">${head}<div class="nom-grid">${q.items.map(it => { const x = (v || {})[it] || {};
    return `<div class="nom-row" data-item="${esc(it)}"><span class="nom-name">${esc(it)}${noteOf(q, it)}</span>
      <input class="who" list="roster-all" placeholder="Кого висуваєш" value="${esc(x.who || '')}" maxlength="60">
      ${(q.links || []).includes(it)
        ? `<input class="link-in" type="url" inputmode="url" placeholder="Посилання на допис у Discord" value="${esc(x.link || '')}" maxlength="300">`
        : `<input class="why" placeholder="Коротко — чому" value="${esc(x.why || '')}" maxlength="300">`}</div>`; }).join('')}</div></fieldset>`;
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
      for (const row of fs.querySelectorAll('.nom-row')) { const who = row.querySelector('.who').value.trim(), li = row.querySelector('.link-in');
        const why = li ? '' : row.querySelector('.why').value.trim(), link = li ? li.value.trim() : '';
        if (!who && !link) continue;
        if (li && !DISCORD_POST.test(link)) return { error: `«${row.dataset.item}»: встав посилання на допис з роздачею на Discord-сервері (Копіювати посилання на повідомлення).` };
        if (!who) return { error: `«${row.dataset.item}»: вкажи, хто зіграв цю роздачу.` };
        m[row.dataset.item] = link ? { who, link } : why ? { who, why } : { who }; }
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
  markets = markets.filter(m => !m.id.startsWith('test') || (typeof TEST_RUN !== 'undefined' && TEST_RUN));   // тестовий шортлист — лише під час тесту
  const canBet = Vote.me.can_bet !== false, voteHere = canVote(p.id, Vote.me.team);   // друзі — лише ставки, без голосу
  if (!markets.length) { slot.innerHTML = `<div class="form-empty">Шортлист з'явиться тут після Nomination Week — анонс буде в Discord.</div>`; return; }
  const votes = (Vote.answers[p.id] && Vote.answers[p.id].payload && Vote.answers[p.id].payload.votes) || {};
  const won = Object.fromEntries(markets.map(m => [m.id, !!m.winner]));
  const pool = {}, tot = {}; pools.filter(r => won[r.market_id]).forEach(r => { pool[r.market_id + '|' + r.option] = +r.pool; tot[r.market_id] = (tot[r.market_id] || 0) + +r.pool; });
  const my = {}; mine.forEach(b => { my[b.market_id + '|' + b.option] = b.amount; });
  const budget = Vote.me.budget;
  slot.innerHTML = `<div class="bet-head">
      <div><b>${!voteHere ? 'Ставки' : canBet ? 'Голос і ставки' : 'Голос'}</b><p class="hint">${!voteHere ? 'Голосують гравці й адміни школи, а ти можеш поставити фішки на того, хто, на твою думку, переможе.' : `${canBet ? '' : 'Для твого акаунта ставки вимкнені — лише голос. '}У кожній номінації обери, за кого голосуєш. Окремо можеш поставити фішки на того, хто, на твою думку, переможе — не обов'язково на того, за кого голосуєш.`}
      Банк номінації ділиться між тими, хто вгадав, пропорційно ставкам. Суми ставок інших учасників не видно до оголошення переможців.</p></div>
      <div class="chips-bal big"${canBet ? '' : ' hidden'}><span class="coin"></span><b data-free>${fmtN(budget - Vote.me.staked)}</b><small>фішок доступно з ${fmtN(budget)}</small></div></div>
    <form class="own-form final${canBet ? '' : ' no-bets'}" novalidate>${markets.map(m => mkHtml(m, votes, pool, tot, my, canBet, voteHere)).join('')}
      <div class="poll-actions sticky-save"><button class="btn" type="submit">${!voteHere ? 'Зберегти ставки' : canBet ? 'Зберегти голос і ставки' : 'Зберегти голос'}</button><span class="form-msg"></span></div></form>`;
  const form = slot.querySelector('form');
  const recalc = () => {
    let sum = 0; form.querySelectorAll('.stake').forEach(i => { const n = Math.max(0, Math.floor(+i.value || 0)); sum += n; });
    const free = budget - sum; const f = slot.querySelector('[data-free]'); f.textContent = fmtN(free); f.closest('.chips-bal').classList.toggle('neg', free < 0);
    // банки й коефіцієнти — лише після оголошення переможця: до того вони підказували б лідера (у базі market_pools теж їх не віддає)
    form.querySelectorAll('.mk').forEach(mk => { const mid = mk.dataset.m; let t = tot[mid] || 0;
      if (!won[mid]) return;
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
    if (canBet) form.querySelectorAll('.mk:not(.closed)').forEach(mk => { const mid = mk.dataset.m, nb = {}; let oldSum = 0, newSum = 0, diff = false;
      mk.querySelectorAll('.opt').forEach(o => { const k = mid + '|' + o.dataset.o, a = Math.max(0, Math.floor(+o.querySelector('.stake').value || 0));
        if (a) nb[o.dataset.o] = a; oldSum += my[k] || 0; newSum += a; if ((my[k] || 0) !== a) diff = true; });
      if (diff) changes.push({ mid, nb, delta: newSum - oldSum }); });
    if (!Object.keys(nv).length && !changes.length) { msg.textContent = voteHere ? 'Обери хоча б одного переможця або зроби ставку.' : 'Зроби хоча б одну ставку.'; msg.className = 'form-msg err'; return; }
    btn.disabled = true; msg.textContent = 'Зберігаємо…'; msg.className = 'form-msg';
    try {
      if (Object.keys(nv).length) { await Vote.api.submit(p.id, { votes: nv }); Vote.answers[p.id] = { poll_id: p.id, payload: { votes: nv }, updated_at: new Date().toISOString() }; }
      changes.sort((a, b) => a.delta - b.delta);                 // спершу зменшення — щоб не впертися в бюджет посередині
      for (const c of changes) await Vote.api.placeBets(c.mid, c.nb);
      Vote.me = await Vote.api.me(); renderAuth(); renderBoard();
      if (Object.keys(nv).length) markVoted(p.id);
      await renderFinal(card, p);
      const m2 = card.querySelector('.form-msg'); if (m2) { m2.textContent = `✓ Збережено. До ${dLabel(p.closes)} можна змінити.`; m2.className = 'form-msg ok'; }
    } catch (x) { msg.textContent = errText(x); msg.className = 'form-msg err'; btn.disabled = false; }
  });
}

function mkHtml(m, votes, pool, tot, my, canBet = true, voteHere = true) {
  const closed = !!m.winner || (m.closes_at && new Date(m.closes_at) < new Date());
  const opts = (m.market_options || []).slice().sort((a, b) => a.ord - b.ord);
  return `<fieldset class="mk${closed ? ' closed' : ''}" data-m="${esc(m.id)}"><legend>${esc(m.title)}</legend>
    ${m.winner ? `<p class="winner">🏆 Переможець: <b>${esc(m.winner)}</b></p>` : ''}
    ${opts.map(o => { const k = m.id + '|' + o.option, mine = my[k] || 0;
      return `<div class="opt${m.winner === o.option ? ' win' : ''}" data-o="${esc(o.option)}">
        ${voteHere ? `<label class="pick"><input type="radio" name="v-${esc(m.id)}" value="${esc(o.option)}" ${votes[m.id] === o.option ? 'checked' : ''} ${closed ? 'disabled' : ''}><span class="dot"></span><span class="nm">${esc(o.option)}</span></label>` : `<span class="pick"><span class="nm">${esc(o.option)}</span></span>`}
        <span class="odds"></span>
        <span class="stake-box"${canBet ? '' : ' hidden'}><span class="coin sm"></span><input class="stake" type="number" inputmode="numeric" min="0" step="10" value="${mine || ''}" placeholder="0" ${closed ? 'disabled' : ''} aria-label="Фішок на ${esc(o.option)}">
        ${closed ? '' : '<button type="button" class="plus" data-plus="50">+50</button>'}</span></div>`; }).join('')}
  </fieldset>`;
}

/* ─── таблиця фішок ──────────────────────────────────────────────────────── */
async function renderBoard() {
  const box = document.getElementById('chips-board'); if (!box) return;
  const live = POLLS.some(p => p.bets && p.status !== 'soon');
  if (!enabled() || !Vote.ready || (!live && !MOCK)) { box.hidden = true; return; }
  let rows; try { rows = await Vote.api.leaderboard(); } catch (e) { box.hidden = true; return; }
  const settled = rows.some(r => r.settled > 0);
  if (!settled && !MOCK) { box.hidden = true; return; }        // до оголошення переможців чужі ставки не показуємо
  box.hidden = false;
  const meP = Vote.me && Vote.me.player;
  const top = rows.filter(r => r.staked > 0 || r.settled > 0), budget = (Vote.me && Vote.me.budget) || 1000;
  let det = {}; if (settled) try { (await Vote.api.betResults()).forEach(d => (det[d.player] = det[d.player] || []).push(d)); } catch (e) { det = {}; }
  const detHtml = r => { const ds = det[r.player] || [], byM = {};
    ds.forEach(d => { const k = d.market; byM[k] = byM[k] || { ord: d.ord, staked: 0, payout: 0, opts: [] }; byM[k].staked += +d.staked; byM[k].payout += +d.payout; byM[k].opts.push(`${fmtN(d.staked)} на ${esc(d.option)}`); });
    const lines = Object.entries(byM).sort((a, b) => a[1].ord - b[1].ord).map(([m, x]) => { const net = Math.round(x.payout - x.staked);
      return `<li><b>${esc(m)}</b>: ${x.opts.join(', ')} → отримав ${fmtN(Math.round(x.payout))} <span class="${net >= 0 ? 'plus-c' : 'minus-c'}">(${net >= 0 ? '+' : '−'}${fmtN(Math.abs(net))})</span></li>`; });
    return `<ul>${lines.join('') || '<li>Ставок у номінаціях з переможцем немає.</li>'}<li>Не поставлено: <b>${fmtN(budget - r.staked)}</b> фішок</li></ul>`; };
  box.innerHTML = `<div class="lb-head"><div><div class="kicker">Фішки</div><h3>${settled ? 'Хто вгадав переможців' : 'Ставки на переможців'}</h3>
      <p class="hint">${settled ? 'Баланс після оголошення переможців: невитрачені фішки + виграші. Lucky Gambler — гравець EVO або REVO з найбільшим балансом.' : `Учасників зі ставками: ${top.length}. Переможців оголосимо на ефірі ${dLabel(EVENT_DATE)} — тоді тут з'явиться підсумок.`}</p></div>
      ${MOCK ? '<div class="poll-actions"><button class="btn ghost" type="button" id="mock-settle">Тест: оголосити переможців</button><button class="btn ghost" type="button" id="mock-reset">Тест: скинути дані</button></div>' : ''}</div>
    ${top.length ? `<div class="board-wrap"><table class="lb"><thead><tr><th>#</th><th>Нік</th><th>Роль</th><th class="r">${settled ? 'Баланс' : 'Доступно'}</th><th class="r">У ставках</th><th class="r">Не поставлено</th>${settled ? '<th class="r">Вгадано</th>' : ''}</tr></thead><tbody>
      ${top.map((r, i) => `<tr class="lb-row ${r.player === meP ? 'me' : ''}" data-i="${i}"><td>${i + 1}</td><td>${esc(r.player)}${LUCKY_TEAMS.includes(r.team) ? '' : ' <small class="muted">поза Lucky Gambler</small>'}</td><td><span class="chip team ${r.team === 'REVO' ? 'revo' : ''}">${esc(teamLabel(r.team))}</span></td>
        <td class="r"><b>${fmtN(r.balance)}</b></td><td class="r">${fmtN(r.staked)}</td><td class="r">${fmtN(budget - r.staked)}</td>${settled ? `<td class="r">${r.won} з ${r.settled}</td>` : ''}</tr>
        ${settled ? `<tr class="lb-det" data-for="${i}" hidden><td colspan="7">${detHtml(r)}</td></tr>` : ''}`).join('')}
      </tbody></table></div>` : '<div class="form-empty">Ставок ще немає — стань першим.</div>'}`;
  box.querySelectorAll('tr.lb-row').forEach(tr => tr.addEventListener('click', () => { const d = box.querySelector(`tr.lb-det[data-for="${tr.dataset.i}"]`); if (d) d.hidden = !d.hidden; }));
  if (settled) { const h = box.querySelector('.lb-head .hint'); if (h) h.textContent += ' Натисни на рядок — деталі по номінаціях.'; }
  if (MOCK) { const s = document.getElementById('mock-settle'); if (s) s.onclick = () => { Vote.api._settle(); location.reload(); };
    const r = document.getElementById('mock-reset'); if (r) r.onclick = () => { Vote.api._reset(); location.reload(); }; }
}

voteInit();
