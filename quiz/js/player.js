/* Liryc Quiz – application joueur (téléphone ou ordinateur) */
(() => {
  'use strict';
  const { api, syncClock, el, fmt, ordinal, store, confetti, rules, LETTERS } = LQ;
  const app = document.getElementById('app');
  const meEl = document.getElementById('me');
  const netEl = document.getElementById('net');
  const KEY = 'lq-player';

  const S = {
    me: null,        // { pin, pub, tok, name }
    live: null,
    v: -1,
    offset: 0,       // horloge serveur − horloge locale
    view: '',
    sel: new Set(),
    answers: {},     // qi -> indices envoyés
    refs: {},
    fails: 0,
    timer: null,
  };
  const now = () => Date.now() + S.offset;
  const ansKey = () => KEY + '-a-' + S.me.pin;

  function show(key, build) {
    if (S.view === key) return;
    S.view = key;
    S.refs = {};
    app.replaceChildren(build());
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ inscription
  // Partie ouverte par l'animateur (pas de code à saisir).
  async function fetchCurrent() {
    try {
      const r = await fetch('live/current.json?_=' + Date.now(), { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch (e) {
      return null;
    }
  }

  function joinScreen(msg) {
    S.me = null;
    S.view = 'join';
    S.joining = false;
    clearTimeout(S.timer);
    meEl.textContent = '';
    const nameIn = el('input', { class: 'field', maxlength: '20', placeholder: 'Votre pseudo', autocomplete: 'nickname', 'aria-label': 'Pseudo' });
    const err = el('p', { class: 'error', role: 'alert', text: msg || '' });
    const status = el('p', { text: 'Recherche du quiz…' });
    const title = el('h1', { text: 'Rejoindre le quiz' });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Rejoindre', disabled: true });
    const form = el('form', {
      class: 'card join-card',
      onsubmit: async e => {
        e.preventDefault();
        err.textContent = '';
        const name = nameIn.value.trim();
        if (!name) { err.textContent = 'Choisissez un pseudo.'; nameIn.focus(); return; }
        S.joining = true;
        btn.disabled = true;
        try {
          const j = await api('join', { name });
          S.me = { pin: j.pin, pub: j.pub, tok: j.tok, name: j.name };
          store.set(KEY, S.me);
          S.answers = {};
          store.set(ansKey(), S.answers);
          await start();
        } catch (ex) {
          err.textContent = ex.message;
          S.joining = false;
          btn.disabled = false;
        }
      },
    }, title, el('div', { class: 'underline' }), status, nameIn, btn, err);
    app.replaceChildren(el('div', { class: 'center' }, form));
    nameIn.focus();

    // Tant qu'on est sur cet écran : affiche le quiz ouvert, ou attend qu'il le soit.
    (async function watch() {
      if (S.view !== 'join') return;
      const cur = await fetchCurrent();
      if (S.view !== 'join') return;
      const open = !!cur && cur.phase !== 'end';
      title.textContent = open && cur.title ? cur.title : 'Rejoindre le quiz';
      status.textContent = !open
        ? 'Aucun quiz n’est ouvert pour l’instant. Cette page se met à jour toute seule.'
        : cur.phase === 'lobby'
          ? 'Choisissez un pseudo pour participer.'
          : 'Le quiz a commencé : choisissez un pseudo pour rejoindre la partie.';
      btn.disabled = !open || S.joining;
      S.timer = setTimeout(watch, 2000);
    })();
  }

  async function start() {
    clearTimeout(S.timer);
    meEl.textContent = S.me.name;
    try { S.offset = await syncClock(); } catch (e) { /* on garde l'horloge locale */ }
    S.v = -1;
    S.view = '';
    app.replaceChildren(el('div', { class: 'center' }, el('div', { class: 'spinner' })));
    poll();
  }

  // ------------------------------------------------------------ synchronisation
  async function poll() {
    clearTimeout(S.timer);
    if (!S.me) return;
    try {
      const r = await fetch('live/' + S.me.pin + '.json?_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const L = await r.json();
      S.fails = 0;
      netEl.hidden = true;
      if (L.v !== S.v) { S.v = L.v; S.live = L; render(); }
    } catch (e) {
      if (++S.fails >= 4) netEl.hidden = false;
    }
    if (S.me) S.timer = setTimeout(poll, document.hidden ? 2500 : 900);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me) poll(); });

  function render() {
    const L = S.live;
    if (!L || !S.me) return;
    if (L.kicked && L.kicked.includes(S.me.pub)) {
      store.del(KEY);
      return joinScreen('Vous avez été retiré de la partie par l’animateur.');
    }
    switch (L.phase) {
      case 'lobby': return show('lobby', lobbyView);
      case 'question': return questionPhase();
      case 'reveal': return show('reveal' + L.qi, revealView);
      case 'scores': return show('scores' + L.qi, scoresView);
      case 'podium': return show('podium' + L.step, podiumView);
      case 'end': return show('end', endView);
    }
  }

  function questionPhase() {
    const L = S.live, t = now();
    if (t < L.started) return show('ready' + L.qi, readyView);
    if (S.answers[L.qi]) return show('sent' + L.qi, sentView);
    if (t > L.ends) return show('late' + L.qi, lateView);
    return show('q' + L.qi, questionView);
  }

  setInterval(() => {
    const L = S.live;
    if (!L || !S.me || L.phase !== 'question') return;
    questionPhase();
    const t = now();
    if (S.refs.count) S.refs.count.textContent = Math.max(1, Math.ceil((L.started - t) / 1000));
    if (S.refs.timerTxt) {
      const left = Math.max(0, L.ends - t);
      S.refs.timerTxt.textContent = Math.ceil(left / 1000) + ' s';
      S.refs.timerTxt.classList.toggle('low', left < 10000);
      S.refs.barI.style.transform = 'scaleX(' + (left / (L.ends - L.started)) + ')';
    }
  }, 200);

  // ------------------------------------------------------------ écrans
  const centered = (...kids) => el('div', { class: 'center' }, ...kids);
  const letters = arr => arr.map(i => LETTERS[i]).join(', ');

  function standing(score, rank, np) {
    return el('div', { class: 'standing' },
      el('div', {}, el('b', { text: fmt(score) }), el('span', { text: 'points' })),
      el('div', {}, el('b', { text: rank ? ordinal(rank) : '–' }), el('span', { text: 'sur ' + (np || 0) })));
  }

  function myResult() {
    const r = (S.live.res || {})[S.me.pub];
    return r ? { score: r[0], rank: r[1], lp: r[2], lo: r[3] } : { score: 0, rank: 0, lp: 0, lo: -1 };
  }

  function lobbyView() {
    const rl = rules(S.live.rules);
    return centered(
      el('div', { class: 'big', text: 'Vous êtes inscrit !' }),
      el('div', { class: 'sub' }, 'Pseudo : ', el('b', { text: S.me.name })),
      el('div', { class: 'sub', text: 'Regardez l’écran partagé : le quiz va bientôt commencer.' }),
      el('div', { class: 'spinner' }),
      rl.length > 0 && el('div', { class: 'rules-card' },
        el('h2', { text: 'Règles du jeu' }),
        el('ul', {}, rl.map(r => el('li', {},
          el('b', { text: r.k }), r.c || ' ', r.t,
          r.ex && el('span', { class: 'ex', text: r.ex }))))));
  }

  function readyView() {
    const L = S.live;
    S.refs.count = el('div', { class: 'count-big', text: '' });
    return centered(
      el('div', { class: 'sub', text: `Question ${L.qi + 1} / ${L.n}` }),
      S.refs.count,
      el('div', { class: 'sub', text: 'Préparez-vous…' }));
  }

  function questionView() {
    const L = S.live, q = L.q;
    S.sel = new Set();
    S.refs.timerTxt = el('div', { class: 'timer' });
    S.refs.barI = el('i');
    S.refs.err = el('p', { class: 'error', role: 'alert' });
    S.refs.btn = el('button', { class: 'btn', type: 'button', disabled: true, text: 'Valider', onclick: submit });
    S.refs.choices = q.c.map((t, i) => {
      const b = el('button', { class: 'choice c' + (i % 6), type: 'button', 'aria-pressed': 'false', onclick: () => (L.single ? pickOne(i, b) : toggle(i, b)) },
        el('span', { class: 'letter', text: LETTERS[i] }), el('span', { text: t }), el('span', { class: 'tick' }));
      return b;
    });
    const img = q.img ? el('img', { class: 'qimg', src: q.img, alt: 'Énoncé de la question', onclick: () => lightbox(q.img) }) : null;
    return el('div', { class: 'screen' },
      el('div', { class: 'qhead' }, el('span', { text: `Question ${L.qi + 1} / ${L.n}` }), S.refs.timerTxt),
      el('div', { class: 'bar' }, S.refs.barI),
      el('p', { class: 'qtext', text: q.q }),
      img,
      img && el('p', { class: 'zoom-hint', text: 'Touchez l’image pour l’agrandir' }),
      el('p', { class: 'multi-hint', text: L.single ? 'Une seule bonne réponse : touchez-la.' : 'Une ou plusieurs réponses justes : cochez, puis validez.' }),
      el('div', { class: 'choices' }, S.refs.choices),
      L.single ? S.refs.err : el('div', { class: 'submit-bar' }, S.refs.err, S.refs.btn));
  }

  // Quiz à réponse unique : le toucher envoie la réponse (comme Kahoot).
  function pickOne(i, b) {
    if (S.refs.btn.textContent === 'Envoi…') return;
    S.sel = new Set([i]);
    S.refs.choices.forEach(x => { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    submit();
  }

  function toggle(i, b) {
    if (S.sel.has(i)) S.sel.delete(i); else S.sel.add(i);
    b.classList.toggle('sel', S.sel.has(i));
    b.setAttribute('aria-pressed', String(S.sel.has(i)));
    const picked = [...S.sel].sort((x, y) => x - y);
    S.refs.btn.disabled = !picked.length;
    S.refs.btn.textContent = picked.length ? `Valider (${letters(picked)})` : 'Valider';
  }

  function remember(qi, c) {
    S.answers[qi] = c;
    store.set(ansKey(), S.answers);
  }

  async function submit() {
    const qi = S.live.qi;
    const c = [...S.sel].sort((x, y) => x - y);
    if (!c.length) return;
    const { btn, err, choices } = S.refs;
    btn.disabled = true;
    btn.textContent = 'Envoi…';
    choices.forEach(b => { b.disabled = true; });
    try {
      await api('answer', { pin: S.me.pin, pub: S.me.pub, tok: S.me.tok, qi, c });
      remember(qi, c);
    } catch (e) {
      if (e.status === 409) {
        remember(qi, c);
      } else if (/Trop tard/.test(e.message)) {
        S.view = '';
      } else {
        err.textContent = e.message;
        choices.forEach(b => { b.disabled = false; });
        btn.disabled = false;
        btn.textContent = `Valider (${letters(c)})`;
        return;
      }
    }
    questionPhase();
  }

  function sentView() {
    return centered(
      el('div', { class: 'big', text: 'Réponse enregistrée ✓' }),
      el('div', { class: 'sub' }, 'Vos choix : ', el('b', { text: letters(S.answers[S.live.qi]) })),
      el('div', { class: 'sub', text: 'La correction s’affiche à la fin du temps…' }),
      el('div', { class: 'spinner' }));
  }

  function lateView() {
    return centered(
      el('div', { class: 'big', text: 'Temps écoulé ⏱' }),
      el('div', { class: 'sub', text: 'Pas de réponse pour cette question. Attendez la suivante !' }));
  }

  function revealView() {
    const L = S.live, mine = S.answers[L.qi] || [], r = myResult();
    const correct = new Set(L.correct);
    const verdict = { 1: ['ok', 'Bonne réponse !'], 2: ['partial', 'Réponse partielle'], 0: ['bad', 'Raté…'] }[r.lo] || ['none', 'Pas de réponse'];
    const rows = L.q.c.map((t, i) => {
      const ok = correct.has(i), picked = mine.includes(i);
      return el('div', { class: 'row' + (ok ? ' good' : '') },
        el('span', { class: 'letter c' + (i % 6), text: LETTERS[i] }),
        el('span', { text: t }),
        el('span', { class: 'mark' + (picked ? (ok ? ' me-ok' : ' me-bad') : ''), text: (ok ? 'Vrai' : 'Faux') + (picked ? ' · coché' : '') }));
    });
    return el('div', { class: 'screen' },
      el('div', { class: 'verdict ' + verdict[0] },
        el('div', { class: 'big', text: verdict[1] }),
        el('div', { class: 'pts', text: r.lp ? '+' + fmt(r.lp) + ' points' : '0 point' })),
      el('div', { class: 'recap' }, rows),
      standing(r.score, r.rank, L.np));
  }

  function scoresView() {
    const L = S.live, r = myResult();
    return centered(
      el('div', { class: 'sub', text: 'Classement provisoire' }),
      el('div', { class: 'big', text: r.rank ? ordinal(r.rank) + ' / ' + L.np : '–' }),
      el('div', { class: 'sub' }, el('b', { text: fmt(r.score) + ' points' })),
      r.lp ? el('div', { class: 'sub', text: '+' + fmt(r.lp) + ' à cette question' }) : null);
  }

  const MEDALS = ['🥇', '🥈', '🥉'];

  function finalBlock(L, r, celebrate) {
    if (r.rank >= 1 && r.rank <= 3) {
      if (celebrate) setTimeout(() => confetti(document.body, 4000), 50);
      return [
        el('div', { class: 'medal', text: MEDALS[r.rank - 1] }),
        el('div', { class: 'big', text: r.rank === 1 ? 'Champion·ne !' : 'Bravo, ' + ordinal(r.rank) + ' place !' }),
        el('div', { class: 'sub' }, el('b', { text: fmt(r.score) + ' points' })),
      ];
    }
    return [
      el('div', { class: 'sub', text: 'Classement final' }),
      el('div', { class: 'big', text: (r.rank ? ordinal(r.rank) : '–') + ' sur ' + L.np }),
      el('div', { class: 'sub' }, el('b', { text: fmt(r.score) + ' points' })),
    ];
  }

  function podiumView() {
    const L = S.live, r = myResult();
    const mineRevealed = r.rank >= 1 && r.rank <= 3 && L.podium[r.rank - 1];
    if (mineRevealed || L.step >= 3) {
      return centered(...finalBlock(L, r, mineRevealed && L.step === 4 - r.rank));
    }
    return centered(
      el('div', { class: 'big', text: 'Le podium…' }),
      el('div', { class: 'sub', text: r.rank && r.rank <= 3 ? 'Suspense… regardez l’écran ! 🤞' : 'Regardez l’écran partagé !' }),
      el('div', { class: 'spinner' }));
  }

  function endView() {
    const L = S.live, r = myResult();
    return centered(
      ...finalBlock(L, r, false),
      el('div', { class: 'sub', text: 'Merci d’avoir participé' + (L.title ? ' au ' + L.title : '') + ' !' }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Rejoindre une nouvelle partie', onclick: () => { store.del(KEY); joinScreen(); } }));
  }

  function lightbox(src) {
    const box = el('div', { class: 'lightbox', onclick: () => box.remove() }, el('img', { src, alt: '' }));
    document.body.append(box);
  }

  // ------------------------------------------------------------ démarrage
  (async function boot() {
    // Retour sur la page (rechargement, appel Zoom…) : on reprend sa place si c'est toujours la même partie.
    const saved = store.get(KEY);
    const cur = await fetchCurrent();
    if (saved && saved.pub && (!cur || cur.pin === saved.pin)) {
      try {
        await api('hello', { pin: saved.pin, pub: saved.pub, tok: saved.tok });
        S.me = saved;
      } catch (e) {
        if (e.network) S.me = saved; else store.del(KEY);
      }
      if (S.me) {
        S.answers = store.get(ansKey()) || {};
        return start();
      }
    }
    joinScreen();
  })();
})();
